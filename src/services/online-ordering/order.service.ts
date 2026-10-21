// src/services/online-ordering/order.service.ts
import {
  ContratoDePrecio,
  KitchenStatus,
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
import { ACCEPT_TIMEOUT_MINUTES, MAX_PENDING_PER_PHONE, MAX_PENDING_PER_VENUE, OPEN_ORDER_STATUSES } from './constants'
import { generateOrderNumber } from './orderNumber'
import { getAcceptingStatus } from './presence.service'
import { buildVenueContact, type VenueContact } from './settings.service'
import { quoteCart, toPublicQuote, type CartItemInput, type QuoteResult } from './quote.service'
import { generateTrackingToken } from './trackingToken'

export interface CreateOnlineOrderInput {
  venueId: string
  idempotencyKey: string
  items: CartItemInput[]
  paymentMode: 'PAY_AT_PICKUP'
  /** R5: el total que el comensal vio y confirmó, en pesos con 2 decimales («206.00»). */
  expectedTotal: string
  customer: { name: string; phone: string; email?: string | null }
  /** De la sesión de cliente (`req.customerAuth`), nunca del cuerpo. */
  customerId: string | null
  /** R6/H1: el teléfono que probó el OTP de WhatsApp (reclamo `verifiedPhone` del token de PEDIDOS, tarea 7b). */
  verifiedPhone: string | null
  note?: string | null
  whatsappConsent?: boolean
  now?: Date
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
 * Pedido ya creado con esta llave. R8: sólo se repite para QUIEN lo hizo; con otro cliente la llave choca. M-3/A1: y sólo si es la
 * MISMA solicitud (su huella): con otro carrito o total la llave también choca (el comensal creería que pidió lo nuevo). Sin
 * huella guardada, también choca.
 */
async function findReplay(
  db: Prisma.TransactionClient,
  venueId: string,
  externalId: string,
  customerId: string,
  requestHash: string,
): Promise<CreateOnlineOrderResult | null> {
  const existing = await db.order.findUnique({
    where: { venueId_externalId: { venueId, externalId } },
    select: {
      id: true,
      orderNumber: true,
      total: true,
      customerId: true,
      onlineOrder: { select: { id: true, status: true, trackingToken: true, acceptDeadlineAt: true, requestHash: true } },
    },
  })
  if (!existing?.onlineOrder) return null
  if (existing.customerId !== customerId) {
    throw final(new ConflictError('Esa llave ya se usó para otro pedido. Vuelve a armar tu pedido.', 'IDEMPOTENCY_KEY_CONFLICT'))
  }
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
function lockAdmission(tx: Prisma.TransactionClient, venueId: string) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-order-admission:' + venueId}))`
}

/**
 * Codex r2: un solo envío de esta llave a la vez mientras DECIDE (repetición, rechazo guardado, topes y creación). Un reintento
 * espera a que el envío vivo termine: si creó, recibe su pedido. Siempre ANTES del candado del negocio (sin abrazo mortal).
 */
function lockKey(tx: Prisma.TransactionClient, venueId: string, externalId: string) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-order-key:' + venueId + ':' + externalId}))`
}

/**
 * Codex r3: la primera DECISIÓN sobre una llave es durable (como Stripe, que también guarda el resultado de un error). Sin
 * migración, en la tabla genérica `IdempotencyRequest` (custodia de SIMs y comandos de la TPV): los prefijos `venue:` y
 * `customer:` nunca chocan con sus ids de organización y de staff. ponytail: sin purga (sólo nacen al rechazar, volumen bajo);
 * si crecen, borrar por `expiresAt` (ya indexado).
 */
const rejectionKey = (venueId: string, customerId: string, idempotencyKey: string) => ({
  organizationId: `venue:${venueId}`,
  actorStaffId: `customer:${customerId}`,
  endpoint: 'POST /public/ordering/orders',
  idempotencyKey,
})

/** El rechazo que la tienda da por definitivo y con el que suelta la llave: todo 4xx salvo 401, 408 y 429 (`isDefinitive`). */
const isDefinitiveRejection = (error: unknown): error is AppError =>
  error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && ![401, 408, 429].includes(error.statusCode)

/**
 * Codex r4: decisión DURABLE sobre la llave (rechazo guardado, o la llave ya es de otro pedido). El controlador la responde con
 * `final: true` y sólo con ella la tienda puede soltar la llave ante un 404 (el del resolver, previo a decidir, no la lleva).
 */
const final = <E extends AppError>(error: E): E & { final: true } => Object.assign(error, { final: true as const })

const TX_OPTIONS = { timeout: 15_000, maxWait: 5_000 }

/** Folio corto que no choque con otra cuenta ABIERTA del mismo negocio (dentro del candado de admisión). */
async function pickOrderNumber(tx: Prisma.TransactionClient, venueId: string): Promise<string> {
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

export async function createOnlineOrder(input: CreateOnlineOrderInput, opts: CreateOnlineOrderOptions): Promise<CreateOnlineOrderResult> {
  const now = input.now ?? new Date()
  const externalId = `web:${input.idempotencyKey}`

  // 1. R6: pagar al recoger exige el teléfono PROBADO por el OTP de WhatsApp, y que sea el del pedido. Tener un teléfono en
  //    la ficha no prueba nada.
  if (!input.customerId || !input.verifiedPhone || !phonesMatch(input.verifiedPhone, input.customer.phone)) {
    throw new UnauthorizedError('Verifica tu teléfono por WhatsApp para pedir y pagar al recoger.', 'PHONE_VERIFICATION_REQUIRED')
  }
  const customerId = input.customerId
  // R23: la forma canónica de la casa (la misma que compara `phonesMatch`: `+521…` → `+52…`); si no la entiende, «+» y sólo
  // dígitos.
  const phone = canonicalPhoneE164(input.verifiedPhone) ?? `+${input.verifiedPhone.replace(/\D/g, '')}`
  // R5: el total que vio el comensal (el Zod de la ruta ya validó «206.00»).
  const expectedTotal = new Prisma.Decimal(input.expectedTotal)
  // A1: la huella decide si una repetición es SU pedido (M-3); se guarda al crear.
  const requestHash = onlineOrderRequestHash({
    venueId: input.venueId,
    customerId,
    paymentMode: input.paymentMode,
    expectedTotal,
    items: input.items,
    customerName: input.customer.name,
    customerPhone: phone,
  })

  const trackingToken = generateTrackingToken()
  const acceptDeadlineAt = new Date(now.getTime() + ACCEPT_TIMEOUT_MINUTES * 60_000)
  const zero = new Prisma.Decimal(0)
  const note = input.note?.trim() ? input.note.trim() : null

  const keyOfRejection = rejectionKey(input.venueId, customerId, input.idempotencyKey)

  /**
   * Bajo el candado de la llave, lo ya decidido gana: SU pedido (R8) o, Codex r3, el MISMO rechazo guardado aunque plan, tienda o
   * precio ya cambiaron (la tienda soltó la llave con él; un envío tardío que creara duplicaría el pedido del siguiente intento).
   */
  const decidedBefore = async (tx: Prisma.TransactionClient): Promise<CreateOnlineOrderResult | null> => {
    await lockKey(tx, input.venueId, externalId)
    const replay = await findReplay(tx, input.venueId, externalId, customerId, requestHash)
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
  try {
    // 2. P1-06: lo que exige un pedido NUEVO (negocio operativo y plan).
    await opts.assertCanCreate()

    // 3. ¿La tienda está recibiendo pedidos?
    const state = await getAcceptingStatus(input.venueId, now)
    if (state.status !== 'OPEN') {
      throw new ConflictError('La tienda no está recibiendo pedidos en este momento.', `ORDERING_${state.status}`, {
        status: state.status,
        reason: state.reason,
      })
    }
    if (!state.config.acceptsPayAtPickup) {
      throw new BadRequestError('Este negocio no acepta pagar al recoger.', 'PAYMENT_MODE_NOT_ACCEPTED')
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

        const again = await findReplay(tx, input.venueId, externalId, customerId, requestHash)
        if (again) return again

        const pendingByPhone = await tx.onlineOrder.count({
          where: { venueId: input.venueId, status: OnlineOrderStatus.PENDING_ACCEPTANCE, order: { customerPhone: phone } },
        })
        if (pendingByPhone >= MAX_PENDING_PER_PHONE) {
          throw new ConflictError('Ya tienes pedidos esperando respuesta en este negocio.', 'TOO_MANY_PENDING_ORDERS')
        }
        const pendingInVenue = await tx.onlineOrder.count({
          where: { venueId: input.venueId, status: OnlineOrderStatus.PENDING_ACCEPTANCE },
        })
        if (pendingInVenue >= MAX_PENDING_PER_VENUE) {
          throw new ConflictError('La tienda no está recibiendo pedidos en este momento.', 'ORDERING_PAUSED', {
            status: 'PAUSED',
            reason: 'TOO_BUSY',
          })
        }

        orderNumber = await pickOrderNumber(tx, input.venueId)
      } catch (error) {
        if (!isDefinitiveRejection(error)) throw error
        return saveRejection(tx, error)
      }

      // 🔴 NO se estampa `shiftId`, y es DELIBERADO — no lo "arregles": el pedido nace desde el teléfono del comensal, no en el
      // mostrador con el cajero enfrente (criterio de `tests/unit/services/shared/ordenLlevaElTurno.guard.test.ts`, donde la
      // tarea 15b lo clasifica). El dinero SÍ cae en el turno: `payCashOrder` estampa `Payment.shiftId` al cobrar (tarea 15).
      const order = await tx.order.create({
        data: {
          venueId: input.venueId,
          orderNumber,
          type: OrderType.PICKUP,
          source: OrderSource.WEB,
          originSystem: OriginSystem.AVOQADO,
          externalId,
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
          customerName: input.customer.name,
          customerPhone: phone,
          customerEmail: input.customer.email ?? null,
          specialRequests: note,
          customerId,
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
              externalId: `${externalId}-${idx}`,
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
          venueId: input.venueId,
          status: OnlineOrderStatus.PENDING_ACCEPTANCE,
          paymentMode: OnlineOrderPaymentMode.PAY_AT_PICKUP,
          trackingToken,
          requestHash,
          acceptDeadlineAt,
          whatsappConsent: input.whatsappConsent === true,
        },
      })
      // S3: `verify` para PEDIR no pone nombre (R7: no activa la cuenta de reservas) y la tienda no lo manda al verificar; sin esto
      // el Customer nacía vacío y «Clientes» lo mostraba sin nombre. Sólo llena si estaba vacío, nunca pisa lo del negocio, y una
      // repetición ya salió arriba sin llegar aquí. No toca la cuenta de reservas.
      const cliente = await tx.customer.findFirst({ where: { id: customerId, venueId: input.venueId } })
      if (cliente) await ponerNombreSiFalta(tx, cliente, input.customer.name)
      return {
        orderId: order.id,
        onlineOrderId: online.id,
        trackingToken,
        status: OnlineOrderStatus.PENDING_ACCEPTANCE,
        orderNumber,
        total: quote.total.toFixed(2),
        acceptDeadlineAt: acceptDeadlineAt.toISOString(),
        replay: false,
      }
    }, TX_OPTIONS)
    if (result instanceof AppError) throw result // Codex r3: el rechazo ya quedó guardado

    if (!result.replay) {
      try {
        socketManager.broadcastToVenue(input.venueId, SocketEventType.ORDER_CREATED, {
          orderId: result.orderId,
          orderNumber: result.orderNumber,
          venueId: input.venueId,
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          source: OrderSource.WEB,
          externalId,
          eventType: 'created',
          timestamp: now.toISOString(),
        })
      } catch (error) {
        logger.error('[OnlineOrdering] socket emit falló (no fatal)', { orderId: result.orderId, error })
      }
    }
    return result
  } catch (error) {
    // Dos peticiones con la misma llave a la vez: gana una, la otra recibe al ganador (si es del mismo cliente, R8).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const again = await findReplay(prisma, input.venueId, externalId, customerId, requestHash)
      if (again) return again
    }
    throw error
  }
}

export interface PublicTracking {
  orderNumber: string
  status: OnlineOrderStatus
  paymentMode: OnlineOrderPaymentMode
  venueId: string
  venueName: string
  venueSlug: string
  /** 1b: zona del negocio para mostrar las horas del seguimiento (por omisión la de CDMX). */
  venueTimezone: string
  /** 1b: domicilio y teléfono del NEGOCIO (nunca los del comensal). */
  venueContact: VenueContact
  items: Array<{ name: string; quantity: number; note: string | null; modifiers: Array<{ name: string; quantity: number }> }>
  total: number
  paid: boolean
  estimatedReadyAt: string | null
  acceptDeadlineAt: string
  rejectReason: OnlineOrderRejectReason | null
  createdAt: string
  canCancel: boolean
}

/** Estado para la página de seguimiento (el canal garantizado de avisos, R18). Nunca devuelve teléfono ni correo. */
export async function getTrackingByToken(token: string): Promise<PublicTracking | null> {
  const row = await prisma.onlineOrder.findUnique({
    where: { trackingToken: token },
    select: {
      status: true,
      paymentMode: true,
      acceptDeadlineAt: true,
      estimatedReadyAt: true,
      rejectReason: true,
      createdAt: true,
      venueId: true,
      order: {
        select: {
          orderNumber: true,
          total: true,
          paymentStatus: true,
          venue: {
            select: { name: true, slug: true, timezone: true, address: true, city: true, state: true, zipCode: true, phone: true },
          },
          items: {
            take: 100,
            orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
            select: { productName: true, quantity: true, notes: true, modifiers: { take: 50, select: { name: true, quantity: true } } },
          },
        },
      },
    },
  })
  if (!row) return null
  return {
    orderNumber: row.order.orderNumber,
    status: row.status,
    paymentMode: row.paymentMode,
    venueId: row.venueId,
    venueName: row.order.venue.name,
    venueSlug: row.order.venue.slug,
    venueTimezone: row.order.venue.timezone || 'America/Mexico_City',
    venueContact: buildVenueContact(row.order.venue),
    items: row.order.items.map(i => ({
      name: i.productName ?? '',
      quantity: i.quantity,
      note: i.notes ?? null,
      modifiers: i.modifiers.map(m => ({ name: m.name ?? '', quantity: m.quantity })),
    })),
    total: Number(new Prisma.Decimal(row.order.total).toFixed(2)),
    paid: row.order.paymentStatus === PaymentStatus.PAID,
    estimatedReadyAt: row.estimatedReadyAt ? row.estimatedReadyAt.toISOString() : null,
    acceptDeadlineAt: row.acceptDeadlineAt.toISOString(),
    rejectReason: row.rejectReason ?? null,
    createdAt: row.createdAt.toISOString(),
    // R1: con dinero encima el comensal ya no cancela desde aquí (respondería HAS_PAYMENTS).
    canCancel: row.status === OnlineOrderStatus.PENDING_ACCEPTANCE && row.order.paymentStatus === PaymentStatus.PENDING,
  }
}
