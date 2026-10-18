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
// R10-3: la lealtad de verdad (sello y puntos) sin tocar carteras ni correo.
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import {
  addTicketToCheckout,
  cancelAreaTicketCheckout,
  createAreaTicketCheckout,
  findSesionesDeVentasCerradasPorOtroCanal,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { mergeOrders, payCashOrder, splitOrderBySeat, splitOrderItems } from '@/services/mobile/order.mobile.service'
import * as cuentaConValesModule from '@/services/shared/cuentaConVales'
import { moveOrderToTable } from '@/services/tpv/table.tpv.service'
import { getOperations, getOverview } from '@/services/dashboard/areaTicket.dashboard.service'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { updatePayment } from '@/services/dashboard/payment.dashboard.service'
import {
  findSesionesDeValesAtoradas,
  markAreaTicketPaymentForReconciliation,
  reconcileOrderFromPayments,
  recordOrderPayment,
  retomarCobroDeValesAtorado,
} from '@/services/tpv/payment.tpv.service'
import * as inventoryPostingModule from '@/services/inventory/inventoryPosting.service'
import * as productInventoryModule from '@/services/dashboard/productInventoryIntegration.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { addCustomerToOrder } from '@/services/tpv/order.tpv.service'
import { PaidOrderReconcilerJob } from '@/jobs/paid-order-reconciler.job'
import { findPaidButOpenOrders } from '@/services/shared/pagadaPeroAbierta'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

const sello = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let n = 0
let organizationId: string | undefined
let venueId: string | undefined
let staffId: string
let cocinaId: string
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
  // R10-3: COCINA (sin `payments:create`) y la lealtad del negocio (sellos y puntos).
  cocinaId = (
    await prisma.staff.create({ data: { email: `itest-vales-cerrada-cocina-${sello}@test.com`, firstName: 'Cocina', lastName: 'Prueba' } })
  ).id
  await prisma.staffVenue.create({ data: { staffId: cocinaId, venueId, role: StaffRole.KITCHEN } })
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
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
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  await prisma.venueTransaction.deleteMany({ where: { venueId } })
  await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
  await prisma.inventoryPosting.deleteMany({ where: { venueId } }) // sus líneas caen en cascada
  await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.areaTicketPrintAttempt.deleteMany({ where: { areaTicket: { venueId } } })
  await prisma.areaTicket.deleteMany({ where: { venueId } })
  await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
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
  if (cocinaId) await prisma.staff.deleteMany({ where: { id: cocinaId } })
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
      // Precondiciones: el pago manual ya descontó los dos renglones (vale + suelto) con su vale de inventario; R10-2 (de vuelta en
      // R12-2): y ese vale soltó la reserva al crearse (antes se quedaba ACTIVE para siempre). R11-8: y cerró la sesión con la venta
      // (antes se quedaba PARTIALLY_PAID e invitaba a «cobrar el resto»).
      expect(antes.inventarios.map((i: { currentStock: string }) => i.currentStock).sort()).toEqual(['9', '9'])
      expect(antes.reservas).toEqual([{ status: 'RELEASED' }])
      expect([antes.sesion, antes.vale]).toEqual([{ status: 'PAID', activePaymentAttemptId: null }, { status: AreaTicketStatus.PAID }])

      // R11-8: el cobro tardío llega con llave NUEVA sobre una sesión ya PAID: es dinero capturado y se registra (antes: 409, perdido).
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

/**
 * 🔴 Ronda 10 (Codex recheck-14), todo real contra Postgres.
 *   · R10-1: dos peticiones del MISMO cobro; una finaliza (10 → 9) y el `catch` de la otra corre después. Ya no degrada el cierre, y la
 *     sesión deja su vale SALE `SKIPPED / AREA_TICKET_TRANSACTIONAL`: aunque algo la degradara, el reenvío no vuelve a consumir.
 *   · R10-2: quedan 2 piezas, un vale reserva 1 y el pago manual cierra la venta ⇒ la reserva se suelta; el siguiente vale SÍ se emite.
 *   · R10-3: el cobro capturado falla al finalizar, el barrido cierra la venta sin efectos; el reenvío (o el propio barrido, si la
 *     terminal nunca reenvía) le da su sello y sus puntos UNA vez, al cliente que estaba ligado — nunca al que COCINA ligó después.
 */
describe('🔴 Ronda 10: constancia del consumo, reservas de otro canal y lealtad tras el barrido', () => {
  const stockDe = async () =>
    Object.fromEntries(
      (
        await prisma.inventory.findMany({
          where: { id: { in: [valeInventoryId, sueltoInventoryId] } },
          select: { id: true, currentStock: true },
          orderBy: { id: 'asc' },
        })
      ).map(i => [i.id === valeInventoryId ? 'vale' : 'suelto', Number(i.currentStock)]),
    )
  /** Sin reservas ACTIVE de otros casos sobre el queso, y el stock que pide cada prueba. */
  const reiniciarInventario = async (vale: number, suelto = 10) => {
    await prisma.areaTicketInventoryReservation.updateMany({
      where: { venueId, inventoryId: valeInventoryId, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    })
    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: vale } })
    await prisma.inventory.update({ where: { id: sueltoInventoryId }, data: { currentStock: suelto } })
  }
  const intentoDe = (sessionId: string) =>
    prisma.areaTicketPaymentAttempt.findFirstOrThrow({
      where: { checkoutSessionId: sessionId },
      orderBy: { sequence: 'desc' },
      select: { id: true, status: true, paymentId: true },
    })
  const valesDeVenta = (orderId: string) =>
    prisma.inventoryPosting.findMany({
      where: { venueId, orderId, effectKind: 'SALE' },
      select: { status: true, skipReason: true },
      take: 5,
    })

  it('🔴 R10-1: finalización exitosa → catch tardío → reenvío ⇒ 10 → 9 UNA vez; el catch no degrada y el vale de la sesión lo respalda', async () => {
    await reiniciarInventario(10)
    const venta = await ventaDeVales()
    const llave = `r10-carrera-${sello}`
    const cobro: any = await cobroDeLaTerminal(venta.orderId, 100, llave)
    expect(cobro.areaTicketCheckoutState).toBe('PAID')
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    // R10-1 (2): la constancia durable del consumo de la sesión.
    expect(await valesDeVenta(venta.orderId)).toEqual([{ status: 'SKIPPED', skipReason: 'AREA_TICKET_TRANSACTIONAL' }])
    const intento = await intentoDe(venta.sessionId)
    expect(intento).toMatchObject({ status: 'SUCCEEDED', paymentId: cobro.id })

    // El `catch` de la otra petición del MISMO cobro corre DESPUÉS (secuencial: la carrera, sin hilos).
    const estado = await markAreaTicketPaymentForReconciliation({
      venueId: venueId!,
      sessionId: venta.sessionId,
      attemptId: intento.id,
      paymentId: cobro.id,
    })

    // R10-1 (1): no degrada lo que ya cerró.
    expect(estado).toBe('PAID')
    expect(await intentoDe(venta.sessionId)).toMatchObject({ status: 'SUCCEEDED', paymentId: cobro.id })
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)

    // El reenvío de la terminal (misma llave): ningún cobro nuevo, ningún consumo más.
    const reenvio: any = await cobroDeLaTerminal(venta.orderId, 100, llave)
    expect(reenvio.areaTicketCheckoutState).toBe('PAID')
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })

    // R10-1 (2), por sí sola: aunque algo degradara la sesión (como hacía el catch viejo), el vale SALE de la sesión dice que la
    // obligación ya tiene dueño y el reenvío NO vuelve a consumir (Codex: 9 → 8 con un solo cobro).
    await prisma.areaTicketPaymentAttempt.update({ where: { id: intento.id }, data: { status: 'UNKNOWN' } })
    await prisma.areaTicketCheckoutSession.update({
      where: { id: venta.sessionId },
      data: { status: 'RECONCILIATION_REQUIRED', activePaymentAttemptId: intento.id },
    })
    const tercero: any = await cobroDeLaTerminal(venta.orderId, 100, llave)
    expect(tercero.areaTicketCheckoutState).toBe('PAID')
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    expect(await prisma.payment.count({ where: { orderId: venta.orderId, status: 'COMPLETED' } })).toBe(1)
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
  })

  it('🔴 R10-2: 2 piezas, el vale reserva 1 y el pago manual cierra la venta ⇒ la reserva se suelta y el siguiente vale SÍ se emite', async () => {
    await reiniciarInventario(2)
    const venta = await ventaDeVales()
    await cobroDeLaTerminal(venta.orderId, 50)
    await createManualPayment(venueId!, staffId, {
      orderId: venta.orderId,
      amount: '50.00',
      tipAmount: '0',
      method: PaymentMethod.CASH,
      source: PaymentSource.POS,
    })

    // El vale de VENTA del pago manual descontó TODO (también el renglón reservado): queda 1 pieza física.
    expect((await stockDe()).vale).toBe(1)
    const reservas = await prisma.areaTicketInventoryReservation.findMany({
      where: { areaTicketId: venta.ticketId },
      select: { status: true, releasedAt: true },
      take: 5,
    })
    expect(reservas).toEqual([{ status: 'RELEASED', releasedAt: expect.any(Date) }])

    // La pieza que queda se puede vender en otro vale (antes: 1 − 1 apartada = 0 ⇒ AREA_TICKET_INSUFFICIENT_STOCK).
    const k = `${sello}-${++n}`
    const siguiente = await issueAreaTicket(venueId!, {
      idempotencyKey: `issue-r10-2-${k}`,
      deviceUid: issueDeviceUid,
      staffId,
      lines: [{ clientLineId: `line-r10-2-${k}`, productId: valeProductId, quantity: '1' }],
    })
    expect(siguiente.id).toEqual(expect.any(String))
    expect((await stockDe()).vale).toBe(1) // soltar la reserva no repuso ni descontó nada
  })

  describe('R10-3: la venta que cerró el barrido no pierde su lealtad', () => {
    /** Venta de vales con el cliente X ligado ANTES de cobrar, y su cobro capturado atorado (la finalización falla sin existencia). */
    async function ventaConClienteYCobroAtorado(llave: string) {
      await reiniciarInventario(10)
      const venta = await ventaDeVales()
      const x = (
        await prisma.customer.create({
          data: { venueId: venueId!, firstName: 'Cliente X', phone: `+5255771${String(++n).padStart(5, '0')}` },
        })
      ).id
      await prisma.orderCustomer.create({ data: { orderId: venta.orderId, customerId: x, isPrimary: true } })
      await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 0 } })
      const primero: any = await cobroDeLaTerminal(venta.orderId, 100, llave)
      expect(primero.areaTicketCheckoutState).toBe('RECONCILIATION_REQUIRED')
      await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })
      return { ...venta, x, cobroId: primero.id as string }
    }
    const lealtadDe = async (orderId: string, customerId: string) => {
      const [sellos, puntos] = await Promise.all([
        prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN', stampCard: { customerId } } }),
        prisma.loyaltyTransaction.count({ where: { orderId, customerId } }),
      ])
      return { sellos, puntos }
    }

    it('🔴 barrido + reenvío ⇒ sello y puntos UNA vez al cliente ligado, con el empleado del cobro; COCINA liga a otro y no recibe nada', async () => {
      const llave = `r10-barrido-reenvio-${sello}`
      const venta = await ventaConClienteYCobroAtorado(llave)
      // El barrido (sin poder retomar la sesión, p. ej. porque seguía sin existencia) la cierra sólo de estado: sin lealtad.
      await reconcileOrderFromPayments(venta.orderId)
      const cerrada = await prisma.order.findUniqueOrThrow({
        where: { id: venta.orderId },
        select: { paymentStatus: true, status: true, loyaltyEligibleAt: true },
      })
      expect(cerrada).toEqual({ paymentStatus: 'PAID', status: 'COMPLETED', loyaltyEligibleAt: null })
      // Decisión A: COCINA (sin `payments:create`) liga a Y a la venta YA cobrada ⇒ acompañante, nunca beneficiario.
      const y = (
        await prisma.customer.create({
          data: { venueId: venueId!, firstName: 'Cliente Y', phone: `+5255772${String(++n).padStart(5, '0')}` },
        })
      ).id
      await addCustomerToOrder(venueId!, venta.orderId, y, cocinaId, { otorgarLealtad: false })

      // La terminal reenvía el MISMO cobro.
      const reenvio: any = await cobroDeLaTerminal(venta.orderId, 100, llave)

      expect(reenvio.areaTicketCheckoutState).toBe('PAID')
      expect(await lealtadDe(venta.orderId, venta.x)).toEqual({ sellos: 1, puntos: 1 })
      expect(await lealtadDe(venta.orderId, y)).toEqual({ sellos: 0, puntos: 0 })
      const despues = await prisma.order.findUniqueOrThrow({
        where: { id: venta.orderId },
        select: { loyaltyEligibleAt: true, loyaltyStaffId: true, loyaltyProcessedAt: true },
      })
      expect(despues).toEqual({ loyaltyEligibleAt: expect.any(Date), loyaltyStaffId: staffId, loyaltyProcessedAt: expect.any(Date) })
      expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
      expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)

      // Un segundo reenvío no repite nada: ni sello, ni puntos, ni consumo.
      await cobroDeLaTerminal(venta.orderId, 100, llave)
      expect(await lealtadDe(venta.orderId, venta.x)).toEqual({ sellos: 1, puntos: 1 })
      expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    })

    it('🔴 la terminal NUNCA reenvía ⇒ el barrido retoma la sesión: inventario, sello y puntos UNA vez (antes: cerrada sin nada)', async () => {
      const venta = await ventaConClienteYCobroAtorado(`r10-barrido-solo-${sello}`)
      const barrido = new PaidOrderReconcilerJob({
        cron: { start: jest.fn(), stop: jest.fn() },
        // Pasada la gracia de 5 min del barrido; sólo ESTA venta (otras pruebas comparten la base).
        now: () => new Date(Date.now() + 10 * 60 * 1000),
        findCandidates: async (opts: any) => (await findPaidButOpenOrders(prisma, opts)).filter(c => c.id === venta.orderId),
        findSesionesAtoradas: async (opts: any) =>
          (await findSesionesDeValesAtoradas(prisma, opts)).filter(x => x.orderId === venta.orderId),
      })

      const r = await barrido.runNow()

      expect(r).toMatchObject({ scanned: 1, reconciled: 1, failed: 0 })
      expect(await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { paymentStatus: true, status: true } })).toEqual(
        {
          paymentStatus: 'PAID',
          status: 'COMPLETED',
        },
      )
      expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
      expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
      expect(await lealtadDe(venta.orderId, venta.x)).toEqual({ sellos: 1, puntos: 1 })
      expect(await valesDeVenta(venta.orderId)).toEqual([{ status: 'SKIPPED', skipReason: 'AREA_TICKET_TRANSACTIONAL' }])

      // Otra pasada no encuentra nada que hacer.
      expect(await barrido.runNow()).toMatchObject({ scanned: 0, reconciled: 0 })
      expect(await lealtadDe(venta.orderId, venta.x)).toEqual({ sellos: 1, puntos: 1 })
    })
  })
})

/** Ayudantes de las rondas 11 y 12 (la ronda 10 conserva los suyos). */
const stockDe = async () =>
  Object.fromEntries(
    (
      await prisma.inventory.findMany({
        where: { id: { in: [valeInventoryId, sueltoInventoryId] } },
        select: { id: true, currentStock: true },
        orderBy: { id: 'asc' },
      })
    ).map(i => [i.id === valeInventoryId ? 'vale' : 'suelto', Number(i.currentStock)]),
  )
const reiniciarInventario = async (vale: number, suelto = 10) => {
  await prisma.areaTicketInventoryReservation.updateMany({
    where: { venueId, inventoryId: valeInventoryId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date() },
  })
  await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: vale } })
  await prisma.inventory.update({ where: { id: sueltoInventoryId }, data: { currentStock: suelto } })
}
const lealtadDe = async (orderId: string, customerId: string) => {
  const [sellos, revertidos, puntos] = await Promise.all([
    prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN', stampCard: { customerId } } }),
    prisma.stampEvent.count({ where: { venueId, orderId, type: { not: 'EARN' }, stampCard: { customerId } } }),
    prisma.loyaltyTransaction.count({ where: { orderId, customerId } }),
  ])
  return { sellos, revertidos, puntos }
}
const nuevoCliente = async (nombre: string) =>
  (await prisma.customer.create({ data: { venueId: venueId!, firstName: nombre, phone: `+5255773${String(++n).padStart(5, '0')}` } })).id
/** La venta de vales con su cobro de $100 capturado y atorado (la finalización falla: el queso sin existencia). */
async function cobroAtorado(llave: string, clienteAntes?: string) {
  await reiniciarInventario(10)
  const venta = await ventaDeVales()
  if (clienteAntes) await prisma.orderCustomer.create({ data: { orderId: venta.orderId, customerId: clienteAntes, isPrimary: true } })
  await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 0 } })
  const primero: any = await cobroDeLaTerminal(venta.orderId, 100, llave)
  expect(primero.areaTicketCheckoutState).toBe('RECONCILIATION_REQUIRED')
  return { ...venta, cobroId: primero.id as string }
}
const barridoDe = (orderId: string, enMinutos: number) =>
  new PaidOrderReconcilerJob({
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => new Date(Date.now() + enMinutos * 60 * 1000),
    findCandidates: async (opts: any) => (await findPaidButOpenOrders(prisma, opts)).filter(c => c.id === orderId),
    findSesionesAtoradas: async (opts: any) => (await findSesionesDeValesAtoradas(prisma, opts)).filter(x => x.orderId === orderId),
    // R12-3: sólo ESTA venta (otras pruebas comparten la base).
    findSesionesDeVentasCerradas: async (opts: any) =>
      (await findSesionesDeVentasCerradasPorOtroCanal(prisma, opts)).filter(x => x.orderId === orderId),
  })

/**
 * 🔴 Ronda 11 (Codex recheck-15), todo real contra Postgres. La venta de vales de $100 (vale $60 con su reserva + suelto $40).
 *   · R11-1: captura → la finalización falla → reembolso → recuperación ⇒ ningún sello ni punto vivo sobre la venta devuelta.
 *   · R11-2: captura completa → la venta sigue PENDING sin primario → COCINA liga a Y → recuperación ⇒ Y sin sello ni puntos.
 *   · R11-3: una sesión degradada «a la vieja» (sin vale SALE, intento UNKNOWN con `completedAt`, vales con `paidAt`, el suelto ya
 *     descontado) → reenvío ⇒ 9 se queda en 9.
 *   · R11-4: el barrido falla por existencia y cierra de estado; se repone; la siguiente pasada termina inventario y lealtad, una vez.
 *     Y el intento que se quedó PENDING (el proceso murió antes de marcarlo incierto) también se rescata.
 *   · R11-7 (revertido en R12-2): la reserva la suelta el vale SALE de otro canal al crearse, aunque no se aplique o falle.
 *   · R11-8: terminal $50 → pago manual $50 ⇒ la sesión cierra; el registro tardío (dinero capturado, llave nueva) se registra
 *     como sobrepago, sin doble descuento; una sesión en conciliación también lo recibe; y dos conexiones a la vez no se interbloquean.
 */
describe('🔴 Ronda 11: reembolso antes de recuperar, decisión A con el dinero real, consumo viejo, rescate del barrido, reservas y otro canal', () => {
  it('🔴 R11-1: captura $100 → la finalización falla → reembolso → reenvío ⇒ el cliente NO queda con sello ni puntos vivos', async () => {
    const x = await nuevoCliente('Cliente R11-1')
    const llave = `r11-reembolso-${sello}`
    const venta = await cobroAtorado(llave, x)
    await issueRefund({
      venueId: venueId!,
      paymentId: venta.cobroId,
      amount: 10000,
      tipRefundCents: 0,
      reason: 'CUSTOMER_REQUEST' as never,
      staffId,
    })
    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })

    const reenvio: any = await cobroDeLaTerminal(venta.orderId, 100, llave)

    expect(reenvio.areaTicketCheckoutState).toBe('PAID')
    const { sellos, revertidos, puntos } = await lealtadDe(venta.orderId, x)
    // Ningún sello VIVO (si uno nació, su reversa lo anula) y ningún punto.
    expect(sellos - revertidos).toBe(0)
    expect(puntos).toBe(0)
    // La venta no se reabre por el reembolso (regla del 18-ago) y su lealtad queda cerrada.
    const orden = await prisma.order.findUniqueOrThrow({
      where: { id: venta.orderId },
      select: { paymentStatus: true, remainingBalance: true, loyaltyProcessedAt: true },
    })
    expect(orden).toMatchObject({ paymentStatus: 'PAID', loyaltyProcessedAt: expect.any(Date) })
    expect(Number(orden.remainingBalance)).toBe(0)
  })

  it('🔴 R11-2: captura completa con la venta aún PENDING y sin primario → COCINA liga a Y → recuperación ⇒ Y sin sello ni puntos', async () => {
    const llave = `r11-cocina-${sello}`
    const venta = await cobroAtorado(llave)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { paymentStatus: true } })).toEqual({
      paymentStatus: 'PENDING',
    })
    const y = await nuevoCliente('Cliente Y R11-2')

    await addCustomerToOrder(venueId!, venta.orderId, y, cocinaId, { otorgarLealtad: false })

    // El dinero ya cubre la venta: para la decisión A ya está cobrada ⇒ acompañante.
    expect(
      await prisma.orderCustomer.findUniqueOrThrow({
        where: { orderId_customerId: { orderId: venta.orderId, customerId: y } },
        select: { isPrimary: true },
      }),
    ).toEqual({ isPrimary: false })
    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })
    const reenvio: any = await cobroDeLaTerminal(venta.orderId, 100, llave)

    expect(reenvio.areaTicketCheckoutState).toBe('PAID')
    expect(await lealtadDe(venta.orderId, y)).toEqual({ sellos: 0, revertidos: 0, puntos: 0 })
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
  })

  it('🔴 R11-3: sesión degradada «a la vieja» (sin vale SALE, intento UNKNOWN con completedAt, vales con paidAt) → reenvío ⇒ 9 se queda en 9', async () => {
    await reiniciarInventario(10)
    const venta = await ventaDeVales()
    const llave = `r11-vieja-${sello}`
    const cobro: any = await cobroDeLaTerminal(venta.orderId, 100, llave)
    expect(cobro.areaTicketCheckoutState).toBe('PAID')
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    // Lo que dejaba el código de ANTES de R10-1: sin su vale SALE de constancia, y el `catch` viejo degradó la sesión y el intento
    // (que conserva su `completedAt`); los vales conservan su `paidAt` y los movimientos siguen ahí.
    await prisma.inventoryPosting.deleteMany({ where: { venueId, orderId: venta.orderId } })
    const intento = await prisma.areaTicketPaymentAttempt.findFirstOrThrow({
      where: { checkoutSessionId: venta.sessionId },
      select: { id: true, completedAt: true },
    })
    expect(intento.completedAt).toEqual(expect.any(Date))
    await prisma.areaTicketPaymentAttempt.update({ where: { id: intento.id }, data: { status: 'UNKNOWN' } })
    await prisma.areaTicketCheckoutSession.update({
      where: { id: venta.sessionId },
      data: { status: 'RECONCILIATION_REQUIRED', activePaymentAttemptId: intento.id },
    })
    const movimientosAntes = await prisma.inventoryMovement.count({ where: { inventoryId: { in: [valeInventoryId, sueltoInventoryId] } } })

    const reenvio: any = await cobroDeLaTerminal(venta.orderId, 100, llave)

    expect(reenvio.areaTicketCheckoutState).toBe('PAID')
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    expect(await prisma.inventoryMovement.count({ where: { inventoryId: { in: [valeInventoryId, sueltoInventoryId] } } })).toBe(
      movimientosAntes,
    )
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
    // Queda la constancia: un reenvío más ya no vuelve a preguntar.
    expect(
      await prisma.inventoryPosting.findMany({
        where: { venueId, orderId: venta.orderId },
        select: { status: true, skipReason: true },
        take: 5,
      }),
    ).toEqual([{ status: 'SKIPPED', skipReason: 'AREA_TICKET_TRANSACTIONAL' }])
    expect(await prisma.payment.count({ where: { orderId: venta.orderId, status: 'COMPLETED' } })).toBe(1)
  })

  it('🔴 R11-4: el barrido falla por existencia y cierra de estado → se repone → la siguiente pasada termina inventario y lealtad, UNA vez', async () => {
    const x = await nuevoCliente('Cliente R11-4')
    const venta = await cobroAtorado(`r11-barrido-${sello}`, x)

    // 1.ª pasada: no puede retomar la sesión (sigue sin existencia) ⇒ cierra de estado.
    const primera = await barridoDe(venta.orderId, 10).runNow()
    expect(primera).toMatchObject({ scanned: 1, reconciled: 1, sessionsRecovered: 0 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { status: true } })).toEqual({
      status: 'COMPLETED',
    })
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED)
    expect(await stockDe()).toEqual({ vale: 0, suelto: 10 })

    // Se repone la mercancía; la venta ya COMPLETED no es candidata, pero su sesión sí (pasada su espera).
    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })
    const segunda = await barridoDe(venta.orderId, 120).runNow()

    expect(segunda).toMatchObject({ scanned: 0, sessionsRecovered: 1, failed: 0 })
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
    expect(await lealtadDe(venta.orderId, x)).toEqual({ sellos: 1, revertidos: 0, puntos: 1 })
    // El asiento (la integración sustituye `logAction` por un doble: se mira lo que recibió).
    const { logAction } = jest.requireMock('@/services/dashboard/activity-log.service')
    expect(
      (logAction as jest.Mock).mock.calls.filter(([a]) => a?.action === 'AREA_TICKET_SESSION_RECOVERED' && a?.entityId === venta.orderId),
    ).toHaveLength(1)

    // Otra pasada no repite nada.
    expect(await barridoDe(venta.orderId, 240).runNow()).toMatchObject({ scanned: 0, sessionsRecovered: 0 })
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    expect(await lealtadDe(venta.orderId, x)).toEqual({ sellos: 1, revertidos: 0, puntos: 1 })
  })

  it('🔴 R11-4: el intento que se quedó PENDING (el proceso murió antes de marcarlo incierto) se rescata pasada la gracia, no antes', async () => {
    const venta = await cobroAtorado(`r11-murio-${sello}`)
    // Como lo deja un proceso que murió entre el registro del dinero y su finalización: intento PENDING sin cobro ligado, sesión
    // PAYMENT_PENDING con él; el `Payment` (por la llave del intento) ya es COMPLETED.
    const intento = await prisma.areaTicketPaymentAttempt.findFirstOrThrow({
      where: { checkoutSessionId: venta.sessionId },
      select: { id: true },
    })
    await prisma.areaTicketPaymentAttempt.update({
      where: { id: intento.id },
      data: { status: 'PENDING', paymentId: null, completedAt: null, lastCheckedAt: null },
    })
    await prisma.areaTicketCheckoutSession.update({
      where: { id: venta.sessionId },
      data: { status: 'PAYMENT_PENDING', activePaymentAttemptId: intento.id },
    })
    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })

    // Dentro de la gracia del cobro en vivo: no se pisa (podría seguir finalizándose).
    expect(await barridoDe(venta.orderId, 1).runNow()).toMatchObject({ sessionsRecovered: 0 })
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAYMENT_PENDING)

    const pasada = await barridoDe(venta.orderId, 10).runNow()

    expect(pasada).toMatchObject({ reconciled: 1, failed: 0 })
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    expect(await prisma.areaTicketPaymentAttempt.findUniqueOrThrow({ where: { id: intento.id }, select: { status: true } })).toEqual({
      status: 'SUCCEEDED',
    })
  })

  describe('R12-2 (revierte R11-7): la reserva la suelta el vale SALE de otro canal al crearse', () => {
    afterEach(() => jest.restoreAllMocks())
    const reservaDe = async (ticketId: string) =>
      (await prisma.areaTicketInventoryReservation.findFirstOrThrow({ where: { areaTicketId: ticketId }, select: { status: true } })).status
    const pagoManual = (orderId: string) =>
      createManualPayment(venueId!, staffId, {
        orderId,
        amount: '50.00',
        tipAmount: '0',
        method: PaymentMethod.CASH,
        source: PaymentSource.POS,
      })

    it('🔴 2 piezas, el vale reserva 1, el pago manual cierra la venta y su vale todavía NO se aplica ⇒ la reserva ya está suelta (la obligación vive en el vale); al aplicarse, sale UNA pieza', async () => {
      await reiniciarInventario(2)
      const venta = await ventaDeVales()
      await cobroDeLaTerminal(venta.orderId, 50)
      // El proceso no alcanza a aplicar el vale después del commit (lo hará el sweeper).
      const aplicar = jest.spyOn(inventoryPostingModule, 'applySalePosting').mockResolvedValueOnce(null)
      await pagoManual(venta.orderId)
      expect(aplicar).toHaveBeenCalled()
      aplicar.mockRestore()

      expect(await stockDe()).toMatchObject({ vale: 2 })
      expect(await reservaDe(venta.ticketId)).toBe('RELEASED')

      const posting = await prisma.inventoryPosting.findFirstOrThrow({ where: { venueId, orderId: venta.orderId }, select: { id: true } })
      await inventoryPostingModule.applySalePosting(posting.id, null)

      expect(await stockDe()).toMatchObject({ vale: 1 })
      expect(await reservaDe(venta.ticketId)).toBe('RELEASED')
    })

    it('🔴 Codex r16 #2: el producto deja de inventariarse antes de liquidar ⇒ vale SKIPPED / NO_TRACKED_ITEMS sin líneas y la reserva se suelta igual (antes: ACTIVE para siempre)', async () => {
      await reiniciarInventario(2)
      const venta = await ventaDeVales()
      await cobroDeLaTerminal(venta.orderId, 50)
      const productos = { id: { in: [valeProductId, sueltoProductId] } }
      await prisma.product.updateMany({ where: productos, data: { trackInventory: false } })
      try {
        await pagoManual(venta.orderId)
      } finally {
        await prisma.product.updateMany({ where: productos, data: { trackInventory: true } })
      }

      const vale = await prisma.inventoryPosting.findFirstOrThrow({
        where: { venueId, orderId: venta.orderId, effectKind: 'SALE' },
        select: { status: true, skipReason: true, _count: { select: { lines: true } } },
      })
      expect(vale).toEqual({ status: 'SKIPPED', skipReason: 'NO_TRACKED_ITEMS', _count: { lines: 0 } })
      expect(await reservaDe(venta.ticketId)).toBe('RELEASED')
      expect(await stockDe()).toEqual({ vale: 2, suelto: 10 })
    })

    it('🔴 Codex r16 #3: con modificadores, el descuento del renglón pasa y falla antes del APPLIED ⇒ el reintento deja la línea FAILED / PARTIAL_EFFECTS y la reserva ya está RELEASED (antes: ACTIVE para siempre); 2 → 1 una vez', async () => {
      await reiniciarInventario(2)
      const venta = await ventaDeVales()
      await cobroDeLaTerminal(venta.orderId, 50)
      const original = productInventoryModule.deductInventoryForProduct
      jest.spyOn(productInventoryModule, 'deductInventoryForProduct').mockImplementation(async (...args: Parameters<typeof original>) => {
        const hecho = await original(...args)
        if (args[1] === valeProductId) throw new Error('falla simulada después del descuento')
        return hecho
      })
      await pagoManual(venta.orderId)
      jest.restoreAllMocks()

      expect(await stockDe()).toMatchObject({ vale: 1 })
      expect(await reservaDe(venta.ticketId)).toBe('RELEASED')

      // La foto del vale congela que ese renglón llevaba un modificador inventariable (es lo que clasifica la recuperación).
      const posting = await prisma.inventoryPosting.findFirstOrThrow({
        where: { venueId, orderId: venta.orderId },
        select: { id: true, payloadSnapshot: true },
      })
      const foto = posting.payloadSnapshot as { items: Array<{ productId: string; hasInventoryModifiers?: boolean }> }
      await prisma.inventoryPosting.update({
        where: { id: posting.id },
        data: {
          payloadSnapshot: { items: foto.items.map(i => (i.productId === valeProductId ? { ...i, hasInventoryModifiers: true } : i)) },
        },
      })
      await inventoryPostingModule.applySalePosting(posting.id, null)

      const linea = await prisma.inventoryPostingLine.findFirstOrThrow({
        where: { postingId: posting.id, productId: valeProductId },
        select: { status: true, reason: true },
      })
      expect(linea).toEqual({ status: 'FAILED', reason: 'PARTIAL_EFFECTS_MANUAL_RECONCILE' })
      expect(await stockDe()).toMatchObject({ vale: 1 })
      expect(await reservaDe(venta.ticketId)).toBe('RELEASED')
    })
  })

  describe('R11-8: cuando otro canal cierra la venta de vales', () => {
    it('🔴 terminal $50 → pago manual $50 ⇒ la sesión cierra; el registro tardío (llave nueva) se registra como sobrepago, PAID/0, sin doble descuento', async () => {
      await reiniciarInventario(10)
      const venta = await ventaDeVales()
      await cobroDeLaTerminal(venta.orderId, 50)
      await createManualPayment(venueId!, staffId, {
        orderId: venta.orderId,
        amount: '50.00',
        tipAmount: '0',
        method: PaymentMethod.CASH,
        source: PaymentSource.POS,
      })
      // La sesión cierra con la venta: ya no invita a «cobrar el resto».
      expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
      expect(await prisma.areaTicket.findUniqueOrThrow({ where: { id: venta.ticketId }, select: { status: true } })).toEqual({
        status: AreaTicketStatus.PAID,
      })
      expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })

      const tardio: any = await cobroDeLaTerminal(venta.orderId, 50)

      expect(tardio.areaTicketCheckoutState).toBe('PAID')
      expect(await prisma.payment.count({ where: { orderId: venta.orderId, status: 'COMPLETED' } })).toBe(3)
      const orden = await prisma.order.findUniqueOrThrow({
        where: { id: venta.orderId },
        select: { paymentStatus: true, remainingBalance: true, paidAmount: true },
      })
      expect([orden.paymentStatus, Number(orden.remainingBalance), Number(orden.paidAmount)]).toEqual(['PAID', 0, 150])
      expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
      expect(
        await prisma.activityLog.count({ where: { venueId, entityId: venta.orderId, action: 'SOBREPAGO_DETECTADO' } }),
      ).toBeGreaterThan(0)
      expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
    })

    it('🔴 sesión en conciliación (el primer cobro no pudo finalizar) + un cobro NUEVO de la terminal ⇒ se registra (antes: 409) y concilia la venta una vez', async () => {
      const venta = await cobroAtorado(`r11-rr-${sello}`)
      await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })

      const nuevo: any = await cobroDeLaTerminal(venta.orderId, 50)

      expect(nuevo.id).toEqual(expect.any(String))
      expect(await prisma.payment.count({ where: { orderId: venta.orderId, status: 'COMPLETED' } })).toBe(2)
      expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
      expect(await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { paymentStatus: true } })).toEqual({
        paymentStatus: 'PAID',
      })
      expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
      // R12-4: el intento viejo conserva su identidad y su evidencia (su cobro); como su dinero ya contó al cerrar, queda SUCCEEDED.
      expect(
        await prisma.areaTicketPaymentAttempt.findFirstOrThrow({ where: { paymentId: venta.cobroId }, select: { status: true } }),
      ).toEqual({ status: 'SUCCEEDED' })
    })

    it('🔴 dos conexiones a la vez (pago manual que salda vs registro de la terminal sobre la MISMA venta) ⇒ sin interbloqueo y un solo resultado coherente', async () => {
      for (let vuelta = 0; vuelta < 3; vuelta++) {
        await reiniciarInventario(10)
        const venta = await ventaDeVales()
        await cobroDeLaTerminal(venta.orderId, 50)

        const [manual, terminal] = await Promise.allSettled([
          createManualPayment(venueId!, staffId, {
            orderId: venta.orderId,
            amount: '50.00',
            tipAmount: '0',
            method: PaymentMethod.CASH,
            source: PaymentSource.POS,
          }),
          cobroDeLaTerminal(venta.orderId, 50),
        ])

        // Ningún interbloqueo (40P01) ni error de serialización sin manejar.
        for (const r of [manual, terminal]) {
          if (r.status === 'rejected') expect(String((r.reason as Error)?.message)).not.toMatch(/deadlock|40P01|could not serialize/i)
        }
        // El dinero de la terminal ya capturado se registra SIEMPRE.
        expect(terminal.status).toBe('fulfilled')
        // Si la terminal saldó primero, el pago manual se rechaza por exceder el saldo (no se cobra dos veces); si no, entra.
        if (manual.status === 'rejected') expect(String((manual.reason as Error)?.message)).toMatch(/excede el saldo/i)
        // Si el lado de la terminal quedó en conciliación por la carrera, el barrido la termina.
        if ((await estadoDeLaSesion(venta.sessionId)) === AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED) {
          await retomarCobroDeValesAtorado(venueId!, venta.orderId)
        }

        expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
        expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
        const orden = await prisma.order.findUniqueOrThrow({
          where: { id: venta.orderId },
          select: { paymentStatus: true, remainingBalance: true },
        })
        expect([orden.paymentStatus, Number(orden.remainingBalance)]).toEqual(['PAID', 0])
        expect(await prisma.payment.count({ where: { orderId: venta.orderId, status: 'COMPLETED' } })).toBe(
          manual.status === 'fulfilled' ? 3 : 2,
        )
      }
    })
  })
})

/**
 * 🔴 Ronda 12 (Codex recheck-16 y re-revisión r11), todo real contra Postgres. La venta de vales de $100 (vale $60 + suelto $40).
 *   · R12-1: $100 capturados; el gerente cancela la sesión antes de que llegue el registro ⇒ el Payment queda (regla de nivel venta: la
 *     cuenta cancelada se reabre), los vales liberados no se tocan y nada se descuenta dos veces. Por la terminal y por la cola sin red.
 *   · R12-3: una venta de ANTES de R10-2 (abono $50 + manual $50, reserva ACTIVE, sesión PARTIALLY_PAID) ⇒ el barrido la cierra.
 *   · R12-4: A atorado (UNKNOWN) + B cierra ⇒ A SUCCEEDED; el contador del panel y su lista dicen lo mismo.
 */
describe('🔴 Ronda 12: dinero capturado sobre una sesión cancelada, reservas viejas de otro canal e intentos hermanos', () => {
  const cancelarSesion = (sessionId: string) =>
    cancelAreaTicketCheckout(venueId!, sessionId, { idempotencyKey: `cancel-${sello}-${++n}`, deviceUid: checkoutDeviceUid, staffId })
  /** La venta de vales con su sesión ya CANCELADA (la orden también): el vale vuelve a ISSUED, sin venta, con su reserva ACTIVE. */
  async function ventaCancelada() {
    await reiniciarInventario(10)
    const venta = await ventaDeVales()
    await cancelarSesion(venta.sessionId)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { status: true } })).toEqual({
      status: 'CANCELLED',
    })
    return venta
  }
  /** Lo que el dinero tardío NO debe tocar: la sesión cancelada y el vale liberado con su reserva. */
  const valesLiberados = async (v: { sessionId: string; ticketId: string }) => ({
    sesion: await estadoDeLaSesion(v.sessionId),
    vale: await prisma.areaTicket.findUniqueOrThrow({ where: { id: v.ticketId }, select: { status: true, orderId: true } }),
    reserva: (
      await prisma.areaTicketInventoryReservation.findFirstOrThrow({ where: { areaTicketId: v.ticketId }, select: { status: true } })
    ).status,
  })
  const LIBERADOS = {
    sesion: AreaTicketCheckoutStatus.CANCELLED,
    vale: { status: AreaTicketStatus.ISSUED, orderId: null },
    reserva: 'ACTIVE',
  }
  const reaperturas = (orderId: string) =>
    prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } })

  it('🔴 R12-1: la terminal registra $100 ya capturados con la sesión CANCELADA ⇒ queda el Payment y la cuenta se reabre (antes: 409, el dinero se perdía); el vale liberado no se toca y sólo el suelto se descuenta, una vez', async () => {
    const venta = await ventaCancelada()
    expect(await valesLiberados(venta)).toEqual(LIBERADOS)

    const cobro: any = await cobroDeLaTerminal(venta.orderId, 100)

    expect(cobro.id).toEqual(expect.any(String))
    expect(await prisma.payment.count({ where: { orderId: venta.orderId, status: 'COMPLETED' } })).toBe(1)
    const orden = await prisma.order.findUniqueOrThrow({
      where: { id: venta.orderId },
      select: { status: true, paymentStatus: true, remainingBalance: true },
    })
    expect([orden.status, orden.paymentStatus, Number(orden.remainingBalance)]).toEqual(['COMPLETED', 'PAID', 0])
    expect(await reaperturas(venta.orderId)).toBe(1)
    expect(await valesLiberados(venta)).toEqual(LIBERADOS)
    expect(await stockDe()).toEqual({ vale: 10, suelto: 9 })
  })

  it('🔴 R12-1: el mismo dinero por la cola sin red del POS (PAY_CASH) ⇒ igual: Payment, cuenta reabierta, vale liberado intacto, sólo el suelto', async () => {
    const venta = await ventaCancelada()

    const cobro = await payCashOrder(venueId!, venta.orderId, {
      amount: 10000,
      tip: 0,
      staffId,
      idempotencyKey: `r12-cola-${sello}`,
      isOfflineReplay: true,
    })

    expect(cobro.paymentId).toEqual(expect.any(String))
    expect(await prisma.payment.count({ where: { orderId: venta.orderId, status: 'COMPLETED' } })).toBe(1)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { paymentStatus: true } })).toEqual({
      paymentStatus: 'PAID',
    })
    expect(await reaperturas(venta.orderId)).toBe(1)
    expect(await valesLiberados(venta)).toEqual(LIBERADOS)
    expect(await stockDe()).toEqual({ vale: 10, suelto: 9 })
  })

  it('regresión R12-1: el efectivo EN VIVO del POS sobre esa venta cancelada se rechaza antes de tomar el dinero', async () => {
    const venta = await ventaCancelada()

    await expect(
      payCashOrder(venueId!, venta.orderId, { amount: 10000, tip: 0, staffId, idempotencyKey: `r12-vivo-${sello}` }),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) })

    expect(await prisma.payment.count({ where: { orderId: venta.orderId } })).toBe(0)
    expect(await valesLiberados(venta)).toEqual(LIBERADOS)
    expect(await stockDe()).toEqual({ vale: 10, suelto: 10 })
  })

  it('🔴 R12-3: venta de ANTES de R10-2 (abono $50 + manual $50: reserva ACTIVE, sesión PARTIALLY_PAID) ⇒ una pasada del barrido cierra la sesión y suelta la reserva, sin mover stock ni crear pagos ni sellos; otra pasada no encuentra nada', async () => {
    await reiniciarInventario(10)
    const x = await nuevoCliente('Cliente R12-3')
    const venta = await ventaDeVales()
    await prisma.orderCustomer.create({ data: { orderId: venta.orderId, customerId: x, isPrimary: true } })
    await cobroDeLaTerminal(venta.orderId, 50)
    await createManualPayment(venueId!, staffId, {
      orderId: venta.orderId,
      amount: '50.00',
      tipAmount: '0',
      method: PaymentMethod.CASH,
      source: PaymentSource.POS,
    })
    // Lo que dejaba el código de ANTES de R10-2 y R11-8: la reserva del vale ACTIVE y la sesión PARTIALLY_PAID con su vale reclamado.
    await prisma.areaTicketInventoryReservation.updateMany({
      where: { areaTicketId: venta.ticketId },
      data: { status: 'ACTIVE', releasedAt: null },
    })
    await prisma.areaTicketCheckoutSession.update({ where: { id: venta.sessionId }, data: { status: 'PARTIALLY_PAID' } })
    await prisma.areaTicket.update({ where: { id: venta.ticketId }, data: { status: AreaTicketStatus.CLAIMED, paidAt: null } })
    const fotoDeLaVenta = async () => ({
      stock: await stockDe(),
      pagos: await prisma.payment.count({ where: { orderId: venta.orderId } }),
      lealtad: await lealtadDe(venta.orderId, x),
      movimientos: await prisma.inventoryMovement.count({ where: { inventoryId: { in: [valeInventoryId, sueltoInventoryId] } } }),
      vales: await prisma.inventoryPosting.count({ where: { venueId, orderId: venta.orderId } }),
    })
    const antes = await fotoDeLaVenta()
    expect(antes.stock).toEqual({ vale: 9, suelto: 9 })

    const pasada = await barridoDe(venta.orderId, 10).runNow()

    expect(pasada).toMatchObject({ sessionsClosed: 1, failed: 0 })
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
    expect(await prisma.areaTicket.findUniqueOrThrow({ where: { id: venta.ticketId }, select: { status: true } })).toEqual({
      status: AreaTicketStatus.PAID,
    })
    expect(
      (await prisma.areaTicketInventoryReservation.findFirstOrThrow({ where: { areaTicketId: venta.ticketId }, select: { status: true } }))
        .status,
    ).toBe('RELEASED')
    expect(await fotoDeLaVenta()).toEqual(antes)
    const { logAction } = jest.requireMock('@/services/dashboard/activity-log.service')
    expect(
      (logAction as jest.Mock).mock.calls.filter(
        ([a]) => a?.action === 'AREA_TICKET_SESSION_CLOSED_BY_SALE' && a?.entityId === venta.orderId,
      ),
    ).toHaveLength(1)

    expect(await barridoDe(venta.orderId, 20).runNow()).toMatchObject({ sessionsClosed: 0 })
    expect(await fotoDeLaVenta()).toEqual(antes)
  })

  it('🔴 R12-4: A capturado y atorado (UNKNOWN) + B cierra la venta ⇒ A queda SUCCEEDED y deja de contarse; el contador del panel y su lista dicen lo mismo', async () => {
    const conteo = async () => {
      const [resumen, operaciones] = await Promise.all([getOverview(venueId!), getOperations(venueId!)])
      return { contador: resumen.operations.paymentReconciliationCount, lista: operaciones.reconciliation.map(r => r.id) }
    }
    const antes = await conteo()
    const venta = await cobroAtorado(`r12-hermano-${sello}`)
    const atorado = await conteo()
    expect(atorado.contador).toBe(antes.contador + 1)
    expect(atorado.lista).toContain(venta.sessionId)

    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })
    await cobroDeLaTerminal(venta.orderId, 50)

    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
    expect(
      await prisma.areaTicketPaymentAttempt.findFirstOrThrow({ where: { paymentId: venta.cobroId }, select: { status: true } }),
    ).toEqual({ status: 'SUCCEEDED' })
    const despues = await conteo()
    expect(despues.contador).toBe(antes.contador)
    expect(despues.lista).not.toContain(venta.sessionId)
    expect(despues.contador).toBe(despues.lista.length)
  })

  /**
   * 🔴 Ronda 13 (Codex r17 y re-revisión r12), todo real contra Postgres. La misma venta de vales de $100 (vale $60 + suelto $40).
   *   · R13-1: transferencia (o terminal ajena) registrada EN VIVO desde el POS sobre la sesión CANCELADA ⇒ el dinero ya capturado se
   *     registra con la regla de nivel venta (antes: 409, sin Payment).
   *   · R13-2: dividir mueve el renglón del vale de A a B (el vale sigue apuntando a A); cobrar B ⇒ 10 → 9 y su reserva RELEASED
   *     (antes: el guarda de R12-1 lo dejaba fuera: 10 y ACTIVE). Desde R14-1 una cuenta con vales ya no se divide: el criterio queda
   *     como defensa para las ventas divididas ANTES del despliegue, y el dato viejo se arma con el código de antes (`divisionDeAntes`).
   *   · R13-4: venta histórica REFUNDED (o sesión PAYMENT_PENDING sin intento) con la reserva ACTIVE ⇒ la simulación la lista; una pasada
   *     del barrido cierra la sesión y suelta la reserva, sin mover stock ni crear pagos.
   */
  describe('🔴 Ronda 13: el cobro externo en vivo, el renglón dividido y las reservas viejas de ventas devueltas', () => {
    /** Una venta de vales dividida ANTES de R14-1: el mismo `splitOrderItems`, con el guarda de R14-1 apagado sólo para esta llamada. */
    const divisionDeAntes = async (orderId: string, itemId: string) => {
      const sinGuarda = jest.spyOn(cuentaConValesModule, 'rechazarSiLaCuentaTieneVales').mockImplementation(() => undefined)
      try {
        return await splitOrderItems(venueId!, orderId, [itemId], staffId)
      } finally {
        sinGuarda.mockRestore()
      }
    }

    it('🔴 R13-1: una transferencia registrada EN VIVO desde el POS con la sesión CANCELADA ⇒ queda el Payment y la cuenta se reabre (antes: 409); el vale liberado no se toca y sólo el suelto se descuenta', async () => {
      const venta = await ventaCancelada()

      const cobro = await payCashOrder(venueId!, venta.orderId, {
        amount: 10000,
        tip: 0,
        staffId,
        idempotencyKey: `r13-transferencia-${sello}`,
        method: 'BANK_TRANSFER',
      })

      expect(cobro.paymentId).toEqual(expect.any(String))
      const pagos = await prisma.payment.findMany({
        where: { orderId: venta.orderId, status: 'COMPLETED' },
        select: { method: true, amount: true },
      })
      expect(pagos.map(p => ({ method: p.method, amount: Number(p.amount) }))).toEqual([
        { method: PaymentMethod.BANK_TRANSFER, amount: 100 },
      ])
      const orden = await prisma.order.findUniqueOrThrow({
        where: { id: venta.orderId },
        select: { status: true, paymentStatus: true, remainingBalance: true },
      })
      expect([orden.status, orden.paymentStatus, Number(orden.remainingBalance)]).toEqual(['COMPLETED', 'PAID', 0])
      expect(await reaperturas(venta.orderId)).toBe(1)
      expect(await valesLiberados(venta)).toEqual(LIBERADOS)
      expect(await stockDe()).toEqual({ vale: 10, suelto: 9 })
    })

    it('🔴 R13-2 (dividida antes de R14-1): el renglón del vale ($60) pasó de A a B y se cobra B ⇒ el queso baja 10 → 9 y su reserva queda RELEASED (antes: 10 y ACTIVE)', async () => {
      await reiniciarInventario(10)
      const venta = await ventaDeVales()
      const renglonDelVale = await prisma.orderItem.findFirstOrThrow({
        where: { orderId: venta.orderId, areaTicketLineId: { not: null } },
        select: { id: true },
      })

      const division = await divisionDeAntes(venta.orderId, renglonDelVale.id)
      // El vale sigue apuntando a A: dividir no lo toca.
      expect(await prisma.areaTicket.findUniqueOrThrow({ where: { id: venta.ticketId }, select: { orderId: true } })).toEqual({
        orderId: venta.orderId,
      })
      await payCashOrder(venueId!, division.created.id, { amount: 6000, tip: 0, staffId, idempotencyKey: `r13-dividida-${sello}` })

      expect(await prisma.order.findUniqueOrThrow({ where: { id: division.created.id }, select: { paymentStatus: true } })).toEqual({
        paymentStatus: 'PAID',
      })
      expect(await stockDe()).toEqual({ vale: 9, suelto: 10 })
      expect(
        (
          await prisma.areaTicketInventoryReservation.findFirstOrThrow({
            where: { areaTicketId: venta.ticketId },
            select: { status: true },
          })
        ).status,
      ).toBe('RELEASED')
    })

    it('🔴 R13-2, orden inverso (dividida antes de R14-1): cobrar A por su sesión ($40: consume la reserva del vale, 10 → 9) y luego B ($60) ⇒ el queso se queda en 9 (sin el filtro de lo ya consumido: 10 → 8)', async () => {
      await reiniciarInventario(10)
      const venta = await ventaDeVales()
      const renglonDelVale = await prisma.orderItem.findFirstOrThrow({
        where: { orderId: venta.orderId, areaTicketLineId: { not: null } },
        select: { id: true },
      })
      const division = await divisionDeAntes(venta.orderId, renglonDelVale.id)
      const reservaDelVale = async () =>
        (
          await prisma.areaTicketInventoryReservation.findFirstOrThrow({
            where: { areaTicketId: venta.ticketId },
            select: { status: true },
          })
        ).status

      await payCashOrder(venueId!, venta.orderId, { amount: 4000, tip: 0, staffId, idempotencyKey: `r13-inverso-a-${sello}` })
      expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
      expect(await reservaDelVale()).toBe('CONSUMED')
      expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })

      await payCashOrder(venueId!, division.created.id, { amount: 6000, tip: 0, staffId, idempotencyKey: `r13-inverso-b-${sello}` })

      expect(await prisma.order.findUniqueOrThrow({ where: { id: division.created.id }, select: { paymentStatus: true } })).toEqual({
        paymentStatus: 'PAID',
      })
      expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
      expect(await reservaDelVale()).toBe('CONSUMED')
    })

    it.each([
      ['venta REFUNDED con la sesión PARTIALLY_PAID', { paymentStatus: 'REFUNDED', sesion: 'PARTIALLY_PAID' }],
      ['venta PAID con la sesión PAYMENT_PENDING sin intento', { paymentStatus: 'PAID', sesion: 'PAYMENT_PENDING' }],
    ] as const)(
      '🔴 R13-4: %s y la reserva ACTIVE (código viejo) ⇒ la simulación la lista; una pasada cierra la sesión y suelta la reserva, sin mover stock ni crear pagos; otra no encuentra nada',
      async (_caso, historico) => {
        await reiniciarInventario(10)
        const venta = await ventaDeVales()
        // Otro canal la cierra: el pago manual de $100 crea su vale SALE (10 → 9 del queso y del pan).
        await createManualPayment(venueId!, staffId, {
          orderId: venta.orderId,
          amount: '100.00',
          tipAmount: '0',
          method: PaymentMethod.CASH,
          source: PaymentSource.POS,
        })
        // Lo que dejaba el código de antes: la reserva del vale ACTIVE, la sesión sin cerrar con su vale reclamado y, en el primer caso,
        // la venta marcada REFUNDED.
        await prisma.areaTicketInventoryReservation.updateMany({
          where: { areaTicketId: venta.ticketId },
          data: { status: 'ACTIVE', releasedAt: null },
        })
        await prisma.areaTicketCheckoutSession.update({
          where: { id: venta.sessionId },
          data: { status: historico.sesion, activePaymentAttemptId: null },
        })
        await prisma.areaTicket.update({ where: { id: venta.ticketId }, data: { status: AreaTicketStatus.CLAIMED, paidAt: null } })
        await prisma.order.update({ where: { id: venta.orderId }, data: { paymentStatus: historico.paymentStatus } })
        const fotoDeLaVenta = async () => ({
          stock: await stockDe(),
          pagos: await prisma.payment.count({ where: { orderId: venta.orderId } }),
          movimientos: await prisma.inventoryMovement.count({ where: { inventoryId: { in: [valeInventoryId, sueltoInventoryId] } } }),
          vales: await prisma.inventoryPosting.count({ where: { venueId, orderId: venta.orderId } }),
          venta: await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { paymentStatus: true, status: true } }),
        })
        const antes = await fotoDeLaVenta()
        expect(antes.stock).toEqual({ vale: 9, suelto: 9 })

        const simulacion = await barridoDe(venta.orderId, 10).runNow({ dryRun: true })
        expect(simulacion.sessionsToClose).toEqual([
          expect.objectContaining({ orderId: venta.orderId, paymentStatus: historico.paymentStatus, sessionStatus: historico.sesion }),
        ])
        expect(await estadoDeLaSesion(venta.sessionId)).toBe(historico.sesion)

        const pasada = await barridoDe(venta.orderId, 10).runNow()

        expect(pasada).toMatchObject({ sessionsClosed: 1, failed: 0 })
        expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
        expect(
          (
            await prisma.areaTicketInventoryReservation.findFirstOrThrow({
              where: { areaTicketId: venta.ticketId },
              select: { status: true },
            })
          ).status,
        ).toBe('RELEASED')
        expect(await fotoDeLaVenta()).toEqual(antes)

        expect(await barridoDe(venta.orderId, 20).runNow()).toMatchObject({ sessionsClosed: 0 })
        expect((await barridoDe(venta.orderId, 20).runNow({ dryRun: true })).sessionsToClose).toEqual([])
        expect(await fotoDeLaVenta()).toEqual(antes)
      },
    )
  })
})

/**
 * 🔴 Ronda 14 (decisión del founder del 17-oct), todo real contra Postgres: una cuenta con vales de mostrador NO se separa ni se junta;
 * para pagar entre varios se registran abonos en la misma cuenta. La venta de $100: el vale del queso ($60, con su reserva) + el pan
 * suelto ($40). Mover la cuenta entera a otra mesa no mueve renglones entre cuentas: sigue permitido.
 */
describe('🔴 Ronda 14: una cuenta con vales no se separa ni se junta; se paga con abonos', () => {
  const RECHAZO = {
    statusCode: 400,
    code: 'AREA_TICKET_ORDER_NOT_SPLITTABLE',
    message:
      'Esta cuenta tiene vales de mostrador: no se puede separar ni juntar. Para pagar entre varios, registra abonos en la misma cuenta.',
  }
  /** Todo lo que separar o juntar movería: renglones, cuentas del local, sesión, vale y reserva. */
  const fotoDeLaCuenta = async (v: { orderId: string; sessionId: string; ticketId: string }) => ({
    renglones: await prisma.orderItem.findMany({
      where: { orderId: v.orderId },
      select: { id: true, orderId: true, areaTicketLineId: true, total: true },
      orderBy: { id: 'asc' },
      take: 10,
    }),
    venta: await prisma.order.findUniqueOrThrow({
      where: { id: v.orderId },
      select: { status: true, paymentStatus: true, total: true, version: true },
    }),
    cuentasDelLocal: await prisma.order.count({ where: { venueId } }),
    sesion: await prisma.areaTicketCheckoutSession.findUniqueOrThrow({
      where: { id: v.sessionId },
      select: { status: true, orderId: true, activePaymentAttemptId: true },
    }),
    vale: await prisma.areaTicket.findUniqueOrThrow({ where: { id: v.ticketId }, select: { status: true, orderId: true } }),
    reserva: (
      await prisma.areaTicketInventoryReservation.findFirstOrThrow({ where: { areaTicketId: v.ticketId }, select: { status: true } })
    ).status,
  })

  it('🔴 separar el queso (o el pan), dividir por puesto o juntarla con otra ⇒ rechazado y nada cambió; moverla de mesa sí; dos abonos de $60 y $40 ⇒ PAID y el queso 10 → 9 una vez', async () => {
    await reiniciarInventario(10)
    const venta = await ventaDeVales()
    const otra = await ventaDeVales()
    const [queso, pan] = await Promise.all([
      prisma.orderItem.findFirstOrThrow({ where: { orderId: venta.orderId, areaTicketLineId: { not: null } }, select: { id: true } }),
      prisma.orderItem.findFirstOrThrow({ where: { orderId: venta.orderId, areaTicketLineId: null }, select: { id: true } }),
    ])
    const antes = await fotoDeLaCuenta(venta)
    expect(antes.reserva).toBe('ACTIVE')

    await expect(splitOrderItems(venueId!, venta.orderId, [queso.id], staffId)).rejects.toMatchObject(RECHAZO)
    await expect(splitOrderItems(venueId!, venta.orderId, [pan.id], staffId)).rejects.toMatchObject(RECHAZO)
    await expect(splitOrderBySeat(venueId!, venta.orderId, staffId)).rejects.toMatchObject(RECHAZO)
    await expect(mergeOrders(venueId!, venta.orderId, otra.orderId, staffId)).rejects.toMatchObject(RECHAZO)
    await expect(mergeOrders(venueId!, otra.orderId, venta.orderId, staffId)).rejects.toMatchObject(RECHAZO)

    expect(await fotoDeLaCuenta(venta)).toEqual(antes)

    // Mover la cuenta ENTERA de mesa no mueve renglones entre cuentas: no se bloquea, y sólo cambia la mesa.
    const mesa = await prisma.table.create({
      data: { venueId: venueId!, number: `R14-${++n}`, capacity: 2, qrCode: `qr-r14-${sello}-${n}` },
      select: { id: true },
    })
    await moveOrderToTable(venueId!, venta.orderId, mesa.id)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { tableId: true } })).toEqual({ tableId: mesa.id })
    const movida = await fotoDeLaCuenta(venta)
    expect({ ...movida, venta: { ...movida.venta, version: antes.venta.version } }).toEqual(antes)

    // Para pagar entre varios: abonos en la MISMA cuenta.
    const movimientosDelQueso = () => prisma.inventoryMovement.count({ where: { inventoryId: valeInventoryId } })
    const movimientosAntes = await movimientosDelQueso()
    await payCashOrder(venueId!, venta.orderId, { amount: 6000, tip: 0, staffId, idempotencyKey: `r14-abono-60-${sello}` })
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PARTIALLY_PAID)
    expect(await stockDe()).toEqual({ vale: 10, suelto: 10 })
    await payCashOrder(venueId!, venta.orderId, { amount: 4000, tip: 0, staffId, idempotencyKey: `r14-abono-40-${sello}` })

    expect(await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId }, select: { paymentStatus: true, status: true } })).toEqual({
      paymentStatus: 'PAID',
      status: 'COMPLETED',
    })
    expect(await estadoDeLaSesion(venta.sessionId)).toBe(AreaTicketCheckoutStatus.PAID)
    expect(await stockDe()).toEqual({ vale: 9, suelto: 9 })
    expect(await movimientosDelQueso()).toBe(movimientosAntes + 1)
    expect(
      (await prisma.areaTicketInventoryReservation.findFirstOrThrow({ where: { areaTicketId: venta.ticketId }, select: { status: true } }))
        .status,
    ).toBe('CONSUMED')
  })
})

/**
 * 🔴 S1 del efectivo sin red (U7 del diseño, 18-oct): la COLA del POS (`payCashOrder` con `isOfflineReplay`) reenvía efectivo cobrado
 * sin red sobre una venta de vales que otra caja YA cerró. Antes (medido): PAID ⇒ 400 «Order is already paid»; REFUNDED ⇒ 409
 * `ORDER_PAYMENT_CONFLICT` tras 3 intentos (la terminal: 409 `CHECKOUT_ORDER_NOT_PAYABLE`); el dinero quedaba fuera. Ahora se
 * registra por la rama de la venta cerrada (`reconcileCapturedPayment`): la venta conserva su estado con saldo 0, la sesión queda
 * PAID y el inventario NO se toca otra vez.
 */
describe('🔴 S1: la cola sin red del POS sobre una venta de vales ya cerrada', () => {
  const sobrepagos = async (orderId: string) => {
    for (let i = 0; i < 40; i++) {
      const c = await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'SOBREPAGO_DETECTADO' } })
      if (c > 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'SOBREPAGO_DETECTADO' } })
  }
  const alInicio = async () => {
    await prisma.areaTicketInventoryReservation.updateMany({
      where: { venueId, inventoryId: valeInventoryId, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    })
    await prisma.inventory.updateMany({ where: { id: { in: [valeInventoryId, sueltoInventoryId] } }, data: { currentStock: 10 } })
  }

  it('🔴 PAID: la terminal cobró los $100 por la sesión; la cola reenvía $100 ⇒ se registran, PAID/0, sesión PAID, sin doble descuento, 🚨 una vez (antes: 400)', async () => {
    await alInicio()
    const venta = await ventaDeVales()
    await cobroDeLaTerminal(venta.orderId, 100)
    const antes = await foto(venta)
    expect([
      antes.venta.paymentStatus,
      antes.sesion.status,
      antes.inventarios.map((i: { currentStock: string }) => i.currentStock),
    ]).toEqual(['PAID', 'PAID', ['9', '9']])

    const r = await payCashOrder(venueId!, venta.orderId, {
      amount: 10000,
      tip: 0,
      staffId,
      idempotencyKey: `s1-vales-paid-${sello}`,
      isOfflineReplay: true,
    })

    const despues = await foto(venta)
    expect(despues).toEqual({
      ...antes,
      venta: { ...antes.venta, paidAmount: '200', remainingBalance: '0' },
      pagos: antes.pagos + 1,
    })
    expect([r.amount, r.changeCents, r.orderPaymentStatus, r.remainingBalanceCents]).toEqual([10000, 0, 'PAID', 0])
    expect(await sobrepagos(venta.orderId)).toBe(1)
  })

  it('🔴 REFUNDED: la venta se cobró por la sesión y se devolvió entera; la cola reenvía $100 ⇒ se registran, sigue REFUNDED/0, sin volver a consumir (antes: 409 y se revertía)', async () => {
    await alInicio()
    const venta = await ventaDeVales()
    await cobroDeLaTerminal(venta.orderId, 100)
    const cobro = await prisma.payment.findFirstOrThrow({ where: { venueId, orderId: venta.orderId, status: 'COMPLETED' } })
    await issueRefund({
      venueId: venueId!,
      paymentId: cobro.id,
      amount: 10000,
      tipRefundCents: 0,
      reason: 'CUSTOMER_REQUEST' as never,
      staffId,
    })
    // Hoy un reembolso deja la venta PAID (no reabre); REFUNDED es como la dejaba el código viejo (R13-4) y la que el diseño cubre.
    await prisma.order.update({ where: { id: venta.orderId }, data: { paymentStatus: 'REFUNDED' } })
    const antes = await foto(venta)
    expect(antes.venta.paymentStatus).toBe('REFUNDED')

    const r = await payCashOrder(venueId!, venta.orderId, {
      amount: 10000,
      tip: 0,
      staffId,
      idempotencyKey: `s1-vales-refunded-${sello}`,
      isOfflineReplay: true,
    })

    const despues = await foto(venta)
    expect(despues).toEqual({
      ...antes,
      venta: { ...antes.venta, paidAmount: '200', remainingBalance: '0' },
      pagos: antes.pagos + 1,
      sesion: { status: 'PAID', activePaymentAttemptId: null },
    })
    expect([r.amount, r.changeCents, r.orderPaymentStatus]).toEqual([10000, 0, 'PAID'])
    expect(await sobrepagos(venta.orderId)).toBe(1)
  })

  it('🔴 la TERMINAL registra $100 capturados sobre esa venta de vales REFUNDED ⇒ se registran por la rama de la venta cerrada, sigue REFUNDED, sesión PAID, sin volver a consumir (antes: 409 `CHECKOUT_ORDER_NOT_PAYABLE` y a conciliación)', async () => {
    await alInicio()
    const venta = await ventaDeVales()
    await cobroDeLaTerminal(venta.orderId, 100)
    // Como la dejaba el código viejo (R13-4): hoy un reembolso deja la venta PAID.
    await prisma.order.update({ where: { id: venta.orderId }, data: { paymentStatus: 'REFUNDED' } })
    const antes = await foto(venta)

    const respuesta: any = await cobroDeLaTerminal(venta.orderId, 100)

    expect(respuesta.areaTicketCheckoutState).toBe('PAID')
    const despues = await foto(venta)
    expect(despues).toEqual({
      ...antes,
      venta: { ...antes.venta, paidAmount: '200', remainingBalance: '0' },
      pagos: antes.pagos + 1,
    })
  })

  it('control: el efectivo EN VIVO del POS sobre esa venta cerrada se sigue rechazando (la sesión, 409) antes de tomar el dinero', async () => {
    await alInicio()
    const venta = await ventaDeVales()
    await cobroDeLaTerminal(venta.orderId, 100)
    const antes = await foto(venta)
    await expect(
      payCashOrder(venueId!, venta.orderId, { amount: 10000, tip: 0, staffId, idempotencyKey: `s1-vales-vivo-${sello}` }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CHECKOUT_PAYMENT_NOT_ALLOWED' })
    expect(await foto(venta)).toEqual(antes)
  })
})

/**
 * 🔴 R2-3 (Codex sobre ceba0df1f, P2 R): S1 abrió la finalización de vales a una venta REFUNDED con dinero capturado. Si esa venta nunca
 * tuvo su primer saldado (sin vale SALE ni `paidAt` en sus vales), `recuperaSaldado` la da por primer saldado y la TERMINAL corría la
 * lealtad ORDINARIA: un sello EARN sobre una venta devuelta. Ahora, como la recuperación del Payment existente (R11-1), la lealtad
 * respeta los reembolsos.
 */
describe('🔴 R2-3: la TERMINAL cobra una venta de vales devuelta que nunca se saldó', () => {
  it('🔴 venta REFUNDED sin vale SALE ni paidAt, cliente ligado + un cobro NUEVO de $100 ⇒ se registra, la sesión cierra y el cliente NO queda con sello ni puntos (antes: sello EARN y puntos)', async () => {
    const x = await nuevoCliente('Cliente R2-3')
    const venta = await cobroAtorado(`r2-3-atorado-${sello}`, x)
    await issueRefund({
      venueId: venueId!,
      paymentId: venta.cobroId,
      amount: 10000,
      tipRefundCents: 0,
      reason: 'CUSTOMER_REQUEST' as never,
      staffId,
    })
    // Como la dejaba el código viejo (R13-4): hoy un reembolso deja la venta como estaba.
    await prisma.order.update({ where: { id: venta.orderId }, data: { paymentStatus: 'REFUNDED' } })
    await prisma.inventory.update({ where: { id: valeInventoryId }, data: { currentStock: 10 } })
    const [vales, pagados] = await Promise.all([
      prisma.inventoryPosting.count({ where: { venueId, sourceKind: 'ORDER', sourceId: venta.orderId, effectKind: 'SALE' } }),
      prisma.areaTicket.count({ where: { id: venta.ticketId, paidAt: { not: null } } }),
    ])
    expect([vales, pagados]).toEqual([0, 0])

    const nuevo: any = await cobroDeLaTerminal(venta.orderId, 100)

    expect(nuevo.areaTicketCheckoutState).toBe('PAID')
    expect(await prisma.payment.count({ where: { orderId: venta.orderId, status: 'COMPLETED', type: { not: 'REFUND' } } })).toBe(2)
    const { sellos, revertidos, puntos } = await lealtadDe(venta.orderId, x)
    expect(sellos - revertidos).toBe(0)
    expect(puntos).toBe(0)
  })
})
