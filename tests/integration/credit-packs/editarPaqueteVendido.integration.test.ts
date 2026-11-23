/**
 * Integración (base REAL desechable) — editar un paquete de créditos que YA se vendió.
 *
 * 22-nov-2026: guardar cualquier cambio de un paquete vendido daba 500. `updateCreditPack` borraba los productos del
 * paquete y los volvía a crear, y Postgres no deja borrar un `CreditPackItem` al que apunta el saldo de una clienta
 * (`CreditItemBalance_creditPackItemId_fkey`, ON DELETE RESTRICT). El DASHBOARD siempre manda los productos al guardar,
 * así que ningún paquete vendido se podía editar (en prod: 10 paquetes en 3 negocios). Un mock no ve la llave foránea.
 *
 * Regla: editar el paquete cambia lo que se vende DE AQUÍ EN ADELANTE; lo ya vendido conserva sus créditos.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { grantPackInTx, sellPackInPerson } from '@/services/mobile/creditPack.mobile.service'
import { updateCreditPack } from '@/services/dashboard/creditPack.dashboard.service'

const RUN = Date.now()

describe('Editar un paquete de créditos ya vendido (integración, base real)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let staffVenueId: string
  let clienta: { id: string }
  let yoga: { id: string }
  let lagree: { id: string }
  let pack: { id: string }
  let n = 0

  const vender = () => sellPackInPerson(venueId!, pack.id, clienta.id, staffVenueId, { deliveryKey: `vendido-${RUN}-${n}` })
  const saldos = (compraId: string) => prisma.creditItemBalance.findMany({ where: { creditPackPurchaseId: compraId } })
  const productosDelPaquete = () => prisma.creditPackItem.findMany({ where: { creditPackId: pack.id }, orderBy: { productId: 'asc' } })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Paquete vendido', email: `itest-paquete-vendido-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    venueId = (
      await prisma.venue.create({
        data: {
          name: 'ITEST Paquete vendido',
          slug: `itest-paquete-vendido-${RUN}`,
          organizationId: orgId,
          address: 'X',
          city: 'X',
          state: 'X',
          country: 'MX',
          zipCode: '00000',
          timezone: 'America/Mexico_City',
          status: 'TRIAL' as any,
        },
        select: { id: true },
      })
    ).id
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Clases', slug: `clases-vendido-${RUN}` } })
    yoga = await prisma.product.create({
      data: { venueId, sku: `PV-yoga-${RUN}`, name: 'Yoga', type: 'CLASS', categoryId: category.id, price: new Prisma.Decimal(200) },
      select: { id: true },
    })
    lagree = await prisma.product.create({
      data: { venueId, sku: `PV-lagree-${RUN}`, name: 'Lagree', type: 'CLASS', categoryId: category.id, price: new Prisma.Decimal(325) },
      select: { id: true },
    })
    staffId = (
      await prisma.staff.create({
        data: { email: `itest-paquete-vendido-${RUN}@test.com`, firstName: 'Ana', lastName: 'Caja' },
        select: { id: true },
      })
    ).id
    staffVenueId = (await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER' as any }, select: { id: true } })).id
    clienta = await prisma.customer.create({ data: { venueId, firstName: 'Ana' }, select: { id: true } })
  })

  beforeEach(async () => {
    n += 1
    pack = await prisma.creditPack.create({
      data: {
        venueId: venueId!,
        name: `5 Sesiones ${n}`,
        price: new Prisma.Decimal(1450),
        validityDays: 15,
        items: { create: [{ productId: yoga.id, quantity: 5 }] },
      },
      select: { id: true },
    })
  })

  afterAll(async () => {
    if (!venueId) return
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    await step(() => prisma.creditTransaction.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId } } }))
    await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditPack.deleteMany({ where: { venueId } }))
    await step(() => prisma.customer.deleteMany({ where: { venueId } }))
    await step(() => prisma.product.deleteMany({ where: { venueId } }))
    await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
    await step(() => prisma.staffVenue.deleteMany({ where: { venueId } }))
    await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    await step(() => prisma.staff.deleteMany({ where: { id: staffId } }))
    await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  it('🔴 guardar con los MISMOS productos (lo que manda el DASHBOARD) ya no truena, y el saldo vendido sigue igual', async () => {
    const compra = await vender()
    const [antes] = await productosDelPaquete()

    const editado = await updateCreditPack(venueId!, pack.id, {
      name: '5 Sesiones BSF',
      price: 1500,
      items: [{ productId: yoga.id, quantity: 5 }],
    })

    expect(editado.name).toBe('5 Sesiones BSF')
    expect(Number(editado.price)).toBe(1500)
    const [despues] = await productosDelPaquete()
    expect(despues.id).toBe(antes.id) // el renglón se conserva: el saldo sigue ligado
    const [saldo] = await saldos(compra.id)
    expect(saldo).toMatchObject({ productId: yoga.id, originalQuantity: 5, remainingQuantity: 5, creditPackItemId: antes.id })
  })

  it('cambiar la cantidad sólo vale para lo que se venda después: la clienta conserva sus 5', async () => {
    const compra = await vender()

    await updateCreditPack(venueId!, pack.id, { items: [{ productId: yoga.id, quantity: 8 }] })

    const [item] = await productosDelPaquete()
    expect(item.quantity).toBe(8)
    const [saldo] = await saldos(compra.id)
    expect(saldo).toMatchObject({ originalQuantity: 5, remainingQuantity: 5, creditPackItemId: item.id })
  })

  it('cambiar el producto del paquete: lo vendido conserva sus créditos de Yoga y lo nuevo trae Lagree', async () => {
    const compra = await vender()

    await updateCreditPack(venueId!, pack.id, { items: [{ productId: lagree.id, quantity: 5 }] })

    const items = await productosDelPaquete()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ productId: lagree.id, quantity: 5 })
    const [saldo] = await saldos(compra.id)
    expect(saldo).toMatchObject({ productId: yoga.id, originalQuantity: 5, remainingQuantity: 5, creditPackItemId: null })
  })

  it('un paquete que nunca se vendió se sigue editando igual (agregar un segundo producto)', async () => {
    await updateCreditPack(venueId!, pack.id, {
      items: [
        { productId: yoga.id, quantity: 3 },
        { productId: lagree.id, quantity: 2 },
      ],
    })

    const items = await productosDelPaquete()
    expect(items.map(i => [i.productId, i.quantity]).sort()).toEqual(
      [
        [yoga.id, 3],
        [lagree.id, 2],
      ].sort(),
    )
  })

  it('🔴 la dueña quita un producto justo cuando el POS entrega: lo vendido se entrega sin enlace y no truena', async () => {
    await prisma.creditPackItem.create({ data: { creditPackId: pack.id, productId: lagree.id, quantity: 2 } })
    // Lo que la venta lee ANTES de abrir su transacción (`sellPackInPerson` y la compra en línea leen el paquete afuera).
    const leido = await prisma.creditPack.findUniqueOrThrow({ where: { id: pack.id }, include: { items: true } })
    // En ese instante el panel quita Lagree: su renglón deja de existir.
    await updateCreditPack(venueId!, pack.id, { items: [{ productId: yoga.id, quantity: 5 }] })

    // Antes: el saldo de Lagree apuntaba al renglón borrado y la entrega tronaba con P2003 (cobrado y sin créditos).
    const compra = await prisma.$transaction(tx =>
      grantPackInTx(tx as any, {
        pack: leido as any,
        venueId: venueId!,
        customerId: clienta.id,
        amountPaid: new Prisma.Decimal(1450),
        deliveryKey: `carrera-${RUN}`,
      }),
    )

    const [vivo] = await productosDelPaquete()
    const entregados = await saldos(compra.id)
    expect(entregados).toHaveLength(2)
    expect(entregados).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: yoga.id, originalQuantity: 5, creditPackItemId: vivo.id }),
        expect.objectContaining({ productId: lagree.id, originalQuantity: 2, creditPackItemId: null }),
      ]),
    )
  })
})
