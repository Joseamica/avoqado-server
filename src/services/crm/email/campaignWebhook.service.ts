/**
 * El carril del CRM en el aviso de Resend (spec 2026-10-30 §5.6, fase 2): lo que le pasó a una delivery de una campaña de
 * plataforma. Corre en el controlador DESPUÉS de los carriles de marketing (`procesarAvisoDeResend`).
 *
 * 🔴 La supresión de la dirección no es de aquí: el paso de reputación del controlador ya la hizo antes de todos los carriles
 * (rebote Permanent → HARD_BOUNCE, queja → COMPLAINT). Aquí sólo se marca la delivery (rebote duro, `email.failed` y
 * `email.suppressed` la dejan FALLIDO: no llegó) y, en la queja, se da de baja el correo de Avoqado (quien marcó spam no quiere nada
 * nuestro, tampoco el uno a uno). La queja deja la delivery ENVIADO con su motivo: prueba que SÍ llegó, y FALLIDO es «No salieron».
 */
import prisma from '../../../utils/prismaClient'
import { optOut } from './optOut.service'

export interface AvisoCrm {
  type: string
  data?: {
    email_id?: string
    to?: string[]
    bounce?: { type?: string; subType?: string }
    /** Resend lo manda como mapa (`{ crmDeliveryId: '…' }`); se acepta también la lista con la que se envió. */
    tags?: Record<string, string> | Array<{ name: string; value: string }>
  }
}

/** El id de la delivery que viajó como tag al mandar: la encuentra aunque su `resendId` no se haya alcanzado a guardar. */
function deliveryIdDelTag(tags: NonNullable<AvisoCrm['data']>['tags']): string | null {
  const valor = Array.isArray(tags) ? tags.find(t => t?.name === 'crmDeliveryId')?.value : tags?.crmDeliveryId
  return typeof valor === 'string' && valor ? valor : null
}

const SELECT = { id: true, email: true, status: true, resendId: true } as const

export async function procesarAvisoCrm(payload: AvisoCrm): Promise<{ manejado: boolean }> {
  const resendId = payload.data?.email_id || null
  const tagId = deliveryIdDelTag(payload.data?.tags)

  let delivery = resendId ? await prisma.crmCampaignDelivery.findFirst({ where: { resendId }, select: SELECT }) : null
  if (!delivery && tagId) delivery = await prisma.crmCampaignDelivery.findUnique({ where: { id: tagId }, select: SELECT })
  if (!delivery) return { manejado: false }

  // Resend la aceptó pero no alcanzamos a guardar su id (DESCONOCIDO) o todavía la estamos guardando (ENVIANDO).
  if (resendId && !delivery.resendId && (delivery.status === 'DESCONOCIDO' || delivery.status === 'ENVIANDO')) {
    await prisma.crmCampaignDelivery.updateMany({ where: { id: delivery.id, resendId: null }, data: { resendId } })
  }

  const queja = payload.type === 'email.complained'
  const reboteDuro = payload.type === 'email.bounced' && payload.data?.bounce?.type === 'Permanent'
  // Resend dice que NO salió (`email.failed`) o que no lo mandó porque la dirección está en su lista de supresión
  // (`email.suppressed`): igual que un rebote duro, la delivery termina FALLIDO y no se cuenta como enviada. Aquí no se anota
  // ninguna supresión nueva: la dirección ya está en la lista de Resend y de ahí en adelante decide el paso de reputación.
  const motivo = queja
    ? 'El destinatario lo marcó como spam'
    : reboteDuro
      ? `Rebote permanente${payload.data?.bounce?.subType ? ` (${payload.data.bounce.subType})` : ''}`
      : payload.type === 'email.failed'
        ? 'Resend no pudo mandarlo'
        : payload.type === 'email.suppressed'
          ? 'Resend lo suprimió (lista de supresión)'
          : null
  if (motivo) {
    // Si el remitente todavía la tiene, su CAS (estado y lease) ya no aplica: no la cambia otra vez.
    await prisma.crmCampaignDelivery.updateMany({
      where: { id: delivery.id },
      data: { status: queja ? 'ENVIADO' : 'FALLIDO', lastError: motivo, leaseUntil: null, nextAttemptAt: null },
    })
    if (queja) await optOut(delivery.email, 'QUEJA')
  }
  return { manejado: true }
}
