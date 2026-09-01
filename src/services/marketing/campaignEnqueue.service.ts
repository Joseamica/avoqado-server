// src/services/marketing/campaignEnqueue.service.ts
import { ConsentAction, CustomerCampaignAudience, CustomerCampaignDeliveryStatus, CustomerCampaignStatus, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { env } from '@/config/env'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { periodoDeEnvio, reservarCuota } from '@/services/marketing/emailQuota.service'
import { filtrarSuprimidos, normalizeEmail } from '@/services/marketing/emailSuppression.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'

/**
 * Encolado de una campaña puntual — la transacción de PUBLICACIÓN (Fase 1A, Task 5).
 *
 * Mueve una campaña DRAFT/SCHEDULED a ENQUEUED y crea una `CustomerCampaignDelivery`
 * PENDING por destinatario elegible; el job de envío (fase futura) las reproduce. Todo
 * vive en UNA transacción — audiencia, supresión, creación de deliveries y reserva de
 * cuota— porque un fallo a medio camino no puede dejar deliveries huérfanas sin cuota
 * reservada, ni cuota reservada sin deliveries que la gasten.
 *
 * 🔴 El reclamo de la campaña (DRAFT/SCHEDULED → ENQUEUED) es un CAS por `updateMany`,
 * no un `findFirst` + `update`: dos publicaciones simultáneas del mismo botón (o el
 * endpoint y un reintento del cliente) leen la misma fila DRAFT y sólo UNA puede ganar
 * la carrera del UPDATE condicional. La segunda recibe `ConflictError` antes de tocar
 * la audiencia — mismo patrón que el canje de premios de sellos y el claim del outbox
 * de anuncios de plataforma.
 */

export interface EnqueueCampaignParams {
  venueId: string
  campaignId: string
  actorStaffId?: string
  /** Reloj inyectable — SÓLO para que las pruebas fijen "ahora" (default: `new Date()`). */
  ahora?: Date
}

export interface EnqueueCampaignResult {
  encoladas: number
  omitidas: number
}

export async function enqueueCampaign({
  venueId,
  campaignId,
  actorStaffId,
  ahora = new Date(),
}: EnqueueCampaignParams): Promise<EnqueueCampaignResult> {
  // R1 — el tier se revalida ANTES de abrir la transacción: si el negocio no tiene el
  // plan, nada se escribe (ni el CAS de la campaña, ni una sola delivery).
  const tieneAcceso = await venueHasFeatureAccess(venueId, 'CUSTOMER_CAMPAIGNS')
  if (!tieneAcceso) {
    throw new ForbiddenError('Las campañas de correo requieren el plan PRO. Actualiza el plan del negocio para poder mandar campañas.')
  }

  const { encoladas, omitidas, period } = await prisma.$transaction(async tx => {
    // Paso a) — el tenant SIEMPRE en el WHERE: nunca `findUnique` por id pelón, o una
    // campaña de OTRO venue con el mismo id (imposible con cuid, pero es la regla del
    // repo) quedaría alcanzable.
    const campaign = await tx.customerCampaign.findFirst({ where: { id: campaignId, venueId } })
    if (!campaign) {
      throw new NotFoundError('La campaña no existe en este negocio.')
    }
    const venue = await tx.venue.findFirst({ where: { id: venueId }, select: { timezone: true } })
    if (!venue) {
      throw new NotFoundError('El negocio no existe.')
    }

    // Paso b) — vencimiento: una campaña de temporada (la promo navideña) publicada
    // tarde no se manda fuera de tiempo. El tope es explícito (`sendNoLaterThan`) o,
    // a falta de él, 24h después de la hora agendada.
    const limite =
      campaign.sendNoLaterThan ?? (campaign.scheduledFor ? new Date(campaign.scheduledFor.getTime() + 24 * 60 * 60 * 1000) : null)
    if (limite && ahora > limite) {
      await tx.customerCampaign.updateMany({
        where: { id: campaignId, venueId, status: { in: [CustomerCampaignStatus.DRAFT, CustomerCampaignStatus.SCHEDULED] } },
        data: { status: CustomerCampaignStatus.EXPIRED },
      })
      // Declarado: el AVISO al dueño de que su campaña venció sin mandarse queda para
      // 1B/1C (el spec lo menciona pero esta task sólo cubre el encolado).
      throw new BadRequestError(`La campaña venció el ${limite.toISOString()}; no se encola tarde.`)
    }

    // Paso c) — el CAS que impide un doble encolado. `skipDuplicates` en el createMany
    // de abajo es la SEGUNDA capa, no la primera: sin este reclamo, dos publicaciones
    // concurrentes verían la MISMA campaña en DRAFT y las dos reservarían cuota.
    const reclamo = await tx.customerCampaign.updateMany({
      where: { id: campaignId, venueId, status: { in: [CustomerCampaignStatus.DRAFT, CustomerCampaignStatus.SCHEDULED] } },
      data: { status: CustomerCampaignStatus.ENQUEUED },
    })
    if (reclamo.count === 0) {
      throw new ConflictError('La campaña ya fue encolada o no está en un estado publicable.')
    }

    // Paso d) — audiencia. Los `marketingConsent: true` LEGACY sin un `ConsentEvent`
    // GRANTED detrás NO son elegibles — lo dice el spec: el consentimiento probado es
    // el ledger, el booleano es sólo su caché.
    let extra: Prisma.CustomerWhereInput = {}
    if (campaign.audience === CustomerCampaignAudience.GROUP) {
      if (!campaign.customerGroupId) {
        throw new BadRequestError('La campaña de audiencia GROUP no tiene un grupo de clientes asignado.')
      }
      const grupo = await tx.customerGroup.findFirst({ where: { id: campaign.customerGroupId, venueId } })
      if (!grupo) {
        throw new BadRequestError('El grupo de clientes de la campaña no existe en este negocio.')
      }
      extra = { customerGroupId: campaign.customerGroupId }
    } else if (campaign.audience === CustomerCampaignAudience.TAGS) {
      if (campaign.tags.length === 0) {
        throw new BadRequestError('La campaña de audiencia TAGS no tiene ninguna etiqueta configurada.')
      }
      // `Customer.tags` guarda la capitalización ORIGINAL con la que se escribió cada
      // tag (ver `applyTagChanges` en src/mcp/tools/customers.ts) — comparar con
      // `hasSome` (igualdad exacta de Postgres) fallaría contra "Vip" vs "VIP". Se
      // filtra en SQL sólo lo barato (que tenga AL MENOS un tag) y la semántica ANY
      // real —insensible a mayúsculas— se aplica en JS abajo. Una versión con índice
      // GIN + comparación insensible en SQL queda para una fase futura.
      extra = { tags: { isEmpty: false } }
    }

    const candidatos = await tx.customer.findMany({
      where: {
        venueId,
        active: true,
        marketingConsent: true,
        email: { not: null },
        consentEvents: { some: { action: ConsentAction.GRANTED } },
        ...extra,
      },
      select: { id: true, email: true, tags: true },
    })

    let elegiblesPorAudiencia = candidatos
    if (campaign.audience === CustomerCampaignAudience.TAGS) {
      const tagsCampaña = new Set(campaign.tags.map(t => t.trim().toLowerCase()))
      elegiblesPorAudiencia = candidatos.filter(c => c.tags.some(t => tagsCampaña.has(t.trim().toLowerCase())))
    }

    // Paso e) — supresión GLOBAL, en UN solo lote (nunca `isSuppressed` N veces: una
    // consulta por persona en una audiencia de miles sería miles de idas y vueltas).
    const emails = elegiblesPorAudiencia.map(c => c.email as string)
    const suprimidos = await filtrarSuprimidos(tx, emails)
    const elegibles = elegiblesPorAudiencia.filter(c => !suprimidos.has(normalizeEmail(c.email as string)))
    const omitidas = elegiblesPorAudiencia.length - elegibles.length

    // Paso f) — sin nadie a quién mandarle, la transacción entera revierte: la
    // campaña NO se queda ENQUEUED con cero destinatarios. Declarado: el futuro job de
    // campañas SCHEDULED tendrá que atrapar este caso y llevarla a un estado terminal
    // en vez de reintentarla para siempre.
    if (elegibles.length === 0) {
      throw new BadRequestError('La campaña no tiene destinatarios elegibles.')
    }

    // Paso g)
    const creadas = await tx.customerCampaignDelivery.createMany({
      data: elegibles.map(c => ({
        campaignId,
        customerId: c.id,
        venueId,
        dedupeKey: `${campaignId}:${c.id}`,
        status: CustomerCampaignDeliveryStatus.PENDING,
      })),
      skipDuplicates: true,
    })
    const encoladas = creadas.count

    // Paso h) — el período es del ENVÍO (agendado si existe, si no "ahora"), en la
    // zona del VENUE — nunca UTC (ver `periodoDeEnvio`). Sólo se reserva cuota si de
    // verdad se encoló algo: reservar 0 sería un no-op que esconde una carrera rara
    // donde el `skipDuplicates` de arriba descartó todo (campaña reencolada sobre
    // deliveries que ya existían de un intento previo).
    const period = periodoDeEnvio(campaign.scheduledFor ?? ahora, venue.timezone)
    if (encoladas > 0) {
      await reservarCuota(tx, { venueId, period, cantidad: encoladas, topeMensual: env.MARKETING_MONTHLY_QUOTA })
    }

    // Paso i) — `totalRecipients` es CACHE reconstruible: se fija con un COUNT real de
    // las deliveries, nunca con la aritmética de arriba (que podría divergir si algún
    // día una delivery se crea por otro camino).
    const totalRecipients = await tx.customerCampaignDelivery.count({ where: { campaignId } })
    await tx.customerCampaign.update({ where: { id: campaignId }, data: { totalRecipients } })

    return { encoladas, omitidas, period }
  })

  // R4 — bitácora DESPUÉS del commit, fuera de la transacción y sin `await` encadenado:
  // si `logAction` falla (nunca debería — es best-effort y atrapa su propio error), el
  // encolado ya ocurrió y no puede revertirse por un fallo de auditoría. El `.catch` es
  // sólo para no dejar una promesa sin manejar — `logAction` real jamás rechaza.
  void logAction({
    action: 'CUSTOMER_CAMPAIGN_ENQUEUED',
    entity: 'CustomerCampaign',
    entityId: campaignId,
    staffId: actorStaffId ?? null,
    venueId,
    data: { encoladas, omitidas, period },
  }).catch(() => {})

  return { encoladas, omitidas }
}
