/**
 * Integración (base REAL desechable) — un renglón de orden vende un paquete y se entrega UNA vez, desde la foto (0.d).
 *
 * La Fase 1 (kiosco) creará el renglón con `buildCreditPackSnapshot` y llamará `fulfillCreditPacksForOrder` en la MISMA
 * transacción que deja la orden pagada. Aquí se arma igual, a mano, y se prueba que se entrega lo que se VENDIÓ (aunque la
 * dueña edite o apague el paquete después), una sola vez aunque se llame dos veces o a la vez, sin tocar `totalSpent`, y que
 * lo imposible de entregar queda retenido con UNA anomalía.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { updateCreditPack, deactivateCreditPack } from '@/services/dashboard/creditPack.dashboard.service'
import { buildCreditPackSnapshot, fulfillCreditPacksForOrder, CREDIT_PACK_LINE_HELD } from '@/services/shared/creditPacksOnPaidOrder'

const RUN = Date.now()

describe('Paquete vendido en un renglón de orden: entrega desde la foto (integración, base real)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let otroVenueId: string | undefined
  let clienta: { id: string }
  let yoga: { id: string }
  let pilates: { id: string }
  let otroProducto: { id: string }
  let otroPaquete: { id: string }
  let pack: { id: string }
  let order: { id: string }
  let linea: { id: string }
  const lineas: string[] = []
  let n = 0

  const crearVenue = async (sufijo: string) => {
    const venue = await prisma.venue.create({
      data: {
        name: `ITEST Paquete renglón ${sufijo}`,
        slug: `itest-paquete-renglon-${sufijo}-${RUN}`,
        organizationId: orgId!,
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
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-${sufijo}-${RUN}` } })
    return { venueId: venue.id, categoryId: category.id }
  }

  const crearProducto = (vId: string, categoryId: string, name: string) =>
    prisma.product.create({
      data: { venueId: vId, sku: `PR-${name}-${RUN}`, name, type: 'CLASS', categoryId, price: new Prisma.Decimal(200) },
      select: { id: true },
    })

  const paqueteConItems = (id: string) =>
    prisma.creditPack.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        name: true,
        price: true,
        currency: true,
        validityDays: true,
        items: { select: { productId: true, quantity: true } },
      },
    })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Paquete renglón', email: `itest-paquete-renglon-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const a = await crearVenue('a')
    venueId = a.venueId
    clienta = await prisma.customer.create({ data: { venueId, firstName: 'Ana' }, select: { id: true } })
    yoga = await crearProducto(venueId, a.categoryId, 'Yoga')
    pilates = await crearProducto(venueId, a.categoryId, 'Pilates')

    const b = await crearVenue('b')
    otroVenueId = b.venueId
    otroProducto = await crearProducto(otroVenueId, b.categoryId, 'Spinning')
    otroPaquete = await prisma.creditPack.create({
      data: {
        venueId: otroVenueId,
        name: '5 spinning',
        price: new Prisma.Decimal(800),
        validityDays: 30,
        items: { create: [{ productId: otroProducto.id, quantity: 5 }] },
      },
      select: { id: true },
    })
  })

  beforeEach(async () => {
    n += 1
    pack = await prisma.creditPack.create({
      data: {
        venueId: venueId!,
        name: '10 clases',
        price: new Prisma.Decimal(1500),
        validityDays: 30,
        items: { create: [{ productId: yoga.id, quantity: 10 }] },
      },
      select: { id: true },
    })
    order = await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ITEST-PR-${RUN}-${n}`,
        subtotal: new Prisma.Decimal(1500),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(1500),
        customerId: clienta.id,
      },
      select: { id: true },
    })
    const foto = buildCreditPackSnapshot(await paqueteConItems(pack.id))
    linea = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        quantity: 1,
        productName: '10 clases',
        unitPrice: new Prisma.Decimal(1500),
        total: new Prisma.Decimal(1500),
        taxAmount: new Prisma.Decimal(0),
        creditPackId: pack.id,
        creditPackSnapshot: foto as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    lineas.push(linea.id)
  })

  afterAll(async () => {
    if (!venueId) return
    const venues = [venueId, otroVenueId].filter((v): v is string => !!v)
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    await step(() => prisma.creditTransaction.deleteMany({ where: { venueId: { in: venues } } }))
    await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId: { in: venues } } } }))
    await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId: { in: venues } } }))
    // Antes que los paquetes: el renglón los referencia con RESTRICT (un paquete vendido no se borra).
    await step(() => prisma.orderItem.deleteMany({ where: { order: { venueId: { in: venues } } } }))
    await step(() => prisma.order.deleteMany({ where: { venueId: { in: venues } } }))
    await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId: { in: venues } } } }))
    await step(() => prisma.creditPack.deleteMany({ where: { venueId: { in: venues } } }))
    await step(() => prisma.product.deleteMany({ where: { venueId: { in: venues } } }))
    await step(() => prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } }))
    await step(() => prisma.customer.deleteMany({ where: { venueId: { in: venues } } }))
    await step(() => prisma.activityLog.deleteMany({ where: { venueId: { in: venues } } }))
    if (lineas.length) {
      await step(() => prisma.moneyAnomaly.deleteMany({ where: { stripeEventId: { in: lineas.map(id => `order-item:${id}`) } } }))
    }
    await step(() => prisma.venue.deleteMany({ where: { id: { in: venues } } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
    await prisma.$disconnect()
  })

  // Como la Fase 1: se paga y se entrega en la misma transacción.
  const entregar = () =>
    prisma.$transaction(async tx => {
      await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } })
      return fulfillCreditPacksForOrder(tx, order.id)
    })

  it('entrega lo VENDIDO aunque antes de pagar la dueña cambie Yoga por Pilates, precio y vigencia, y lo desactive', async () => {
    await updateCreditPack(venueId!, pack.id, { price: 999, validityDays: 7, items: [{ productId: pilates.id, quantity: 5 }] }) // borra y recrea CreditPackItem
    await deactivateCreditPack(venueId!, pack.id)

    expect(await entregar()).toEqual({ delivered: 1, skipped: 0, held: 0 })

    const compra = await prisma.creditPackPurchase.findUniqueOrThrow({
      where: { orderItemId: linea.id },
      include: { itemBalances: { include: { transactions: true } } },
    })
    expect(compra).toMatchObject({ customerId: clienta.id, creditPackId: pack.id, status: 'ACTIVE' })
    expect(compra.amountPaid.toFixed(2)).toBe('1500.00')
    expect(compra.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    expect(compra.itemBalances).toHaveLength(1) // Yoga, no Pilates
    expect(compra.itemBalances[0]).toMatchObject({
      productId: yoga.id,
      creditPackItemId: null,
      originalQuantity: 10,
      remainingQuantity: 10,
    })
    expect(compra.itemBalances[0].transactions).toEqual([
      expect.objectContaining({ type: 'PURCHASE', quantity: 10, customerId: clienta.id }),
    ])
    // la entrega no tocó el catálogo vigente
    expect(await prisma.creditPackItem.findMany({ where: { creditPackId: pack.id }, select: { productId: true } })).toEqual([
      { productId: pilates.id },
    ])
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `order-item:${linea.id}` } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { venueId, action: 'CREDIT_PACK_DELIVERED_FROM_ORDER', entityId: compra.id } })).toBe(1)
  })

  it('la segunda llamada no entrega otra vez', async () => {
    await entregar()
    expect(await entregar()).toEqual({ delivered: 0, skipped: 1, held: 0 })
    expect(await prisma.creditPackPurchase.count({ where: { orderItemId: linea.id } })).toBe(1)
  })

  it('dos entregas a la vez de la misma orden dejan UNA compra', async () => {
    const r = await Promise.all([entregar(), entregar()])
    expect(r.map(x => x.delivered).sort()).toEqual([0, 1])
    expect(await prisma.creditPackPurchase.count({ where: { orderItemId: linea.id } })).toBe(1)
  })

  it('no toca totalSpent: el cobro de la orden ya lo cuenta', async () => {
    await entregar()
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: clienta.id } })).totalSpent.toFixed(2)).toBe('0.00')
  })

  it('una orden que no existe es NotFound', async () => {
    await expect(prisma.$transaction(tx => fulfillCreditPacksForOrder(tx, 'cnoexisteestaorden0000000'))).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  // Sólo lo de verdad imposible de entregar. Cambiar o quitar productos del paquete NO está aquí (ver la primera prueba).
  const preparar: Record<string, () => Promise<unknown>> = {
    'sin clienta': () => prisma.order.update({ where: { id: order.id }, data: { customerId: null } }),
    'cantidad 2': () => prisma.orderItem.update({ where: { id: linea.id }, data: { quantity: 2 } }),
    'foto inválida': () =>
      prisma.orderItem.update({ where: { id: linea.id }, data: { creditPackSnapshot: { v: 1, creditPackId: pack.id } } }),
    'foto de otro paquete': async () => {
      const foto = buildCreditPackSnapshot(await paqueteConItems(pack.id))
      return prisma.orderItem.update({
        where: { id: linea.id },
        data: { creditPackSnapshot: { ...foto, creditPackId: otroPaquete.id } as unknown as Prisma.InputJsonValue },
      })
    },
    'paquete de otro negocio': async () => {
      const foto = buildCreditPackSnapshot(await paqueteConItems(otroPaquete.id))
      return prisma.orderItem.update({
        where: { id: linea.id },
        data: { creditPackId: otroPaquete.id, creditPackSnapshot: foto as unknown as Prisma.InputJsonValue },
      })
    },
    'producto de la foto que es de otro negocio': async () => {
      const foto = buildCreditPackSnapshot(await paqueteConItems(pack.id))
      return prisma.orderItem.update({
        where: { id: linea.id },
        data: {
          creditPackSnapshot: { ...foto, items: [{ productId: otroProducto.id, quantity: 10 }] } as unknown as Prisma.InputJsonValue,
        },
      })
    },
  }

  it.each(Object.keys(preparar))('%s: queda retenido con UNA anomalía y sin compra, aunque se llame dos veces', async caso => {
    await preparar[caso]()
    expect(await entregar()).toEqual({ delivered: 0, skipped: 0, held: 1 })
    expect(await entregar()).toEqual({ delivered: 0, skipped: 0, held: 1 })
    expect(await prisma.moneyAnomaly.count({ where: { category: CREDIT_PACK_LINE_HELD, stripeEventId: `order-item:${linea.id}` } })).toBe(1)
    expect(await prisma.creditPackPurchase.count({ where: { orderItemId: linea.id } })).toBe(0)
  })

  it('una orden sin renglones de paquete no hace nada', async () => {
    await prisma.orderItem.update({ where: { id: linea.id }, data: { creditPackId: null, creditPackSnapshot: Prisma.DbNull } })
    expect(await entregar()).toEqual({ delivered: 0, skipped: 0, held: 0 })
  })
})
