/**
 * S9 (P2-5) contra Postgres REAL: al anular un folio, lo que la clienta usó en él regresa al instante y su fila se queda como cortesía
 * del mismo importe; si después llega dinero que ya se había cobrado, la cuenta lo salda con la aritmética de hoy, al precio que ella
 * vio. Un folio de $219 con $85 de beneficio vale $134. Cada caso es un camino de dinero del mapa P2-9 del diseño.
 *
 * Proveedores simulados (Stripe, Wallet, sockets, avisos); todo lo demás —candados, cobros, cola sin red, pago manual, cripto, saldo
 * de tarjeta de regalo— es el código real. Sin limpieza del negocio: la libreta de tarjetas de regalo es de sólo inserción y sus sobres
 * apuntan al negocio (como las suites de tarjetas, `sembrarTarjetasDeRegalo.ts`); se limpian sus cuentas y lo borrable.
 */
import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { expireOnlineOrder, cancelOnlineOrderByCustomer } from '@/services/online-ordering/transitions.service'
import { cerrarFoliosDelDiaTerminado, syncPaidClosedFolios } from '@/services/online-ordering/folios.service'
import { cerrarCanceladasReleyendo } from '@/services/online-ordering/cancelledOrderSync'
import { OnlineOrderAcceptanceExpiryJob } from '@/jobs/online-order-acceptance-expiry.job'
import { settleOrder, updateOrder } from '@/services/dashboard/order.dashboard.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import * as inventario from '@/services/inventory/inventoryPosting.service'
import { emitOnlineOrderUpdated } from '@/services/online-ordering/traySocket'
import { notifyOrderEvent } from '@/services/online-ordering/notifications.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { MOTIVO_BENEFICIO_REGRESADO } from '@/services/online-ordering/cortesiaDeFolio'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { applyAutomaticDiscounts } from '@/services/dashboard/discountEngine.service'
import { initiateCryptoPayment, processWebhook } from '@/services/b4bit/b4bit.service'
import {
  payCashOrder,
  payGiftCardBalanceOnOrder,
  removeOrderDiscount,
  returnGiftBalanceAndCancelOrder,
} from '@/services/mobile/order.mobile.service'
import { addItemsToOrder, voidItems } from '@/services/tpv/order.tpv.service'
import { aplicarReasignacion, type CobroFoto, type DepsAplicar, type OrdenFoto } from '@/services/shared/reasignarCobro'
import { recordOrderPayment, settleStandalonePaymentInTx } from '@/services/tpv/payment.tpv.service'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { notifyCustomerPassUpdated } from '@/services/wallet/notifyPassUpdated.service'
import { limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: {
    getServer: jest.fn(() => ({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })),
    getBroadcastingService: jest.fn(() => null),
    broadcastToVenue: jest.fn(),
    broadcastToUser: jest.fn(),
  },
  default: {
    getServer: jest.fn(() => ({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })),
    getBroadcastingService: jest.fn(() => null),
    broadcastToVenue: jest.fn(),
    broadcastToUser: jest.fn(),
  },
}))
// S9 v5 (T2): el cobro en efectivo de la terminal entra por `recordOrderPayment` con una terminal del negocio.
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn(async () => null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn(async () => ({ notified: 0 })),
  reintentarAvisosDeTarjeta: jest.fn().mockResolvedValue({ avisados: 0, fallidos: 0, ocupados: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(),
}))
jest.mock('@/services/online-ordering/notifications.service', () => ({ notifyOrderEvent: jest.fn() }))
// S9 (Codex r2, G3): el evento en vivo de la bandeja, para contar las publicaciones de después del commit.
jest.mock('@/services/online-ordering/traySocket', () => ({
  ...jest.requireActual('@/services/online-ordering/traySocket'),
  emitOnlineOrderUpdated: jest.fn(),
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
// La tarjeta en línea: Stripe simulado (la liberación de una tarjeta apartada al cancelar).
jest.mock('@/services/payments/provider-registry', () => ({
  getProvider: () => {
    const estado = (pi: string) => ({
      sessionStatus: null,
      paymentIntentId: pi,
      piStatus: 'canceled',
      amountCapturableCents: 0,
      amountReceivedCents: 0,
      captureBefore: null,
      card: { brand: 'visa', last4: '4242', funding: 'credit' },
      paymentMethodType: 'card',
    })
    return {
      capture: async (_m: unknown, a: any) => estado(a.paymentIntentId),
      voidAuthorization: async (_m: unknown, a: any) => estado(a.paymentIntentId),
      getAuthorization: async (_m: unknown, a: any) => estado(a.paymentIntentId),
    }
  },
}))

jest.setTimeout(90_000)

const RUN = Date.now()
const SERIAL = `AVQD-N86S9${String(RUN).slice(-6)}`
const D = (v: number | string) => new Prisma.Decimal(v)
let orgId: string
let venueId: string
let staffId: string
let productId: string
let extraId: string
let merchantId: string
let ciclo = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `s9-${RUN}`, email: `s9-${RUN}@example.test`, phone: '5550000000' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `s9-${RUN}`, slug: `itest-s9-${RUN}`, status: 'LIVE_DEMO', timezone: 'America/Mexico_City' },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `s9-${RUN}@staff.test`, firstName: 'Gerente', lastName: 'S9', venues: { create: { venueId, role: 'MANAGER' } } },
    })
  ).id
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Menú', slug: `menu-${RUN}` } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: categoria.id, name: 'Combo', sku: `S9-C-${RUN}`, price: 219 } }))
    .id
  extraId = (await prisma.product.create({ data: { venueId, categoryId: categoria.id, name: 'Galleta', sku: `S9-G-${RUN}`, price: 30 } }))
    .id
  await prisma.terminal.create({ data: { venueId, name: 'N86 S9', serialNumber: SERIAL, type: 'TPV_ANDROID' } })
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000] } })
  await ensureGiftCardTender(prisma, venueId)
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: 'STRIPE_CONNECT' },
    update: {},
    create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  merchantId = (
    await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: `s9-${RUN}`,
        contactEmail: `s9-${RUN}@example.test`,
        publicKey: cuid(),
        secretKeyHash: cuid(),
        providerId: proveedor.id,
        providerCredentials: { connectAccountId: 'acct_test' },
      },
    })
  ).id
})

afterAll(async () => {
  if (!venueId) return
  await prisma.onlineOrderCharge.deleteMany({ where: { venueId } })
  await prisma.inventoryPosting.deleteMany({ where: { venueId } })
  await prisma.commissionCalculation.deleteMany({ where: { venueId } })
  await prisma.venueTransaction.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await limpiarNegocioDePrueba(venueId) // bandeja de Wallet, efectos, asignaciones y cuentas (con sus cobros y renglones)
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.couponCode.deleteMany({ where: { discount: { venueId } } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.notification.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
})

// ── siembra ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Beneficio = 'premio' | 'puntos' | 'cupon' | 'descuento' | 'veinte'
interface Folio {
  orderId: string
  customerId: string
  filaId: string
  trackingToken: string
  premioId?: string
  discountId?: string
  couponCodeId?: string
}

async function cliente(puntos = 0) {
  return prisma.customer.create({ data: { venueId, firstName: 'Ana', loyaltyPoints: puntos } })
}

/**
 * Un folio por pagar de $219 con un beneficio ya aplicado (así lo deja la creación del folio, S10/S11). `vencido` = su plazo ya pasó.
 * `veinte` es un 20 % del catálogo con límite por clienta (de $219 = $43.80); los demás valen $85.
 */
async function folio(
  beneficio: Beneficio,
  o: { vencido?: boolean; plazo?: Date; tarjeta?: boolean; miEquipo?: boolean; pagado?: { cobro: number; devuelto?: number } } = {},
): Promise<Folio> {
  const c = await cliente(beneficio === 'puntos' ? 150 : 0)
  const monto = beneficio === 'veinte' ? D('43.80') : D(85)
  const total = D(219).minus(monto)
  const pagado = o.pagado ? D(o.pagado.cobro) : D(0)
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `S9${RUN}${++ciclo}`,
      source: 'WEB',
      type: 'PICKUP',
      customerId: c.id,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 219,
      discountAmount: monto,
      taxAmount: 0,
      total,
      paidAmount: pagado,
      remainingBalance: total.minus(pagado),
      createdById: staffId,
      status: 'PENDING',
      paymentStatus: o.pagado ? 'PARTIAL' : 'PENDING',
      orderCustomers: { create: { customerId: c.id, isPrimary: true } },
      items: { create: [{ productId, productName: 'Combo', quantity: 1, unitPrice: 219, taxAmount: 0, total: 219 }] },
    },
  })
  const fila: Prisma.OrderDiscountUncheckedCreateInput = {
    orderId: order.id,
    type: beneficio === 'veinte' ? 'PERCENTAGE' : 'FIXED_AMOUNT',
    name: beneficio,
    value: beneficio === 'veinte' ? 20 : 85,
    amount: monto,
    taxReduction: D('11.72'),
  }
  const r: Partial<Folio> = { orderId: order.id, customerId: c.id }
  if (beneficio === 'premio') {
    const card = await prisma.stampCard.create({
      data: { customerId: c.id, venueId, cycle: 1, stampsRequired: 7, stampsEarned: 7, completedAt: new Date() },
    })
    const od = await prisma.orderDiscount.create({ data: fila })
    r.premioId = (
      await prisma.stampReward.create({
        data: {
          stampCardId: card.id,
          customerId: c.id,
          venueId,
          rewardType: 'FIXED_AMOUNT',
          rewardValue: 85,
          rewardLabel: 'Combo gratis',
          status: 'REDEEMED',
          redeemedAt: new Date(),
          orderDiscountId: od.id,
        },
      })
    ).id
    r.filaId = od.id
  } else if (beneficio === 'puntos') {
    const lt = await prisma.loyaltyTransaction.create({ data: { customerId: c.id, type: 'REDEEM', points: -850, orderId: order.id } })
    r.filaId = (await prisma.orderDiscount.create({ data: { ...fila, loyaltyTransactionId: lt.id } })).id
  } else {
    const d = await prisma.discount.create({
      data: {
        venueId,
        name: `${beneficio}-${ciclo}`,
        type: beneficio === 'veinte' ? 'PERCENTAGE' : 'FIXED_AMOUNT',
        value: beneficio === 'veinte' ? 20 : 85,
        scope: 'ORDER',
        isAutomatic: beneficio === 'descuento',
        active: true,
        ...(beneficio === 'descuento' ? { maxTotalUses: 1, currentUses: 1 } : {}),
        ...(beneficio === 'cupon' ? { maxTotalUses: 1, currentUses: 0 } : {}),
        ...(beneficio === 'veinte' ? { maxUsesPerCustomer: 1, currentUses: 1 } : {}),
      },
    })
    r.discountId = d.id
    if (beneficio === 'cupon') {
      r.couponCodeId = (await prisma.couponCode.create({ data: { discountId: d.id, code: `S9-${RUN}-${ciclo}`, maxUses: 1 } })).id
    }
    r.filaId = (
      await prisma.orderDiscount.create({
        data: { ...fila, discountId: d.id, couponCodeId: r.couponCodeId ?? null, isAutomatic: beneficio === 'descuento' },
      })
    ).id
  }
  if (o.pagado) {
    await cobro(order.id, o.pagado.cobro)
    if (o.pagado.devuelto) await cobro(order.id, -o.pagado.devuelto, 'REFUND')
  }
  r.trackingToken = cuid()
  const online = await prisma.onlineOrder.create({
    data: {
      venueId,
      orderId: order.id,
      trackingToken: r.trackingToken,
      paymentMode: o.tarjeta ? 'CARD_ONLINE' : 'PAY_AT_PICKUP',
      requiresAcceptance: o.tarjeta === true || o.miEquipo === true,
      status: 'PENDING_ACCEPTANCE',
      acceptDeadlineAt: o.plazo ?? new Date(Date.now() + (o.vencido ? -60_000 : 30 * 60_000)),
    },
  })
  if (o.tarjeta)
    await prisma.onlineOrderCharge.create({
      data: {
        venueId,
        onlineOrderId: online.id,
        ecommerceMerchantId: merchantId,
        idempotencyKey: cuid(),
        trackingToken: cuid(),
        customerPhone: '+525555000000',
        request: {},
        requestHash: cuid(),
        checkoutExpiresAt: new Date(Date.now() + 30 * 60_000),
        platformFeeBps: 0,
        applicationFeeCents: 0,
        amount: total,
        paymentIntentId: `pi_${cuid()}`,
        status: 'AUTHORIZED',
        merchantSnapshot: { connectAccountId: 'acct_test', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
      },
    })
  return r as Folio
}

/** Un cobro COMPLETED sembrado (o su reembolso: importe negativo y `type: REFUND`). */
function cobro(orderId: string, monto: number, type: 'REGULAR' | 'REFUND' = 'REGULAR') {
  return prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: monto,
      tipAmount: 0,
      method: 'CASH',
      source: 'TPV',
      status: 'COMPLETED',
      type,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: monto,
      processedById: staffId,
    },
  })
}

/** El efectivo de la cola sin red (la cobranza que el aparato ya hizo y sube después). */
async function efectivoSinRed(orderId: string, pesos: number, cobradoEn = new Date(Date.now() - 60_000)) {
  const intent = {
    id: cuid(),
    type: 'PAY_CASH' as const,
    createdAtLocal: cobradoEn.getTime(),
    payload: { orderId, amountCents: pesos * 100, tipCents: 0 },
  }
  const [ack] = await processIntents({ venueId, staffId, deviceId: cuid(), intents: [intent], authorizeIntent: () => true })
  expect(ack.status).toBe('ACKED')
}

const cuenta = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { orderDiscounts: true, onlineOrder: true } })
const fila = (id: string) => prisma.orderDiscount.findUniqueOrThrow({ where: { id } })
const netoCobrado = async (orderId: string) =>
  (await prisma.payment.aggregate({ where: { orderId, status: 'COMPLETED' }, _sum: { amount: true } }))._sum.amount!.toFixed(2)
const avisos = (orderId: string) => prisma.notification.findMany({ where: { venueId, entityId: orderId }, take: 10 })

/** La cortesía: mismo importe, IVA y reparto; importe fijo y sin enlaces. */
async function esCortesia(id: string, monto: string) {
  expect(await fila(id)).toMatchObject({
    isComp: true,
    compReason: MOTIVO_BENEFICIO_REGRESADO,
    type: 'FIXED_AMOUNT',
    value: D(monto),
    amount: D(monto),
    taxReduction: D('11.72'),
    discountId: null,
    couponCodeId: null,
    loyaltyTransactionId: null,
  })
}

async function esperarA(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 20))
}

const TZ = 'America/Mexico_City'
/** El corte de las 04:00 (zona del negocio) más reciente que ya pasó. */
function corteDelDia(ahora: Date): Date {
  const hoy = fromZonedTime(`${formatInTimeZone(ahora, TZ, 'yyyy-MM-dd')}T04:00:00.000`, TZ)
  return hoy.getTime() <= ahora.getTime()
    ? hoy
    : fromZonedTime(`${formatInTimeZone(new Date(ahora.getTime() - 86_400_000), TZ, 'yyyy-MM-dd')}T04:00:00.000`, TZ)
}

async function fotoDeOrden(id: string): Promise<OrdenFoto> {
  const o = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: {
      payments: { where: { status: 'COMPLETED' }, select: { id: true, status: true, type: true, amount: true, tipAmount: true }, take: 10 },
      items: { select: { areaTicketLineId: true, giftCardId: true }, take: 10 },
      onlineOrder: { select: { id: true } },
    },
  })
  return { ...o, cobros: o.payments, pedidoEnLinea: o.onlineOrder !== null }
}
async function fotoDeCobro(id: string): Promise<CobroFoto> {
  const p = await prisma.payment.findUniqueOrThrow({ where: { id }, include: { tenderType: { select: { systemKind: true } } } })
  return { ...p, orderId: p.orderId!, tenderSystemKind: p.tenderType?.systemKind ?? null }
}
/** Las MISMAS dependencias que `scripts/reasignar-cobro-a-su-orden.ts` (candado, cierre con `settleStandalonePaymentInTx`, bitácora). */
const depsDelScript = (): DepsAplicar => ({
  enTransaccion: fn =>
    withDeadlockRetry(
      tx =>
        fn({
          bloquear: async ids => {
            for (const id of ids) if (!(await lockExistingOrderForPayment(tx, { venueId, orderId: id }))) throw new Error(`orden ${id}`)
          },
          releer: async antes => ({
            cobro: { ...antes.cobro, ...(await tx.payment.findUniqueOrThrow({ where: { id: antes.cobro.id } })), tenderSystemKind: null },
            origen: { ...antes.origen, ...(await tx.order.findUniqueOrThrow({ where: { id: antes.origen.id } })) },
            destino: { ...antes.destino, ...(await tx.order.findUniqueOrThrow({ where: { id: antes.destino.id } })) },
          }),
          moverCobro: async (paymentId, de, a) =>
            (await tx.payment.updateMany({ where: { id: paymentId, orderId: de, status: 'COMPLETED' }, data: { orderId: a } })).count,
          prepararDestino: async (ordenId, data) => {
            await tx.order.update({ where: { id: ordenId }, data })
          },
          guardarTotales: async (ordenId, c, conEfectos) => {
            const pago = c
              ? { id: c.id, amount: D((c.amount ?? 0).toString()), tipAmount: D((c.tipAmount ?? 0).toString()) }
              : { amount: D(0), tipAmount: D(0) }
            await settleStandalonePaymentInTx(tx, venueId, ordenId, pago, undefined, false, conEfectos)
          },
          fijarCompletadoEn: async (id, cuando) => {
            await tx.order.update({ where: { id }, data: { completedAt: cuando } })
          },
          bitacora: async p => {
            await tx.activityLog.create({
              data: { staffId: null, venueId: p.venueId, action: p.action, entity: p.entity, entityId: p.entityId, data: p.data as any },
            })
          },
        }),
      { etiqueta: 'reasignarCobroAsuOrden', ...ORDER_LOCK_WAIT_BUDGET },
    ),
  liberarMesa: async () => undefined,
})

const AVISO_CON_CORTESIA = (n: string, monto: string) =>
  `Pedido #${n}: se cobró después de vencer y se respetó su precio; su beneficio de $${monto} ya había regresado a la clienta.`

/**
 * G3: las tres publicaciones de después del commit que acompañan a un folio que pasa a «Por entregar» (evento en vivo, aviso a la
 * clienta y bitácora `ONLINE_ORDER_ACCEPTED` por `logAction`, que la preparación de integración ya simula).
 */
async function publicaciones(orderId: string) {
  const online = await prisma.onlineOrder.findUniqueOrThrow({ where: { orderId } })
  return {
    enVivo: (emitOnlineOrderUpdated as jest.Mock).mock.calls.filter(([e]) => e.orderId === orderId && e.onlineStatus === 'ACCEPTED').length,
    clienta: (notifyOrderEvent as jest.Mock).mock.calls.filter(([id, evento]) => id === orderId && evento === 'ACCEPTED').length,
    bitacora: (logAction as jest.Mock).mock.calls.filter(([p]) => p.action === 'ONLINE_ORDER_ACCEPTED' && p.entityId === online.id).length,
  }
}

/** G2: cómo termina un folio que recibió dinero, sin lo que cambia de un folio a otro (ids, folio, fechas). */
async function finalDe(orderId: string) {
  const o = await cuenta(orderId)
  return {
    cuenta: [o.status, o.paymentStatus, o.total.toFixed(2), o.remainingBalance.toFixed(2)],
    pedido: o.onlineOrder?.status,
    avisos: (await avisos(orderId)).map(a => a.message.replace(o.orderNumber, 'N')),
    reaperturas: await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } }),
    cobradoTarde: await prisma.activityLog.count({
      where: { venueId, entityId: o.onlineOrder!.id, action: 'ONLINE_ORDER_COLLECTED_AFTER_CANCEL' },
    }),
    publicaciones: await publicaciones(orderId),
  }
}

/** Un cobro de `pesos` que quedó por error en otra cuenta ya saldada, reasignado a `orderId` por el camino completo del script. */
async function reasignarA(orderId: string, pesos: number) {
  const origen = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `S9-orig-${RUN}-${++ciclo}`,
      subtotal: 50,
      taxAmount: 0,
      total: 50,
      paidAmount: 50,
      remainingBalance: 0,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
  })
  await cobro(origen.id, 50)
  const ajeno = await cobro(origen.id, pesos)
  const destino = await fotoDeOrden(orderId)
  const r = await aplicarReasignacion(
    depsDelScript(),
    { paymentId: ajeno.id, deOrden: origen.orderNumber, aOrden: destino.orderNumber, motivo: 'S9' },
    await fotoDeCobro(ajeno.id),
    await fotoDeOrden(origen.id),
    destino,
  )
  expect(r).toMatchObject({ ok: true, resumen: { destinoCambiaEstado: true } })
  const ori = await cuenta(origen.id)
  expect([ori.paymentStatus, ori.remainingBalance.toFixed(2)]).toEqual(['PAID', '0.00'])
}

/** S9 v5: el texto D2, cuando el dinero llega y la cuenta sigue cancelada (el cripto no la reabre). */
const AVISO_D2 = (n: string, monto: string) =>
  `Pedido #${n}: llegó un cobro después de cancelarse y la cuenta sigue cancelada; su beneficio de $${monto} ya había regresado a la clienta. Decide si lo devuelves o reabres la cuenta.`

/** La pasada completa del trabajo de cada 30 s, con sus dependencias reales (sin cron). */
const trabajo = new OnlineOrderAcceptanceExpiryJob({ cron: { start: jest.fn(), stop: jest.fn() } as never })
const pasada = () => trabajo.checkNow()

/** Un folio R44 (su abono de $100 se devolvió completo) que venció hace 8 días: fuera de la ventana de 7 del barrido. */
async function r44Viejo() {
  const f = await folio('premio', { vencido: true, pagado: { cobro: 100, devuelto: 100 } })
  await expireOnlineOrder({ venueId, orderId: f.orderId })
  expect((await cuenta(f.orderId)).status).toBe('PENDING')
  const hace8 = new Date(Date.now() - 8 * 24 * 3_600_000)
  await prisma.onlineOrder.update({ where: { orderId: f.orderId }, data: { expiredAt: hace8, updatedAt: hace8 } })
  return f
}

/** Un Payment cripto ya PENDING (S9 bloquea un inicio nuevo sobre un folio, pero su confirmación tardía no se pierde). */
function pendienteCripto(orderId: string, pesos: number) {
  return prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: pesos,
      tipAmount: 0,
      method: 'CRYPTOCURRENCY',
      source: 'TPV',
      status: 'PENDING',
      type: 'FAST',
      processor: 'B4BIT',
      processedById: staffId,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: pesos,
    },
  })
}
const confirmarCripto = (id: string, pesos: number) =>
  processWebhook({
    identifier: cuid(),
    reference: id,
    fiat_amount: pesos,
    fiat_currency: 'MXN',
    crypto_amount: '0.001',
    currency: 'BTC',
    status: 'CO',
    tx_hash: `tx-${id}`,
    confirmations: 3,
  })

/** El efectivo de la terminal del negocio (`recordOrderPayment` → `settleStandalonePaymentInTx`). */
const efectivoDeLaTpv = (orderId: string, pesos: number) =>
  recordOrderPayment(
    venueId,
    orderId,
    {
      venueId,
      amount: pesos * 100,
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      source: 'TPV',
      splitType: 'FULLPAYMENT',
      staffId,
      idempotencyKey: cuid(),
      paidProductsId: [],
      currency: 'MXN',
      isInternational: false,
      deviceSerialNumber: SERIAL,
      authenticatedTerminalSerial: SERIAL,
    } as any,
    staffId,
  )

/** T2: los caminos que dejan dinero en la cuenta de un folio (A1). La reasignación a una R44 no la admite su validación (informe). */
const CAMINOS = [
  'efectivo sin red',
  'POS en vivo',
  'terminal',
  'saldo de regalo',
  'pago manual',
  'Liquidar saldo',
  'Liquidar todo',
  'cripto',
] as const
async function pagar(camino: (typeof CAMINOS)[number], f: Folio, pesos: number) {
  switch (camino) {
    case 'efectivo sin red':
      return efectivoSinRed(f.orderId, pesos)
    case 'POS en vivo':
      return payCashOrder(venueId, f.orderId, { amount: pesos * 100, tip: 0, staffId, idempotencyKey: cuid() })
    case 'terminal':
      return efectivoDeLaTpv(f.orderId, pesos)
    case 'saldo de regalo': {
      const t = await tarjeta(500)
      return payGiftCardBalanceOnOrder(venueId, f.orderId, {
        idempotencyKey: cuid(),
        proof: { kind: 'CODE', code: t.codigo } as any,
        amount: D(pesos),
        tip: D(0),
        staffId,
        deviceId: null,
      })
    }
    case 'pago manual':
      return createManualPayment(venueId, staffId, {
        orderId: f.orderId,
        amount: pesos.toFixed(2),
        tipAmount: '0',
        method: 'BANK_TRANSFER',
        source: 'OTHER',
      })
    case 'Liquidar saldo':
      return settleOrder(venueId, f.orderId, undefined, staffId)
    case 'Liquidar todo':
      return settleCustomerBalance(venueId, f.customerId, undefined, staffId)
    case 'cripto': {
      const p = await pendienteCripto(f.orderId, pesos)
      return confirmarCripto(p.id, pesos)
    }
  }
}

/** Un folio «Nadie» vencido de $219 sin beneficios (T10). */
async function folioSinBeneficio(): Promise<Folio> {
  const c = await cliente()
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `S9${RUN}${++ciclo}`,
      source: 'WEB',
      type: 'PICKUP',
      customerId: c.id,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 219,
      taxAmount: 0,
      total: 219,
      remainingBalance: 219,
      createdById: staffId,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      items: { create: [{ productId, productName: 'Combo', quantity: 1, unitPrice: 219, taxAmount: 0, total: 219 }] },
    },
  })
  const trackingToken = cuid()
  await prisma.onlineOrder.create({
    data: {
      venueId,
      orderId: order.id,
      trackingToken,
      paymentMode: 'PAY_AT_PICKUP',
      requiresAcceptance: false,
      status: 'PENDING_ACCEPTANCE',
      acceptDeadlineAt: new Date(Date.now() - 60_000),
    },
  })
  return { orderId: order.id, customerId: c.id, filaId: '', trackingToken }
}

beforeEach(() => (notifyCustomerPassUpdated as jest.Mock).mockClear())

// ── los caminos de dinero (P2-9) ──────────────────────────────────────────────────────────────────────────────────────────
describe('S9 · anular un folio regresa sus beneficios y su fila queda como cortesía', () => {
  it('folio con premio vence ⇒ el premio regresa y la cuenta sigue en $134', async () => {
    const f = await folio('premio', { vencido: true })

    await expect(expireOnlineOrder({ venueId, orderId: f.orderId })).resolves.toEqual({ outcome: 'OK', status: 'EXPIRED' })

    const o = await cuenta(f.orderId)
    expect([o.status, o.total.toFixed(2), o.discountAmount.toFixed(2)]).toEqual(['CANCELLED', '134.00', '85.00'])
    await esCortesia(f.filaId, '85.00')
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: f.premioId } })).toMatchObject({
      status: 'PENDING',
      orderDiscountId: null,
      redeemedAt: null,
    })
    expect(await prisma.walletPassOutbox.count({ where: { venueId, customerId: f.customerId, motivo: 'PREMIO_DEVUELTO' } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: f.orderId, action: 'ONLINE_ORDER_BENEFITS_RETURNED' } })).toBe(1)
    // Tras el commit se despierta el pase de la clienta.
    await esperarA(() => (notifyCustomerPassUpdated as jest.Mock).mock.calls.length > 0)
    expect(notifyCustomerPassUpdated).toHaveBeenCalledWith(venueId, f.customerId)
  })

  it('puntos: vuelven a su saldo una sola vez, aunque otra vía intente anular otra vez', async () => {
    const f = await folio('puntos', { vencido: true })
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    await expireOnlineOrder({ venueId, orderId: f.orderId }) // la siguiente pasada del trabajo: STALE, nada se devuelve otra vez
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: f.customerId } })).loyaltyPoints).toBe(1000)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: f.orderId, type: 'ADJUST' } })).toBe(1)
    await esCortesia(f.filaId, '85.00')
  })

  it('descuento automático con un solo uso ⇒ otro cliente lo usa', async () => {
    const f = await folio('descuento', { vencido: true })
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: f.discountId } })).currentUses).toBe(0)
    await esCortesia(f.filaId, '85.00')

    const otro = await cliente()
    const venta = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `S9-otra-${RUN}-${++ciclo}`,
        customerId: otro.id,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 219,
        taxAmount: 0,
        total: 219,
        remainingBalance: 219,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        items: { create: [{ productId, productName: 'Combo', quantity: 1, unitPrice: 219, taxAmount: 0, total: 219 }] },
      },
    })
    const r = await applyAutomaticDiscounts(venta.id, undefined, venueId)
    expect(r.applied.map(a => a.discountId)).toContain(f.discountId)
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: f.discountId } })).currentUses).toBe(1)
  })

  it('efectivo sin red cruza el vencimiento y las 04:00 ⇒ saldado a $134 y aviso, cada fecha en su día del negocio', async () => {
    // El corte del día del negocio más reciente (04:00 en la zona del negocio). El folio vence y el efectivo se cobra ANTES de él
    // (día de ayer), y la cola sube DESPUÉS (día de hoy).
    const corte = corteDelDia(new Date())
    const f = await folio('premio', { plazo: new Date(corte.getTime() - 20 * 60_000) })
    await expect(expireOnlineOrder({ venueId, orderId: f.orderId, now: new Date(corte.getTime() - 10 * 60_000) })).resolves.toEqual({
      outcome: 'OK',
      status: 'EXPIRED',
    })
    expect((await cuenta(f.orderId)).status).toBe('CANCELLED')

    await efectivoSinRed(f.orderId, 134, new Date(corte.getTime() - 5 * 60_000))

    const pagado = await cuenta(f.orderId)
    expect([pagado.status, pagado.paymentStatus, pagado.total.toFixed(2), pagado.remainingBalance.toFixed(2)]).toEqual([
      'COMPLETED',
      'PAID',
      '134.00',
      '0.00',
    ])
    // G3 (Codex r2): el dinero no lo mueve; lo pasa a «Por entregar» el barrido, que publica después del commit.
    expect(pagado.onlineOrder?.status).toBe('EXPIRED')
    await syncPaidClosedFolios({ venueId }, () => new Date())
    const o = await cuenta(f.orderId)
    expect(o.onlineOrder?.status).toBe('ACCEPTED') // «Por entregar»
    expect(await publicaciones(f.orderId)).toEqual({ enVivo: 1, clienta: 1, bitacora: 1 })
    expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(o.orderNumber, '85.00')])
    // El premio ya regresó: el cobro tardío no lo vuelve a gastar ni a ligar.
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: f.premioId } })).toMatchObject({
      status: 'PENDING',
      orderDiscountId: null,
    })
    // Las fechas, a cada lado del corte: venció ayer; la venta (lealtad) es de ayer; el cobro se registró hoy (al subir la cola) y el
    // folio entró hoy a «Por entregar».
    const diaDe = (d: Date | null | undefined) => d && formatInTimeZone(new Date(d.getTime() - 4 * 3_600_000), TZ, 'yyyy-MM-dd')
    const ayer = diaDe(new Date(corte.getTime() - 1))
    const hoy = diaDe(corte)
    expect(diaDe(o.onlineOrder!.expiredAt)).toBe(ayer)
    expect(diaDe(o.loyaltySaleAt)).toBe(ayer)
    const pago = await prisma.payment.findFirstOrThrow({ where: { orderId: f.orderId, status: 'COMPLETED' } })
    expect(diaDe(pago.createdAt)).toBe(hoy)
    expect(diaDe(o.onlineOrder!.acceptedAt)).toBe(hoy)

    // El cierre de HOY no lo saca de «Por entregar» (entró hoy); el del día siguiente sí, y la cuenta sigue saldada al mismo precio.
    await cerrarFoliosDelDiaTerminado({ venueId }, () => new Date())
    expect((await cuenta(f.orderId)).onlineOrder?.status).toBe('ACCEPTED')
    await cerrarFoliosDelDiaTerminado({ venueId }, () => new Date(corte.getTime() + 24 * 3_600_000 + 60_000))
    const despues = await cuenta(f.orderId)
    expect(despues.onlineOrder?.status).toBe('COMPLETED')
    expect([despues.paymentStatus, despues.total.toFixed(2)]).toEqual(['PAID', '134.00'])
    expect(await netoCobrado(f.orderId)).toBe('134.00')
  })

  it('P1 (Codex r1): descuento limitado de $85, anular, $20 tardíos y «aplicar automáticos» ⇒ una sola rebaja y el uso no vuelve a subir', async () => {
    const f = await folio('descuento', { vencido: true })
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: f.discountId } })).currentUses).toBe(0)
    await efectivoSinRed(f.orderId, 20)
    expect((await cuenta(f.orderId)).status).toBe('PENDING') // revivida, debe $114

    const r = await applyAutomaticDiscounts(f.orderId, undefined, venueId)

    expect(r.applied).toEqual([])
    const o = await cuenta(f.orderId)
    expect([o.total.toFixed(2), o.discountAmount.toFixed(2), o.remainingBalance.toFixed(2)]).toEqual(['134.00', '85.00', '114.00'])
    expect(o.orderDiscounts).toHaveLength(1)
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: f.discountId } })).currentUses).toBe(0)
  })

  it('$50 sin red + $84 de pago manual ⇒ saldado', async () => {
    const f = await folio('premio', { vencido: true })
    await expireOnlineOrder({ venueId, orderId: f.orderId })

    await efectivoSinRed(f.orderId, 50)
    const parcial = await cuenta(f.orderId)
    expect([parcial.status, parcial.paymentStatus, parcial.remainingBalance.toFixed(2)]).toEqual(['PENDING', 'PARTIAL', '84.00'])

    await createManualPayment(venueId, staffId, {
      orderId: f.orderId,
      amount: '84.00',
      tipAmount: '0',
      method: 'BANK_TRANSFER',
      source: 'OTHER',
    })

    const o = await cuenta(f.orderId)
    expect([o.paymentStatus, o.remainingBalance.toFixed(2)]).toEqual(['PAID', '0.00'])
    expect(await netoCobrado(f.orderId)).toBe('134.00')
  })

  it('transferencia tardía como primer dinero ⇒ el pago manual la admite', async () => {
    const f = await folio('premio', { vencido: true })
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    expect((await cuenta(f.orderId)).status).toBe('CANCELLED')

    await createManualPayment(venueId, staffId, {
      orderId: f.orderId,
      amount: '134.00',
      tipAmount: '0',
      method: 'BANK_TRANSFER',
      source: 'OTHER',
    })

    expect((await cuenta(f.orderId)).onlineOrder?.status).toBe('EXPIRED') // G3: lo pasa el barrido
    await syncPaidClosedFolios({ venueId }, () => new Date())
    const o = await cuenta(f.orderId)
    expect([o.status, o.paymentStatus, o.total.toFixed(2)]).toEqual(['COMPLETED', 'PAID', '134.00'])
    expect(o.onlineOrder?.status).toBe('ACCEPTED')
    expect(await prisma.activityLog.count({ where: { venueId, entityId: f.orderId, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } })).toBe(
      1,
    )
    expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(o.orderNumber, '85.00')])
  })

  it('el pago manual sobre otra cuenta cancelada sigue rechazado (400 como hoy)', async () => {
    const otra = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `S9-canc-${RUN}`,
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        remainingBalance: 50,
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
      },
    })
    await expect(
      createManualPayment(venueId, staffId, { orderId: otra.id, amount: '50.00', tipAmount: '0', method: 'CASH', source: 'OTHER' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.payment.count({ where: { orderId: otra.id } })).toBe(0)
  })

  it('$100 cobrados, $100 devueltos y $34 tardíos ⇒ saldado con $34 netos (regla del 18-ago, deuda); R44 también convierte', async () => {
    const f = await folio('premio', { vencido: true, pagado: { cobro: 100, devuelto: 100 } })

    // R44: el abono se devolvió completo ⇒ vence SIN cancelar la cuenta, y aun así su premio regresa.
    await expect(expireOnlineOrder({ venueId, orderId: f.orderId })).resolves.toEqual({ outcome: 'OK', status: 'EXPIRED' })
    const vencida = await cuenta(f.orderId)
    expect([vencida.status, vencida.paymentStatus]).toEqual(['PENDING', 'PARTIAL'])
    await esCortesia(f.filaId, '85.00')
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: f.premioId } })).toMatchObject({ status: 'PENDING' })

    await efectivoSinRed(f.orderId, 34)

    const o = await cuenta(f.orderId)
    expect([o.paymentStatus, o.total.toFixed(2)]).toEqual(['PAID', '134.00'])
    expect(await netoCobrado(f.orderId)).toBe('34.00')

    // P2 (Codex r1): la cuenta nunca se canceló, así que el dinero no pasa por la reapertura; el paso que revive el folio cerrado y
    // saldado (el barrido) lo deja en «Por entregar» y avisa al gerente UNA vez, aunque vuelva a pasar.
    await syncPaidClosedFolios({ venueId }, () => new Date())
    await syncPaidClosedFolios({ venueId }, () => new Date())
    expect((await cuenta(f.orderId)).onlineOrder?.status).toBe('ACCEPTED')
    expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(o.orderNumber, '85.00')])
  })

  it.each(['efectivo sin red', 'reasignar'] as const)(
    'T1 (r3 #1 / H1): %s $134 a un folio «Nadie» que venció hace 8 días ⇒ aviso en el cobro; el barrido lo pasa a «Por entregar», 1/1/1 y sin comanda',
    async camino => {
      const f = await folio('premio', { vencido: true })
      await expireOnlineOrder({ venueId, orderId: f.orderId })
      // Venció hace 8 días: fuera de la ventana de 7 del barrido (`updatedAt` es la hora del cierre).
      const hace8 = new Date(Date.now() - 8 * 24 * 3_600_000)
      await prisma.onlineOrder.update({ where: { orderId: f.orderId }, data: { expiredAt: hace8, updatedAt: hace8 } })

      if (camino === 'reasignar') await reasignarA(f.orderId, 134)
      else await efectivoSinRed(f.orderId, 134)
      const pagada = await cuenta(f.orderId)
      expect(pagada.onlineOrder?.status).toBe('EXPIRED') // R11: el dinero no lo mueve
      expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(pagada.orderNumber, '85.00')]) // la nota
      await pasada()
      await pasada()

      const o = await cuenta(f.orderId)
      expect([o.status, o.paymentStatus, o.onlineOrder?.status]).toEqual(['COMPLETED', 'PAID', 'ACCEPTED'])
      expect(await publicaciones(f.orderId)).toEqual({ enVivo: 1, clienta: 1, bitacora: 1 })
      expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(o.orderNumber, '85.00')])
      expect(o.kitchenPendingAt).toBeNull()
      expect(await prisma.kdsOrder.count({ where: { venueId, orderId: f.orderId } })).toBe(0)
    },
  )

  // ── S9 v5 (rediseño del dinero tardío): T2–T19 ─────────────────────────────────────────────────────────────────────────

  it.each(CAMINOS)(
    'T2 (r4 #1): R44 de hace 8 días + $34 por %s ⇒ UN aviso en el cobro y la ventana renovada; tras la pasada PAID, ACCEPTED y 1/1/1',
    async camino => {
      const f = await r44Viejo()
      await pagar(camino, f, 34)

      const pagada = await cuenta(f.orderId)
      expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(pagada.orderNumber, '85.00')])
      expect(pagada.onlineOrder!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000) // renovada: cuenta desde este dinero
      await pasada()
      await pasada()

      const o = await cuenta(f.orderId)
      expect([o.paymentStatus, o.onlineOrder?.status]).toEqual(['PAID', 'ACCEPTED'])
      expect(await publicaciones(f.orderId)).toEqual({ enVivo: 1, clienta: 1, bitacora: 1 })
      expect(await avisos(f.orderId)).toHaveLength(1)
    },
  )

  it('T2b: el CO que termina en el rescate (la cuenta no se pudo liquidar) ⇒ UN aviso; el folio sigue EXPIRED', async () => {
    const f = await r44Viejo()
    const p = await pendienteCripto(f.orderId, 34)
    const vale = jest.spyOn(inventario, 'createSalePostingInTx').mockRejectedValue(new Error('vale de prueba'))
    try {
      await confirmarCripto(p.id, 34).catch(() => undefined)
    } finally {
      vale.mockRestore()
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('COMPLETED')
    const o = await cuenta(f.orderId)
    expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(o.orderNumber, '85.00')])
    await pasada()
    expect((await cuenta(f.orderId)).onlineOrder?.status).toBe('EXPIRED')
  })

  it('T3: R44 + $20, se mueve −8 días, luego $14 ⇒ UN aviso en total y ACCEPTED', async () => {
    const f = await r44Viejo()
    await efectivoSinRed(f.orderId, 20)
    expect(await avisos(f.orderId)).toHaveLength(1)
    const hace8 = new Date(Date.now() - 8 * 24 * 3_600_000)
    await prisma.onlineOrder.update({ where: { orderId: f.orderId }, data: { updatedAt: hace8 } })

    await efectivoSinRed(f.orderId, 14)
    await pasada()
    await pasada()

    const o = await cuenta(f.orderId)
    expect([o.paymentStatus, o.onlineOrder?.status]).toEqual(['PAID', 'ACCEPTED'])
    expect(await avisos(f.orderId)).toHaveLength(1)
  })

  it('T4 (r4 #2): cripto confirmado y rescatado ANTES de anular; luego vence ⇒ 0 avisos', async () => {
    const f = await folio('premio')
    // El CO salda la cuenta, pero su vale de inventario falla tres veces: el rescate completa el pago SIN tocar la cuenta.
    const p = await pendienteCripto(f.orderId, 134)
    const vale = jest.spyOn(inventario, 'createSalePostingInTx').mockRejectedValue(new Error('vale de prueba'))
    try {
      await confirmarCripto(p.id, 134).catch(() => undefined)
    } finally {
      vale.mockRestore()
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('COMPLETED')
    await prisma.onlineOrder.update({ where: { orderId: f.orderId }, data: { acceptDeadlineAt: new Date(Date.now() - 60_000) } })
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    await pasada()

    expect(await avisos(f.orderId)).toEqual([])
  })

  it('T4b: un folio R44 sin dinero nuevo no avisa', async () => {
    const f = await r44Viejo()
    await pasada()
    expect(await avisos(f.orderId)).toEqual([])
  })

  it('T5 (r4 #3): cripto PENDING; la clienta cancela; el CO llega (cuenta cancelada) ⇒ D2 y sigue CANCELLED; luego $114 ⇒ reabre y sigue en 1; ACCEPTED', async () => {
    const f = await folio('premio')
    const p = await pendienteCripto(f.orderId, 20)
    await expect(cancelOnlineOrderByCustomer({ venueId, trackingToken: f.trackingToken })).resolves.toMatchObject({ outcome: 'OK' })

    await confirmarCripto(p.id, 20)
    const cancelada = await cuenta(f.orderId)
    expect(cancelada.status).toBe('CANCELLED')
    expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_D2(cancelada.orderNumber, '85.00')])

    await efectivoSinRed(f.orderId, 114)
    expect((await cuenta(f.orderId)).status).toBe('COMPLETED')
    expect(await avisos(f.orderId)).toHaveLength(1)
    await pasada()
    expect((await cuenta(f.orderId)).onlineOrder?.status).toBe('ACCEPTED')
  })

  it('T6 (r5 #1 / r7 #2): cripto PENDING; el panel anula y el folio sigue por pagar; el CO ⇒ D2; la sincronización y el efectivo no lo repiten', async () => {
    const f = await folio('premio')
    const p = await pendienteCripto(f.orderId, 20)
    await updateOrder(venueId, f.orderId, { status: 'CANCELLED' } as any, { staffId })
    const anulada = await cuenta(f.orderId)
    expect([anulada.status, anulada.onlineOrder?.status]).toEqual(['CANCELLED', 'PENDING_ACCEPTANCE'])
    expect(anulada.onlineOrder?.cancelledAt).not.toBeNull() // B1: el sello del embudo

    await confirmarCripto(p.id, 20)
    expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_D2(anulada.orderNumber, '85.00')])

    await cerrarCanceladasReleyendo({ venueId }, () => new Date())
    await efectivoSinRed(f.orderId, 114)
    await pasada()
    expect(await avisos(f.orderId)).toHaveLength(1)
  })

  it.each([
    ['con el sello del embudo', false],
    ['T7b: anulado antes del despliegue (sin sello): la conciliación lo sella', true],
  ] as const)(
    'T7 (r6 #1): el panel anula; sin sincronizar entran $134 sin red y la conciliación lo pasa a ACCEPTED ⇒ UN aviso (%s)',
    async (_c, sinSello) => {
      const f = await folio('premio')
      await updateOrder(venueId, f.orderId, { status: 'CANCELLED' } as any, { staffId })
      if (sinSello) await prisma.onlineOrder.update({ where: { orderId: f.orderId }, data: { cancelledAt: null } })

      await efectivoSinRed(f.orderId, 134)

      const o = await cuenta(f.orderId)
      expect([o.status, o.paymentStatus, o.onlineOrder?.status]).toEqual(['COMPLETED', 'PAID', 'ACCEPTED'])
      expect(o.onlineOrder?.cancelledAt).not.toBeNull()
      expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(o.orderNumber, '85.00')])
    },
  )

  it('T8 (r5 #2 + r6 #2): dos CO de $134 después de anular; −8 días; reasignar uno con el folio como ORIGEN ⇒ PAID, renovado, 0 avisos nuevos; ACCEPTED 1/1/1', async () => {
    const f = await folio('premio', { vencido: true })
    const p1 = await pendienteCripto(f.orderId, 134)
    const p2 = await pendienteCripto(f.orderId, 134)
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    await confirmarCripto(p1.id, 134)
    await confirmarCripto(p2.id, 134)
    expect(await avisos(f.orderId)).toHaveLength(1) // D2, una vez
    const hace8 = new Date(Date.now() - 8 * 24 * 3_600_000)
    await prisma.onlineOrder.update({ where: { orderId: f.orderId }, data: { expiredAt: hace8, updatedAt: hace8 } })

    const destino = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `S9-T8-${RUN}-${++ciclo}`,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 134,
        taxAmount: 0,
        total: 134,
        remainingBalance: 134,
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
      },
    })
    const r = await aplicarReasignacion(
      depsDelScript(),
      { paymentId: p2.id, deOrden: (await cuenta(f.orderId)).orderNumber, aOrden: destino.orderNumber, motivo: 'S9 T8' },
      await fotoDeCobro(p2.id),
      await fotoDeOrden(f.orderId),
      await fotoDeOrden(destino.id),
    )
    expect(r.ok).toBe(true)

    const origen = await cuenta(f.orderId)
    expect([origen.status, origen.paymentStatus]).toEqual(['COMPLETED', 'PAID'])
    expect(origen.onlineOrder!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(await avisos(f.orderId)).toHaveLength(1)
    await pasada()
    await pasada()
    expect((await cuenta(f.orderId)).onlineOrder?.status).toBe('ACCEPTED')
    expect(await publicaciones(f.orderId)).toEqual({ enVivo: 1, clienta: 1, bitacora: 1 })
    expect(await avisos(f.orderId)).toHaveLength(1)
  })

  it('T9 (H2): cripto PENDING de $20 antes de vencer (R44); el CO después y una reentrega ⇒ UN aviso', async () => {
    const f = await folio('premio', { vencido: true, pagado: { cobro: 100, devuelto: 100 } })
    const cripto = await pendienteCripto(f.orderId, 20)
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    expect((await cuenta(f.orderId)).status).toBe('PENDING') // R44

    await confirmarCripto(cripto.id, 20)
    await confirmarCripto(cripto.id, 20) // la reentrega del mismo CO
    await pasada()

    const o = await cuenta(f.orderId)
    expect(o.paymentStatus).toBe('PARTIAL')
    expect((await avisos(f.orderId)).map(a => a.message)).toEqual([AVISO_CON_CORTESIA(o.orderNumber, '85.00')])
    expect(o.onlineOrder?.status).toBe('EXPIRED')
  })

  it('T10: folio SIN beneficios, cancelado, + $219 ⇒ UN aviso con el texto S1 de hoy', async () => {
    const f = await folioSinBeneficio()
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    await efectivoSinRed(f.orderId, 219)
    const o = await cuenta(f.orderId)
    expect((await avisos(f.orderId)).map(a => a.message)).toEqual([
      `El pedido #${o.orderNumber} se había cancelado y después se registró su cobro. Revisa con quien lo canceló.`,
    ])
  })

  it('T11: anular la cuenta de un «Mi equipo» no lo sella (como hoy)', async () => {
    const f = await folio('premio', { miEquipo: true })
    await updateOrder(venueId, f.orderId, { status: 'CANCELLED' } as any, { staffId })
    expect((await cuenta(f.orderId)).onlineOrder?.cancelledAt).toBeNull()
  })

  it('T18: el efectivo que salda una R44 y el barrido a la vez ⇒ UN aviso y un solo ONLINE_ORDER_ACCEPTED', async () => {
    const f = await r44Viejo()
    await Promise.all([efectivoSinRed(f.orderId, 34), syncPaidClosedFolios({ venueId }, () => new Date())])
    await pasada()
    await pasada()
    expect(await avisos(f.orderId)).toHaveLength(1)
    expect((await publicaciones(f.orderId)).bitacora).toBe(1)
  })

  it('T19 (R13): 101 folios cerrados y saldados; los 100 de id más bajo con su Order en otro negocio ⇒ una pasada revive el 101', async () => {
    const otro = (
      await prisma.venue.create({
        data: { organizationId: orgId, name: `s9-otro-${RUN}`, slug: `itest-s9-otro-${RUN}`, status: 'LIVE_DEMO' },
      })
    ).id
    const ids = Array.from({ length: 101 }, () => cuid()).sort()
    try {
      for (let i = 0; i < 101; i++) {
        const order = await prisma.order.create({
          data: {
            venueId: i < 100 ? otro : venueId,
            orderNumber: `S9-T19-${RUN}-${i}`,
            source: 'WEB',
            subtotal: 10,
            taxAmount: 0,
            total: 10,
            paidAmount: 10,
            remainingBalance: 0,
            status: 'COMPLETED',
            paymentStatus: 'PAID',
          },
        })
        await prisma.onlineOrder.create({
          data: {
            id: ids[i],
            venueId,
            orderId: order.id,
            trackingToken: cuid(),
            paymentMode: 'PAY_AT_PICKUP',
            requiresAcceptance: false,
            status: 'EXPIRED',
            expiredAt: new Date(),
            acceptDeadlineAt: new Date(Date.now() - 60_000),
          },
        })
      }
      await syncPaidClosedFolios({ venueId }, () => new Date())
      expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: ids[100] } })).status).toBe('ACCEPTED')
      expect(await prisma.onlineOrder.count({ where: { id: { in: ids.slice(0, 100) }, status: 'EXPIRED' } })).toBe(100)
    } finally {
      await prisma.onlineOrder.deleteMany({ where: { id: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId: otro } })
      await prisma.venue.deleteMany({ where: { id: otro } })
    }
  })

  it.each([
    ['Nadie', false],
    ['Mi equipo', true],
  ] as const)(
    'G2/G3 (Codex r2): reasignar un cobro de $134 a un folio de «%s» anulado con cortesía termina IGUAL que el efectivo sin red',
    async (_modo, miEquipo) => {
      const conEfectivo = await folio('premio', { vencido: true, miEquipo })
      const reasignado = await folio('premio', { vencido: true, miEquipo })
      for (const f of [conEfectivo, reasignado]) await expireOnlineOrder({ venueId, orderId: f.orderId })

      await efectivoSinRed(conEfectivo.orderId, 134)
      await reasignarA(reasignado.orderId, 134)
      // El barrido de cada 30 s (y de cada lectura de la bandeja), dos veces: lo que publica no se repite.
      await syncPaidClosedFolios({ venueId }, () => new Date())
      await syncPaidClosedFolios({ venueId }, () => new Date())

      const esperado = {
        cuenta: ['COMPLETED', 'PAID', '134.00', '0.00'],
        // «Nadie»: «Por entregar» por el barrido, con sus tres publicaciones. «Mi equipo»: «Entregado» por la conciliación de hoy.
        pedido: miEquipo ? 'COMPLETED' : 'ACCEPTED',
        avisos: [AVISO_CON_CORTESIA('N', '85.00')],
        reaperturas: 1,
        cobradoTarde: 1,
        publicaciones: miEquipo ? { enVivo: 0, clienta: 0, bitacora: 0 } : { enVivo: 1, clienta: 1, bitacora: 1 },
      }
      expect({ efectivo: await finalDe(conEfectivo.orderId), reasignado: await finalDe(reasignado.orderId) }).toEqual({
        efectivo: esperado,
        reasignado: esperado,
      })
    },
  )

  it('regresión: reasignar a una cuenta que no es de folio queda como hoy (sin pedido en línea ni aviso)', async () => {
    const destinoNormal = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `S9-dest-${RUN}`,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 80,
        taxAmount: 0,
        total: 80,
        remainingBalance: 80,
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
      },
    })
    const origen = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `S9-orig2-${RUN}`,
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        paidAmount: 50,
        remainingBalance: 0,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
      },
    })
    await cobro(origen.id, 50)
    const ajeno = await cobro(origen.id, 80)

    const r = await aplicarReasignacion(
      depsDelScript(),
      { paymentId: ajeno.id, deOrden: origen.orderNumber, aOrden: destinoNormal.orderNumber, motivo: 'S9' },
      await fotoDeCobro(ajeno.id),
      await fotoDeOrden(origen.id),
      await fotoDeOrden(destinoNormal.id),
    )

    expect(r.ok).toBe(true)
    const d = await cuenta(destinoNormal.id)
    expect([d.status, d.paymentStatus, d.total.toFixed(2)]).toEqual(['COMPLETED', 'PAID', '80.00'])
    expect(d.onlineOrder).toBeNull()
    expect(await avisos(destinoNormal.id)).toEqual([])
    // Como hoy: la reasignación la pre-reabre (sin la bitácora del dinero que reabre una cancelada).
    expect(
      await prisma.activityLog.count({ where: { venueId, entityId: destinoNormal.id, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } }),
    ).toBe(0)
  })

  it('cupón del folio revivido no se aparta otra vez', async () => {
    const f = await folio('cupon', { vencido: true })
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    await esCortesia(f.filaId, '85.00')

    await efectivoSinRed(f.orderId, 134)

    expect((await cuenta(f.orderId)).paymentStatus).toBe('PAID')
    // Ninguna venta lo aparta ni lo canjea: el código sigue libre para otro pedido.
    expect(await prisma.orderDiscount.count({ where: { couponCodeId: f.couponCodeId } })).toBe(0)
    expect(await prisma.couponRedemption.count({ where: { couponCodeId: f.couponCodeId } })).toBe(0)
    expect((await prisma.couponCode.findUniqueOrThrow({ where: { id: f.couponCodeId } })).currentUses).toBe(0)
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: f.discountId } })).currentUses).toBe(0)
  })

  it('cripto sobre un folio ⇒ rechazado antes de crear nada', async () => {
    const f = await folio('premio')
    await expect(initiateCryptoPayment({ venueId, amount: 13_400, tip: 0, staffId, orderId: f.orderId } as any)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_PAID_AT_REGISTER',
    })
    expect(await prisma.payment.count({ where: { orderId: f.orderId } })).toBe(0)
  })

  it('premio quitado en caja y abono con saldo ⇒ debe la diferencia', async () => {
    const f = await folio('premio')
    // «Quitar descuento» en una cuenta viva: el premio regresa y la rebaja se va (no es anulación ni deja cortesía).
    await removeOrderDiscount(venueId, f.orderId, f.filaId, staffId)
    expect((await cuenta(f.orderId)).total.toFixed(2)).toBe('219.00')
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: f.premioId } })).toMatchObject({ status: 'PENDING' })

    const t = await tarjeta(500)
    await payGiftCardBalanceOnOrder(venueId, f.orderId, {
      idempotencyKey: `s9-saldo-${RUN}`,
      proof: { kind: 'CODE', code: t.codigo } as any,
      amount: D(134),
      tip: D(0),
      staffId,
      deviceId: null,
    })

    const o = await cuenta(f.orderId)
    expect([o.paymentStatus, o.remainingBalance.toFixed(2)]).toEqual(['PARTIAL', '85.00'])
  })

  it('un producto agregado al folio revivido se debe completo, y un 20 % convertido no crece', async () => {
    const f = await folio('veinte', { vencido: true })
    await expireOnlineOrder({ venueId, orderId: f.orderId })
    await esCortesia(f.filaId, '43.80')
    await efectivoSinRed(f.orderId, 50)

    const viva = await cuenta(f.orderId)
    expect([viva.status, viva.remainingBalance.toFixed(2)]).toEqual(['PENDING', '125.20'])
    await addItemsToOrder(venueId, f.orderId, [{ productId: extraId, quantity: 1 }], viva.version)

    const o = await cuenta(f.orderId)
    expect([o.total.toFixed(2), o.discountAmount.toFixed(2), o.remainingBalance.toFixed(2)]).toEqual(['205.20', '43.80', '155.20'])
    expect((await fila(f.filaId)).amount.toFixed(2)).toBe('43.80')
  })

  it('anular TODOS los artículos de un folio ⇒ 400 FOLIO_SE_CANCELA_COMO_PEDIDO; la cuenta y su premio siguen igual', async () => {
    const f = await folio('premio')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: f.orderId }, include: { items: true } })
    await expect(
      voidItems(venueId, f.orderId, { itemIds: o.items.map(i => i.id), reason: 'S9', staffId, expectedVersion: o.version }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'FOLIO_SE_CANCELA_COMO_PEDIDO' })
    expect((await cuenta(f.orderId)).status).toBe('PENDING')
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: f.premioId } })).toMatchObject({ status: 'REDEEMED' })
  })

  it('folio de tarjeta se anula sin que lo frene ninguna guarda: la tarjeta se suelta y el premio regresa', async () => {
    const f = await folio('premio', { tarjeta: true })

    await expect(cancelOnlineOrderByCustomer({ venueId, trackingToken: f.trackingToken })).resolves.toEqual({
      outcome: 'OK',
      status: 'CANCELLED_BY_CUSTOMER',
    })

    const o = await cuenta(f.orderId)
    expect([o.status, o.total.toFixed(2)]).toEqual(['CANCELLED', '134.00'])
    await esCortesia(f.filaId, '85.00')
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: f.premioId } })).toMatchObject({ status: 'PENDING' })
    const cargo = await prisma.onlineOrderCharge.findFirstOrThrow({ where: { onlineOrderId: o.onlineOrder!.id } })
    expect(['RELEASING', 'RELEASED', 'VOIDED']).toContain(cargo.status)
  })

  it('folio con abono de saldo («Regresar el saldo y cancelar») se anula sin que lo frene ninguna guarda', async () => {
    const f = await folio('premio')
    const t = await tarjeta(500)
    await payGiftCardBalanceOnOrder(venueId, f.orderId, {
      idempotencyKey: `s9-abono-${RUN}`,
      proof: { kind: 'CODE', code: t.codigo } as any,
      amount: D(50),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: t.id } })).balance.toFixed(2)).toBe('450.00')

    await expect(returnGiftBalanceAndCancelOrder(venueId, f.orderId, { staffId, operationKey: `s9-regresa-${RUN}` })).resolves.toEqual({
      replay: false,
    })

    const o = await cuenta(f.orderId)
    expect([o.status, o.total.toFixed(2)]).toEqual(['CANCELLED', '134.00'])
    await esCortesia(f.filaId, '85.00')
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: f.premioId } })).toMatchObject({
      status: 'PENDING',
      orderDiscountId: null,
    })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: t.id } })).balance.toFixed(2)).toBe('500.00')
  })
})

/** Un sobre ACTIVE con su código real y su ACTIVATE (saldo = suma de la libreta), como `cobroConSaldo.integration.test.ts`. */
async function tarjeta(monto: number) {
  const c = generateGiftCardCode()
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId: orgId,
      codeHash: hashGiftCardCode(c.normalized),
      codeEnc: encryptGiftCardCode(c.normalized),
      codeLast4: c.last4,
      pageToken: generateOpaqueToken(),
      initialAmount: D(monto),
      balance: D(monto),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
    },
  })
  await prisma.giftCardActivity.create({ data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: D(monto), balanceAfter: D(monto) } })
  return { id: s.id, codigo: c.display }
}
