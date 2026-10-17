import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import { sendOrderStatusUpdateWhatsApp } from '@/services/whatsapp.service'
import { sanitizeTemplateVar } from '@/utils/whatsappSanitize'

export type OrderNotificationEvent = 'ACCEPTED' | 'READY' | 'REJECTED' | 'EXPIRED' | 'CANCELLED'

const DEFAULT_STOREFRONT_BASE_URL = 'https://pedidos.avoqado.io'
let warnedDefaultStorefrontBase = false

/** Sin diagonal final. Si falta la variable se usa el dominio propuesto en el spec (aún por confirmar) y se avisa UNA vez por proceso. */
const storefrontBase = (): string => {
  const configured = process.env.ORDERING_STOREFRONT_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (!warnedDefaultStorefrontBase) {
    warnedDefaultStorefrontBase = true
    logger.warn(
      `[OnlineOrdering] ORDERING_STOREFRONT_BASE_URL no está configurada: las ligas de seguimiento de los avisos usan ${DEFAULT_STOREFRONT_BASE_URL}`,
    )
  }
  return DEFAULT_STOREFRONT_BASE_URL
}

/** Sólo para pruebas: vuelve a permitir el aviso de «URL base sin configurar». */
export const __resetStorefrontBaseWarningForTests = (): void => {
  warnedDefaultStorefrontBase = false
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function buildOrderMessage(
  event: OrderNotificationEvent,
  ctx: { orderNumber: string; venueName: string; estimatedMinutes: number | null },
): { subject: string; text: string } {
  const { orderNumber: folio, venueName: venue } = ctx
  switch (event) {
    case 'ACCEPTED': {
      const eta = ctx.estimatedMinutes ? ` Estará listo en aproximadamente ${ctx.estimatedMinutes} min.` : ''
      return { subject: `Tu pedido ${folio} fue aceptado`, text: `${venue} aceptó tu pedido ${folio}.${eta}` }
    }
    case 'READY':
      return { subject: `Tu pedido ${folio} está listo`, text: `Tu pedido ${folio} en ${venue} ya está listo para recoger.` }
    case 'REJECTED':
      return {
        subject: `${venue} no pudo aceptar tu pedido ${folio}`,
        text: `${venue} no pudo aceptar tu pedido ${folio}. No se te cobró nada.`,
      }
    case 'EXPIRED':
      return {
        subject: `${venue} no alcanzó a responder tu pedido ${folio}`,
        text: `${venue} no alcanzó a responder tu pedido ${folio}. No se te cobró nada.`,
      }
    case 'CANCELLED':
      return { subject: `Se canceló tu pedido ${folio}`, text: `Se canceló tu pedido ${folio} en ${venue}.` }
  }
}

/**
 * Avisa al comensal por los canales disponibles. NUNCA lanza: un aviso fallido no puede tumbar una operación.
 * R18: sin bitácora de envíos; el correo lleva su llave idempotente y un fallo queda en `logger.error`. La página de
 * seguimiento es el canal garantizado (spec §5.6).
 *
 * Contrato para quien la llama (tarea 9, transiciones):
 * - Llamarla DESPUÉS de que la transacción del CAS ganador haya confirmado (commit), y sólo desde el ganador.
 * - NO esperarla (`await`) dentro de una transacción: lee con el `prisma` global, así que dentro de una tx vería datos
 *   viejos (por ejemplo, sin `acceptedAt` y por lo tanto sin hora estimada) y alargaría la tx con llamadas de red.
 */
export async function notifyOrderEvent(orderId: string, event: OrderNotificationEvent): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true,
        customerName: true,
        customerPhone: true,
        customerEmail: true,
        venue: { select: { name: true, slug: true } },
        onlineOrder: { select: { whatsappConsent: true, trackingToken: true, acceptedAt: true, estimatedReadyAt: true } },
      },
    })
    if (!order?.onlineOrder) return

    const minutes =
      order.onlineOrder.acceptedAt && order.onlineOrder.estimatedReadyAt
        ? Math.max(1, Math.round((order.onlineOrder.estimatedReadyAt.getTime() - order.onlineOrder.acceptedAt.getTime()) / 60_000))
        : null
    const { subject, text } = buildOrderMessage(event, {
      orderNumber: order.orderNumber,
      venueName: order.venue.name,
      estimatedMinutes: minutes,
    })
    const trackUrl = `${storefrontBase()}/${encodeURIComponent(order.venue.slug)}/pedido/${encodeURIComponent(
      order.onlineOrder.trackingToken,
    )}`

    if (order.customerEmail) {
      const name = order.customerName?.trim()
      const greeting = name ? `Hola ${escapeHtml(name)},` : 'Hola,'
      const html =
        `<p>${greeting}</p><p>${escapeHtml(text)}</p>` +
        `<p><a href="${escapeHtml(trackUrl)}">Ver mi pedido</a></p><p style="color:#666">${escapeHtml(order.venue.name)}</p>`
      try {
        const r = await emailService.sendEmailWithResult({
          to: order.customerEmail,
          subject,
          html,
          text: `${text}\n${trackUrl}`,
          idempotencyKey: `online-order:${orderId}:${event}:EMAIL`,
        })
        if (!r.ok) {
          // A15: un destinatario imposible y NO transitorio es un correo mal escrito por el comensal, no una falla del servidor.
          const delComensal = r.errorCode === 'UNDELIVERABLE_RECIPIENT' && r.transient === false
          logger[delComensal ? 'warn' : 'error']('[OnlineOrdering] el correo del aviso no salió', {
            orderId,
            event,
            channel: 'EMAIL',
            errorCode: r.errorCode ?? 'UNKNOWN',
            transient: r.transient,
          })
        }
      } catch (error) {
        logger.error('[OnlineOrdering] el correo del aviso no salió', {
          orderId,
          event,
          channel: 'EMAIL',
          errorCode: 'EXCEPTION',
          error: errorText(error),
        })
      }
    }

    if (process.env.ONLINE_ORDERING_WHATSAPP_ENABLED === 'true' && order.onlineOrder.whatsappConsent && order.customerPhone) {
      try {
        const ok = await sendOrderStatusUpdateWhatsApp(order.customerPhone, {
          customerName: sanitizeTemplateVar(order.customerName ?? '', 40) || 'cliente',
          venueName: sanitizeTemplateVar(order.venue.name, 60),
          status: sanitizeTemplateVar(text, 200),
        })
        if (!ok) {
          logger.error('[OnlineOrdering] el WhatsApp del aviso no salió', {
            orderId,
            event,
            channel: 'WHATSAPP',
            errorCode: 'WHATSAPP_SEND_FAILED',
          })
        }
      } catch (error) {
        logger.error('[OnlineOrdering] el WhatsApp del aviso no salió', {
          orderId,
          event,
          channel: 'WHATSAPP',
          errorCode: 'EXCEPTION',
          error: errorText(error),
        })
      }
    }
  } catch (error) {
    logger.error('[OnlineOrdering] notifyOrderEvent falló (no fatal)', { orderId, event, errorCode: 'EXCEPTION', error: errorText(error) })
  }
}
