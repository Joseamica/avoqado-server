/**
 * 🔴 R9-1 (ronda 9 post-QA de sellos tardíos; Codex recheck-13 #3), todo real contra Postgres: la sesión de vales v7 de una venta que
 * YA estaba cerrada antes de que entrara su cobro.
 *
 * La cadena (por v7):
 *   1. venta de vales de $100 (un vale de $60 con su reserva + un producto suelto de $40);
 *   2. la TERMINAL cobra $50 por la sesión ⇒ sesión PARTIALLY_PAID, venta PARTIAL;
 *   3. el panel salda los otros $50 con un pago manual (no conoce la sesión) ⇒ venta PAID y COMPLETED, y su vale de inventario
 *      descuenta los DOS renglones; la reserva del vale se queda ACTIVE;
 *   4. el panel corrige ese cobro a $30 ⇒ la venta sigue PAID con $80 cobrados (el panel no recalcula);
 *   5. llega un cobro tardío de la terminal por la sesión: $10 (no cubre) o $20 (vuelve a cubrir).
 * Antes: con $10 la venta seguía PAID (R8-1) pero la sesión quedaba PARTIALLY_PAID (Android e iOS la restauran como carrito cobrable);
 * con $20 la sesión volvía a consumir la reserva y el producto suelto (segundo descuento). Ahora la sesión cierra PAID como una venta
 * pagada, sin tocar inventario, y el dinero se registra como siempre.
 */
import {
  AreaTicketCheckoutStatus,
  AreaTicketInventoryReservationMode,
  AreaTicketStatus,
  InventoryMethod,
  PaymentMethod,
  PaymentSource,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

import {
  addTicketToCheckout,
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { updatePayment } from '@/services/dashboard/payment.dashboard.service'
import { reconcileOrderFromPayments, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

const sello = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let n = 0
let organizationId: string | undefined
let venueId: string | undefined
let staffId: string
let issueDeviceUid: string
let checkoutDeviceUid: string
let valeProductId: string
let sueltoProductId: string
let valeInventoryId: string
let sueltoInventoryId: string

beforeAll(async () => {
  organizationId = (
    await prisma.organization.create({
      data: { name: `ITEST vales cerrada ${sello}`, email: `itest-vales-cerrada-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: {
        organizationId,
        name: `itest-vales-cerrada-${sello}`,
        slug: `itest-vales-cerrada-${sello}`,
        timezone: 'America/Mexico_City',
        seatCapExempt: true,
      },
    })
  ).id
  // Ruling R12: los productos son al 0 %; el venue representa un negocio con IVA por producto encendido.
  await encenderIvaPorProducto(venueId)
  staffId = (
    await prisma.staff.create({ data: { email: `itest-vales-cerrada-${sello}@test.com`, firstName: 'Dueño', lastName: 'Prueba' } })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER } })
  await prisma.shift.create({ data: { venueId, staffId, startTime: new Date() } })

  const areaId = (await prisma.fulfillmentArea.create({ data: { venueId, name: `Cremería ${sello}`, fulfillmentMode: 'HOLD_UNTIL_PAID' } }))
    .id
  issueDeviceUid = `issue-${sello}`
  checkoutDeviceUid = `checkout-${sello}`
  await prisma.terminal.createMany({
    data: [
      {
        venueId,
        name: 'Cremería',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: issueDeviceUid,
        fulfillmentAreaId: areaId,
        canIssueAreaTickets: true,
      },
      {
        venueId,
        name: 'Caja',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: checkoutDeviceUid,
        canCheckoutAreaTickets: true,
      },
    ],
  })
  await prisma.venueAreaTicketSettings.create({
    data: { venueId, enabled: true, inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK },
  })
  const categoryId = (
    await prisma.menuCategory.create({ data: { venueId, name: 'Cremería', slug: `cremeria-${sello}`, availableDays: [] } })
  ).id
  const producto = (sku: string, name: string, price: string) =>
    prisma.product.create({
      data: {
        venueId: venueId!,
        categoryId,
        sku: `${sku}-${sello}`,
        name,
        price: new Prisma.Decimal(price),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        trackInventory: true,
        inventoryMethod: InventoryMethod.QUANTITY,
        unit: Unit.PIECE,
      },
    })
  valeProductId = (await producto('QUESO', 'Queso del vale', '60.00')).id
  sueltoProductId = (await producto('PAN', 'Pan suelto', '40.00')).id
  valeInventoryId = (await prisma.inventory.create({ data: { venueId, productId: valeProductId, currentStock: new Prisma.Decimal(10) } }))
    .id
  sueltoInventoryId = (
    await prisma.inventory.create({ data: { venueId, productId: sueltoProductId, currentStock: new Prisma.Decimal(10) } })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !organizationId) return
  await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  await prisma.venueTransaction.deleteMany({ where: { venueId } })
  await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
  await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.areaTicketPrintAttempt.deleteMany({ where: { areaTicket: { venueId } } })
  await prisma.areaTicket.deleteMany({ where: { venueId } })
  await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.inventory.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
  await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

/** Venta de vales de $100 materializada: un vale de $60 (con su reserva) + un producto suelto de $40. */
async function ventaDeVales(): Promise<{ orderId: string; sessionId: string; ticketId: string }> {
  const k = `${sello}-${++n}`
  const ticket = await issueAreaTicket(venueId!, {
    idempotencyKey: `issue-${k}`,
    deviceUid: issueDeviceUid,
    staffId,
    lines: [{ clientLineId: `line-${k}`, productId: valeProductId, quantity: '1' }],
  })
  const checkout = await createAreaTicketCheckout(venueId!, { idempotencyKey: `checkout-${k}`, deviceUid: checkoutDeviceUid, staffId })
  await addTicketToCheckout(venueId!, checkout.id, ticket.code, { idempotencyKey: `claim-${k}`, deviceUid: checkoutDeviceUid, staffId })
  const materialized = await materializeAreaTicketCheckout(venueId!, checkout.id, {
    idempotencyKey: `materialize-${k}`,
    deviceUid: checkoutDeviceUid,
    staffId,
    source: 'AVOQADO_ANDROID',
    normalItems: [{ productId: sueltoProductId, quantity: 1 }],
  })
  expect(materialized.order.total).toBe('100.00')
  return { orderId: materialized.order.id, sessionId: checkout.id, ticketId: ticket.id }
}

/**
 * El cobro de la TERMINAL de verdad, en efectivo y con llave (las ventas con vales la exigen): el importe en centavos. `llave` fija
 * = el MISMO cobro reenviado por la terminal (respuesta perdida o cola sin red).
 */
async function cobroDeLaTerminal(orderId: string, pesos: number, llave = `r9-tpv-${sello}-${++n}`) {
  return recordOrderPayment(
    venueId!,
    orderId,
    {
      venueId: venueId!,
      amount: pesos * 100,
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      source: 'TPV',
      splitType: 'CUSTOMAMOUNT',
      tpvId: `tpv-${sello}`,
      staffId,
      paidProductsId: [],
      idempotencyKey: llave,
      currency: 'MXN',
      isInternational: false,
    } as never,
    staffId,
  )
}

/** Pasos 1-4 de la cadena: la venta queda PAID (saldada por el pago manual, corregido a $30) y su sesión PARTIALLY_PAID. */
async function ventaDeValesCerradaPorOtroCanal() {
  // Cada caso parte de 10 piezas por producto (el anterior dejó su reserva ACTIVE a propósito: no estorba con 10).
  await prisma.inventory.updateMany({ where: { id: { in: [valeInventoryId, sueltoInventoryId] } }, data: { currentStock: 10 } })
  const venta = await ventaDeVales()
  await cobroDeLaTerminal(venta.orderId, 50)
  expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PARTIALLY_PAID)
  const manual = await createManualPayment(venueId!, staffId, {
    orderId: venta.orderId,
    amount: '50.00',
    tipAmount: '0',
    method: PaymentMethod.CASH,
    source: PaymentSource.POS,
  })
  await updatePayment(venueId!, manual.id, { amount: 30 })
  const venta80 = await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { paymentStatus: true, status: true } })
  expect(venta80).toEqual({ paymentStatus: 'PAID', status: 'COMPLETED' }) // el panel no recalcula: sigue PAID con $80
  return venta
}

async function estadoDeLaSesion(sessionId: string) {
  return (await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true } })).status
}

/** Todo lo que el cobro tardío podría escribir: dinero, venta, sesión, vales e inventario. */
async function foto(v: { orderId: string; sessionId: string; ticketId: string }) {
  const [venta, pagos, sesion, vale, reservas, inventarios, movimientos, vales] = await Promise.all([
    prisma.order.findUniqueOrThrow({
      where: { id: v.orderId },
      select: {
        paymentStatus: true,
        status: true,
        paidAmount: true,
        remainingBalance: true,
        completedAt: true,
        loyaltyEligibleAt: true,
        kitchenPendingAt: true,
      },
    }),
    prisma.payment.count({ where: { orderId: v.orderId, status: 'COMPLETED' } }),
    prisma.areaTicketCheckoutSession.findUniqueOrThrow({
      where: { id: v.sessionId },
      select: { status: true, activePaymentAttemptId: true },
    }),
    prisma.areaTicket.findUniqueOrThrow({ where: { id: v.ticketId }, select: { status: true } }),
    prisma.areaTicketInventoryReservation.findMany({ where: { areaTicketId: v.ticketId }, select: { status: true }, take: 10 }),
    prisma.inventory.findMany({
      where: { id: { in: [valeInventoryId, sueltoInventoryId] } },
      select: { id: true, currentStock: true },
      orderBy: { id: 'asc' },
    }),
    prisma.inventoryMovement.count({ where: { inventoryId: { in: [valeInventoryId, sueltoInventoryId] } } }),
    prisma.inventoryPosting.count({ where: { venueId, orderId: v.orderId } }),
  ])
  return JSON.parse(JSON.stringify({ venta, pagos, sesion, vale, reservas, inventarios, movimientos, vales }))
}

describe('🔴 R9-1: el cobro tardío de la sesión de vales de una venta YA cerrada', () => {
  it.each([
    ['$10 (no cubre)', 10, '90'],
    ['$20 (vuelve a cubrir)', 20, '100'],
  ])(
    '🔴 %s ⇒ la sesión cierra PAID, el vale queda pagado, el inventario NO se toca otra vez y el dinero se registra',
    async (_caso, pesos, pagado) => {
      const venta = await ventaDeValesCerradaPorOtroCanal()
      const antes = await foto(venta)
      // Precondiciones: el pago manual ya descontó los dos renglones (vale + suelto) con su vale de inventario; la reserva sigue ACTIVE.
      expect(antes.inventarios.map((i: { currentStock: string }) => i.currentStock).sort()).toEqual(['9', '9'])
      expect(antes.reservas).toEqual([{ status: 'ACTIVE' }])
      expect(antes.sesion.status).toBe('PARTIALLY_PAID')

      const respuesta: any = await cobroDeLaTerminal(venta.orderId, pesos)

      const despues = await foto(venta)
      // Sólo cambia lo que debe: el cobro (uno más, $X pagados), la sesión (PAID, sin intento activo) y el vale (pagado).
      expect(despues).toEqual({
        ...antes,
        venta: { ...antes.venta, paidAmount: pagado, remainingBalance: '0' },
        pagos: antes.pagos + 1,
        sesion: { status: 'PAID', activePaymentAttemptId: null },
        vale: { status: AreaTicketStatus.PAID },
      })
      // La venta sigue cerrada con su fecha y su lealtad de antes; inventario, reservas, movimientos y vales de inventario, IGUAL.
      expect(despues.venta).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
      expect(respuesta.areaTicketCheckoutState).toBe('PAID')
      const intento = await prisma.areaTicketPaymentAttempt.findFirstOrThrow({
        where: { checkoutSessionId: venta.sessionId },
        orderBy: { sequence: 'desc' },
        select: { status: true, paymentId: true },
      })
      expect(intento).toEqual({ status: 'SUCCEEDED', paymentId: respuesta.id })
    },
  )

  it('regresión: una venta de vales cobrada TODA por la sesión ($50 + $50) consume la reserva y el suelto UNA vez y cierra PAID', async () => {
    const venta = await ventaDeVales()
    const antes = await foto(venta)
    await cobroDeLaTerminal(venta.orderId, 50)
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PARTIALLY_PAID)
    await cobroDeLaTerminal(venta.orderId, 50)

    const despues = await foto(venta)
    expect(despues.venta).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED', paidAmount: '100', remainingBalance: '0' })
    expect(despues.sesion.status).toBe('PAID')
    expect(despues.vale.status).toBe(AreaTicketStatus.PAID)
    expect(despues.reservas).toEqual([{ status: 'CONSUMED' }])
    // Un descuento por renglón: cada inventario baja 1 desde lo que tenía.
    const stock = (f: typeof antes) =>
      Object.fromEntries(f.inventarios.map((i: { id: string; currentStock: string }) => [i.id, Number(i.currentStock)]))
    expect(stock(despues)).toEqual({
      [valeInventoryId]: stock(antes)[valeInventoryId] - 1,
      [sueltoInventoryId]: stock(antes)[sueltoInventoryId] - 1,
    })
    expect(despues.movimientos).toBe(antes.movimientos + 2)
  })

  // Lo que «no se repite» exige que el primer cierre SÍ lo haya hecho. El barrido de pagadas-abiertas (`reconcileOrderFromPayments`)
  // cierra la venta SIN vale de inventario y sin descontar nada (con cobros previos, `settledBeforeThisPayment`). Si después la
  // terminal reenvía el cobro cuya finalización había fallado, la sesión lo concilia sobre una venta ya PAID: ahí el consumo de la
  // sesión es el PRIMER descuento de esa venta, no un segundo — saltarlo dejaba el stock sin descontar para siempre.
  it('🔴 venta cerrada por el barrido (sin vale de inventario) ⇒ el cobro reenviado SÍ consume reserva y suelto, una sola vez', async () => {
    await prisma.inventory.updateMany({ where: { id: { in: [valeInventoryId, sueltoInventoryId] } }, data: { currentStock: 10 } })
    const venta = await ventaDeVales()
    // La finalización del vale falla con el dinero ya capturado (la reserva ya no tiene existencia) ⇒ conciliación pendiente.
    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 0 } })
    const llave = `r9-tpv-reenvio-${sello}`
    const primero: any = await cobroDeLaTerminal(venta.orderId, 100, llave)
    expect(primero.areaTicketCheckoutState).toBe('RECONCILIATION_REQUIRED')
    // El barrido cierra la venta: PAID y COMPLETED, sin vale de inventario ni descuento.
    await reconcileOrderFromPayments(venta.orderId)
    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })
    const antes = await foto(venta)
    expect(antes.venta).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
    expect([antes.vales, antes.reservas, antes.sesion.status]).toEqual([0, [{ status: 'ACTIVE' }], 'RECONCILIATION_REQUIRED'])

    // La terminal reenvía el MISMO cobro (misma llave): no es dinero nuevo, se reanuda la finalización.
    const reenvio: any = await cobroDeLaTerminal(venta.orderId, 100, llave)

    const despues = await foto(venta)
    expect(reenvio.areaTicketCheckoutState).toBe('PAID')
    expect([despues.pagos, despues.sesion.status, despues.vale.status, despues.reservas]).toEqual([
      antes.pagos,
      'PAID',
      AreaTicketStatus.PAID,
      [{ status: 'CONSUMED' }],
    ])
    const stock = (f: typeof antes) =>
      Object.fromEntries(f.inventarios.map((i: { id: string; currentStock: string }) => [i.id, Number(i.currentStock)]))
    expect(stock(despues)).toEqual({ [valeInventoryId]: 9, [sueltoInventoryId]: 9 })
    expect(despues.movimientos).toBe(antes.movimientos + 2)
    expect(despues.venta).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED', remainingBalance: '0' })
  })
})
