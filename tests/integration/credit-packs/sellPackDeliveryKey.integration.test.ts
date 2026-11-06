/**
 * Integración (base REAL desechable) — D4: un paquete vendido en el POS se entrega UNA vez.
 *
 * Lo que un mock no ve: el índice único de Postgres, la serialización de dos transacciones a la vez y lo que queda escrito de
 * verdad (una compra, un juego de clases y un solo incremento de `totalSpent`).
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { sellPackInPerson } from '@/services/mobile/creditPack.mobile.service'
import { deactivateCreditPack, updateCreditPack } from '@/services/dashboard/creditPack.dashboard.service'
import { firmarFotoDelPaquete, leerFotoDelPaquete } from '@/services/shared/creditPacksOnPaidOrder'

const RUN = Date.now()

describe('Venta en persona con llave de entrega (integración, base real)', () => {
  let orgId: string | undefined
  let venueId: string
  let staffVenueId: string
  let staffId: string
  let clienta: { id: string }
  let yoga: { id: string }
  let pack: { id: string }
  let n = 0

  const compras = (key: string) =>
    prisma.creditPackPurchase.findMany({ where: { venueId, deliveryKey: key }, include: { itemBalances: true } })
  const gastado = async () =>
    (await prisma.customer.findUniqueOrThrow({ where: { id: clienta.id }, select: { totalSpent: true } })).totalSpent
  const vender = (key: string, foto?: ReturnType<typeof leerFotoDelPaquete>) =>
    sellPackInPerson(venueId, pack.id, clienta.id, staffVenueId, { deliveryKey: key, foto })

  const crearVenue = async (sufijo: string) => {
    const venue = await prisma.venue.create({
      data: {
        name: `ITEST Paquete llave ${sufijo}`,
        slug: `itest-paquete-llave-${sufijo}-${RUN}`,
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
    return venue.id
  }

  const limpiarVenue = async (id: string) => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    await step(() => prisma.creditTransaction.deleteMany({ where: { venueId: id } }))
    await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId: id } } }))
    await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId: id } }))
    await step(() => prisma.creditPack.deleteMany({ where: { venueId: id } }))
    await step(() => prisma.customer.deleteMany({ where: { venueId: id } }))
    await step(() => prisma.product.deleteMany({ where: { venueId: id } }))
    await step(() => prisma.menuCategory.deleteMany({ where: { venueId: id } }))
    await step(() => prisma.staffVenue.deleteMany({ where: { venueId: id } }))
    await step(() => prisma.venue.deleteMany({ where: { id } }))
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Paquete llave', email: `itest-paquete-llave-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    venueId = await crearVenue('a')
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Clases', slug: `clases-${RUN}` } })
    yoga = await prisma.product.create({
      data: { venueId, sku: `PL-yoga-${RUN}`, name: 'Yoga', type: 'CLASS', categoryId: category.id, price: new Prisma.Decimal(200) },
      select: { id: true },
    })
    const staff = await prisma.staff.create({
      data: { email: `itest-paquete-llave-${RUN}@test.com`, firstName: 'Ana', lastName: 'Caja' },
      select: { id: true },
    })
    staffId = staff.id
    const sv = await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER' as any }, select: { id: true } })
    staffVenueId = sv.id
    clienta = await prisma.customer.create({ data: { venueId, firstName: 'Ana' }, select: { id: true } })
  })

  beforeEach(async () => {
    n += 1
    pack = await prisma.creditPack.create({
      data: {
        venueId,
        name: `10 clases ${n}`,
        price: new Prisma.Decimal(1500),
        validityDays: 30,
        items: { create: [{ productId: yoga.id, quantity: 10 }] },
      },
      select: { id: true },
    })
  })

  afterAll(async () => {
    if (!venueId) return
    await limpiarVenue(venueId)
    await prisma.staff.deleteMany({ where: { id: staffId } }).catch(() => {})
    await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
  })

  it('🔴 se perdió la respuesta: el reintento contesta la misma compra, con sus clases, y no suma dos veces', async () => {
    const antes = await gastado()
    const primera = await vender(`resp-${n}`)
    const segunda = await vender(`resp-${n}`)

    expect(segunda.id).toBe(primera.id)
    expect(await compras(`resp-${n}`)).toHaveLength(1)
    expect((segunda as any).itemBalances).toHaveLength(1)
    expect((segunda as any).creditPack.name).toContain('10 clases')
    expect(Number(await gastado()) - Number(antes)).toBe(1500)
  })

  it('🔴 dos a la vez con la misma llave: una sola compra, y las dos contestan esa', async () => {
    const antes = await gastado()
    const r = await Promise.all(Array.from({ length: 5 }, () => vender(`dos-${n}`)))

    expect(new Set(r.map(c => c.id)).size).toBe(1)
    const filas = await compras(`dos-${n}`)
    expect(filas).toHaveLength(1)
    expect(filas[0].itemBalances).toHaveLength(1)
    expect(Number(await gastado()) - Number(antes)).toBe(1500)
  })

  it('🔴 dos a la vez con tope 1: la perdedora contesta la compra, no «alcanzó el máximo»', async () => {
    await prisma.creditPack.update({ where: { id: pack.id }, data: { maxPerCustomer: 1 } })
    const r = await Promise.all([vender(`tope-${n}`), vender(`tope-${n}`), vender(`tope-${n}`)])

    expect(new Set(r.map(c => c.id)).size).toBe(1)
    expect(await compras(`tope-${n}`)).toHaveLength(1)
  })

  it('🔴 el reintento gana aunque la dueña ya apagó el paquete', async () => {
    const primera = await vender(`apagado-${n}`)
    await deactivateCreditPack(venueId, pack.id)

    const segunda = await vender(`apagado-${n}`)

    expect(segunda.id).toBe(primera.id)
  })

  it('🔴 con la foto se entrega lo VENDIDO aunque la dueña lo editó y lo apagó', async () => {
    const hoy = await prisma.creditPack.findUniqueOrThrow({ where: { id: pack.id }, include: { items: true } })
    const foto = leerFotoDelPaquete(firmarFotoDelPaquete(hoy))
    await updateCreditPack(venueId, pack.id, { price: 2000, items: [{ productId: yoga.id, quantity: 5 }] } as any)
    await deactivateCreditPack(venueId, pack.id)

    const entregada = await vender(`foto-${n}`, foto)

    expect(Number(entregada.amountPaid)).toBe(1500)
    expect((entregada as any).itemBalances[0]).toMatchObject({ productId: yoga.id, originalQuantity: 10, creditPackItemId: null })
  })

  it('sin foto, el paquete apagado es un rechazo visible', async () => {
    await deactivateCreditPack(venueId, pack.id)

    await expect(vender(`sinfoto-${n}`)).rejects.toMatchObject({ statusCode: 400 })
    expect(await compras(`sinfoto-${n}`)).toHaveLength(0)
  })

  it('🔴 la misma llave en OTRO negocio no choca: la unicidad es por negocio', async () => {
    const otro = await crearVenue('b')
    const cat = await prisma.menuCategory.create({ data: { venueId: otro, name: 'C', slug: `c-${RUN}` } })
    const prod = await prisma.product.create({
      data: { venueId: otro, sku: `PL-o-${RUN}`, name: 'O', type: 'CLASS', categoryId: cat.id, price: new Prisma.Decimal(100) },
      select: { id: true },
    })
    const cli = await prisma.customer.create({ data: { venueId: otro, firstName: 'B' }, select: { id: true } })
    const pk = await prisma.creditPack.create({
      data: { venueId: otro, name: 'P', price: new Prisma.Decimal(100), items: { create: [{ productId: prod.id, quantity: 1 }] } },
      select: { id: true },
    })
    const sv = await prisma.staffVenue.create({ data: { staffId, venueId: otro, role: 'CASHIER' as any }, select: { id: true } })

    try {
      const aqui = await vender(`compartida-${n}`)
      const alla = await sellPackInPerson(otro, pk.id, cli.id, sv.id, { deliveryKey: `compartida-${n}` })
      expect(alla.id).not.toBe(aqui.id)
    } finally {
      await limpiarVenue(otro)
    }
  })

  it('apps viejas: sin llave, cada llamada crea su compra, como hoy', async () => {
    const a = await sellPackInPerson(venueId, pack.id, clienta.id, staffVenueId)
    const b = await sellPackInPerson(venueId, pack.id, clienta.id, staffVenueId)

    expect(a.id).not.toBe(b.id)
    expect((a as any).deliveryKey).toBeNull()
  })
})
