/**
 * AJENO de S11 (E12; ficha `docs/audit/2026-11-08-tienda-hibrida-parte2/ajeno-cupon-cliente-de-otra-sucursal.md`): el canje público de
 * un cupón (`POST …/coupons/:couponId/redeem` → `recordCouponRedemption`) acotaba el cupón y la cuenta a la sucursal, pero copiaba el
 * `customerId` del cuerpo sin mirar de quién era: la llave foránea de `CouponRedemption` sólo mira el id. Contra Postgres real, con dos
 * sucursales: la clienta de OTRA sucursal se rechaza y ni el canje ni los dos contadores se mueven; la propia y la ausente, como hoy.
 */
import '../../__helpers__/integration-setup'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { recordCouponRedemption } from '@/services/dashboard/coupon.dashboard.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const RUN = cuid()
let orgId: string | undefined
let a: string | undefined
let b: string | undefined
let secuencia = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `ajeno-${RUN}`, email: `ajeno-${RUN}@example.test`, phone: '5550000000' } })).id
  a = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Sucursal A', slug: `ajeno-a-${RUN}` } })).id
  b = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Sucursal B', slug: `ajeno-b-${RUN}` } })).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!orgId || !a || !b) return
  const venues = [a, b]
  await prisma.couponRedemption.deleteMany({ where: { order: { venueId: { in: venues } } } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.couponCode.deleteMany({ where: { discount: { venueId: { in: venues } } } })
  await prisma.discount.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.customer.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

async function escena() {
  const discount = await prisma.discount.create({
    data: { venueId: a!, name: `Diez ${++secuencia}`, type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER' },
  })
  const cupon = await prisma.couponCode.create({ data: { discountId: discount.id, code: `AJ${secuencia}${RUN.slice(-8)}`.toUpperCase() } })
  const venta = await prisma.order.create({
    data: {
      venueId: a!,
      orderNumber: `AJ-${RUN}-${secuencia}`,
      status: 'PENDING',
      source: 'WEB',
      originSystem: 'AVOQADO',
      subtotal: 100,
      total: 100,
      taxAmount: 0,
      remainingBalance: 100,
    },
  })
  return { discount, cupon, venta }
}

const foto = async (e: Awaited<ReturnType<typeof escena>>) => ({
  canjes: await prisma.couponRedemption.count({ where: { couponCodeId: e.cupon.id } }),
  usosDelCodigo: (await prisma.couponCode.findUniqueOrThrow({ where: { id: e.cupon.id } })).currentUses,
  usosDelDescuento: (await prisma.discount.findUniqueOrThrow({ where: { id: e.discount.id } })).currentUses,
})

describe('AJENO S11 · el canje público de un cupón no liga a una clienta de otra sucursal', () => {
  it('una clienta de la sucursal B en un canje de la sucursal A ⇒ 404 «Cliente no encontrado»; canje y contadores intactos', async () => {
    const e = await escena()
    const deOtra = await prisma.customer.create({ data: { venueId: b!, firstName: 'Clienta', lastName: 'De B' } })
    const antes = await foto(e)

    await expect(recordCouponRedemption(a!, e.cupon.id, e.venta.id, 10, deOtra.id)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Cliente no encontrado',
    })
    expect(await foto(e)).toEqual(antes)
    expect(antes).toEqual({ canjes: 0, usosDelCodigo: 0, usosDelDescuento: 0 })
  })

  it('la clienta de la MISMA sucursal, como hoy: canje con ella y los dos contadores en 1', async () => {
    const e = await escena()
    const propia = await prisma.customer.create({ data: { venueId: a!, firstName: 'Clienta', lastName: 'De A' } })
    const r = await recordCouponRedemption(a!, e.cupon.id, e.venta.id, 10, propia.id)
    expect(r.customer).toMatchObject({ id: propia.id, firstName: 'Clienta', lastName: 'De A' })
    expect(await foto(e)).toEqual({ canjes: 1, usosDelCodigo: 1, usosDelDescuento: 1 })
  })

  it('sin clienta (parámetro ausente), como hoy: el canje sin clienta', async () => {
    const e = await escena()
    const r = await recordCouponRedemption(a!, e.cupon.id, e.venta.id, 10)
    expect(r.customer).toBeNull()
    expect(await foto(e)).toEqual({ canjes: 1, usosDelCodigo: 1, usosDelDescuento: 1 })
  })
})
