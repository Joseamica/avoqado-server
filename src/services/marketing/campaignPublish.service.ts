// src/services/marketing/campaignPublish.service.ts
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { firmarTokenDeEnvio, huellaDeCampana, verificarTokenDeEnvio, VIGENCIA_MS } from '@/services/marketing/campaignConfirmToken'
import { enqueueCampaign, resolverAudiencia, type EnqueueCampaignResult } from '@/services/marketing/campaignEnqueue.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

/**
 * Vista previa y publicación de una campaña — Fase 1C-A, Task 5.
 *
 * El dueño pide una vista previa ("esto le llega a 340 clientes"), la revisa, y confirma.
 * `previsualizarEnvio` cuenta y firma un token (T4, `campaignConfirmToken.ts`); `publicarCampana`
 * lo verifica y sólo entonces delega en `enqueueCampaign` (Fase 1A) — el token es lo que
 * impide publicar sobre un contenido o una audiencia que ya cambiaron desde que el dueño miró
 * la vista previa.
 *
 * 🔴 El conteo de la vista previa y el encolado real usan la MISMA `resolverAudiencia`
 * (extraída de `campaignEnqueue.service.ts` en esta misma tarea): si contaran distinto, el
 * token bloquearía publicaciones legítimas por un "cambio" que nunca ocurrió.
 */

export interface PrevisualizarEnvioParams {
  venueId: string
  campaignId: string
  /** Reloj inyectable — SÓLO para que las pruebas fijen "ahora" (default: `new Date()`). */
  ahora?: Date
}

export interface PrevisualizarEnvioResult {
  totalDestinatarios: number
  token: string
  expiraEn: Date
}

/**
 * Carga la campaña y resuelve su audiencia AHORA MISMO — nunca cachea nada del guardado
 * anterior, porque la huella del token debe reflejar el contenido tal como está en este
 * instante, no como estaba cuando se abrió la pantalla.
 */
async function cargarCampanaOFallar(venueId: string, campaignId: string) {
  const campaign = await prisma.customerCampaign.findFirst({ where: { id: campaignId, venueId } })
  if (!campaign) {
    throw new NotFoundError('La campaña no existe en este negocio.')
  }
  return campaign
}

/**
 * Vista previa: cuenta la audiencia ELEGIBLE ahora mismo y firma un token que ata contenido
 * + audiencia + conteo. Sólo LEE — no toca ninguna fila, así que `resolverAudiencia` recibe
 * el cliente Prisma normal, no una transacción (no hay nada que aislar todavía).
 */
export async function previsualizarEnvio({
  venueId,
  campaignId,
  ahora = new Date(),
}: PrevisualizarEnvioParams): Promise<PrevisualizarEnvioResult> {
  const campaign = await cargarCampanaOFallar(venueId, campaignId)

  const { elegibles } = await resolverAudiencia({
    tx: prisma,
    venueId,
    audience: campaign.audience,
    customerGroupId: campaign.customerGroupId,
    tags: campaign.tags,
  })
  const totalDestinatarios = elegibles.length

  const huellaContenido = huellaDeCampana({
    subject: campaign.subject,
    bloques: campaign.contentBlocks,
    audience: campaign.audience,
    customerGroupId: campaign.customerGroupId,
    tags: campaign.tags,
  })
  const token = firmarTokenDeEnvio({ campaignId, venueId, huellaContenido, totalDestinatarios, ahora })

  return { totalDestinatarios, token, expiraEn: new Date(ahora.getTime() + VIGENCIA_MS) }
}

export interface PublicarCampanaParams {
  venueId: string
  campaignId: string
  token: string
  actorStaffId?: string
  /** Reloj inyectable — SÓLO para que las pruebas fijen "ahora" (default: `new Date()`). */
  ahora?: Date
}

const MOTIVO_A_MENSAJE: Record<'INVALIDO' | 'VENCIDO' | 'CAMBIO', string> = {
  INVALIDO: 'El token de confirmación no es válido.',
  VENCIDO: 'La vista previa venció; vuelve a revisarla antes de publicar.',
  CAMBIO: 'El contenido o la audiencia de la campaña cambiaron desde la vista previa; vuelve a revisarla antes de publicar.',
}

/**
 * Publicación: recalcula la MISMA huella + conteo que `previsualizarEnvio`, verifica el
 * token contra ellos, y sólo si verifica delega en `enqueueCampaign` (Fase 1A) — que hace su
 * propio CAS de estado (DRAFT/SCHEDULED → ENQUEUED) y así responde `ConflictError` si la
 * campaña ya se publicó por otro camino.
 *
 * 🔴 El token se verifica ANTES de llamar a `enqueueCampaign`: si no verifica, `enqueueCampaign`
 * NUNCA se invoca. Publicar sin confirmación válida no puede tener ningún efecto, ni siquiera
 * el de reclamar la campaña.
 */
export async function publicarCampana({
  venueId,
  campaignId,
  token,
  actorStaffId,
  ahora = new Date(),
}: PublicarCampanaParams): Promise<EnqueueCampaignResult> {
  const campaign = await cargarCampanaOFallar(venueId, campaignId)

  const { elegibles } = await resolverAudiencia({
    tx: prisma,
    venueId,
    audience: campaign.audience,
    customerGroupId: campaign.customerGroupId,
    tags: campaign.tags,
  })
  const totalDestinatarios = elegibles.length
  const huellaContenido = huellaDeCampana({
    subject: campaign.subject,
    bloques: campaign.contentBlocks,
    audience: campaign.audience,
    customerGroupId: campaign.customerGroupId,
    tags: campaign.tags,
  })

  const verificacion = verificarTokenDeEnvio(token, { campaignId, venueId, huellaContenido, totalDestinatarios, ahora })
  if (!verificacion.ok) {
    throw new BadRequestError(MOTIVO_A_MENSAJE[verificacion.motivo])
  }

  const resultado = await enqueueCampaign({ venueId, campaignId, actorStaffId, ahora })

  // Bitácora DESPUÉS del commit de `enqueueCampaign` (que ya ocurrió cuando `await` regresa
  // aquí), sin `await` encadenado — mismo patrón que `campaignEnqueue.service.ts` y
  // `campaignDraft.service.ts`: si `logAction` falla, la publicación ya ocurrió y no puede
  // revertirse por un fallo de auditoría. Es una entrada PROPIA (`CUSTOMER_CAMPAIGN_PUBLISHED`,
  // distinta de `CUSTOMER_CAMPAIGN_ENQUEUED` que ya escribe `enqueueCampaign`): deja rastro de
  // que esto pasó por la confirmación con token del dueño, no por otro camino futuro que
  // llame a `enqueueCampaign` directamente (p. ej. el job de campañas agendadas).
  void logAction({
    action: 'CUSTOMER_CAMPAIGN_PUBLISHED',
    entity: 'CustomerCampaign',
    entityId: campaignId,
    staffId: actorStaffId ?? null,
    venueId,
    data: { encoladas: resultado.encoladas, omitidas: resultado.omitidas, totalDestinatarios },
  }).catch(() => {})

  return resultado
}
