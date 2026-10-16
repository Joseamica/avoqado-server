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
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { updatePayment } from '@/services/dashboard/payment.dashboard.service'
import { markAreaTicketPaymentForReconciliation, reconcileOrderFromPayments, recordOrderPayment } from '@/services/tpv/payment.tpv.service'
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
      // Precondiciones: el pago manual ya descontó los dos renglones (vale + suelto) con su vale de inventario; R10-2: y soltó la
      // reserva del vale en esa misma transacción (antes se quedaba ACTIVE para siempre).
      expect(antes.inventarios.map((i: { currentStock: string }) => i.currentStock).sort()).toEqual(['9', '9'])
      expect(antes.reservas).toEqual([{ status: 'RELEASED' }])
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
        findCandidates: async opts => (await findPaidButOpenOrders(prisma, opts)).filter(c => c.id === venta.orderId),
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
