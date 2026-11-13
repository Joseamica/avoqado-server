/**
 * Mercado Pago IPN (webhook) payment-flow handler.
 *
 * Pipeline:
 *   1. Atomic dedupe insert into MercadoPagoWebhookEvent. The unique
 *      constraint (mpUserId, dataId, requestId) means duplicate deliveries
 *      raise P2002 — we short-circuit on that.
 *   2. Resolve the seller's EcommerceMerchant via providerMerchantId == mpUserId.
 *   3. Load + decrypt the seller's access_token.
 *   4. Fetch the authoritative payment state from MP API (the IPN body is
 *      just a notification trigger; status truth comes from /v1/payments/:id).
 *   5. Find the CheckoutSession by external_reference (which we set to our
 *      CheckoutSession.sessionId at preference/payment creation time).
 *   6. Update CheckoutSession.mpPaymentId, mpMerchantOrderId, status, completedAt.
 *   7. Mark the webhook event row processed.
 *
 * All branches end by marking the webhook event's `processingStatus` so the
 * row serves as both dedupe key AND audit log.
 */
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { getPayment, mpToCheckoutStatus } from './payment.service'
import { loadCredentials, type DecryptedCredentials } from './connection.service'
import type { MercadoPagoWebhookPayload } from './types'

export interface HandleIpnParams {
  payload: MercadoPagoWebhookPayload
  /** x-request-id from the IPN HTTP request — part of the dedupe key. */
  requestId: string
}

export type HandleIpnResult =
  | { status: 'processed'; checkoutSessionId: string; paymentId: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string }
  | { status: 'error'; reason: string }

export async function handleIpn(p: HandleIpnParams): Promise<HandleIpnResult> {
  const mpUserId = String(p.payload.user_id)
  const dataId = String(p.payload.data.id)
  const eventType = p.payload.type
  const action = p.payload.action

  // 1. Atomic dedupe. The unique constraint on (mpUserId, dataId, requestId)
  //    is our O(1) "have we seen this?" check. A failed delivery is NOT lost
  //    by the dedupe: its row stays 'error'/'pending' and the MP recovery job
  //    (`mercadopago-cierre-perdido.job.ts`) retries it.
  try {
    await prisma.mercadoPagoWebhookEvent.create({
      data: {
        mpUserId,
        dataId,
        requestId: p.requestId,
        eventType,
        action,
        // Cast to any because Prisma's Json input type is broad and the MP
        // payload shape isn't worth fighting the compiler over.
        payload: p.payload as unknown as object,
        processingStatus: 'pending',
      },
    })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return { status: 'duplicate' }
    }
    throw err
  }

  // 2. Only "payment" events are processed in v1. Other types (merchant_order,
  //    claim, chargeback) are logged for future handling but not acted on.
  if (eventType !== 'payment') {
    await markStatus(mpUserId, dataId, p.requestId, 'ignored', `unsupported event type ${eventType}`)
    return { status: 'ignored', reason: `unsupported event type ${eventType}` }
  }

  // 3. Find the seller (the EcommerceMerchant who owns this mpUserId).
  const merchant = await buscarComercioDeMercadoPago(mpUserId)
  if (!merchant) {
    await markStatus(mpUserId, dataId, p.requestId, 'error', `no merchant matches mpUserId ${mpUserId}`)
    return { status: 'error', reason: 'merchant_not_found' }
  }

  // 4-8. Consultar a MP, escribir la sesión y cerrar la venta: lo mismo que repite el barrido.
  const d = await procesarPagoDeMercadoPago(merchant, dataId)
  await markStatus(mpUserId, dataId, p.requestId, d.estado, d.detalle)
  if (!d.checkoutSessionId) {
    return d.estado === 'ignored' ? { status: 'ignored', reason: d.razon } : { status: 'error', reason: d.razon }
  }

  logger.info('[MP] IPN processed', {
    checkoutSessionId: d.checkoutSessionId,
    paymentId: d.paymentId,
    mpStatus: d.mpStatus,
    requestId: p.requestId,
  })

  return {
    status: 'processed',
    checkoutSessionId: d.checkoutSessionId,
    paymentId: d.paymentId!,
  }
}

/** El comercio de Avoqado dueño de una cuenta de MP (providerMerchantId == user_id del aviso). */
export async function buscarComercioDeMercadoPago(mpUserId: string): Promise<{ id: string; venueId: string } | null> {
  return prisma.ecommerceMerchant.findFirst({
    where: { providerMerchantId: mpUserId, provider: { code: 'MERCADO_PAGO' } },
    select: { id: true, venueId: true },
  })
}

/** Lo que pasó al procesar un pago de MP. `detalle` va a `errorMessage` del evento. */
export interface DesenlaceDePagoMp {
  estado: 'processed' | 'ignored' | 'error'
  razon: string
  detalle: string | null
  checkoutSessionId?: string
  paymentId?: string
  mpStatus?: string
  /** true sólo si ESTA llamada creó la venta (Order + Payment). */
  ventaCreada?: boolean
}

/**
 * Pasos 4-8 del aviso de MP, reutilizados por el barrido de recuperación:
 * credenciales → estado real en MP → sesión por external_reference → escribir
 * el desenlace (CAS) → si está aprobado, cerrar la venta (idempotente).
 * Nunca lanza por un fallo de MP o del cierre: lo devuelve como 'error' para que
 * el evento quede reintentable.
 */
export async function procesarPagoDeMercadoPago(
  merchant: { id: string },
  dataId: string,
  /** Sólo el barrido: credenciales ya cargadas (una vez por vendedor y vuelta) y la bitácora de recuperación del cierre. */
  barrido?: { creds: DecryptedCredentials | null; auditoriaDeRecuperacion?: Record<string, unknown> },
): Promise<DesenlaceDePagoMp> {
  const creds = barrido ? barrido.creds : await loadCredentials(merchant.id)
  if (!creds) {
    return { estado: 'error', razon: 'credentials_missing', detalle: 'merchant credentials missing' }
  }

  // Estado autoritativo: el aviso sólo dice "algo cambió"; la verdad es /v1/payments/:id.
  let payment
  try {
    payment = await getPayment(creds.accessToken, dataId)
  } catch (err: any) {
    return { estado: 'error', razon: 'fetch_failed', detalle: err?.message ?? String(err) }
  }

  // Sesión por external_reference (lo pusimos = CheckoutSession.sessionId al crear el pago).
  const externalRef = payment.external_reference
  if (!externalRef) {
    return { estado: 'ignored', razon: 'no_external_reference', detalle: 'no external_reference on payment' }
  }

  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId: externalRef, ecommerceMerchantId: merchant.id },
  })
  if (!session) {
    return { estado: 'ignored', razon: 'session_not_found', detalle: `session_not_found for ${externalRef}` }
  }

  const checkoutStatus = mpToCheckoutStatus(payment.status)
  await escribirDesenlaceDeMercadoPago({
    sessionDbId: session.id,
    mpPaymentId: String(payment.id),
    mpMerchantOrderId: payment.order?.id ? String(payment.order.id) : null,
    status: checkoutStatus,
  })

  const base = { checkoutSessionId: session.id, paymentId: String(payment.id), mpStatus: payment.status }
  // Rechazado, cancelado o reembolsado en MP es definitivo: el evento queda `ignored` y el barrido deja de revisar la sesión.
  if (checkoutStatus === 'CANCELLED' || checkoutStatus === 'FAILED') {
    return { estado: 'ignored', razon: 'processed', detalle: `MP ${payment.status}: desenlace final, sin venta`, ...base }
  }
  if (checkoutStatus !== 'COMPLETED') return { estado: 'processed', razon: 'processed', detalle: null, ...base }

  // Order + Payment al aprobar. Idempotente (paymentId de la sesión + Payment.idempotencyKey = mpPaymentId), así que
  // el aviso, la respuesta optimista y el barrido pueden llegar en cualquier orden. Import dinámico: evita el ciclo
  // entre el módulo de MP y paymentLink.service.
  const { finalizeMercadoPagoCheckout } = await import('@/services/dashboard/paymentLink.service')
  try {
    const ventaCreada = await finalizeMercadoPagoCheckout({
      sessionId: session.sessionId,
      mpPaymentId: payment.id,
      paymentTypeId: payment.payment_type_id,
      auditoriaDeRecuperacion: barrido?.auditoriaDeRecuperacion,
    })
    return { estado: 'processed', razon: 'processed', detalle: null, ventaCreada, ...base }
  } catch (err) {
    // Cobrado en MP sin venta local: el evento queda 'error' y el barrido lo reintenta.
    const detalle = err instanceof Error ? err.message : String(err)
    logger.error('[MP IPN] finalizeMercadoPagoCheckout failed — charged on MP but no local Order/Payment', {
      sessionId: session.sessionId,
      mpPaymentId: String(payment.id),
      error: detalle,
    })
    return { estado: 'error', razon: 'finalize_failed', detalle, ...base }
  }
}

/**
 * Escribe en la sesión lo que dijo MP sin que un desenlace confirmado retroceda
 * (PENDING < COMPLETED < FAILED). Una respuesta vieja (la optimista de mp-pay, o
 * un aviso lento) que dice «pendiente» o «rechazado» NO pisa un COMPLETED ni un
 * FAILED: antes lo pisaba y la sesión cobrada se escondía de la recuperación
 * (Codex r2 H4). Una aprobación vieja tampoco pisa un FAILED (refunded /
 * charged_back, que MP reporta después de aprobar). completedAt sólo la primera vez.
 * Devuelve si escribió.
 */
export async function escribirDesenlaceDeMercadoPago(args: {
  sessionDbId: string
  mpPaymentId: string
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  mpMerchantOrderId?: string | null
}): Promise<boolean> {
  const data = {
    mpPaymentId: args.mpPaymentId,
    status: args.status,
    ...(args.mpMerchantOrderId !== undefined && { mpMerchantOrderId: args.mpMerchantOrderId }),
  }
  if (args.status === 'COMPLETED') {
    // Una aprobación vieja no revive un reembolso ya escrito (FAILED): el cierre tampoco crea venta (lo reclama COMPLETED).
    const noReembolsada = { not: 'FAILED' as const }
    const primera = await prisma.checkoutSession.updateMany({
      where: { id: args.sessionDbId, status: noReembolsada, completedAt: null },
      data: { ...data, completedAt: new Date() },
    })
    if (primera.count > 0) return true
    return (await prisma.checkoutSession.updateMany({ where: { id: args.sessionDbId, status: noReembolsada }, data })).count > 0
  }
  const where =
    args.status === 'FAILED'
      ? { id: args.sessionDbId }
      : { id: args.sessionDbId, status: { notIn: ['COMPLETED' as const, 'FAILED' as const] } }
  return (await prisma.checkoutSession.updateMany({ where, data })).count > 0
}

/**
 * Update the webhook event row's processingStatus + errorMessage. Uses
 * updateMany so it's safe even if the row doesn't exist (no exception).
 */
async function markStatus(
  mpUserId: string,
  dataId: string,
  requestId: string,
  status: 'processed' | 'ignored' | 'error',
  errorMessage: string | null,
): Promise<void> {
  await prisma.mercadoPagoWebhookEvent.updateMany({
    where: { mpUserId, dataId, requestId },
    data: { processingStatus: status, errorMessage },
  })
}
