/**
 * 🔴 DINERO (tope de usos), contra PostgreSQL real — pizarrón hz:e82938e1:D24, encargo ea1827.
 *
 * D19 hizo que el descuento de cuenta del POS (Mesas de ANDROID ≥ 2.25.32, WINDOWS, iOS) sume su uso al aplicarse
 * (`OrderDiscount.usoContado`) y lo devuelva al QUITAR la fila o al BORRAR la cuenta vacía. Pero ANULAR la cuenta sin cobrar sólo
 * devolvía los canjes de lealtad: el uso quedaba gastado y un «primeros 100» (o uno de un solo uso) se agotaba antes de tiempo en todas
 * las cajas, también en la TPV.
 *
 * Aquí, por cada camino que anula: aplicar → anular → `currentUses` igual que antes, la fila se queda como historia sin su marca, y queda
 * la bitácora `ORDER_CANCEL_DISCOUNT_USES_RETURNED`. Los caminos: el POS (`cancelOrder`, el mismo que reproduce la cola sin red
 * `CANCEL_ORDER`), la TPV al anular todos los renglones (`voidItems`) y el panel/MCP (`cancelarCuentaSinCobrar`).
 */
import prisma from '@/utils/prismaClient'
import { applyOrderDiscount, cancelOrder, createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { voidItems } from '@/services/tpv/order.tpv.service'
import { cancelarCuentaSinCobrar } from '@/services/dashboard/order.dashboard.service'
import { removeDiscountFromOrder } from '@/services/dashboard/discountEngine.service'
import { devolverUsosDeCuentaQueSeBorraEnTx } from '@/services/shared/usoDelDescuento'

jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const sufijo = `anular-uso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let orgId: string
let venueId: string
let staffId: string
let promoId: string

/** Una cuenta abierta de $100 en un renglón «Otro importe», sin cobrar. */
async function cuentaAbierta(): Promise<string> {
  const creada = await createOrderWithItems(venueId, {
    staffId,
    items: [{ name: 'Otro importe', quantity: 1, unitPrice: 10000 }],
    orderType: 'TAKEOUT',
    source: 'AVOQADO_ANDROID',
  } as any)
  return creada.id
}

const usos = async () => (await prisma.discount.findUniqueOrThrow({ where: { id: promoId }, select: { currentUses: true } })).currentUses
const filas = (orderId: string) =>
  prisma.orderDiscount.findMany({
    where: { orderId },
    select: { discountId: true, usoContado: true, usoDevueltoAlAnular: true },
    orderBy: { id: 'asc' },
    take: 10,
  })
const bitacora = (orderId: string) =>
  prisma.activityLog.findMany({
    where: { venueId, entityId: orderId, action: 'ORDER_CANCEL_DISCOUNT_USES_RETURNED' },
    select: { data: true, staffId: true },
    take: 10,
  })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${sufijo}`, email: `${sufijo}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `Café ${sufijo}`, slug: sufijo, seatCapExempt: true },
      select: { id: true },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `gerente-${sufijo}@example.test`, firstName: 'Gerente', lastName: 'Prueba' },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER' } })
  promoId = (
    await prisma.discount.create({
      data: { venueId, name: 'Primeros 100', type: 'PERCENTAGE', value: 10, scope: 'ORDER', maxTotalUses: 100, currentUses: 40 },
      select: { id: true },
    })
  ).id
})

afterAll(async () => {
  if (!orgId) return
  const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 100 })).map(o => o.id)
  await prisma.orderAction.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.order.deleteMany({ where: { id: { in: ids } } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('🔴 D24: anular una cuenta sin cobrar devuelve el uso de su descuento de cuenta (PostgreSQL real)', () => {
  it('POS «Anular cuenta» (y la cola sin red CANCEL_ORDER, que llama lo mismo): el contador regresa', async () => {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    // El escenario ocurrió de verdad: el uso se sumó (si esto falla, la prueba no está midiendo nada).
    expect(await usos()).toBe(antes + 1)

    await cancelOrder(venueId, orderId, 'el cliente se fue', staffId)

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await usos()).toBe(antes)
    expect(await filas(orderId)).toEqual([{ discountId: promoId, usoContado: false, usoDevueltoAlAnular: true }])
    expect(await bitacora(orderId)).toEqual([
      { staffId, data: expect.objectContaining({ camino: 'cancelOrder', usosDevueltos: 1, porDescuento: { [promoId]: 1 } }) },
    ])
    // El barrido de cuentas vacías (o cualquier otro que devuelva por la marca) ya no devuelve otra vez.
    expect(await prisma.$transaction(tx => devolverUsosDeCuentaQueSeBorraEnTx(tx as any, venueId, orderId))).toBe(0)
    expect(await usos()).toBe(antes)
  })

  it('TPV: anular TODOS los renglones cancela la cuenta y el contador regresa', async () => {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    expect(await usos()).toBe(antes + 1)
    const orden = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { version: true, items: { select: { id: true } } },
    })

    await voidItems(venueId, orderId, {
      itemIds: orden.items.map(i => i.id),
      reason: 'se equivocó de mesa',
      staffId,
      actorId: staffId,
      expectedVersion: orden.version,
    })

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await usos()).toBe(antes)
    expect(await bitacora(orderId)).toEqual([{ staffId, data: expect.objectContaining({ camino: 'voidItems', usosDevueltos: 1 }) }])
  })

  it('panel / MCP «Cancelar cuenta sin cobrar»: el contador regresa', async () => {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    expect(await usos()).toBe(antes + 1)

    await cancelarCuentaSinCobrar(venueId, orderId, 'cuenta de prueba', staffId)

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await usos()).toBe(antes)
  })

  it('🔴 Codex r1 #1: la cuenta anulada revive por dinero tardío y la TPV le quita el descuento: no se resta otro uso', async () => {
    const orderId = await cuentaAbierta()
    const antes = await usos()
    await applyOrderDiscount(venueId, orderId, promoId, staffId)
    await cancelOrder(venueId, orderId, 'anulada en otra caja', staffId)
    expect(await usos()).toBe(antes)
    // Lo que deja `reabrirSiRecibeDinero` cuando llega un abono sin red de otra caja: la cuenta vuelve a estar viva y debe.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED' } })
    const [fila] = await prisma.orderDiscount.findMany({ where: { orderId }, select: { id: true }, take: 1 })

    await removeDiscountFromOrder(orderId, fila.id, staffId, venueId)

    expect(await prisma.orderDiscount.count({ where: { orderId } })).toBe(0)
    expect(await usos()).toBe(antes)
  })

  it('regresión: la TPV sigue restando el uso de un descuento que su motor sí sumó (sin marca de anulación)', async () => {
    const orderId = await cuentaAbierta()
    await prisma.discount.update({ where: { id: promoId }, data: { currentUses: { increment: 1 } } })
    const fila = await prisma.orderDiscount.create({
      data: { orderId, discountId: promoId, type: 'PERCENTAGE', name: 'Primeros 100', value: 10, amount: 0 },
      select: { id: true },
    })
    const antes = await usos()

    await removeDiscountFromOrder(orderId, fila.id, staffId, venueId)

    expect(await usos()).toBe(antes - 1)
  })

  it('regresión: una fila vieja sin marca (de antes de D19) no resta lo que nunca sumó', async () => {
    const orderId = await cuentaAbierta()
    await prisma.orderDiscount.create({
      data: { orderId, discountId: promoId, type: 'PERCENTAGE', name: 'Primeros 100', value: 10, amount: 0, usoContado: false },
    })
    const antes = await usos()

    await cancelOrder(venueId, orderId, 'fila vieja', staffId)

    expect(await usos()).toBe(antes)
    expect(await bitacora(orderId)).toEqual([])
  })
})
