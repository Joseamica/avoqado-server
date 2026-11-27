/**
 * D39 fase 1 (hz:be99f328:D39): «Recompensas» en las cuentas de «Pagar después» de Pedidos usa el canje de Mesas con dos candados
 * nuevos, contra Postgres:
 * - la versión de la cuenta que enseñó la caja (`expectedVersion`): otra versión es el 409 del candado y no quema nada. El canje sube
 *   la versión, así que repetir el mismo canje tras perder la respuesta tampoco quema otra vez (Codex r1 #2 y #3);
 * - un cobro de la terminal sin desenlace en la cuenta: el canje se rechaza y no baja la cuenta debajo de lo que la terminal cobra
 *   (Codex r1 #4).
 * Y el detalle del POS dice `payLater` (Codex r1 #1).
 * Promesa: docs/audit/2026-11-25-defectos-lealtad-referidos/d39/promesa.md (workspace).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { getOrder, payCashOrder } from '@/services/mobile/order.mobile.service'
import { redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => ({ broadcastToVenue: jest.fn(() => true) })) },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const manager = { broadcastToVenue: jest.fn(), getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: manager, socketManager: manager }
})
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const venueId = `itest-d39-${randomUUID()}`
let staffId: string
let productId: string

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Canje', lastName: 'Pedidos' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Catálogo', slug: 'catalogo' } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'Café', sku: 'D39-1', price: 100 } })).id
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, redemptionRate: 0.1, minPointsRedeem: 10 } })
})

afterAll(async () => {
  if (!venueId) return
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  await prisma.paymentAllocation.deleteMany({ where: { order: { venueId } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  // Codex r2 #7: si el arranque falló antes de crear al empleado, `staffId` es undefined y Prisma borraría a TODO el personal.
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

async function cuentaDePagarDespues(puntos = 500, importe = 100) {
  const customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Ana', loyaltyPoints: puntos } })).id
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      customerId,
      payLater: true,
      subtotal: importe,
      discountAmount: 0,
      taxAmount: 0,
      total: importe,
      remainingBalance: importe,
      items: { create: [{ productId, productName: 'Café', quantity: 1, unitPrice: importe, taxAmount: 0, total: importe }] },
    },
  })
  return { orderId: order.id, customerId, version: order.version }
}

const puntosDe = async (customerId: string) => (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints
const canjesDe = (orderId: string) => prisma.orderDiscount.count({ where: { orderId, loyaltyTransactionId: { not: null } } })

describe('D39 · canje en una cuenta de «Pagar después»', () => {
  it('el detalle del POS dice payLater', async () => {
    const { orderId } = await cuentaDePagarDespues()
    expect((await getOrder(venueId, orderId)).payLater).toBe(true)
  })

  it('con la versión que se enseñó canjea; repetirlo con esa misma versión (respuesta perdida) es 409 y no quema otra vez', async () => {
    const { orderId, customerId, version } = await cuentaDePagarDespues()
    const esperado = { monto: 10, puntos: 100, deLaCabecera: true, version }
    await expect(redeemPointsToOrder(venueId, orderId, customerId, 100, staffId, esperado)).resolves.toMatchObject({
      pointsRedeemed: 100,
      discountAmount: 10,
    })
    expect(await puntosDe(customerId)).toBe(400)
    const despues = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(despues.version).toBeGreaterThan(version)
    expect(Number(despues.total)).toBe(90)

    await expect(redeemPointsToOrder(venueId, orderId, customerId, 100, staffId, esperado)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LOYALTY_OFFER_CHANGED',
    })
    expect(await puntosDe(customerId)).toBe(400)
    expect(await canjesDe(orderId)).toBe(1)
  })

  it('otra versión aunque la oferta dé lo mismo: 409 y nada se quema', async () => {
    const { orderId, customerId, version } = await cuentaDePagarDespues()
    // Otra caja cambió la cuenta sin cambiar lo que valen 100 puntos.
    await prisma.order.update({ where: { id: orderId }, data: { version: { increment: 1 } } })
    await expect(
      redeemPointsToOrder(venueId, orderId, customerId, 100, staffId, { monto: 10, puntos: 100, deLaCabecera: true, version }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LOYALTY_OFFER_CHANGED' })
    expect(await puntosDe(customerId)).toBe(500)
    expect(await canjesDe(orderId)).toBe(0)
  })

  it('con un cobro de la terminal sin desenlace sobre la cuenta: 409 y nada se quema (Mesas también)', async () => {
    const { orderId, customerId, version } = await cuentaDePagarDespues()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId: randomUUID(),
        venueId,
        terminalId: `t-${randomUUID()}`,
        status: 'PENDING',
        amountCents: 10000,
        orderId,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    })
    await expect(
      redeemPointsToOrder(venueId, orderId, customerId, 100, staffId, { monto: 10, puntos: 100, deLaCabecera: true, version }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE' })
    // Sin lo enseñado (Mesas, apps viejas) también.
    await expect(redeemPointsToOrder(venueId, orderId, customerId, 100, staffId)).rejects.toMatchObject({ statusCode: 409 })
    expect(await puntosDe(customerId)).toBe(500)
    expect(await canjesDe(orderId)).toBe(0)
  })

  it('D39 r10 (de raíz): un canje que deja la cuenta de «Pagar después» en $0.00 entra, y «Cerrar cuenta ($0.00)» (un cobro de $0) la cierra', async () => {
    const { orderId, customerId, version } = await cuentaDePagarDespues(500, 20)
    await expect(
      redeemPointsToOrder(venueId, orderId, customerId, 200, staffId, { monto: 20, puntos: 200, deLaCabecera: true, version }),
    ).resolves.toMatchObject({ pointsRedeemed: 200 })
    expect(await puntosDe(customerId)).toBe(300)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).total)).toBe(0)
    // Lo que hace el botón de Pedidos: el mismo cobro de $0 con el que Mesas cierra una cortesía.
    await payCashOrder(venueId, orderId, { amount: 0, tip: 0, staffId, idempotencyKey: `cero-${orderId}` })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
  })

  it('sin versión (Mesas, apps viejas): canjea como siempre', async () => {
    const { orderId, customerId } = await cuentaDePagarDespues()
    await prisma.order.update({ where: { id: orderId }, data: { version: { increment: 3 } } })
    await expect(
      redeemPointsToOrder(venueId, orderId, customerId, 100, staffId, { monto: 10, puntos: 100, deLaCabecera: true }),
    ).resolves.toMatchObject({ pointsRedeemed: 100 })
  })
})
