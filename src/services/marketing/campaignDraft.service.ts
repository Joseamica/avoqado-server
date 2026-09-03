// src/services/marketing/campaignDraft.service.ts
import { CustomerCampaignAudience, CustomerCampaignStatus, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { bloquesCampanaSchema } from '@/services/marketing/campaignBlocks'
import { dominiosDeLosBloques, renderizarBloques } from '@/services/marketing/campaignRenderer'
import { logAction } from '@/services/dashboard/activity-log.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'

/**
 * Guardar (crear o editar) el BORRADOR de una campaña — Fase 1C, Task 3.
 *
 * El dueño escribe con BLOQUES (T1); esta función es la ÚNICA puerta por la que esos bloques
 * se convierten en HTML/texto (T2) y se persisten. El cliente NUNCA manda HTML: si viniera del
 * cuerpo del request, la decisión de no sanitizar (documentada en `campaignBlocks.ts`) se
 * caería — cualquiera podría mandar el marcado que quisiera firmado con nuestro dominio de
 * marketing. Por eso `htmlBody`, `textBody` y `linkDomains` se CALCULAN aquí, nunca se leen
 * del parámetro.
 *
 * También se guardan los bloques ORIGINALES en `contentBlocks` — sin eso no habría forma
 * honesta de reabrir el editor ni de recalcular la huella del token de envío (T4
 * `huellaDeCampana`, que recibe `bloques` de vuelta).
 */

export interface GuardarBorradorParams {
  venueId: string
  campaignId?: string
  name: string
  subject: string
  bloques: unknown
  audience: CustomerCampaignAudience
  customerGroupId?: string
  tags?: string[]
  // 🔴 `scheduledFor` NO vive aquí a propósito — ver el comentario en
  // `marketingCampaign.schema.ts` sobre por qué se quitó del cuerpo de la API. No lo
  // reintroduzcas sólo en este servicio: sin el job que lo honre, aceptarlo aquí abriría
  // la misma puerta por un camino que no pasa por Zod (p. ej. un futuro consumidor MCP).
  actorStaffId?: string
}

// Sólo estas dos aceptan una edición — mismo CAS que `enqueueCampaign` (campaignEnqueue.service.ts).
// Una vez ENQUEUED/SENDING/SENT (o CANCELLED/BLOCKED/EXPIRED), el contenido queda congelado.
const ESTADOS_EDITABLES: CustomerCampaignStatus[] = [CustomerCampaignStatus.DRAFT, CustomerCampaignStatus.SCHEDULED]

export async function guardarBorrador(p: GuardarBorradorParams): Promise<{ id: string }> {
  // Paso a) — `bloques` llega como `unknown` porque viene crudo del cuerpo del request;
  // `bloquesCampanaSchema` (T1) es la ÚNICA puerta al catálogo. Nunca se confía en la forma
  // que el cliente diga tener.
  const parseo = bloquesCampanaSchema.safeParse(p.bloques)
  if (!parseo.success) {
    throw new BadRequestError('El contenido de la campaña no es válido: revisa los bloques.')
  }
  const bloques = parseo.data

  // Paso b) — GROUP sin grupo asignado no se puede guardar: quedaría imposible de publicar
  // después (enqueueCampaign ya lo rechaza ahí, pero avisar al guardar es más claro).
  if (p.audience === CustomerCampaignAudience.GROUP && !p.customerGroupId) {
    throw new BadRequestError('La campaña de audiencia GROUP necesita un grupo de clientes.')
  }

  // Paso c) — el SERVIDOR renderiza. `dominiosDeLosBloques` lee los `url` de los bloques
  // (T2) — nunca se parsea el HTML para encontrarlos, así que no puede desalinearse de lo que
  // el correo realmente manda.
  const { html, text } = renderizarBloques(bloques)
  const linkDomains = dominiosDeLosBloques(bloques)

  const contenido = {
    name: p.name,
    subject: p.subject,
    contentBlocks: bloques as unknown as Prisma.InputJsonValue,
    htmlBody: html,
    textBody: text,
    linkDomains,
    audience: p.audience,
    customerGroupId: p.audience === CustomerCampaignAudience.GROUP ? (p.customerGroupId ?? null) : null,
    tags: p.tags ?? [],
    // `scheduledFor` NO se escribe aquí — ver el comentario de `GuardarBorradorParams`
    // arriba. El campo del modelo se queda en `null` para toda campaña creada por esta
    // puerta hasta que exista el job de campañas agendadas.
  }

  const { id, accion } = await prisma.$transaction(async tx => {
    if (!p.campaignId) {
      const creada = await tx.customerCampaign.create({
        data: {
          venueId: p.venueId,
          ...contenido,
          status: CustomerCampaignStatus.DRAFT,
          createdByStaffId: p.actorStaffId ?? null,
        },
      })
      return { id: creada.id, accion: 'CUSTOMER_CAMPAIGN_DRAFT_CREATED' as const }
    }

    // Paso d) — cargar SIEMPRE con venueId en el where: nunca `findUnique` por id pelón, o una
    // campaña de OTRO venue con el mismo id (imposible con cuid, pero es la regla del repo)
    // quedaría alcanzable.
    const existente = await tx.customerCampaign.findFirst({ where: { id: p.campaignId, venueId: p.venueId } })
    if (!existente) {
      throw new NotFoundError('La campaña no existe en este negocio.')
    }

    // Paso e) — CAS por `updateMany` condicional: sólo DRAFT/SCHEDULED se pueden editar.
    // Editar una SCHEDULED la REGRESA a DRAFT — el contenido que la agenda validó ya no es el
    // mismo, así que cualquier agenda confirmada sobre el contenido viejo deja de ser válida.
    const reclamo = await tx.customerCampaign.updateMany({
      where: { id: p.campaignId, venueId: p.venueId, status: { in: ESTADOS_EDITABLES } },
      data: { ...contenido, status: CustomerCampaignStatus.DRAFT },
    })
    if (reclamo.count === 0) {
      throw new ConflictError('La campaña ya se envió o está en curso; no se puede editar.')
    }

    return { id: p.campaignId, accion: 'CUSTOMER_CAMPAIGN_DRAFT_UPDATED' as const }
  })

  // Bitácora DESPUÉS del commit, sin `await` encadenado: si `logAction` falla (no debería —
  // es best-effort y atrapa su propio error), el guardado ya ocurrió y no puede revertirse
  // por un fallo de auditoría. Mismo patrón que `campaignEnqueue.service.ts`.
  void logAction({
    action: accion,
    entity: 'CustomerCampaign',
    entityId: id,
    staffId: p.actorStaffId ?? null,
    venueId: p.venueId,
    data: { name: p.name },
  }).catch(() => {})

  return { id }
}
