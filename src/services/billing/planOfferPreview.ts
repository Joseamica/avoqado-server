/**
 * Planes editables (B1, Task 6): lo que se LEE de la oferta de los planes, sin escribir nada: su estado (`estadoDeLaOferta`) y la
 * vista previa de una publicación (`vistaPreviaDeLaOferta`), con las revisiones que comparte con el publicador (validar la
 * entrada, qué cambia, las campañas y las promociones que la frenan).
 *
 * 🔴 Dependencia en un solo sentido: `planOfferPublisher.ts` importa de aquí; este módulo nunca importa al publicador.
 * Dinero: centavos enteros CON IVA (excepción declarada de `critical-warnings.md`); las listas híbridas, en pesos.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import AppError, { BadRequestError, ConflictError } from '../../errors/AppError'
import { promotionsBrokenByList, type RuleViolation } from '../launchCampaigns/hybridPriceRule'
import { getDestinatariosDelAlta } from '../superadmin/platformSettings.service'
import { estadoDelInterruptor } from './interruptorPlanesEditables'
import {
  definicionDesdeEntrada,
  entradaDesdeDefinicion,
  ofertaVigente,
  planOfferDefinition,
  planOfferInput,
  problemasDeLaOferta,
  ranurasQueCambian,
  type Periodicidad,
  type PlanOfferDefinition,
  type PlanOfferInput,
  type PlanPagado,
  type Ranura,
} from './planOffer'

export type Db = Prisma.TransactionClient | typeof prisma

// ---------------------------------------------------------------------------------------------------------------------
// Las formas
// ---------------------------------------------------------------------------------------------------------------------

export interface Cambio {
  plan: 'FREE' | PlanPagado
  campo: string
  antes: unknown
  despues: unknown
}

export interface CampanaQueBloquea {
  id: string
  code: string
  name: string
  planTier: PlanPagado
}

export interface VistaPrevia {
  cambios: Cambio[]
  /** Las ranuras que necesitan un precio nuevo en Stripe. */
  preciosNuevos: Ranura[]
  bloqueos: { campanas: CampanaQueBloquea[]; promociones: RuleViolation[] }
  /** Cuántos negocios con suscripción pagan hoy el precio vigente de cada ranura (lo conservan al publicar). */
  conservanSuPrecio: Record<Ranura, number>
  /** Vacío al responder: con problemas, la vista previa responde 400 `PLAN_OFFER_INVALID`, igual que publicar. */
  problemas: { path: string; message: string }[]
}

export interface EstadoDeLaOferta {
  revision: number
  vigente: {
    number: number
    versionId: string | null
    definition: PlanOfferDefinition
    /** Lo que llena el editor (`entradaDesdeDefinicion`). */
    entrada: PlanOfferInput
    publishedAt: Date | null
    publishedById: string | null
  }
  pendiente: { versionId: string; definition: PlanOfferDefinition; creadaAt: Date; preparacion: unknown } | null
  interruptor: Awaited<ReturnType<typeof estadoDelInterruptor>>
  nombresEnStripe: unknown
  /** Los destinatarios de los avisos internos (Task 9): `PlatformSettings.avisosDelAltaCorreos`, `[]` sin renglón. */
  destinatarios: string[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Constantes compartidas con el publicador
// ---------------------------------------------------------------------------------------------------------------------

export const PUNTERO_ID = 'vigente'
export const PLANES: readonly PlanPagado[] = ['PRO', 'PREMIUM']
export const RANURAS: readonly Ranura[] = ['PRO:monthly', 'PRO:annual', 'PREMIUM:monthly', 'PREMIUM:annual']

/** Las campañas que se enseñan al bloquear (el bloqueo vale aunque haya más). ponytail: hoy hay unas cuantas activas a la vez. */
const TOPE_DE_CAMPANAS = 100

export const partes = (ranura: Ranura) => ranura.split(':') as [PlanPagado, Periodicidad]
export const precioDe = (definition: PlanOfferDefinition, ranura: Ranura) => {
  const [tier, periodicidad] = partes(ranura)
  return definition[tier][periodicidad]
}

// ---------------------------------------------------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------------------------------------------------

export const desfasada = (details?: Record<string, unknown>) =>
  new ConflictError(
    'La oferta de los planes cambió mientras la editabas. Vuelve a cargarla y revisa los cambios.',
    'PLAN_OFFER_STALE',
    details,
  )

// ---------------------------------------------------------------------------------------------------------------------
// Validar y comparar
// ---------------------------------------------------------------------------------------------------------------------

/** La forma (`planOfferInput`) y luego las reglas (`problemasDeLaOferta`): con cualquier problema, 400 `PLAN_OFFER_INVALID`. */
export function validarEntrada(entrada: unknown): PlanOfferInput {
  const forma = planOfferInput.safeParse(entrada)
  const issues = forma.success
    ? problemasDeLaOferta(forma.data)
    : forma.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
  if (!forma.success || issues.length) {
    throw new BadRequestError('Hay datos de la oferta que hay que corregir antes de publicar.', 'PLAN_OFFER_INVALID', { issues })
  }
  return forma.data
}

/** Lo que cambia, campo por campo, en los términos del editor (netos sin IVA, nombres recortados). */
export function cambiosEntre(antes: PlanOfferDefinition, despues: PlanOfferDefinition): Cambio[] {
  const a = entradaDesdeDefinicion(antes)
  const d = entradaDesdeDefinicion(despues)
  const cambios: Cambio[] = []
  if (a.FREE.displayName !== d.FREE.displayName)
    cambios.push({ plan: 'FREE', campo: 'displayName', antes: a.FREE.displayName, despues: d.FREE.displayName })
  for (const plan of PLANES) {
    for (const campo of ['displayName', 'onSale', 'requiresCard', 'trialDays', 'monthlyNetCents', 'annualNetCents'] as const) {
      if (a[plan][campo] !== d[plan][campo]) cambios.push({ plan, campo, antes: a[plan][campo], despues: d[plan][campo] })
    }
  }
  return cambios
}

/** La lista híbrida de un plan vende su MENSUAL, en pesos con IVA. */
export const mensualEnPesos = (definition: PlanOfferDefinition, tier: PlanPagado) => definition[tier].monthly.grossCents / 100

/**
 * Las campañas `ACTIVE` que impiden publicar: las del plan cuyo MENSUAL cambia (`PRECIO`) o que queda fuera de venta
 * (`FUERA_DE_VENTA`). El anual no las toca: las campañas son mensuales.
 */
export async function campanasQueBloquean(
  db: Db,
  vigente: PlanOfferDefinition,
  nueva: PlanOfferDefinition,
): Promise<Array<CampanaQueBloquea & { motivo: 'PRECIO' | 'FUERA_DE_VENTA' }>> {
  const motivos = new Map<PlanPagado, 'PRECIO' | 'FUERA_DE_VENTA'>()
  for (const tier of PLANES) {
    if (nueva[tier].monthly.grossCents !== vigente[tier].monthly.grossCents) motivos.set(tier, 'PRECIO')
    else if (!nueva[tier].onSale) motivos.set(tier, 'FUERA_DE_VENTA')
  }
  if (!motivos.size) return []
  const filas = await db.launchCampaign.findMany({
    where: { status: 'ACTIVE', planTier: { in: [...motivos.keys()] } },
    select: { id: true, code: true, name: true, planTier: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: TOPE_DE_CAMPANAS,
  })
  return filas.map(f => {
    const planTier = f.planTier as PlanPagado
    return { id: f.id, code: f.code, name: f.name, planTier, motivo: motivos.get(planTier)! }
  })
}

export async function exigirSinCampanas(db: Db, vigente: PlanOfferDefinition, nueva: PlanOfferDefinition): Promise<void> {
  const campaigns = await campanasQueBloquean(db, vigente, nueva)
  if (!campaigns.length) return
  throw new ConflictError(
    'Hay campañas activas de este plan. Páusalas antes de cambiar su precio mensual o de sacarlo de venta.',
    'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS',
    { motivo: campaigns.some(c => c.motivo === 'PRECIO') ? 'PRECIO' : 'FUERA_DE_VENTA', campaigns },
  )
}

/** Las promociones activas de cada plan que su mensual nuevo rompería (la regla del precio de lista). */
export async function promocionesQueRompe(nueva: PlanOfferDefinition): Promise<RuleViolation[]> {
  const rotas: RuleViolation[] = []
  for (const tier of PLANES) rotas.push(...(await promotionsBrokenByList(prisma, `PLAN:${tier}`, mensualEnPesos(nueva, tier))))
  return rotas
}

// ---------------------------------------------------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------------------------------------------------

/** Los negocios con suscripción que pagan hoy cada precio vigente: una consulta acotada a los cuatro precios. */
async function conservanSuPrecio(vigente: PlanOfferDefinition): Promise<Record<Ranura, number>> {
  const ids = [...new Set(RANURAS.map(r => precioDe(vigente, r).stripePriceId).filter((id): id is string => !!id))]
  const grupos = ids.length
    ? await prisma.venueFeature.groupBy({
        by: ['stripePriceId'],
        where: { active: true, stripeSubscriptionId: { not: null }, stripePriceId: { in: ids } },
        _count: { _all: true },
      })
    : []
  const porPrecio = new Map(grupos.map(g => [g.stripePriceId, g._count._all]))
  const cuenta = (r: Ranura) => {
    const id = precioDe(vigente, r).stripePriceId
    return id ? (porPrecio.get(id) ?? 0) : 0
  }
  return {
    'PRO:monthly': cuenta('PRO:monthly'),
    'PRO:annual': cuenta('PRO:annual'),
    'PREMIUM:monthly': cuenta('PREMIUM:monthly'),
    'PREMIUM:annual': cuenta('PREMIUM:annual'),
  }
}

/** La definición de una versión leída por una relación, validada como `ofertaPorId` (rota → 503 `PLAN_NOT_CONFIGURED`). */
function definicionGuardada(versionId: string, definition: unknown): PlanOfferDefinition {
  const r = planOfferDefinition.safeParse(definition)
  if (r.success) return r.data
  // 🚨 a propósito: una versión guardada que no se puede leer es un problema nuestro.
  logger.error('🚨 planOfferPreview: la versión pendiente guardada no es válida', {
    versionId,
    motivo: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
  })
  throw new AppError(
    'Los planes no están disponibles por un problema nuestro de configuración. No se cobró nada. Escríbenos y lo resolvemos.',
    503,
    true,
    'PLAN_NOT_CONFIGURED',
    { versionId },
  )
}

export async function estadoDeLaOferta(): Promise<EstadoDeLaOferta> {
  // La vigente (validada, o 503 si está rota) y el puntero en lecturas separadas: se repite si el puntero se movió entre las dos.
  for (let intento = 0; intento < 3; intento++) {
    const vigente = await ofertaVigente()
    const puntero = await prisma.planOfferPointer.findUnique({
      where: { id: PUNTERO_ID },
      select: {
        revision: true,
        currentVersionId: true,
        nombresEnStripe: true,
        currentVersion: { select: { publishedAt: true, publishedById: true } },
        // La pendiente en la MISMA consulta (con su estado): una segunda lectura podía devolver una ya descartada.
        pendingVersion: { select: { id: true, status: true, definition: true, createdAt: true, preparacion: true } },
      },
    })
    if ((puntero?.currentVersionId ?? null) !== vigente.versionId) continue
    const p = puntero?.pendingVersion
    const pendiente =
      p && p.status === 'PREPARING'
        ? { versionId: p.id, definition: definicionGuardada(p.id, p.definition), creadaAt: p.createdAt, preparacion: p.preparacion }
        : null
    return {
      revision: puntero?.revision ?? 0,
      vigente: {
        number: vigente.number,
        versionId: vigente.versionId,
        definition: vigente.definition,
        entrada: entradaDesdeDefinicion(vigente.definition),
        publishedAt: puntero?.currentVersion?.publishedAt ?? null,
        publishedById: puntero?.currentVersion?.publishedById ?? null,
      },
      pendiente,
      interruptor: await estadoDelInterruptor(),
      nombresEnStripe: puntero?.nombresEnStripe ?? null,
      destinatarios: await getDestinatariosDelAlta(),
    }
  }
  throw desfasada()
}

/** Lo que publicar haría con esta `entrada`. Valida igual que publicar y NO escribe (tampoco pide el interruptor). */
export async function vistaPreviaDeLaOferta(entrada: unknown): Promise<VistaPrevia> {
  const datos = validarEntrada(entrada)
  const vigente = await ofertaVigente()
  const nueva = definicionDesdeEntrada(datos, vigente.definition)
  const campanas = await campanasQueBloquean(prisma, vigente.definition, nueva)
  return {
    cambios: cambiosEntre(vigente.definition, nueva),
    preciosNuevos: ranurasQueCambian(nueva, vigente.definition),
    bloqueos: { campanas: campanas.map(({ motivo: _motivo, ...c }) => c), promociones: await promocionesQueRompe(nueva) },
    conservanSuPrecio: await conservanSuPrecio(vigente.definition),
    problemas: [],
  }
}
