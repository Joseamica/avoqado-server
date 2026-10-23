import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  createCustomerReturnPostingInTx,
  applyCustomerReturnPosting,
  applySalePosting,
} from '@/services/inventory/inventoryPosting.service'
import { InventoryPostingSweeperJob } from '@/jobs/inventory-posting-sweeper.job'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

jest.setTimeout(60000)
const D = (n: number) => new Prisma.Decimal(n)
let venueId = ''
let staffId = ''
let organizationId = ''
let categoryId = ''
let sequence = 0
const fixture = `return-${process.pid}-${Date.now()}`
const old = () => new Date(Date.now() - 4 * 60 * 1000)

beforeAll(async () => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toBe('/avoqado_cambio_test_20261020')
  organizationId = (await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId, name: fixture, slug: fixture } })).id
  staffId = (await prisma.staff.create({ data: { email: `${fixture}@staff.test`, firstName: 'Caja', lastName: 'Cambio' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })).id
})

afterAll(async () => {
  if (!venueId) return
  await prisma.inventoryPosting.deleteMany({ where: { venueId } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.rawMaterial.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: organizationId } })
  await prisma.staff.delete({ where: { id: staffId } })
  await prisma.$disconnect()
})

async function returned(quantity = 2, inventoryMethod: 'QUANTITY' | 'RECIPE' = 'QUANTITY') {
  const product = await prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: `Prenda ${++sequence}`,
      sku: `${fixture}-${sequence}`,
      price: D(100),
      trackInventory: true,
      inventoryMethod,
      inventory: { create: { venueId, currentStock: D(5) } },
    },
  })
  // Son referencias escalares: cuid v1 generado por Prisma, sin insertar una venta ajena al contrato de este bloque.
  const params = {
    venueId,
    refundPaymentId: product.id,
    orderId: categoryId,
    staffId,
    lines: [{ orderItemId: product.id, productId: product.id, quantity }],
  }
  const posting = await prisma.$transaction(tx => createCustomerReturnPostingInTx(tx, params))
  return { product, params, id: posting!.id }
}

const stock = async (productId: string) => (await prisma.inventory.findUniqueOrThrow({ where: { productId } })).currentStock.toString()
const state = (id: string) => prisma.inventoryPosting.findUniqueOrThrow({ where: { id }, include: { lines: true } })
const age = (id: string) => prisma.inventoryPosting.update({ where: { id }, data: { updatedAt: old() } })

// El job real lee sólo el negocio de ESTA prueba, conservando sus filtros y su paginación.
function sweeper() {
  return new InventoryPostingSweeperJob({
    cron: { async start() {}, async stop() {} },
    prisma: {
      inventoryPosting: {
        findMany: (args: Prisma.InventoryPostingFindManyArgs) =>
          prisma.inventoryPosting.findMany({ ...args, where: { ...args.where, venueId } }),
        findUnique: prisma.inventoryPosting.findUnique.bind(prisma.inventoryPosting),
      },
    } as any,
  })
}

describe('durable customer returns', () => {
  it('returns 2 pieces exactly once with a linked movement and an applied line', async () => {
    const r = await returned()
    expect(await applyCustomerReturnPosting(r.id, staffId)).toEqual({ postingId: r.id, applied: true })
    expect(await stock(r.product.id)).toBe('7')
    const posting = await state(r.id)
    expect(posting.lines[0].status).toBe('APPLIED')
    const movement = await prisma.inventoryMovement.findMany({ where: { postingLineId: posting.lines[0].id }, take: 2 })
    expect(movement).toHaveLength(1)
    expect(movement[0]).toMatchObject({ type: 'ADJUSTMENT', reference: r.params.refundPaymentId, createdBy: staffId })
    expect([movement[0].quantity, movement[0].previousStock, movement[0].newStock].map(String)).toEqual(['2', '5', '7'])
    expect(await applyCustomerReturnPosting(r.id)).toBeNull()
    expect(await stock(r.product.id)).toBe('7')
  })

  it('applies a pending return left behind by a crash through the sweeper once', async () => {
    const r = await returned()
    await age(r.id)
    expect(await sweeper().runNow()).toMatchObject({ applied: 1, errors: 0 })
    expect(await sweeper().runNow()).toMatchObject({ scanned: 0 })
    expect(await stock(r.product.id)).toBe('7')
  })

  it('recovers an existing movement without adding stock again', async () => {
    const r = await returned()
    const line = (await state(r.id)).lines[0]
    await prisma.$transaction(async tx => {
      const inv = await tx.inventory.update({ where: { productId: r.product.id }, data: { currentStock: { increment: D(2) } } })
      await tx.inventoryMovement.create({
        data: { inventoryId: inv.id, type: 'ADJUSTMENT', quantity: D(2), previousStock: D(5), newStock: D(7), postingLineId: line.id },
      })
    })
    await applyCustomerReturnPosting(r.id)
    expect(await stock(r.product.id)).toBe('7')
    expect((await state(r.id)).lines[0]).toMatchObject({ status: 'APPLIED', reason: 'RECOVERED_FROM_MOVEMENTS' })
    expect(await prisma.inventoryMovement.count({ where: { postingLineId: line.id } })).toBe(1)
  })

  it('skips an originally RECIPE line even if changed to QUANTITY later and leaves raw materials untouched', async () => {
    const r = await returned(1, 'RECIPE')
    const raw = await prisma.rawMaterial.create({
      data: {
        venueId,
        sku: fixture,
        name: 'Tela',
        currentStock: D(9),
        unit: 'UNIT',
        unitType: 'COUNT',
        minimumStock: D(0),
        reorderPoint: D(0),
        costPerUnit: D(1),
        avgCostPerUnit: D(1),
      },
    })
    await prisma.product.update({ where: { id: r.product.id }, data: { inventoryMethod: 'QUANTITY' } })
    await applyCustomerReturnPosting(r.id)
    expect((await state(r.id)).lines[0]).toMatchObject({ status: 'SKIPPED', reason: 'NOT_QUANTITY_METHOD' })
    expect(await stock(r.product.id)).toBe('5')
    expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: raw.id } })).currentStock.toString()).toBe('9')
    expect(await prisma.rawMaterialMovement.count({ where: { rawMaterialId: raw.id } })).toBe(0)
  })

  it('never lets the sale applicator claim a customer return', async () => {
    const r = await returned()
    expect(await applySalePosting(r.id)).toBeNull()
    expect((await state(r.id)).attempts).toBe(0)
    expect(await stock(r.product.id)).toBe('5')
  })

  it('returns the existing posting twice in the same transaction', async () => {
    const r = await returned()
    await prisma.inventoryPosting.delete({ where: { id: r.id } })
    const [a, b] = await prisma.$transaction(async tx => [
      await createCustomerReturnPostingInTx(tx, r.params),
      await createCustomerReturnPostingInTx(tx, r.params),
    ])
    expect(a!.id).toBe(b!.id)
    expect(await prisma.inventoryPosting.count({ where: { venueId, sourceId: r.params.refundPaymentId } })).toBe(1)
  })

  it('survives 20 sweeps and a restart while inventory is off and applies once after re-enabling', async () => {
    const r = await returned(1)
    await prisma.product.update({ where: { id: r.product.id }, data: { trackInventory: false, inventoryMethod: null } })
    for (let i = 0; i < 20; i++) {
      if (i === 10) await prisma.$disconnect()
      await age(r.id)
      // Instancia nueva = sin memoria de los barridos anteriores.
      expect(await sweeper().runNow()).toMatchObject({ scanned: 1, partial: 1, errors: 0 })
    }
    const waiting = await state(r.id)
    expect(waiting).toMatchObject({ attempts: 0, lastError: 'INVENTORY_DISABLED_AFTER_EXCHANGE' })
    expect(waiting.lines[0]).toMatchObject({ status: 'PENDING', reason: 'INVENTORY_DISABLED_AFTER_EXCHANGE' })
    expect(await stock(r.product.id)).toBe('5')
    await updateProduct(
      venueId,
      r.product.id,
      { trackInventory: true, inventoryMethod: 'QUANTITY' },
      {
        type: 'HUMAN',
        staffId,
        impersonating: false,
      },
    )
    // No se envejece a mano: reactivar por la ficha debe rearmar el posting inmediatamente.
    expect(await sweeper().runNow()).toMatchObject({ scanned: 1, applied: 1, errors: 0 })
    expect(await stock(r.product.id)).toBe('6')
    expect(await applyCustomerReturnPosting(r.id)).toBeNull()
  })

  it('serializes concurrent applications', async () => {
    const r = await returned()
    const result = await Promise.all([applyCustomerReturnPosting(r.id), applyCustomerReturnPosting(r.id)])
    expect(result.filter(x => x?.applied)).toHaveLength(1)
    expect(await stock(r.product.id)).toBe('7')
  })

  it('rearms a waiting return whose previous errors exhausted the posting budget', async () => {
    const r = await returned(1)
    await prisma.product.update({ where: { id: r.product.id }, data: { trackInventory: false } })
    await applyCustomerReturnPosting(r.id)
    await prisma.inventoryPosting.update({ where: { id: r.id }, data: { attempts: 15 } })
    await updateProduct(
      venueId,
      r.product.id,
      { trackInventory: true, inventoryMethod: 'QUANTITY' },
      {
        type: 'HUMAN',
        staffId,
        impersonating: false,
      },
    )
    expect(await sweeper().runNow()).toMatchObject({ scanned: 1, applied: 1, errors: 0 })
    expect(await stock(r.product.id)).toBe('6')
  })

  it('keeps a live lease and recovers an orphaned APPLYING lease', async () => {
    const r = await returned()
    await prisma.inventoryPosting.update({ where: { id: r.id }, data: { status: 'APPLYING' } })
    expect(await applyCustomerReturnPosting(r.id)).toBeNull()
    expect(await stock(r.product.id)).toBe('5')
    await prisma.inventoryPosting.update({ where: { id: r.id }, data: { updatedAt: new Date(Date.now() - 11 * 60 * 1000) } })
    expect(await applyCustomerReturnPosting(r.id)).toMatchObject({ applied: true })
    expect(await stock(r.product.id)).toBe('7')
  })

  it('does not spend the last error attempt while waiting for inventory', async () => {
    const r = await returned(1)
    await prisma.inventoryPosting.update({ where: { id: r.id }, data: { attempts: 14 } })
    await prisma.product.update({ where: { id: r.product.id }, data: { trackInventory: false } })
    for (let i = 0; i < 2; i++) {
      await age(r.id)
      expect(await sweeper().runNow()).toMatchObject({ scanned: 1, partial: 1, errors: 0 })
      expect((await state(r.id)).attempts).toBe(14)
      expect(await sweeper().runNow()).toMatchObject({ scanned: 0 })
    }
    await prisma.product.update({ where: { id: r.product.id }, data: { trackInventory: true } })
    expect(await applyCustomerReturnPosting(r.id)).toMatchObject({ applied: true })
    expect(await stock(r.product.id)).toBe('6')
    expect(await prisma.activityLog.count({ where: { venueId, entityId: r.id, action: 'INVENTORY_POSTING_ABANDONED' } })).toBe(0)
  })

  it('retires an owner whose claim was replaced before its line transaction', async () => {
    const r = await returned()
    const realTransaction = prisma.$transaction.bind(prisma)
    const replacement = new Date(Date.now() + 1000)
    const reclaimed = jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (fn: any) => {
      await prisma.inventoryPosting.update({ where: { id: r.id }, data: { updatedAt: replacement } })
      return realTransaction(fn)
    }) as any)
    try {
      expect(await applyCustomerReturnPosting(r.id)).toBeNull()
    } finally {
      reclaimed.mockRestore()
    }
    expect(await stock(r.product.id)).toBe('5')
    expect(await state(r.id)).toMatchObject({ status: 'APPLYING', updatedAt: replacement })
  })

  it('rolls back stock if writing the movement fails and retries exactly once', async () => {
    const r = await returned()
    const realTransaction = prisma.$transaction.bind(prisma)
    // La segunda escritura falla dentro de una transacción REAL: el incremento previo debe revertirse.
    const failing = jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (fn: any) =>
      realTransaction(async tx => {
        tx.inventoryMovement.create = jest.fn().mockRejectedValue(new Error('movement unavailable'))
        return fn(tx)
      })) as any)
    try {
      expect(await applyCustomerReturnPosting(r.id)).toMatchObject({ applied: false })
    } finally {
      failing.mockRestore()
    }
    expect(await stock(r.product.id)).toBe('5')
    expect((await state(r.id)).lines[0].status).toBe('FAILED')
    expect(await applyCustomerReturnPosting(r.id)).toMatchObject({ applied: true })
    expect(await stock(r.product.id)).toBe('7')
  })
})
