// src/services/online-ordering/order.service.ts
import {
  ContratoDePrecio,
  KitchenStatus,
  NotificationChannel,
  NotificationPriority,
  NotificationType,
  OnlineOrderChargeStatus,
  OnlineOrderPaymentMode,
  OnlineOrderStatus,
  OrderSource,
  OrderStatus,
  OrderType,
  OriginSystem,
  PaymentStatus,
  Prisma,
  type OnlineOrderRejectReason,
} from '@prisma/client'
import { createHash } from 'node:crypto'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import AppError, { BadRequestError, ConflictError, UnauthorizedError } from '@/errors/AppError'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { SocketEventType } from '@/communication/sockets/types'
import { canonicalPhoneE164, phonesMatch } from '@/utils/phone'
import { ponerNombreSiFalta } from '@/services/customer/customerName'
import {
  ACCEPT_TIMEOUT_MINUTES,
  FOLIO_TIMEOUT_MINUTES,
  MAX_PENDING_PER_PHONE,
  MAX_PENDING_PER_VENUE,
  MAX_UNPAID_FOLIOS_PER_VENUE,
  OPEN_ORDER_STATUSES,
  awaitingAcceptanceWhere,
  liveCardDraftsWhere,
  unpaidFoliosWhere,
} from './constants'
import { closesAt, isWithinHours } from './hours'
import type { OnlineOrderingConfig, Reloj } from './types'
import { MAX_GERENTES_AVISADOS, ROLES_QUE_RECIBEN_EL_AVISO } from '@/services/shared/cuentaCancelada'
import { generateOrderNumber } from './orderNumber'
import { getAcceptingStatus } from './presence.service'
import { buildVenueContact, getSettings, type VenueContact } from './settings.service'
import { quoteCart, toPublicQuote, type CartItemInput, type PricedLine, type QuoteResult } from './quote.service'
import { generateTrackingToken } from './trackingToken'
import { CAPTURED_OUTSIDE, confirmCardAuthorization } from './card/confirm.service'
import { chargeMerchant, cardOnlineAvailable } from './card/merchant'
import { getProvider } from '@/services/payments/provider-registry'

export interface CreateOnlineOrderInput {
  venueId: string
  idempotencyKey: string
  items: CartItemInput[]
  paymentMode: 'PAY_AT_PICKUP'
  /** R5: el total que el comensal vio y confirmó, en pesos con 2 decimales («206.00»). */
  expectedTotal: string
  /** T7: en «Nadie» basta el nombre; el teléfono sólo cuenta si es el que probó la sesión (pestaña vieja o «Mi equipo»). */
  customer: { name: string; phone?: string | null; email?: string | null }
  /** De la sesión de cliente (`req.customerAuth`), nunca del cuerpo. */
  customerId: string | null
  /** R6/H1: el teléfono que probó el OTP de WhatsApp (reclamo `verifiedPhone` del token de PEDIDOS, tarea 7b). */
  verifiedPhone: string | null
  /** Tienda híbrida: por dónde llegó la clienta (`?canal=qr` del QR de «Compartir tu tienda»), sólo para medir. */
  channel?: 'QR' | 'LINK' | null
  note?: string | null
  whatsappConsent?: boolean
  /** Una hora fija (pruebas). Sin ella se lee `reloj` (o el del sistema): al empezar, y otra vez justo antes de escribir (R52). */
  now?: Date
  reloj?: Reloj
}

export interface CreateOnlineOrderOptions {
  /**
   * P1-06: lo que sólo un pedido NUEVO exige (negocio operativo, plan). Corre ANTES de mirar si la tienda abre y fuera de toda
   * transacción (Codex r4); su rechazo se decide después de buscar la repetición: un reintento de un pedido ya creado recibe SU
   * pedido aunque el plan haya vencido o el negocio ya no opere.
   * OBLIGATORIO: ningún llamador crea un pedido sin decir cómo se revisan plan y negocio.
   */
  assertCanCreate: () => Promise<void>
}

export interface CreateOnlineOrderResult {
  orderId: string
  onlineOrderId: string
  trackingToken: string
  status: OnlineOrderStatus
  orderNumber: string
  total: string
  acceptDeadlineAt: string
  replay: boolean
}

/**
 * A1 (P1-01): huella de la solicitud normalizada. La repetición idempotente la compara en vez del total de la cuenta (la caja
 * puede cambiarlo) y del cliente solo (otro carrito del mismo total pasaría). Renglones en el orden recibido; las opciones de
 * cada renglón ordenadas por id (sin cantidad = 1); nota recortada; nombre y teléfono tal como se guardan en la cuenta.
 */
export function onlineOrderRequestHash(r: {
  venueId: string
  customerId: string
  paymentMode: string
  expectedTotal: string | Prisma.Decimal
  items: CartItemInput[]
  customerName: string
  customerPhone: string
}): string {
  const normalized = {
    venueId: r.venueId,
    customerId: r.customerId,
    paymentMode: r.paymentMode,
    expectedTotal: new Prisma.Decimal(r.expectedTotal).toFixed(2),
    items: r.items.map(i => ({
      productId: i.productId,
      quantity: i.quantity,
      note: i.note?.trim() || null,
      modifiers: (i.modifiers ?? [])
        .map(m => ({ modifierId: m.modifierId, quantity: m.quantity ?? 1 }))
        .sort((a, b) => (a.modifierId === b.modifierId ? a.quantity - b.quantity : a.modifierId < b.modifierId ? -1 : 1)),
    })),
    customer: { name: r.customerName, phone: r.customerPhone },
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

/**
 * Pedido ya creado con esta llave. Lo decide SÓLO la huella (M-3/A1): se repite si es la MISMA solicitud; con otro carrito o total
 * la llave choca (el comensal creería que pidió lo nuevo). R8: la huella guarda la identidad con la que NACIÓ el pedido, así que
 * otro cliente también choca. T7 (codex-plan-r6 #2): no se compara `Order.customerId`, que la caja cambia al ligar un cliente
 * (`order.mobile.service.ts`); el reintento de un folio anónimo ya cobrado recibe SU folio. Sin huella guardada, también choca.
 */
async function findReplay(
  db: Prisma.TransactionClient,
  venueId: string,
  externalId: string,
  requestHash: string,
): Promise<CreateOnlineOrderResult | null> {
  const existing = await db.order.findUnique({
    where: { venueId_externalId: { venueId, externalId } },
    select: {
      id: true,
      orderNumber: true,
      total: true,
      onlineOrder: { select: { id: true, status: true, trackingToken: true, acceptDeadlineAt: true, requestHash: true } },
    },
  })
  if (!existing?.onlineOrder) return null
  if (existing.onlineOrder.requestHash !== requestHash) {
    throw final(
      new ConflictError(
        'Ya hiciste un pedido distinto con esta misma solicitud. Recarga la página para empezar uno nuevo.',
        'IDEMPOTENCY_KEY_CONFLICT',
      ),
    )
  }
  return {
    orderId: existing.id,
    onlineOrderId: existing.onlineOrder.id,
    trackingToken: existing.onlineOrder.trackingToken,
    status: existing.onlineOrder.status,
    orderNumber: existing.orderNumber,
    total: new Prisma.Decimal(existing.total).toFixed(2),
    acceptDeadlineAt: existing.onlineOrder.acceptDeadlineAt.toISOString(),
    replay: true,
  }
}

/** R4: la admisión de pedidos de un negocio se serializa con este candado consultivo de Postgres (sin Redis). */
export function lockAdmission(tx: Prisma.TransactionClient, venueId: string) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-order-admission:' + venueId}))`
}

/**
 * Codex r2: un solo envío de esta llave a la vez mientras DECIDE (repetición, rechazo guardado, topes y creación). Un reintento
 * espera a que el envío vivo termine: si creó, recibe su pedido. Siempre ANTES del candado del negocio (sin abrazo mortal).
 */
export function lockKey(tx: Prisma.TransactionClient, venueId: string, externalId: string) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-order-key:' + venueId + ':' + externalId}))`
}

/**
 * Codex r3: la primera DECISIÓN sobre una llave es durable (como Stripe, que también guarda el resultado de un error). Sin
 * migración, en la tabla genérica `IdempotencyRequest` (custodia de SIMs y comandos de la TPV): los prefijos `venue:` y
 * `customer:` nunca chocan con sus ids de organización y de staff. ponytail: sin purga (sólo nacen al rechazar, volumen bajo);
 * si crecen, borrar por `expiresAt` (ya indexado).
 */
const rejectionKey = (venueId: string, customerId: string | null, idempotencyKey: string) => ({
  organizationId: `venue:${venueId}`,
  // T7: el folio anónimo de «Nadie» no tiene cliente: la llave misma (`anon:` nunca choca con `customer:<id>`).
  actorStaffId: customerId ? `customer:${customerId}` : `anon:${idempotencyKey}`,
  endpoint: 'POST /public/ordering/orders',
  idempotencyKey,
})

/** El rechazo que la tienda da por definitivo y con el que suelta la llave: todo 4xx salvo 401, 408 y 429 (`isDefinitive`). */
export const isDefinitiveRejection = (error: unknown): error is AppError =>
  error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && ![401, 408, 429].includes(error.statusCode)

/**
 * Codex r4: decisión DURABLE sobre la llave (rechazo guardado, o la llave ya es de otro pedido). El controlador la responde con
 * `final: true` y sólo con ella la tienda puede soltar la llave ante un 404 (el del resolver, previo a decidir, no la lleva).
 */
export const final = <E extends AppError>(error: E): E & { final: true } => Object.assign(error, { final: true as const })

export const TX_OPTIONS = { timeout: 15_000, maxWait: 5_000 }

/** Folio corto que no choque con otra cuenta ABIERTA del mismo negocio (dentro del candado de admisión). */
export async function pickOrderNumber(tx: Prisma.TransactionClient, venueId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generateOrderNumber()
    const clash = await tx.order.findFirst({
      where: { venueId, orderNumber: candidate, status: { in: [...OPEN_ORDER_STATUSES] as OrderStatus[] } },
      select: { id: true },
    })
    if (!clash) return candidate
  }
  throw new ConflictError('No se pudo asignar un folio. Intenta de nuevo.', 'ORDER_NUMBER_UNAVAILABLE')
}

/** Fase 2: la cotización guardable en JSON (el borrador de tarjeta la guarda y crea la cuenta al autorizarse). Decimal como texto. */
export interface QuoteSnapshot {
  subtotal: string
  total: string
  lines: Array<
    Omit<PricedLine, 'unitPrice' | 'lineTotal' | 'modifiers'> & {
      unitPrice: string
      lineTotal: string
      modifiers: Array<Omit<PricedLine['modifiers'][number], 'unitPrice'> & { unitPrice: string }>
    }
  >
}
type QuoteForOrder = Pick<QuoteResult, 'subtotal' | 'total' | 'lines'>

/** `toFixed()` sin decimales fijos: el texto exacto, sin notación exponencial. */
export function toQuoteSnapshot(q: QuoteForOrder): QuoteSnapshot {
  return {
    subtotal: q.subtotal.toFixed(),
    total: q.total.toFixed(),
    lines: q.lines.map(l => ({
      ...l,
      unitPrice: l.unitPrice.toFixed(),
      lineTotal: l.lineTotal.toFixed(),
      modifiers: l.modifiers.map(m => ({ ...m, unitPrice: m.unitPrice.toFixed() })),
    })),
  }
}

export function fromQuoteSnapshot(s: QuoteSnapshot): QuoteForOrder {
  const D = (v: string) => new Prisma.Decimal(v)
  return {
    subtotal: D(s.subtotal),
    total: D(s.total),
    lines: s.lines.map(l => ({
      ...l,
      unitPrice: D(l.unitPrice),
      lineTotal: D(l.lineTotal),
      modifiers: l.modifiers.map(m => ({ ...m, unitPrice: D(m.unitPrice) })),
    })),
  }
}

/**
 * La cuenta del pedido en línea (`Order` con renglones y extras + `OnlineOrder`) y el nombre del cliente si le faltaba, en la
 * transacción de quien ya tomó los candados de admisión. La comparten pagar al recoger y la tarjeta (fase 2).
 */
export async function writeOnlineOrderInTx(
  tx: Prisma.TransactionClient,
  i: {
    venueId: string
    externalId: string
    orderNumber: string
    quote: QuoteSnapshot
    customer: { name: string; phone: string | null; email: string | null }
    customerId: string | null
    note: string | null
    paymentMode: OnlineOrderPaymentMode
    trackingToken: string
    requestHash: string
    acceptDeadlineAt: Date
    whatsappConsent: boolean
    requiresAcceptance: boolean
    channel: 'QR' | 'LINK' | null
  },
): Promise<{ orderId: string; onlineOrderId: string }> {
  const quote = fromQuoteSnapshot(i.quote)
  const zero = new Prisma.Decimal(0)
  // 🔴 NO se estampa `shiftId`, y es DELIBERADO — no lo "arregles": el pedido nace desde el teléfono del comensal, no en el
  // mostrador con el cajero enfrente (criterio de `tests/unit/services/shared/ordenLlevaElTurno.guard.test.ts`, donde la
  // tarea 15b lo clasifica). El dinero SÍ cae en el turno: `payCashOrder` estampa `Payment.shiftId` al cobrar (tarea 15).
  const order = await tx.order.create({
    data: {
      venueId: i.venueId,
      orderNumber: i.orderNumber,
      type: OrderType.PICKUP,
      source: OrderSource.WEB,
      originSystem: OriginSystem.AVOQADO,
      externalId: i.externalId,
      status: OrderStatus.PENDING,
      kitchenStatus: KitchenStatus.PENDING,
      paymentStatus: PaymentStatus.PENDING,
      contratoDePrecio: ContratoDePrecio.IVA_INCLUIDO,
      subtotal: quote.subtotal,
      discountAmount: zero,
      taxAmount: zero, // el IVA ya va incluido en el precio
      tipAmount: zero, // propina fuera de la v1
      total: quote.total,
      paidAmount: zero,
      remainingBalance: quote.total,
      customerName: i.customer.name,
      customerPhone: i.customer.phone,
      customerEmail: i.customer.email,
      specialRequests: i.note,
      customerId: i.customerId,
      // Codex r1 C1: la tarjeta se cobra en el momento; nunca es fiado («Liquidar saldo», saldo y antigüedad del cliente), aunque
      // la TPV le ligue un cliente después. Pagar al recoger queda como hoy («no se sabe»).
      ...(i.paymentMode === OnlineOrderPaymentMode.CARD_ONLINE ? { payLater: false } : {}),
      items: {
        create: quote.lines.map((line, idx) => ({
          productId: line.productId,
          productName: line.productName,
          productSku: line.productSku,
          // R3: la foto de la categoría, como TPV y móvil (los reportes la leen del renglón).
          categoryName: line.categoryName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: zero,
          taxAmount: zero,
          total: line.lineTotal,
          notes: line.note,
          originSystem: OriginSystem.AVOQADO,
          externalId: `${i.externalId}-${idx}`,
          sequence: idx,
          modifiers: line.modifiers.length
            ? {
                create: line.modifiers.map(m => ({
                  modifierId: m.modifierId,
                  name: m.name,
                  // 🔴 F2 (founder, 15-oct): como la terminal y el POS móvil. `price` = precio POR UNIDAD del extra y
                  // `quantity` = cuántos por unidad del platillo. La factura reconstruye Σ(price × quantity) × cantidad
                  // (`examinarRenglon`); con el precio ya multiplicado el renglón no cuadraría.
                  quantity: m.quantity,
                  price: m.unitPrice,
                })),
              }
            : undefined,
        })),
      },
    },
  })

  const online = await tx.onlineOrder.create({
    data: {
      orderId: order.id,
      venueId: i.venueId,
      status: OnlineOrderStatus.PENDING_ACCEPTANCE,
      paymentMode: i.paymentMode,
      trackingToken: i.trackingToken,
      requestHash: i.requestHash,
      acceptDeadlineAt: i.acceptDeadlineAt,
      whatsappConsent: i.whatsappConsent,
      requiresAcceptance: i.requiresAcceptance,
      channel: i.channel,
    },
  })
  // S3: `verify` para PEDIR no pone nombre (R7: no activa la cuenta de reservas) y la tienda no lo manda al verificar; sin esto
  // el Customer nacía vacío y «Clientes» lo mostraba sin nombre. Sólo llena si estaba vacío, nunca pisa lo del negocio, y una
  // repetición ya salió antes sin llegar aquí. No toca la cuenta de reservas.
  if (i.customerId) {
    const cliente = await tx.customer.findFirst({ where: { id: i.customerId, venueId: i.venueId } })
    if (cliente) await ponerNombreSiFalta(tx, cliente, i.customer.name)
  }
  return { orderId: order.id, onlineOrderId: online.id }
}

/** El aviso de cuenta nueva a las apps del negocio, después del commit. Nunca lanza. */
export function emitOnlineOrderCreated(venueId: string, r: { orderId: string; orderNumber: string; externalId: string }, now: Date): void {
  try {
    socketManager.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      venueId,
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.PENDING,
      source: OrderSource.WEB,
      externalId: r.externalId,
      eventType: 'created',
      timestamp: now.toISOString(),
    })
  } catch (error) {
    logger.error('[OnlineOrdering] socket emit falló (no fatal)', { orderId: r.orderId, error })
  }
}

/** T3b: la acción de bitácora del aviso «se llenaron los folios por pagar» (una por hora y negocio). */
const UNPAID_FOLIOS_FULL_ACTION = 'ONLINE_ORDERING_UNPAID_FOLIOS_FULL'

/**
 * T3b: tope propio de folios SIN dinero (R18: uno con abono no ocupa lugar), dentro del candado de admisión. Al llenarse, la tienda
 * sigue abierta (se ve el menú) y se recupera sola: cada folio vence en 30 min o menos. El aviso al negocio sale una vez por hora,
 * con su bitácora, en la misma transacción (que confirma: el rechazo se guarda), como `cuentaCancelada.ts`.
 */
async function admitFolio(tx: Prisma.TransactionClient, venueId: string, now: Date): Promise<void> {
  const sinPagar = await tx.onlineOrder.count({ where: unpaidFoliosWhere(venueId) })
  if (sinPagar < MAX_UNPAID_FOLIOS_PER_VENUE) return
  const avisado = await tx.activityLog.findFirst({
    where: { venueId, action: UNPAID_FOLIOS_FULL_ACTION, createdAt: { gte: new Date(now.getTime() - 3600_000) } },
    select: { id: true },
  })
  if (!avisado) {
    const data = { sinPagar, tope: MAX_UNPAID_FOLIOS_PER_VENUE }
    await tx.activityLog.create({
      data: { action: UNPAID_FOLIOS_FULL_ACTION, entity: 'Venue', entityId: venueId, venueId, data, createdAt: now },
    })
    const gerentes = await tx.staffVenue.findMany({
      where: { venueId, active: true, role: { in: ROLES_QUE_RECIBEN_EL_AVISO } },
      select: { staffId: true },
      orderBy: { staffId: 'asc' },
      take: MAX_GERENTES_AVISADOS,
    })
    if (gerentes.length === MAX_GERENTES_AVISADOS) {
      logger.warn('⚠️ [OnlineOrdering] página llena de gerentes al avisar que se llenaron los folios; puede haber más sin aviso', {
        venueId,
        tope: MAX_GERENTES_AVISADOS,
      })
    }
    if (gerentes.length > 0) {
      await tx.notification.createMany({
        data: gerentes.map(g => ({
          recipientId: g.staffId,
          venueId,
          type: NotificationType.ALERT,
          priority: NotificationPriority.HIGH,
          channels: [NotificationChannel.IN_APP],
          entityType: 'Venue',
          entityId: venueId,
          title: 'Se llenaron los pedidos por pagar',
          message: `Hay ${sinPagar} pedidos en línea esperando pago en caja y la tienda no recibe más hasta que se cobren o venzan. Cancela los que no vengan desde «Por pagar».`,
          metadata: data,
        })),
      })
    }
    logger.warn('🧾 [OnlineOrdering] se llenaron los folios por pagar', { venueId, ...data, gerentesAvisados: gerentes.length })
  }
  throw new ConflictError('Hay muchos pedidos esperando pago. Pide directo en caja.', 'TOO_MANY_UNPAID_FOLIOS')
}

export async function createOnlineOrder(input: CreateOnlineOrderInput, opts: CreateOnlineOrderOptions): Promise<CreateOnlineOrderResult> {
  const fija = input.now
  const reloj: Reloj = input.reloj ?? (fija ? () => fija : () => new Date())
  const now = reloj()
  const externalId = `web:${input.idempotencyKey}`

  // 1. T7: la identidad sale de la sesión sólo si probó el teléfono del PEDIDO por el OTP de WhatsApp (R6: tenerlo en la ficha no
  //    prueba nada); si no, el pedido es anónimo (cliente y teléfono nulos).
  const sessionPhone =
    input.customerId && input.verifiedPhone && phonesMatch(input.verifiedPhone, input.customer.phone) ? input.verifiedPhone : null
  const customerId = sessionPhone ? input.customerId : null
  // R47: sin esa sesión, «Mi equipo» responde 401 de inmediato. La única lectura es el modo de la tienda (su fila de ajustes, por su
  // llave): sin él no se sabe si se puede pedir sin sesión. Ni plan, ni tienda, ni la llave, y nunca una fila de rechazo `anon:` (la
  // tienda pide el código y reintenta con la MISMA llave). En «Nadie» esa misma lectura es la de la tienda (paso 3).
  const ajustesSinSesion = customerId ? undefined : await getSettings(input.venueId)
  if (ajustesSinSesion && ajustesSinSesion.requiresAcceptance !== false) {
    throw new UnauthorizedError('Verifica tu teléfono por WhatsApp para pedir y pagar al recoger.', 'PHONE_VERIFICATION_REQUIRED')
  }
  // R23: la forma canónica de la casa (la misma que compara `phonesMatch`: `+521…` → `+52…`); si no la entiende, «+» y sólo
  // dígitos.
  const phone = sessionPhone ? (canonicalPhoneE164(sessionPhone) ?? `+${sessionPhone.replace(/\D/g, '')}`) : null
  // R5: el total que vio el comensal (el Zod de la ruta ya validó «206.00»).
  const expectedTotal = new Prisma.Decimal(input.expectedTotal)
  // A1: la huella decide si una repetición es SU pedido (M-3); se guarda al crear. T7: la anónima lleva cliente y teléfono ''.
  const requestHash = onlineOrderRequestHash({
    venueId: input.venueId,
    customerId: customerId ?? '',
    paymentMode: input.paymentMode,
    expectedTotal,
    items: input.items,
    customerName: input.customer.name,
    customerPhone: phone ?? '',
  })

  const trackingToken = generateTrackingToken()
  const note = input.note?.trim() ? input.note.trim() : null

  const keyOfRejection = rejectionKey(input.venueId, customerId, input.idempotencyKey)

  /**
   * Bajo el candado de la llave, lo ya decidido gana: SU pedido (R8) o, Codex r3, el MISMO rechazo guardado aunque plan, tienda o
   * precio ya cambiaron (la tienda soltó la llave con él; un envío tardío que creara duplicaría el pedido del siguiente intento).
   */
  const decidedBefore = async (tx: Prisma.TransactionClient): Promise<CreateOnlineOrderResult | null> => {
    await lockKey(tx, input.venueId, externalId)
    // Codex r2 #5: la llave ya abrió un borrador de TARJETA (mismo candado y mismo `externalId`): nunca otro pedido con ella.
    const card = await tx.onlineOrderCharge.findUnique({
      where: { venueId_idempotencyKey: { venueId: input.venueId, idempotencyKey: input.idempotencyKey } },
      select: { id: true },
    })
    if (card) throw final(new ConflictError('Esa llave ya se usó para otro pedido. Vuelve a armar tu pedido.', 'IDEMPOTENCY_KEY_CONFLICT'))
    const replay = await findReplay(tx, input.venueId, externalId, requestHash)
    if (replay) return replay
    const rejected = await tx.idempotencyRequest.findUnique({
      where: { organizationId_actorStaffId_endpoint_idempotencyKey: keyOfRejection },
    })
    if (!rejected) return null
    if (rejected.requestHash !== requestHash) {
      throw final(new ConflictError('Esa llave ya se usó para otro pedido. Vuelve a armar tu pedido.', 'IDEMPOTENCY_KEY_CONFLICT'))
    }
    const body = rejected.responseBody as { code?: string; message: string; details?: unknown }
    throw final(new AppError(body.message, rejected.responseStatus, true, body.code, body.details))
  }
  /** Codex r3: el rechazo definitivo se guarda y la transacción CONFIRMA devolviéndolo; se lanza después del commit. */
  const saveRejection = async (tx: Prisma.TransactionClient, error: AppError) => {
    await tx.idempotencyRequest.create({
      data: {
        ...keyOfRejection,
        requestHash,
        responseStatus: error.statusCode,
        responseBody: JSON.parse(JSON.stringify({ code: error.code, message: error.message, details: error.details })),
        expiresAt: new Date(now.getTime() + 24 * 3600_000),
      },
    })
    return final(error)
  }

  // 2-5. Codex r4: plan, tienda y cotización se leen ANTES y FUERA de la transacción (cliente raíz). Una transacción abierta que
  //      esperara otra conexión del pool atascaría una ráfaga. No necesitan el candado: un envío que leyó datos viejos encuentra,
  //      ya bajo la llave, el rechazo que guardó su reintento.
  let quote: QuoteResult
  /** Tienda híbrida: se copia del ajuste al pedido y nunca cambia (`false` = folio de «Nadie»). */
  let requiresAcceptance: boolean
  let acceptDeadlineAt: Date
  /** R52 (Codex f1 r5): el horario con el que se comprueba, justo antes de escribir, que el folio nace vigente (sólo folios). */
  let horarioDelFolio: { hours: OnlineOrderingConfig['hours']; timezone: string } | null = null
  try {
    // 2. P1-06: lo que exige un pedido NUEVO (negocio operativo y plan).
    await opts.assertCanCreate()

    // 3. ¿La tienda está recibiendo pedidos?
    const state = await getAcceptingStatus(input.venueId, now, ajustesSinSesion)
    if (state.status !== 'OPEN') {
      throw new ConflictError('La tienda no está recibiendo pedidos en este momento.', `ORDERING_${state.status}`, {
        status: state.status,
        reason: state.reason,
      })
    }
    // «Nadie» sólo con `=== false` (como `getAcceptingStatus`): un ajuste sin el campo es «Mi equipo». R6/R47: un anónimo sólo
    // llega aquí en «Nadie» (la tienda se leyó con los mismos ajustes del paso 1).
    requiresAcceptance = state.config.requiresAcceptance !== false
    if (!state.config.acceptsPayAtPickup) {
      // S8: la tienda vieja abierta en una pestaña muestra este texto ante un código que no conoce. Si la tarjeta SÍ está disponible
      // (misma regla que `paymentModes.cardOnline` de GET /info), le dice qué hacer. El código no cambia.
      const cardOnline = await cardOnlineAvailable(state.config, prisma, input.venueId)
      throw new BadRequestError(
        cardOnline
          ? 'Este negocio ahora cobra con tarjeta en línea. Recarga la página para pagar con tarjeta.'
          : 'Este negocio no acepta pagar al recoger.',
        'PAYMENT_MODE_NOT_ACCEPTED',
      )
    }

    // 4. Cotizar en el servidor (única fuente de verdad) y exigir el total que vio el comensal (R5).
    quote = await quoteCart(input.venueId, input.items, { now })
    if (!quote.ok) {
      throw new BadRequestError('Tu pedido tiene productos que ya no están disponibles o datos incompletos.', 'CART_INVALID', {
        issues: quote.issues,
      })
    }
    if (!quote.total.equals(expectedTotal)) {
      throw new ConflictError('El precio de tu pedido cambió. Revisa el nuevo total antes de confirmar.', 'PRICE_CHANGED', {
        quote: toPublicQuote(quote),
      })
    }
    if (requiresAcceptance) {
      acceptDeadlineAt = new Date(now.getTime() + ACCEPT_TIMEOUT_MINUTES * 60_000)
    } else {
      // Codex r3 #4: el cobro del POS da por «Pagado» un saldo cero sin registrar nada; un folio de $0 nunca pasaría a preparación.
      if (quote.total.isZero()) throw new BadRequestError('Tu pedido no tiene costo: pídelo directo en caja.', 'ZERO_TOTAL')
      // R23: mín(ahora + 30 min, cierre de la franja vigente) en la zona del negocio; sin cierre, sólo 30 min. Se guarda y no se
      // recalcula si cambia el horario.
      const venue = await prisma.venue.findUnique({ where: { id: input.venueId }, select: { timezone: true } })
      horarioDelFolio = { hours: state.config.hours, timezone: venue?.timezone || 'America/Mexico_City' }
      const cierre = closesAt(state.config.hours, now, horarioDelFolio.timezone)
      const plazo = new Date(now.getTime() + FOLIO_TIMEOUT_MINUTES * 60_000)
      acceptDeadlineAt = cierre && cierre < plazo ? cierre : plazo
    }
  } catch (error) {
    // 5. Un rechazo definitivo se decide en una transacción corta, bajo la llave: si ya hay pedido es SU pedido (R8, aunque el plan
    //    venza o la tienda cierre); si ya hay rechazo guardado, ése; si no, se guarda éste. Cualquier otro error sale tal cual.
    if (!isDefinitiveRejection(error)) throw error
    const rejection = error
    const decided = await prisma.$transaction(async tx => (await decidedBefore(tx)) ?? saveRejection(tx, rejection), TX_OPTIONS)
    if (decided instanceof AppError) throw decided
    return decided
  }

  try {
    const result = await prisma.$transaction(async (tx): Promise<CreateOnlineOrderResult | AppError> => {
      const before = await decidedBefore(tx)
      if (before) return before

      let orderNumber: string
      try {
        // Sólo lecturas y candados. La primera escritura (la cuenta) va fuera de este bloque: un rechazo guardado nunca confirma
        // un pedido a medias.
        // 6. R4: la admisión se serializa por negocio. Dentro del candado se repiten la repetición, los topes y el folio:
        //    dos pedidos simultáneos no pasan juntos un tope ni toman el mismo folio. Sin Redis ni tabla de candados.
        await lockAdmission(tx, input.venueId)

        const again = await findReplay(tx, input.venueId, externalId, requestHash)
        if (again) return again

        // Fase 2: los pedidos por aceptar MÁS los borradores de tarjeta con su sesión vigente. T7: sólo con teléfono.
        if (phone) {
          const pendingByPhone =
            (await tx.onlineOrder.count({
              where: { ...awaitingAcceptanceWhere(input.venueId), order: { customerPhone: phone } },
            })) + (await tx.onlineOrderCharge.count({ where: { ...liveCardDraftsWhere(input.venueId, now), customerPhone: phone } }))
          if (pendingByPhone >= MAX_PENDING_PER_PHONE) {
            throw new ConflictError('Ya tienes pedidos esperando respuesta en este negocio.', 'TOO_MANY_PENDING_ORDERS')
          }
        }
        const pendingInVenue =
          (await tx.onlineOrder.count({ where: awaitingAcceptanceWhere(input.venueId) })) +
          (await tx.onlineOrderCharge.count({ where: liveCardDraftsWhere(input.venueId, now) }))
        if (pendingInVenue >= MAX_PENDING_PER_VENUE) {
          throw new ConflictError('La tienda no está recibiendo pedidos en este momento.', 'ORDERING_PAUSED', {
            status: 'PAUSED',
            reason: 'TOO_BUSY',
          })
        }
        if (!requiresAcceptance) await admitFolio(tx, input.venueId, now)

        orderNumber = await pickOrderNumber(tx, input.venueId)
        // R52 (Codex f1 r5): el plazo se calculó con la hora de la petición (R23) y no se estira. Justo antes de escribir, con el reloj
        // de ESTE momento, el folio tiene que nacer vigente y con la tienda abierta (la misma regla de apertura); si cotizar y esperar
        // los candados cruzó el cierre (pidió 20:59:59, se escribe 21:00:05), la misma respuesta que fuera de horario, guardada igual.
        if (horarioDelFolio) {
          const alEscribir = reloj()
          if (
            acceptDeadlineAt.getTime() <= alEscribir.getTime() ||
            !isWithinHours(horarioDelFolio.hours, alEscribir, horarioDelFolio.timezone)
          ) {
            throw new ConflictError('La tienda no está recibiendo pedidos en este momento.', 'ORDERING_CLOSED', {
              status: 'CLOSED',
              reason: 'OUTSIDE_HOURS',
            })
          }
        }
      } catch (error) {
        if (!isDefinitiveRejection(error)) throw error
        return saveRejection(tx, error)
      }

      const created = await writeOnlineOrderInTx(tx, {
        venueId: input.venueId,
        externalId,
        orderNumber,
        quote: toQuoteSnapshot(quote),
        customer: { name: input.customer.name, phone, email: input.customer.email ?? null },
        customerId,
        note,
        paymentMode: OnlineOrderPaymentMode.PAY_AT_PICKUP,
        trackingToken,
        requestHash,
        acceptDeadlineAt,
        whatsappConsent: input.whatsappConsent === true,
        requiresAcceptance,
        channel: input.channel ?? null,
      })
      return {
        orderId: created.orderId,
        onlineOrderId: created.onlineOrderId,
        trackingToken,
        status: OnlineOrderStatus.PENDING_ACCEPTANCE,
        orderNumber,
        total: quote.total.toFixed(2),
        acceptDeadlineAt: acceptDeadlineAt.toISOString(),
        replay: false,
      }
    }, TX_OPTIONS)
    if (result instanceof AppError) throw result // Codex r3: el rechazo ya quedó guardado

    // T7: un folio sin pagar no se anuncia: las apps viejas lo tratarían como cuenta nueva (sale de las listas hasta pagarse).
    if (!result.replay && requiresAcceptance) {
      emitOnlineOrderCreated(input.venueId, { orderId: result.orderId, orderNumber: result.orderNumber, externalId }, now)
    }
    return result
  } catch (error) {
    // Dos peticiones con la misma llave a la vez: gana una, la otra recibe al ganador (si es del mismo cliente, R8).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const again = await findReplay(prisma, input.venueId, externalId, requestHash)
      if (again) return again
    }
    throw error
  }
}

type DraftCharge = { status: OnlineOrderChargeStatus; lastError: string | null }
/** S4 (Codex plan r2 #3): un borrador que sigue `PENDING_AUTH` pero ya se cobró fuera de Avoqado (`capturedOutside`). */
const draftCapturedOutside = (c: DraftCharge) => c.status === OnlineOrderChargeStatus.PENDING_AUTH && c.lastError === CAPTURED_OUTSIDE

/** Fase 2: el borrador de tarjeta todavía no es pedido: espera el pago, o ya no se pagó (vencido, liberado o cobrado fuera). */
export type CardDraftTrackingStatus = 'AWAITING_PAYMENT' | 'PAYMENT_NOT_COMPLETED'
export const cardDraftTrackingStatus = (c: DraftCharge): CardDraftTrackingStatus =>
  c.status === OnlineOrderChargeStatus.PENDING_AUTH && !draftCapturedOutside(c) ? 'AWAITING_PAYMENT' : 'PAYMENT_NOT_COMPLETED'

/**
 * Fase 2: lo que el comensal ve de su tarjeta. `CONFIRMING` = cobrando al aceptar. S4 (Codex plan r1 #3): `RELEASING` = la liberación
 * aún no termina (puede fallar o resultar cobrada a mano): nunca se dice «liberada» antes de tiempo.
 */
export type PublicCardStatus = 'AUTHORIZED' | 'CONFIRMING' | 'CAPTURED' | 'RELEASING' | 'RELEASED'
const PUBLIC_CARD_STATUS: Partial<Record<OnlineOrderChargeStatus, PublicCardStatus>> = {
  AUTHORIZED: 'AUTHORIZED',
  CAPTURING: 'CONFIRMING',
  CAPTURED: 'CAPTURED',
  RELEASING: 'RELEASING',
  RELEASED: 'RELEASED',
}
/** S4: el borrador también dice la verdad de su tarjeta (p. ej. `CAPTURED` sin pedido). */
const draftCardStatus = (c: DraftCharge): PublicCardStatus | null =>
  draftCapturedOutside(c) ? 'CAPTURED' : (PUBLIC_CARD_STATUS[c.status] ?? null)

export interface PublicTracking {
  orderNumber: string
  status: OnlineOrderStatus | CardDraftTrackingStatus
  paymentMode: OnlineOrderPaymentMode
  /** Fase 2: estado de la tarjeta; `null` al recoger y en el borrador que espera el pago. */
  cardStatus?: PublicCardStatus | null
  venueId: string
  venueName: string
  venueSlug: string
  /** 1b: zona del negocio para mostrar las horas del seguimiento (por omisión la de CDMX). */
  venueTimezone: string
  /** 1b: domicilio y teléfono del NEGOCIO (nunca los del comensal). */
  venueContact: VenueContact
  /** T18b: `unitPrice` y `total` del renglón en pesos (opcionales para quien ya lee esta respuesta). */
  items: Array<{
    name: string
    quantity: number
    note: string | null
    unitPrice?: number
    total?: number
    modifiers: Array<{ name: string; quantity: number }>
  }>
  total: number
  paid: boolean
  /** T18b: el nombre con que se hizo el pedido (nunca teléfono ni correo). */
  customerName?: string | null
  /** T18b: ISO del cobro COMPLETED más reciente de la cuenta pagada; `null` si no está pagada. */
  paidAt?: string | null
  estimatedReadyAt: string | null
  acceptDeadlineAt: string
  rejectReason: OnlineOrderRejectReason | null
  createdAt: string
  canCancel: boolean
  /** T15: `false` = folio de «Nadie» (nadie lo acepta). Opcional para quien ya lee esta respuesta. */
  requiresAcceptance?: boolean
  /** T15: por dónde llegó el pedido; `null` con tarjeta o si no se midió. */
  channel?: 'QR' | 'LINK' | null
}

const VENUE_PUBLIC_SELECT = {
  name: true,
  slug: true,
  timezone: true,
  address: true,
  city: true,
  state: true,
  zipCode: true,
  phone: true,
} as const
/** Fase 2: la página de regreso de Stripe confirma sola si el aviso no llegó en estos ms (sin martillar a Stripe en cada consulta). */
const DRAFT_CONFIRM_AFTER_MS = 5_000

/** Estado para la página de seguimiento (el canal garantizado de avisos, R18). Nunca devuelve teléfono ni correo. */
export async function getTrackingByToken(token: string): Promise<PublicTracking | null> {
  const order = await orderTracking(token)
  if (order) return order
  const charge = await prisma.onlineOrderCharge.findUnique({
    where: { trackingToken: token },
    select: { id: true, status: true, updatedAt: true },
  })
  if (!charge) return null
  if (charge.status === OnlineOrderChargeStatus.PENDING_AUTH && Date.now() - charge.updatedAt.getTime() > DRAFT_CONFIRM_AFTER_MS) {
    // Se aparta el turno (CAS sobre `updatedAt`): a lo más UNA consulta a Stripe cada 5 s por borrador, aunque lleguen varias
    // consultas a la vez. El conciliador elige por `checkoutExpiresAt`, así que refrescar `updatedAt` no le esconde nada.
    const claimed = await prisma.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: OnlineOrderChargeStatus.PENDING_AUTH, updatedAt: charge.updatedAt },
      data: { updatedAt: new Date() },
    })
    if (claimed.count === 1) {
      try {
        await confirmCardAuthorization(charge.id)
      } catch (error) {
        logger.warn('[OnlineOrdering] el seguimiento no pudo confirmar la tarjeta (sigue esperando)', { chargeId: charge.id, error })
      }
    }
    const confirmed = await orderTracking(token)
    if (confirmed) return confirmed
  }
  return draftTracking(token)
}

/**
 * S5 (Codex plan r1 #5, r2 #2): el comensal regresó de Stripe sin pagar (`?pago=cancelado`). 🔴 Nunca cancela ni libera un pedido:
 * si el token ya es pedido (otra pestaña pagó), sólo responde su seguimiento. Con un borrador que espera el pago, vence su página
 * en la cuenta conectada de la FOTO del cargo y corre la MISMA confirmación, que relee la sesión: vencida ⇒ `ABANDONED`; completada
 * y apartada ⇒ nace el pedido. Repetir da lo mismo. `null` si el token no es de este negocio.
 */
export async function abandonCardPayment(i: { venueId: string; trackingToken: string }): Promise<PublicTracking | null> {
  const charge = await prisma.onlineOrderCharge.findFirst({
    where: { trackingToken: i.trackingToken, venueId: i.venueId },
    select: { id: true, status: true, lastError: true, checkoutSessionId: true, ecommerceMerchantId: true, merchantSnapshot: true },
  })
  if (charge?.checkoutSessionId && cardDraftTrackingStatus(charge) === 'AWAITING_PAYMENT') {
    const merchant = chargeMerchant(charge)
    let expiredByUs = false
    try {
      await getProvider(merchant).expireAuthorizationCheckout(merchant, charge.checkoutSessionId)
      expiredByUs = true
    } catch (error: any) {
      // Stripe contestó que ya no se puede (vencida o completada): la confirmación decide. Sin respuesta, la página puede seguir
      // abierta y el comensal todavía podría pagar: no se afirma nada (el borrador sigue PENDING_AUTH) y la tienda reintenta.
      if (error?.type !== 'StripeInvalidRequestError') {
        logger.warn('[OnlineOrdering] no se pudo vencer la página de pago abandonada', { chargeId: charge.id, error: error?.message })
        throw new AppError('No pudimos cerrar la página de pago. Intenta de nuevo en un momento.', 502, true, 'CARD_PROVIDER_UNAVAILABLE')
      }
    }
    if (expiredByUs) {
      // Codex servidor r1 #1: Stripe ya la venció. Evidencia local ANTES de confirmar (CAS: sólo si sigue esperando), para que la
      // repetición del POST (S7) no vuelva a mandar esa URL aunque la confirmación de abajo falle.
      await prisma.onlineOrderCharge.updateMany({
        where: { id: charge.id, status: OnlineOrderChargeStatus.PENDING_AUTH },
        data: { checkoutExpiresAt: new Date() },
      })
    }
    try {
      await confirmCardAuthorization(charge.id)
    } catch (error) {
      // Igual que el seguimiento: si la confirmación truena, el borrador sigue esperando y el conciliador lo retoma.
      logger.warn('[OnlineOrdering] el abandono no pudo confirmar la tarjeta (sigue esperando)', { chargeId: charge.id, error })
    }
  }
  const tracking = (await orderTracking(i.trackingToken)) ?? (await draftTracking(i.trackingToken))
  return tracking?.venueId === i.venueId ? tracking : null
}

/** El borrador de tarjeta (sin pedido todavía): renglones y total del carrito guardado, sin folio. */
async function draftTracking(token: string): Promise<PublicTracking | null> {
  const c = await prisma.onlineOrderCharge.findUnique({
    where: { trackingToken: token },
    select: {
      status: true,
      lastError: true,
      request: true,
      amount: true,
      checkoutExpiresAt: true,
      createdAt: true,
      venueId: true,
      venue: { select: VENUE_PUBLIC_SELECT },
    },
  })
  if (!c) return null
  const quote = (c.request as unknown as { quote: QuoteSnapshot }).quote
  return {
    orderNumber: '', // el folio nace con el pedido
    status: cardDraftTrackingStatus(c),
    paymentMode: OnlineOrderPaymentMode.CARD_ONLINE,
    cardStatus: draftCardStatus(c),
    venueId: c.venueId,
    venueName: c.venue.name,
    venueSlug: c.venue.slug,
    venueTimezone: c.venue.timezone || 'America/Mexico_City',
    venueContact: buildVenueContact(c.venue),
    items: quote.lines.slice(0, 100).map(l => ({
      name: l.productName,
      quantity: l.quantity,
      note: l.note ?? null,
      modifiers: l.modifiers.map(m => ({ name: m.name, quantity: m.quantity })),
    })),
    total: Number(new Prisma.Decimal(c.amount).toFixed(2)),
    paid: false,
    estimatedReadyAt: null,
    acceptDeadlineAt: c.checkoutExpiresAt.toISOString(), // en el borrador, cuándo vence la página de pago
    rejectReason: null,
    createdAt: c.createdAt.toISOString(),
    canCancel: false,
    requiresAcceptance: true, // el borrador de tarjeta es de «Mi equipo»
    channel: null,
  }
}

async function orderTracking(token: string): Promise<PublicTracking | null> {
  const row = await prisma.onlineOrder.findUnique({
    where: { trackingToken: token },
    select: {
      status: true,
      paymentMode: true,
      requiresAcceptance: true,
      channel: true,
      acceptDeadlineAt: true,
      estimatedReadyAt: true,
      rejectReason: true,
      createdAt: true,
      venueId: true,
      charge: { select: { status: true } },
      order: {
        select: {
          orderNumber: true,
          total: true,
          paymentStatus: true,
          customerName: true,
          payments: { // `type` es nullable y `<> 'REFUND'` también descarta NULL; orderBalance cuenta NULL como cobro.
          where: { status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
          venue: { select: VENUE_PUBLIC_SELECT },
          items: {
            take: 100,
            orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
            select: {
              productName: true,
              quantity: true,
              notes: true,
              unitPrice: true,
              total: true,
              modifiers: { take: 50, select: { name: true, quantity: true } },
            },
          },
        },
      },
    },
  })
  if (!row) return null
  const pending = row.status === OnlineOrderStatus.PENDING_ACCEPTANCE && row.order.paymentStatus === PaymentStatus.PENDING
  return {
    orderNumber: row.order.orderNumber,
    status: row.status,
    paymentMode: row.paymentMode,
    cardStatus: row.charge ? (PUBLIC_CARD_STATUS[row.charge.status] ?? null) : null,
    venueId: row.venueId,
    venueName: row.order.venue.name,
    venueSlug: row.order.venue.slug,
    venueTimezone: row.order.venue.timezone || 'America/Mexico_City',
    venueContact: buildVenueContact(row.order.venue),
    items: row.order.items.map(i => ({
      name: i.productName ?? '',
      quantity: i.quantity,
      note: i.notes ?? null,
      unitPrice: Number(new Prisma.Decimal(i.unitPrice).toFixed(2)),
      total: Number(new Prisma.Decimal(i.total).toFixed(2)),
      modifiers: i.modifiers.map(m => ({ name: m.name ?? '', quantity: m.quantity })),
    })),
    total: Number(new Prisma.Decimal(row.order.total).toFixed(2)),
    paid: row.order.paymentStatus === PaymentStatus.PAID,
    customerName: row.order.customerName ?? null,
    paidAt: row.order.paymentStatus === PaymentStatus.PAID ? (row.order.payments[0]?.createdAt.toISOString() ?? null) : null,
    estimatedReadyAt: row.estimatedReadyAt ? row.estimatedReadyAt.toISOString() : null,
    acceptDeadlineAt: row.acceptDeadlineAt.toISOString(),
    rejectReason: row.rejectReason ?? null,
    createdAt: row.createdAt.toISOString(),
    // R1: con dinero encima el comensal ya no cancela desde aquí (respondería HAS_PAYMENTS). Fase 2: con tarjeta, sólo apartada.
    canCancel:
      row.paymentMode === OnlineOrderPaymentMode.CARD_ONLINE
        ? pending && row.charge?.status === OnlineOrderChargeStatus.AUTHORIZED
        : pending,
    requiresAcceptance: row.requiresAcceptance,
    channel: (row.channel as 'QR' | 'LINK' | null) ?? null,
  }
}
