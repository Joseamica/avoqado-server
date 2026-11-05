/**
 * D5 (5-nov-2026): el cupón de punta a punta contra PostgreSQL real, por las dos puertas de caja. La promesa:
 * `docs/audit/2026-11-05-cupones/promesa.md`. Medido en producción ese día: 8 cupones activos, 0 usados alguna vez.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { createOrderWithItems as crearEnTerminal } from '@/services/tpv/order.tpv.service'
import { createOrderWithItems as crearEnMovil, payCashOrder } from '@/services/mobile/order.mobile.service'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'
import { removeDiscountFromOrder } from '@/services/dashboard/discountEngine.service'
import { validateCoupon as validarEnTerminal } from '@/services/tpv/discount.tpv.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9_]+_test/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local aislada (avoqado_<x>_test…), nunca av-db-25.')
}

const venueId = `cupon-${randomUUID()}`
let staffId: string, cafeId: string, discountId: string

const uso = async (couponId: string) => {
  const c = await prisma.couponCode.findUniqueOrThrow({ where: { id: couponId }, select: { currentUses: true } })
  const d = await prisma.discount.findUniqueOrThrow({ where: { id: discountId }, select: { currentUses: true } })
  return { cupon: c.currentUses, descuento: d.currentUses, canjes: await prisma.couponRedemption.count({ where: { couponCodeId: couponId } }) }
}
const nuevoCupon = (extra: Record<string, unknown> = {}) =>
  prisma.couponCode.create({ data: { discountId, code: `C${randomUUID().slice(0, 8).toUpperCase()}`, ...extra } })
const clienteNuevo = () => prisma.customer.create({ data: { venueId, firstName: 'Ana', phone: `55${Math.floor(Math.random() * 1e8)}` } })
const ventaMovil = (code: string, extra: Record<string, unknown> = {}) =>
  crearEnMovil(venueId, {
    staffId,
    source: 'AVOQADO_ANDROID',
    orderType: 'TAKEOUT',
    items: [{ productId: cafeId, quantity: 1 }],
    couponCode: code,
    ...extra,
  } as any)

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Caja', lastName: 'Cupon' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Café', slug: `cafe-${venueId}` } })
  cafeId = (await prisma.product.create({ data: { venueId, categoryId: categoria.id, name: 'Café', sku: 'CUP-CAFE', price: 100 } })).id
  discountId = (await prisma.discount.create({ data: { venueId, name: 'Diez', type: 'PERCENTAGE', value: 10, scope: 'ORDER', active: true } })).id
})

afterAll(async () => {
  const ordenes = (await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 200 })).map(o => o.id)
  await prisma.couponRedemption.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderCustomer.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.paymentAllocation.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.payment.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.order.deleteMany({ where: { id: { in: ordenes } } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

describe('POS (mobile): efectivo', () => {
  it('el cupón baja el total, se cobra y al quedar pagada cuenta un solo uso, con su fila ligada para el reporte', async () => {
    const cupon = await nuevoCupon()
    const antes = await uso(cupon.id)
    const orden = await ventaMovil(cupon.code)
    expect(Number(orden.total)).toBe(90)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: orden.id } })
    expect(fila).toMatchObject({ couponCodeId: cupon.id, discountId, name: `Diez (${cupon.code})` })
    expect(Number(fila.amount)).toBe(10)
    // Crear no cuenta: el uso nace al cobrar (si no, una cuenta abandonada gastaría el cupón).
    expect(await uso(cupon.id)).toEqual(antes)

    await payCashOrder(venueId, orden.id, { amount: 9000, tip: 0, staffId, idempotencyKey: `cob-${orden.id}` })
    const despues = await uso(cupon.id)
    expect(despues).toEqual({ cupon: antes.cupon + 1, descuento: antes.descuento + 1, canjes: antes.canjes + 1 })

    // Idempotente: otro paso del cierre o un reintento no cuenta otra vez.
    await onOrderPaid({ orderId: orden.id, venueId })
    expect(await uso(cupon.id)).toEqual(despues)
    const canje = await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: orden.id } })
    expect(Number(canje.amountSaved)).toBe(10)
  })

  it('un abono parcial no cuenta el uso; el que salda sí', async () => {
    const cupon = await nuevoCupon()
    const orden = await ventaMovil(cupon.code)
    await payCashOrder(venueId, orden.id, { amount: 4000, tip: 0, staffId, idempotencyKey: `a-${orden.id}` })
    expect((await uso(cupon.id)).cupon).toBe(0)
    await payCashOrder(venueId, orden.id, { amount: 5000, tip: 0, staffId, idempotencyKey: `b-${orden.id}` })
    expect((await uso(cupon.id)).cupon).toBe(1)
  })

  it('el mismo reintento (misma llave) devuelve la misma orden y una sola fila', async () => {
    const cupon = await nuevoCupon()
    const externalId = `llave-${randomUUID()}`
    const a = await ventaMovil(cupon.code, { externalId })
    const b = await ventaMovil(cupon.code, { externalId })
    expect(b.id).toBe(a.id)
    expect(await prisma.orderDiscount.count({ where: { orderId: a.id } })).toBe(1)
  })

  it('agotado, vencido y límite por cliente se rechazan en español y no crean nada', async () => {
    const agotado = await nuevoCupon({ maxUses: 1, currentUses: 1 })
    const vencido = await nuevoCupon({ validUntil: new Date(Date.now() - 60_000) })
    const porCliente = await nuevoCupon({ maxUsesPerCustomer: 1 })
    const cliente = await clienteNuevo()

    await expect(ventaMovil(agotado.code)).rejects.toMatchObject({ statusCode: 400, message: 'Este cupón ya alcanzó su límite de usos.' })
    await expect(ventaMovil(vencido.code)).rejects.toMatchObject({ statusCode: 400, message: 'Este cupón ya venció.' })

    const primera = await ventaMovil(porCliente.code, { customerId: cliente.id })
    await payCashOrder(venueId, primera.id, { amount: 9000, tip: 0, staffId, idempotencyKey: `c-${primera.id}` })
    await expect(ventaMovil(porCliente.code, { customerId: cliente.id })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Este cliente ya usó este cupón 1 vez.',
    })
    // Sin cliente no hay a quién contarle el límite por cliente: la regla de siempre de `validateCouponCode`.
    expect(Number((await ventaMovil(porCliente.code)).total)).toBe(90)
  })

  it('cancelar sin cobrar no gasta el cupón: nunca se contó', async () => {
    const cupon = await nuevoCupon({ maxUses: 1 })
    const orden = await ventaMovil(cupon.code)
    await prisma.order.update({ where: { id: orden.id }, data: { status: 'CANCELLED' } })
    await onOrderPaid({ orderId: orden.id, venueId })
    expect((await uso(cupon.id)).cupon).toBe(0)
  })
})

describe('terminal (/tpv/with-items)', () => {
  it('el cupón baja el total y la fila queda ligada; crear no cuenta', async () => {
    const cupon = await nuevoCupon()
    const orden = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 1 }],
      staffId,
      taxAmount: 0,
      subtotal: 100,
      discount: 10,
      total: 90,
      tip: 0,
      couponCode: cupon.code,
    } as any)
    expect(Number(orden.total)).toBe(90)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: orden.id } })
    expect(fila).toMatchObject({ couponCodeId: cupon.id, name: `Diez (${cupon.code})` })
    expect((await uso(cupon.id)).cupon).toBe(0)
  })

  it('un cupón al 100 % nace pagado y cuenta su uso de una vez', async () => {
    const total = await prisma.discount.create({ data: { venueId, name: 'Gratis', type: 'PERCENTAGE', value: 100, scope: 'ORDER', active: true } })
    const cupon = await prisma.couponCode.create({ data: { discountId: total.id, code: `G${randomUUID().slice(0, 8).toUpperCase()}` } })
    const orden = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 1 }],
      staffId,
      taxAmount: 0,
      subtotal: 100,
      discount: 100,
      total: 0,
      tip: 0,
      couponCode: cupon.code,
    } as any)
    expect(orden.paymentStatus).toBe('PAID')
    expect(await prisma.couponRedemption.count({ where: { orderId: orden.id } })).toBe(1)
  })

  it('validar devuelve el código, el tope y el texto en español', async () => {
    const cupon = await nuevoCupon()
    await expect(validarEnTerminal(venueId, cupon.code, 100)).resolves.toMatchObject({
      valid: true,
      couponId: cupon.id,
      code: cupon.code,
      scope: 'ORDER',
      maxDiscountAmount: null,
      estimatedSavings: 10,
    })
    await expect(validarEnTerminal(venueId, 'NOEXISTE', 100)).resolves.toMatchObject({
      valid: false,
      errorCode: 'NOT_FOUND',
      message: 'No encontramos ese código de cupón.',
    })
  })
})

describe('quitar el descuento antes de cobrar', () => {
  it('no baja `Discount.currentUses`: el cupón todavía no lo había subido', async () => {
    const cupon = await nuevoCupon()
    const orden = await ventaMovil(cupon.code)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: orden.id } })
    const antes = await uso(cupon.id)
    await removeDiscountFromOrder(orden.id, fila.id, staffId, venueId)
    expect(await uso(cupon.id)).toEqual(antes)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })
    expect(Number(o.total)).toBe(100)
  })
})
