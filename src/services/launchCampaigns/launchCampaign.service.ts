/**
 * S4 — la ficha de campaña: listar, leer, crear, editar y cambiar de estado
 * (spec 2026-09-17 § 2.1, § 3.4).
 *
 * 🔴 TRES invariantes que este archivo existe para sostener, y cada uno tiene su prueba:
 *
 *  1. **Toda edición es un CAS** (`updateMany where { id, updatedAt: <lo que el editor vio> }`).
 *     Dos pestañas del superadmin abiertas sobre la misma ficha no se pisan en silencio.
 *  2. **Los campos de oferta se congelan al activar.** El precio que un cliente aceptó no puede
 *     cambiar debajo de él: para cambiarlo se TERMINA la ficha y se crea otra (§1).
 *  3. **Bajar el cupo NO se valida leyendo y luego escribiendo.** Entre la lectura de
 *     `redemptionCount` y la escritura de `redemptionCap` cabe una reserva, y entonces el
 *     `UPDATE` viola el CHECK `count <= cap` y el superadmin recibe un **500** sin explicación.
 *     Se hace condicional, en una sola sentencia.
 */
import { Prisma } from '@prisma/client'
import type { LaunchCampaignStatus } from '@prisma/client'
// 🔴 Valores de enum como cadenas: dentro de Jest el objeto de `@prisma/client` viene sin los
// enums nuevos y `CAMPAIGN_STATUS.DRAFT` valdría `undefined` — un WHERE sin filtro que
// ninguna prueba grita. Ver `launchCampaignEnums.ts`.
import { CAMPAIGN_STATUS } from './launchCampaignEnums'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import logger from '../../config/logger'
import { launchOfferAvailability, LaunchOfferCampaignRow } from './launchOfferMath'
import type {
  CreateLaunchCampaignBody,
  ListLaunchCampaignsQuery,
  RedemptionListQuery,
  UpdateLaunchCampaignBody,
} from './launchCampaign.schema'

/**
 * Las columnas que la aritmética de la oferta necesita, ni una más. El `select` es explícito a
 * propósito: así nadie arrastra la fila entera a una vista pública por descuido.
 */
export const LAUNCH_CAMPAIGN_SELECT = {
  id: true,
  code: true,
  name: true,
  landingSlug: true,
  vertical: true,
  channel: true,
  featuredForVertical: true,
  planTier: true,
  billingInterval: true,
  advertisedPriceCents: true,
  discountMonths: true,
  currency: true,
  offerVersion: true,
  listPriceCentsSnapshot: true,
  discountAmountCents: true,
  stripePriceId: true,
  stripeCouponId: true,
  validFrom: true,
  validUntil: true,
  redemptionCap: true,
  redemptionCount: true,
  headline: true,
  subheadline: true,
  bullets: true,
  status: true,
  statusReason: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LaunchCampaignSelect

export type LaunchCampaignRow = Prisma.LaunchCampaignGetPayload<{ select: typeof LAUNCH_CAMPAIGN_SELECT }>

/** Adapta una fila de Prisma a la forma estructural que consume la aritmética pura. */
export function toOfferRow(c: LaunchCampaignRow): LaunchOfferCampaignRow {
  return {
    code: c.code,
    landingSlug: c.landingSlug,
    offerVersion: c.offerVersion,
    vertical: c.vertical,
    // El CHECK `LaunchCampaign_plan_tier_paid` garantiza que sólo hay PRO o PREMIUM en la base.
    planTier: c.planTier as 'PRO' | 'PREMIUM',
    status: c.status,
    validFrom: c.validFrom,
    validUntil: c.validUntil,
    redemptionCap: c.redemptionCap,
    redemptionCount: c.redemptionCount,
    advertisedPriceCents: c.advertisedPriceCents,
    discountMonths: c.discountMonths,
    listPriceCentsSnapshot: c.listPriceCentsSnapshot,
    discountAmountCents: c.discountAmountCents,
    headline: c.headline,
    subheadline: c.subheadline,
    bullets: c.bullets,
  }
}

/** Traduce el P2002 de Prisma al 409 que el superadmin puede explicar. */
function traducirUnico(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    // Prisma reporta un índice declarado como lista de columnas, pero uno PARCIAL escrito a mano
    // (el de la vitrina) puede llegar como el NOMBRE del índice: se aceptan las dos formas.
    const target = error.meta?.target
    const campos = Array.isArray(target) ? (target as string[]) : typeof target === 'string' ? [target] : []
    if (campos.includes('code')) throw new ConflictError('Ya existe una campaña con ese código', 'LAUNCH_CAMPAIGN_CODE_TAKEN')
    if (campos.includes('landingSlug')) throw new ConflictError('Ya existe una campaña con esa dirección', 'LAUNCH_CAMPAIGN_SLUG_TAKEN')
    if (campos.includes('vertical') || campos.some(c => c.includes('featured'))) {
      throw new ConflictError('Otra campaña acaba de tomar la vitrina de ese giro. Vuelve a abrirla.', 'LAUNCH_CAMPAIGN_FEATURED_TAKEN')
    }
  }
  throw error
}

type Tx = Prisma.TransactionClient

/**
 * 🔴 La VITRINA del giro es EXCLUSIVA: marcar una campaña desmarca a la que la ocupaba.
 *
 * Se llama SIEMPRE dentro de la transacción que marca a la nueva, así que si esa escritura pierde
 * (CAS, cupo, índice) la desmarca se revierte con ella: nunca queda el giro sin vitrina por una
 * edición que falló. El advisory lock por giro serializa a dos pestañas que marcan a la vez; el
 * índice único parcial de la migración es el respaldo que la hace imposible de romper.
 *
 * Devuelve la campaña desplazada (o null) para dejarle su propio renglón en la bitácora.
 */
async function soltarVitrinaDelGiro(tx: Tx, vertical: string, exceptoId: string | undefined, staffId?: string | null) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`launch-campaign-featured:${vertical}`}))::text`
  const previa = await tx.launchCampaign.findFirst({
    where: {
      vertical: vertical as Prisma.LaunchCampaignWhereInput['vertical'],
      featuredForVertical: true,
      ...(exceptoId ? { id: { not: exceptoId } } : {}),
    },
    select: { id: true, code: true },
  })
  if (previa) {
    await tx.launchCampaign.update({ where: { id: previa.id }, data: { featuredForVertical: false, updatedById: staffId ?? null } })
  }
  return previa
}

/** La que perdió la vitrina deja su propio renglón: el dueño de esa ficha tiene que poder verlo. */
async function registrarDesplazada(
  previa: { id: string; code: string } | null,
  nueva: { code: string; vertical: string },
  staffId?: string | null,
) {
  if (!previa) return
  await logAction({
    staffId,
    action: 'LAUNCH_CAMPAIGN_UNFEATURED',
    entity: 'LaunchCampaign',
    entityId: previa.id,
    data: { code: previa.code, vertical: nueva.vertical, replacedBy: nueva.code },
  })
}

/** Marca de que el CAS no escribió: se lanza DENTRO de la transacción para que revierta la desmarca. */
class SinEscribir extends Error {}

export async function listLaunchCampaigns(query: ListLaunchCampaignsQuery) {
  const where: Prisma.LaunchCampaignWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.q
      ? {
          OR: [
            { code: { contains: query.q, mode: 'insensitive' as const } },
            { name: { contains: query.q, mode: 'insensitive' as const } },
            { landingSlug: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.launchCampaign.count({ where }),
    prisma.launchCampaign.findMany({
      where,
      select: LAUNCH_CAMPAIGN_SELECT,
      // 🔴 `id` como desempate: sin él, dos fichas creadas en el mismo milisegundo pueden salir
      // en las dos páginas o en ninguna. Es el mismo defecto de paginación de siempre.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ])

  const now = new Date()
  return {
    data: rows.map(c => ({ ...c, availability: launchOfferAvailability(toOfferRow(c), now) })),
    meta: { total, page: query.page, pageSize: query.pageSize },
  }
}

/** Cuántos lugares RESERVED llevan más de N minutos apartados sin que nadie los cierre. */
export const STALE_RESERVED_MINUTES = 30

export async function getLaunchCampaignDetail(id: string) {
  const campaign = await prisma.launchCampaign.findUnique({ where: { id }, select: LAUNCH_CAMPAIGN_SELECT })
  if (!campaign) throw new NotFoundError('Campaña no encontrada', 'LAUNCH_CAMPAIGN_NOT_FOUND')

  const [porEstado, claimed, staleReserved] = await Promise.all([
    prisma.launchCampaignRedemption.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } }),
    prisma.onboardingProgress.count({ where: { launchCampaignId: id } }),
    prisma.launchCampaignRedemption.count({
      where: { campaignId: id, status: 'RESERVED', reservedAt: { lt: new Date(Date.now() - STALE_RESERVED_MINUTES * 60_000) } },
    }),
  ])
  const cuenta = (s: string) => porEstado.find(g => g.status === s)?._count._all ?? 0

  return {
    ...campaign,
    availability: launchOfferAvailability(toOfferRow(campaign), new Date()),
    metrics: {
      claimed,
      reserved: cuenta('RESERVED'),
      applied: cuenta('APPLIED'),
      released: cuenta('RELEASED'),
      cap: campaign.redemptionCap,
      count: campaign.redemptionCount,
      // 🔴 Lo único que hace visible el riesgo R2 (un lugar apartado que nadie reintenta consume
      // cupo para siempre) ahora que el barrido automático queda fuera de fase 1.
      staleReserved,
      staleReservedMinutes: STALE_RESERVED_MINUTES,
    },
  }
}

export async function createLaunchCampaign(body: CreateLaunchCampaignBody, staffId?: string | null) {
  try {
    const marcar = body.featuredForVertical === true
    const { campaign, desplazada } = await prisma.$transaction(async tx => {
      const desplazada = marcar ? await soltarVitrinaDelGiro(tx, body.vertical, undefined, staffId) : null
      const campaign = await tx.launchCampaign.create({
        data: {
          code: body.code,
          name: body.name,
          landingSlug: body.landingSlug,
          vertical: body.vertical,
          channel: body.channel,
          planTier: body.planTier,
          billingInterval: body.billingInterval,
          advertisedPriceCents: body.advertisedPriceCents,
          discountMonths: body.discountMonths,
          validFrom: body.validFrom,
          validUntil: body.validUntil,
          redemptionCap: body.redemptionCap,
          headline: body.headline,
          subheadline: body.subheadline,
          bullets: body.bullets,
          featuredForVertical: marcar,
          // 🔴 Nace SIEMPRE en DRAFT. Crear no activa: activar es lo que habla con Stripe.
          status: CAMPAIGN_STATUS.DRAFT,
          createdById: staffId ?? null,
          updatedById: staffId ?? null,
        },
        select: LAUNCH_CAMPAIGN_SELECT,
      })
      return { campaign, desplazada }
    })

    await registrarDesplazada(desplazada, campaign, staffId)
    await logAction({
      staffId,
      action: 'LAUNCH_CAMPAIGN_CREATED',
      entity: 'LaunchCampaign',
      entityId: campaign.id,
      data: {
        code: campaign.code,
        advertisedPriceCents: campaign.advertisedPriceCents,
        discountMonths: campaign.discountMonths,
        ...(marcar ? { featuredForVertical: true, replaced: desplazada?.code ?? null } : {}),
      },
    })
    return campaign
  } catch (error) {
    traducirUnico(error)
  }
}

/** Campos que el estado de la ficha CONGELA. Devuelve los que la petición intentó mover. */
export function camposBloqueados(actual: LaunchCampaignRow, cambios: UpdateLaunchCampaignBody): string[] {
  const bloqueados: string[] = []
  const activada = actual.activatedAt !== null || actual.status !== CAMPAIGN_STATUS.DRAFT
  const terminada = actual.status === CAMPAIGN_STATUS.ENDED

  const intenta = (campo: keyof UpdateLaunchCampaignBody) => cambios[campo] !== undefined

  if (terminada) {
    // Una ficha terminada es historia: no se edita NADA.
    for (const campo of Object.keys(cambios)) if (campo !== 'expectedUpdatedAt') bloqueados.push(campo)
    return bloqueados
  }

  if (activada) {
    // La oferta y la dirección pública quedan congeladas. Los textos y las etiquetas no.
    for (const campo of ['planTier', 'billingInterval', 'advertisedPriceCents', 'discountMonths', 'landingSlug'] as const) {
      if (intenta(campo)) bloqueados.push(campo)
    }
    // `validFrom` sólo se puede mover mientras nadie haya tomado un lugar: correrlo después
    // dejaría fuera de la ventana a una oferta que alguien ya aceptó.
    if (intenta('validFrom') && actual.redemptionCount > 0) bloqueados.push('validFrom')
  }
  return bloqueados
}

export async function updateLaunchCampaign(id: string, body: UpdateLaunchCampaignBody, staffId?: string | null) {
  const actual = await prisma.launchCampaign.findUnique({ where: { id }, select: LAUNCH_CAMPAIGN_SELECT })
  if (!actual) throw new NotFoundError('Campaña no encontrada', 'LAUNCH_CAMPAIGN_NOT_FOUND')

  const bloqueados = camposBloqueados(actual, body)
  if (bloqueados.length > 0) {
    throw new ConflictError(
      'Esa campaña ya se activó: para cambiar el precio o los meses, termínala y crea otra.',
      'LAUNCH_CAMPAIGN_FIELD_LOCKED',
      { fields: bloqueados },
    )
  }

  const { expectedUpdatedAt, ...cambios } = body

  // 🔴 Mover de giro una campaña que ocupa la vitrina movería la vitrina en silencio: el giro de
  // origen se quedaría sin precio (o el de destino chocaría con la suya). Se pide soltarla explícito.
  const cambiaDeGiro = cambios.vertical !== undefined && cambios.vertical !== actual.vertical
  if (actual.featuredForVertical && cambiaDeGiro && cambios.featuredForVertical !== false) {
    throw new ConflictError(
      'Esta campaña ocupa la vitrina de su giro. Quítale la vitrina antes de cambiarla de giro.',
      'LAUNCH_CAMPAIGN_FEATURED_VERTICAL_CHANGE',
    )
  }

  const data: Prisma.LaunchCampaignUpdateManyMutationInput = { updatedById: staffId ?? null }
  for (const [k, v] of Object.entries(cambios)) {
    if (v !== undefined) (data as Record<string, unknown>)[k] = v
  }

  const nuevaVigenciaDesde = cambios.validFrom ?? actual.validFrom
  const nuevaVigenciaHasta = cambios.validUntil ?? actual.validUntil
  if (nuevaVigenciaDesde >= nuevaVigenciaHasta) {
    throw new BadRequestError('La vigencia debe terminar después de empezar', 'LAUNCH_CAMPAIGN_INVALID_WINDOW')
  }

  // 🔴 EL CANDADO DEL CUPO, y es la razón de que esto sea un `updateMany` y no un `update`:
  // `redemptionCount <= nuevoCap` viaja DENTRO del WHERE. Leer el conteo y decidir después deja
  // una ventana en la que una reserva entra y el UPDATE revienta contra el CHECK con un 500.
  const nuevoCap = cambios.redemptionCap
  const where: Prisma.LaunchCampaignWhereInput = {
    id,
    updatedAt: expectedUpdatedAt,
    ...(nuevoCap !== undefined ? { redemptionCount: { lte: nuevoCap } } : {}),
  }

  const marcar = cambios.featuredForVertical === true
  const giroDestino = cambios.vertical ?? actual.vertical
  let desplazada: { id: string; code: string } | null = null
  let escribio = true
  try {
    desplazada = await prisma.$transaction(async tx => {
      const previa = marcar ? await soltarVitrinaDelGiro(tx, giroDestino, id, staffId) : null
      const r = await tx.launchCampaign.updateMany({ where, data })
      // Se lanza DENTRO: si el CAS pierde, la desmarca de la otra campaña se revierte con él.
      if (r.count === 0) throw new SinEscribir()
      return previa
    })
  } catch (error) {
    if (!(error instanceof SinEscribir)) traducirUnico(error)
    escribio = false
  }

  if (!escribio) {
    // Se relee para distinguir los DOS motivos y responder el que corresponde. Un 409 genérico
    // haría que el superadmin bajara el cupo otra vez creyendo que fue una carrera de edición.
    const releida = await prisma.launchCampaign.findUnique({
      where: { id },
      select: { updatedAt: true, redemptionCount: true },
    })
    if (!releida) throw new NotFoundError('Campaña no encontrada', 'LAUNCH_CAMPAIGN_NOT_FOUND')
    if (nuevoCap !== undefined && releida.redemptionCount > nuevoCap) {
      throw new BadRequestError(
        `No puedes bajar el cupo a ${nuevoCap}: ya hay ${releida.redemptionCount} lugares tomados.`,
        'LAUNCH_CAMPAIGN_CAP_BELOW_COUNT',
        { redemptionCount: releida.redemptionCount },
      )
    }
    throw new ConflictError('Alguien más cambió esta campaña. Vuelve a abrirla.', 'LAUNCH_CAMPAIGN_STALE')
  }

  const campaign = await prisma.launchCampaign.findUniqueOrThrow({ where: { id }, select: LAUNCH_CAMPAIGN_SELECT })
  await registrarDesplazada(desplazada, campaign, staffId)
  await logAction({
    staffId,
    action: 'LAUNCH_CAMPAIGN_UPDATED',
    entity: 'LaunchCampaign',
    entityId: id,
    data: {
      code: campaign.code,
      // Sólo los campos que de verdad cambiaron, con su antes y su después.
      changes: Object.fromEntries(
        Object.entries(cambios)
          .filter(([k, v]) => v !== undefined && String((actual as Record<string, unknown>)[k]) !== String(v))
          .map(([k, v]) => [k, { from: (actual as Record<string, unknown>)[k], to: v }]),
      ),
      ...(desplazada ? { replacedFeatured: desplazada.code } : {}),
    } as Prisma.InputJsonValue,
  })
  return campaign
}

/**
 * Transición de estado con CAS. `desde` es la lista de estados desde los que la transición es
 * legítima; `updatedAt` es lo que el editor tenía en pantalla.
 */
async function transicion(
  id: string,
  desde: LaunchCampaignStatus[],
  hacia: LaunchCampaignStatus,
  accion: string,
  reason: string,
  staffId?: string | null,
) {
  const actual = await prisma.launchCampaign.findUnique({ where: { id }, select: LAUNCH_CAMPAIGN_SELECT })
  if (!actual) throw new NotFoundError('Campaña no encontrada', 'LAUNCH_CAMPAIGN_NOT_FOUND')
  if (!desde.includes(actual.status)) {
    throw new ConflictError(`No se puede ${accion} una campaña en estado ${actual.status}`, 'LAUNCH_CAMPAIGN_BAD_STATE', {
      currentStatus: actual.status,
    })
  }

  const r = await prisma.launchCampaign.updateMany({
    where: { id, status: { in: desde }, updatedAt: actual.updatedAt },
    data: {
      status: hacia,
      statusReason: reason,
      updatedById: staffId ?? null,
      // 🔴 Terminar es definitivo: una ficha terminada no puede seguir ocupando la vitrina de su
      // giro (el CHECK `LaunchCampaign_featured_not_ended` lo exige). Pausar, en cambio, la
      // CONSERVA: al reanudarla la página vuelve a enseñarla sin que nadie la marque de nuevo.
      ...(hacia === CAMPAIGN_STATUS.ENDED ? { featuredForVertical: false } : {}),
    },
  })
  if (r.count === 0) throw new ConflictError('Alguien más cambió esta campaña. Vuelve a abrirla.', 'LAUNCH_CAMPAIGN_STALE')

  const campaign = await prisma.launchCampaign.findUniqueOrThrow({ where: { id }, select: LAUNCH_CAMPAIGN_SELECT })
  await logAction({
    staffId,
    action: accion === 'pausar' ? 'LAUNCH_CAMPAIGN_PAUSED' : 'LAUNCH_CAMPAIGN_ENDED',
    entity: 'LaunchCampaign',
    entityId: id,
    data: {
      code: campaign.code,
      reason,
      ...(hacia === CAMPAIGN_STATUS.ENDED && actual.featuredForVertical ? { releasedFeatured: true } : {}),
    },
  })
  return campaign
}

export function pauseLaunchCampaign(id: string, reason: string, staffId?: string | null) {
  return transicion(id, [CAMPAIGN_STATUS.ACTIVE], CAMPAIGN_STATUS.PAUSED, 'pausar', reason, staffId)
}

/** Terminar es IRREVERSIBLE: es el camino para cambiar un precio ya publicado (§1). */
export function endLaunchCampaign(id: string, reason: string, staffId?: string | null) {
  return transicion(
    id,
    [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED],
    CAMPAIGN_STATUS.ENDED,
    'terminar',
    reason,
    staffId,
  )
}

export async function listRedemptions(campaignId: string, query: RedemptionListQuery) {
  const existe = await prisma.launchCampaign.findUnique({ where: { id: campaignId }, select: { id: true } })
  if (!existe) throw new NotFoundError('Campaña no encontrada', 'LAUNCH_CAMPAIGN_NOT_FOUND')

  const where: Prisma.LaunchCampaignRedemptionWhereInput = {
    campaignId,
    ...(query.status ? { status: query.status } : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.launchCampaignRedemption.count({ where }),
    prisma.launchCampaignRedemption.findMany({
      where,
      // 🔴 `select` explícito y SIN la huella de tarjeta ni el id del cupón: la tabla del
      // superadmin muestra nombres, no rastros de medio de pago (§7.8).
      select: {
        id: true,
        status: true,
        offerVersion: true,
        advertisedPriceCents: true,
        discountMonths: true,
        listPriceCents: true,
        reservedAt: true,
        appliedAt: true,
        releasedAt: true,
        organization: { select: { id: true, name: true } },
        venue: { select: { id: true, name: true, slug: true } },
      },
      orderBy: [{ reservedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ])

  // La atribución vive en el progreso del alta, que es de la organización, no de la redención.
  const orgIds = [...new Set(rows.map(r => r.organization.id))]
  const progresos = orgIds.length
    ? await prisma.onboardingProgress.findMany({
        where: { organizationId: { in: orgIds } },
        select: { organizationId: true, acquisitionSource: true, acquisitionUtm: true },
      })
    : []
  const porOrg = new Map(progresos.map(p => [p.organizationId, p]))

  return {
    data: rows.map(r => {
      const p = porOrg.get(r.organization.id)
      const utm = (p?.acquisitionUtm ?? null) as Record<string, string> | null
      return {
        ...r,
        acquisitionSource: p?.acquisitionSource ?? null,
        utmSource: utm?.utm_source ?? null,
        utmCampaign: utm?.utm_campaign ?? null,
      }
    }),
    meta: { total, page: query.page, pageSize: query.pageSize },
  }
}

/**
 * La ficha que un código PUEDE reclamar. «Reclamable» es ACTIVE y dentro de la ventana:
 * 🔴 el CUPO no se revisa aquí a propósito (§3.5). Reclamar es atribución, no un lugar apartado;
 * negar el reclamo por cupo lleno perdería el dato de qué anuncio trajo a esa persona.
 */
/**
 * Reclamable = publicada y dentro de su ventana. 🔴 NO mira el cupo a propósito: la atribución no
 * es un lugar (una ficha llena sigue atribuyendo el clic que ya se pagó).
 *
 * Vive aquí UNA sola vez porque la reclaman dos caminos —por código y por slug— y si cada uno
 * repitiera la regla, relajar uno dejaría cobrar una oferta vencida por la puerta de al lado.
 */
function esReclamable(campaign: LaunchCampaignRow, now: Date): boolean {
  if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) return false
  return now >= campaign.validFrom && now < campaign.validUntil
}

export async function findClaimableByCode(code: string, now: Date = new Date()): Promise<LaunchCampaignRow | null> {
  const campaign = await prisma.launchCampaign.findUnique({ where: { code }, select: LAUNCH_CAMPAIGN_SELECT })
  return campaign && esReclamable(campaign, now) ? campaign : null
}

/**
 * 🔴 El anuncio puede traer el CÓDIGO o el SLUG, y NUNCA son la misma cadena: el schema fuerza
 * `code` a MAYÚSCULAS y `landingSlug` a minúsculas (§2.1). El CTA de `/oferta/pos-22` manda
 * `?oferta=pos-22`, el alta lo sube a mayúsculas (`POS-22`) y buscar sólo por código no encuentra
 * `POS22` jamás — y se pierde en SILENCIO, porque quien llama hace `.catch(() => null)`. Resultado:
 * cuenta creada sin la oferta y sin atribución, con el clic ya pagado.
 *
 * El código gana cuando ambos existen: es la identidad de la ficha; el slug es sólo su dirección.
 */
export async function findClaimableByCodeOrSlug(raw: string, now: Date = new Date()): Promise<LaunchCampaignRow | null> {
  const limpio = raw.trim()
  if (!limpio) return null

  const porCodigo = await findClaimableByCode(limpio.toUpperCase(), now)
  if (porCodigo) return porCodigo

  const porSlug = await findBySlug(limpio.toLowerCase())
  return porSlug && esReclamable(porSlug, now) ? porSlug : null
}

export async function findBySlug(landingSlug: string): Promise<LaunchCampaignRow | null> {
  return prisma.launchCampaign.findUnique({ where: { landingSlug }, select: LAUNCH_CAMPAIGN_SELECT })
}

/**
 * La campaña que ocupa la vitrina de un giro, en cualquier estado (quien la muestra decide con
 * `launchOfferAvailability`). Giro EXACTO: una campaña «ALL» no rellena la vitrina de otro giro —
 * si el founder la quiere ahí, la marca ahí. Sin caídas implícitas que nadie eligió.
 */
export async function findFeaturedByVertical(vertical: string): Promise<LaunchCampaignRow | null> {
  return prisma.launchCampaign.findFirst({
    where: { vertical: vertical as Prisma.LaunchCampaignWhereInput['vertical'], featuredForVertical: true },
    select: LAUNCH_CAMPAIGN_SELECT,
  })
}

export async function findByCode(code: string): Promise<LaunchCampaignRow | null> {
  return prisma.launchCampaign.findUnique({ where: { code }, select: LAUNCH_CAMPAIGN_SELECT })
}

export { logger }
