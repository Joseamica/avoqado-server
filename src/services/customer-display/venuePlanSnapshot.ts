// src/services/customer-display/venuePlanSnapshot.ts
import { getVenuePlanInfo, venueHasFeatureAccess, type VenuePlanInfo } from '@/services/access/basePlan.service'
import { SingleFlightCache, esperarTodas, type PollWorkLimiter } from './pollWork'

/**
 * El plan del venue tal como lo necesita la pantalla del cliente, en caché de 60 s POR VENUE (spec §5.7.4, 3).
 *
 * 🔴 Los dos son códigos de `Feature` → `venueHasFeatureAccess` (nunca el resolver de módulos: un venue
 * grandfathered pasaría un candado del sistema equivocado sin avisar). Un cambio de plan se ve en ≤ 60 s.
 */

export interface Entitlements {
  slides: boolean
  promotionCards: boolean
}

export interface PlanGrants {
  CUSTOMER_DISPLAY_PROMOS: boolean
  PROMOTIONS: boolean
}

/**
 * 🔴 LA regla (spec §5.3, §5.8): las imágenes exigen `CUSTOMER_DISPLAY_PROMOS`; las tarjetas exigen ese código Y
 * `PROMOTIONS`, porque el catálogo móvil exige `PROMOTIONS`: prometerlas sin él dejaría la pantalla anunciando un
 * catálogo que la tablet no puede bajar.
 */
export function entitlementsFrom(grants: PlanGrants): Entitlements {
  return { slides: grants.CUSTOMER_DISPLAY_PROMOS, promotionCards: grants.CUSTOMER_DISPLAY_PROMOS && grants.PROMOTIONS }
}

export async function readPlanGrants(venueId: string): Promise<PlanGrants> {
  // `esperarTodas` y no `Promise.all`: dentro del lugar del poll, un grant que falla no puede soltarlo con el otro vivo.
  const [CUSTOMER_DISPLAY_PROMOS, PROMOTIONS] = await esperarTodas([
    venueHasFeatureAccess(venueId, 'CUSTOMER_DISPLAY_PROMOS'),
    venueHasFeatureAccess(venueId, 'PROMOTIONS'),
  ])
  return { CUSTOMER_DISPLAY_PROMOS, PROMOTIONS }
}

export interface VenuePlanSnapshot {
  planInfo: VenuePlanInfo
  grants: PlanGrants
  entitlements: Entitlements
  /** Cuándo terminó de calcularse: con él, quien lo usa sabe hasta cuándo vale (DD4). */
  calculadoEn: number
}

export const PLAN_SNAPSHOT_TTL_MS = 60_000

const cache = new SingleFlightCache<VenuePlanSnapshot>({ ttlMs: PLAN_SNAPSHOT_TTL_MS, maxEntradas: 5_000 })

/**
 * UN trabajo del tope: se suelta cuando TODAS sus lecturas se asentaron (Codex r1 #2). Abre hasta 7 consultas a la vez
 * (las 5 ramas de `getVenuePlanInfo` y los dos grants); si la Task 13 mide que eso hace esperar a un cobro, el remedio es
 * leer los grants DESPUÉS del plan (dos `await` seguidos), no cambiar el 8. Las 5 ramas de `getVenuePlanInfo` también se
 * esperan todas antes de propagar un error, con su opción explícita (Codex r2 #2): nada sale del lugar con trabajo vivo. SÓLO
 * aquí: los demás consumidores del lector siguen con su `Promise.all` (Codex r3 N2).
 */
async function calcular(venueId: string): Promise<VenuePlanSnapshot> {
  const [planInfo, grants] = await esperarTodas([getVenuePlanInfo(venueId, { esperarTodasLasRamas: true }), readPlanGrants(venueId)])
  return { planInfo, grants, entitlements: entitlementsFrom(grants), calculadoEn: Date.now() }
}

export function readVenuePlanSnapshot(venueId: string, o: { limiter?: PollWorkLimiter } = {}): Promise<VenuePlanSnapshot> {
  return cache.get(venueId, () => calcular(venueId), { limiter: o.limiter })
}

export function peekVenuePlanSnapshot(venueId: string): VenuePlanSnapshot | undefined {
  return cache.peek(venueId)
}

/**
 * La parte del plan que entra a la huella `settings` (R2): lo que cambia lo que el aparato muestra o permite. Lista blanca
 * ESTABLE: 🔴 nunca `accessObservedAt`, que cambia en cada llamada y haría que la tablet refrescara sus ajustes en cada poll.
 * El `satisfies` obliga a decidir aquí el día que `VenuePlanInfo` gane un campo.
 */
export function planFingerprintPart(s: VenuePlanSnapshot): {
  tier: string
  grandfathered: boolean
  exempt: boolean
  grantedFeatureCodes: string[]
  accessSchemaVersion: number | null
  commercialPlanTier: string | null
  grants: PlanGrants
} {
  const p = s.planInfo
  const estable = {
    tier: p.tier,
    grandfathered: p.grandfathered,
    exempt: p.exempt,
    grantedFeatureCodes: [...(p.grantedFeatureCodes ?? [])].sort(),
    accessSchemaVersion: p.accessSchemaVersion ?? null,
    commercialPlanTier: p.commercialPlanTier ?? null,
  } satisfies Record<Exclude<keyof VenuePlanInfo, 'accessObservedAt'>, unknown>
  return { ...estable, grants: s.grants }
}

export function resetVenuePlanSnapshotsForTests(): void {
  cache.clearForTests()
}
