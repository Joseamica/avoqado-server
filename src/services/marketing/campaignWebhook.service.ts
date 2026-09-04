import { EmailSuppressionReason, CustomerCampaignDeliveryStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { recordSuppression } from './emailSuppression.service'

/**
 * Los avisos que Resend manda sobre las campañas de un negocio a SUS clientes.
 *
 * El webhook ya existía, pero pertenece al Marketing de superadmin (Avoqado → los venues) y
 * descartaba estos avisos con «Not a marketing campaign delivery» — así que un rebote se
 * perdía y el correo se seguía intentando. Este servicio es el otro lado del mismo webhook.
 *
 * 🔴 Por qué importa más de lo que parece: el subdominio de marketing es **compartido entre
 * todos los negocios**. Seguir escribiéndole a una dirección que rebota, o a alguien que ya
 * marcó el correo como spam, degrada la entrega de TODOS los que sí pagan.
 */

/** El contrato que Resend manda (espejo del tipo del webhook de superadmin). */
export interface AvisoDeResend {
  type: string
  data: {
    email_id: string
    to: string[]
    from?: string
    subject?: string
    created_at?: string
    click?: { link: string; timestamp: string }
    /** `type` es 'Permanent' | 'Transient' | 'Undetermined'. */
    bounce?: { type?: string; subType?: string }
  }
}

export interface ResultadoDelAviso {
  manejado: boolean
  motivo: string
}

/**
 * 🔴 SÓLO un rebote permanente suprime.
 *
 * Un transitorio —buzón lleno, servidor caído un rato— es temporal: suprimirlo dejaría a un
 * cliente bueno sin recibir un correo NUNCA MÁS, y eso no se nota, simplemente deja de
 * llegarle. Y ante un rebote sin clasificar tampoco se suprime: el coste es asimétrico —
 * equivocarse suprimiendo pierde un cliente en silencio; equivocarse sin suprimir sólo
 * cuesta un intento más, que el siguiente rebote volverá a reportar.
 */
function esRebotePermanente(bounce?: { type?: string }): boolean {
  return bounce?.type === 'Permanent'
}

export async function procesarAvisoDeResend(payload: AvisoDeResend): Promise<ResultadoDelAviso> {
  const resendId = payload.data?.email_id
  if (!resendId) return { manejado: false, motivo: 'El aviso no trae email_id.' }

  const delivery = await prisma.customerCampaignDelivery.findFirst({
    where: { resendId },
    select: { id: true, venueId: true, status: true },
  })
  if (!delivery) return { manejado: false, motivo: 'La entrega no es de una campaña a clientes.' }

  const destinatario = payload.data.to?.[0]
  const ahora = new Date()

  switch (payload.type) {
    case 'email.bounced': {
      const permanente = esRebotePermanente(payload.data.bounce)
      // El rebote se marca SIEMPRE en la entrega — permanente o no, ese correo no llegó.
      await prisma.customerCampaignDelivery.update({
        where: { id: delivery.id },
        data: {
          status: CustomerCampaignDeliveryStatus.FAILED,
          lastError: `Rebote ${payload.data.bounce?.type ?? 'sin clasificar'}${
            payload.data.bounce?.subType ? ` (${payload.data.bounce.subType})` : ''
          }`,
        },
      })
      if (permanente && destinatario) {
        await recordSuppression(destinatario, EmailSuppressionReason.HARD_BOUNCE)
        logger.warn('[campaign-webhook] rebote permanente: correo suprimido', { venueId: delivery.venueId })
      }
      return { manejado: true, motivo: permanente ? 'Rebote permanente: suprimido.' : 'Rebote transitorio: sólo marcado.' }
    }

    case 'email.complained': {
      // 🔴 Una queja suprime SIEMPRE. Alguien marcó el correo como spam: volver a
      // escribirle es exactamente lo que destruye la reputación del subdominio.
      await prisma.customerCampaignDelivery.update({
        where: { id: delivery.id },
        data: { status: CustomerCampaignDeliveryStatus.FAILED, lastError: 'El destinatario lo marcó como spam.' },
      })
      if (destinatario) {
        await recordSuppression(destinatario, EmailSuppressionReason.COMPLAINT)
        logger.warn('[campaign-webhook] queja de spam: correo suprimido', { venueId: delivery.venueId })
      }
      return { manejado: true, motivo: 'Queja de spam: suprimido.' }
    }

    case 'email.opened':
      // 🔴 NO se toca el `status`. Los avisos de Resend llegan desordenados, y una apertura
      // tardía que pisara el estado haría parecer sana una dirección que rebotó.
      await prisma.customerCampaignDelivery.update({ where: { id: delivery.id }, data: { openedAt: ahora } })
      return { manejado: true, motivo: 'Apertura registrada.' }

    case 'email.clicked':
      await prisma.customerCampaignDelivery.update({ where: { id: delivery.id }, data: { clickedAt: ahora } })
      return { manejado: true, motivo: 'Clic registrado.' }

    case 'email.delivered':
      // El envío ya se marcó SENT al mandarlo; la confirmación no añade nada que usemos.
      return { manejado: true, motivo: 'Entrega confirmada.' }

    default:
      // Un tipo nuevo de Resend no puede reventar el webhook.
      return { manejado: false, motivo: `Tipo de aviso no manejado: ${payload.type}` }
  }
}
