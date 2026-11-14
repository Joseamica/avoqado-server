/**
 * Un vale de inventario nunca descuenta dos veces (bloque 0 de la liga con talla).
 *
 * 🔴 El caso (Codex r3 #1, plan-r1 #1, plan-r2 H1, plan-r3 H1): el trabajador A reclama el vale y pasa la cerca
 * cooperativa de `applySalePosting`, pero se atora antes de escribir el movimiento. Pasados los 10 min del permiso
 * (`APPLYING_LEASE_MS`), B re-reclama el MISMO vale y descuenta. A despierta y, sin una cerca dentro de su
 * transacción, vuelve a descontar: una venta, dos descuentos.
 *
 * Contra PostgreSQL real: A se pausa con el gancho de prueba DENTRO de la transacción real de `deductSimpleStock` /
 * `deductStockFIFOInTx` (justo antes del `SELECT … FOR UPDATE` de la cerca), no antes del envoltorio. El reloj de B se
 * adelanta 11 min con `Date.now` para que vea el permiso de A vencido.
 */
import { MovementType, Prisma, Unit, UnitType } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { applySalePosting, createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'
import { __pausarAntesDeLaCercaEnPruebas } from '@/services/inventory/postingFence'

const N = (v: string | number) => new Prisma.Decimal(v)
const PERMISO_VENCIDO_MS = 11 * 60 * 1000 // > APPLYING_LEASE_MS (10 min)

describe('cerca del vale: un renglón nunca descuenta dos veces', () => {
  let venueId: string, orgId: string, categoryId: string
  let n = 0
  const tag = () => `${Date.now()}-${++n}`

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org cerca ${tag()}`, email: `cerca${tag()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V cerca ${tag()}`, slug: `vc-${tag()}` } })
    venueId = v.id
    categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Cat', slug: `cc-${tag()}` } })).id
  })

  afterEach(() => __pausarAntesDeLaCercaEnPruebas(null))

  afterAll(async () => {
    try {
      await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
      await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
      await prisma.inventoryPostingLine.deleteMany({ where: { posting: { venueId } } })
      await prisma.inventoryPosting.deleteMany({ where: { venueId } })
      await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.recipeLine.deleteMany({ where: { recipe: { product: { venueId } } } })
      await prisma.recipe.deleteMany({ where: { product: { venueId } } })
      await prisma.modifier.deleteMany({ where: { group: { venueId } } })
      await prisma.modifierGroup.deleteMany({ where: { venueId } })
      await prisma.lowStockAlert.deleteMany({ where: { venueId } })
      await prisma.stockBatch.deleteMany({ where: { venueId } })
      await prisma.rawMaterial.deleteMany({ where: { venueId } })
      await prisma.inventory.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  // ── fixtures ──────────────────────────────────────────────────────────────

  async function producto(opts: { method: 'QUANTITY' | 'RECIPE' | null; stock?: number }) {
    const p = await prisma.product.create({
      data: {
        venueId,
        categoryId,
        name: `Prenda ${tag()}`,
        sku: `SKU-C-${tag()}`,
        price: '100.00',
        trackInventory: opts.method !== null,
        inventoryMethod: opts.method,
      },
    })
    const inv =
      opts.method === 'QUANTITY'
        ? await prisma.inventory.create({ data: { productId: p.id, venueId, currentStock: N(opts.stock ?? 10) } })
        : null
    return { productId: p.id, inventoryId: inv?.id ?? null }
  }

  async function insumo(stock = 5) {
    const mp = await prisma.rawMaterial.create({
      data: {
        venueId,
        name: `Insumo ${tag()}`,
        sku: `MP-${tag()}`,
        currentStock: N(stock),
        unit: Unit.KILOGRAM,
        unitType: UnitType.WEIGHT,
        minimumStock: N(0),
        reorderPoint: N(0),
        costPerUnit: N(10),
        avgCostPerUnit: N(10),
      },
    })
    await prisma.stockBatch.create({
      data: {
        rawMaterialId: mp.id,
        venueId,
        batchNumber: `B-${tag()}`,
        initialQuantity: N(stock),
        remainingQuantity: N(stock),
        unit: Unit.KILOGRAM,
        costPerUnit: N(10),
        receivedDate: new Date('2026-11-01'),
        status: 'ACTIVE',
      },
    })
    return mp.id
  }

  async function extraConInsumo(rawMaterialId: string) {
    const group = await prisma.modifierGroup.create({ data: { venueId, name: `Extras ${tag()}` } })
    return prisma.modifier.create({
      data: {
        groupId: group.id,
        name: 'Extra',
        price: N(0),
        rawMaterialId,
        quantityPerUnit: N('0.1'),
        unit: Unit.KILOGRAM,
        inventoryMode: 'ADDITION',
      },
    })
  }

  /** Una venta cobrada con su vale SALE, como lo deja la transacción del cobro. */
  async function ventaCobrada(productId: string, modifierId?: string) {
    const order = await prisma.order.create({
      data: { venueId, orderNumber: `C-${tag()}`, subtotal: N(100), taxAmount: N(0), total: N(100) },
    })
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        quantity: 1,
        unitPrice: N(100),
        taxAmount: N(0),
        total: N(100),
        ...(modifierId ? { modifiers: { create: [{ modifierId, quantity: 1, price: N(0) }] } } : {}),
      },
      include: { modifiers: { include: { modifier: true } } },
    })
    const posting = await prisma.$transaction(tx =>
      createSalePostingInTx(tx, {
        venueId,
        orderId: order.id,
        items: [{ id: item.id, productId, quantity: 1, modifiers: item.modifiers as any }],
      }),
    )
    const line = await prisma.inventoryPostingLine.findFirstOrThrow({ where: { postingId: posting.id } })
    return { postingId: posting.id, lineId: line.id }
  }

  /**
   * A se pausa en su llamada número `pausaEn` a la cerca (dentro de la transacción real). Mientras, B corre completo
   * con el reloj 11 min adelante (el permiso de A ya venció) y re-reclama el vale. Luego A despierta.
   */
  async function carrera(postingId: string, pausaEn: number) {
    let llamadas = 0
    let llego!: () => void
    let soltar!: () => void
    const aLlego = new Promise<void>(r => (llego = r))
    const aSuelto = new Promise<void>(r => (soltar = r))
    __pausarAntesDeLaCercaEnPruebas(async () => {
      if (++llamadas !== pausaEn) return
      llego()
      await aSuelto
    })

    const a = applySalePosting(postingId)
    await aLlego

    const ahora = Date.now()
    const reloj = jest.spyOn(Date, 'now').mockImplementation(() => ahora + PERMISO_VENCIDO_MS)
    let b: Awaited<ReturnType<typeof applySalePosting>>
    try {
      b = await applySalePosting(postingId)
    } finally {
      reloj.mockRestore()
      soltar()
    }
    return { a: await a, b }
  }

  const movimientos = async (lineId: string) => ({
    inv: await prisma.inventoryMovement.count({ where: { postingLineId: lineId } }),
    raw: await prisma.rawMaterialMovement.count({ where: { postingLineId: lineId } }),
  })
  const stockProducto = async (inventoryId: string) =>
    (await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } })).currentStock.toString()
  const stockInsumo = async (id: string) => (await prisma.rawMaterial.findUniqueOrThrow({ where: { id } })).currentStock.toString()
  const linea = (lineId: string) => prisma.inventoryPostingLine.findUniqueOrThrow({ where: { id: lineId } })
  const vale = (postingId: string) => prisma.inventoryPosting.findUniqueOrThrow({ where: { id: postingId } })

  // ── la carrera ────────────────────────────────────────────────────────────

  it('(a) producto QUANTITY: B re-reclama y aplica, A despierta → un solo movimiento y stock −1', async () => {
    const { productId, inventoryId } = await producto({ method: 'QUANTITY', stock: 10 })
    const { postingId, lineId } = await ventaCobrada(productId)

    const { a, b } = await carrera(postingId, 1)

    expect(b?.applied).toBe(true)
    expect(a).toBeNull() // A se retira sin tocar la línea
    expect(await movimientos(lineId)).toEqual({ inv: 1, raw: 0 })
    expect(await stockProducto(inventoryId!)).toBe('9')
    expect((await linea(lineId)).status).toBe('APPLIED')
    expect((await vale(postingId)).status).toBe('APPLIED')
  })

  it('(b) receta: B re-reclama y aplica, A despierta → un solo descuento del insumo', async () => {
    const { productId } = await producto({ method: 'RECIPE' })
    const rawMaterialId = await insumo(5)
    await prisma.recipe.create({
      data: { productId, totalCost: N(1), lines: { create: [{ rawMaterialId, quantity: N('0.5'), unit: Unit.KILOGRAM }] } },
    })
    const { postingId, lineId } = await ventaCobrada(productId)

    const { a, b } = await carrera(postingId, 1)

    expect(b?.applied).toBe(true)
    expect(a).toBeNull()
    expect(await movimientos(lineId)).toEqual({ inv: 0, raw: 1 })
    expect(await stockInsumo(rawMaterialId)).toBe('4.5')
    expect((await linea(lineId)).status).toBe('APPLIED')
  })

  it('(c) producto + extra: A descuenta el producto y pierde la cerca antes del extra → el extra no se duplica y la línea va a conciliación manual', async () => {
    const { productId, inventoryId } = await producto({ method: 'QUANTITY', stock: 10 })
    const rawMaterialId = await insumo(5)
    const extra = await extraConInsumo(rawMaterialId)
    const { postingId, lineId } = await ventaCobrada(productId, extra.id)

    // Llamada 1 = transacción del producto (pasa); llamada 2 = transacción del extra (A se atora ahí).
    const { a, b } = await carrera(postingId, 2)

    expect(a).toBeNull()
    expect(b?.applied).toBe(false)
    expect(b?.issues.map(i => i.reason)).toContain('PARTIAL_EFFECTS_MANUAL_RECONCILE')
    expect(await movimientos(lineId)).toEqual({ inv: 1, raw: 0 })
    expect(await stockProducto(inventoryId!)).toBe('9')
    expect(await stockInsumo(rawMaterialId)).toBe('5')
    const l = await linea(lineId)
    expect(l.status).toBe('FAILED')
    expect(l.reason).toBe('PARTIAL_EFFECTS_MANUAL_RECONCILE')
    expect((await vale(postingId)).status).toBe('PARTIAL_FAILED')
  })

  it('(d) sólo el extra (producto sin inventario): un solo descuento', async () => {
    const { productId } = await producto({ method: null })
    const rawMaterialId = await insumo(5)
    const extra = await extraConInsumo(rawMaterialId)
    const { postingId, lineId } = await ventaCobrada(productId, extra.id)

    const { a, b } = await carrera(postingId, 1)

    expect(b?.applied).toBe(true)
    expect(a).toBeNull()
    expect(await movimientos(lineId)).toEqual({ inv: 0, raw: 1 })
    expect(await stockInsumo(rawMaterialId)).toBe('4.9')
    expect((await linea(lineId)).status).toBe('APPLIED')
  })

  // ── regresión: sin carrera, todo igual que hoy ────────────────────────────

  it('sin carrera, el dueño del vale descuenta producto y extra y lo deja APPLIED', async () => {
    const { productId, inventoryId } = await producto({ method: 'QUANTITY', stock: 3 })
    const rawMaterialId = await insumo(5)
    const extra = await extraConInsumo(rawMaterialId)
    const { postingId, lineId } = await ventaCobrada(productId, extra.id)

    const r = await applySalePosting(postingId)

    expect(r?.applied).toBe(true)
    expect(await movimientos(lineId)).toEqual({ inv: 1, raw: 1 })
    expect(await stockProducto(inventoryId!)).toBe('2')
    expect(await stockInsumo(rawMaterialId)).toBe('4.9')
    const mov = await prisma.inventoryMovement.findFirstOrThrow({ where: { postingLineId: lineId } })
    expect(mov.type).toBe(MovementType.SALE)
    expect((await vale(postingId)).status).toBe('APPLIED')
  })
})
