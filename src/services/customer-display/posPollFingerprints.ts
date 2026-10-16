// src/services/customer-display/posPollFingerprints.ts
import { Prisma, TerminalStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { fingerprintOf } from './canonicalHash'
import { getEffectiveDesign, peekEffectiveFingerprint } from './customerDisplayDesign.service'
import { POLL_BUDGET_MS, PollWorkSaturated, dentroDelPlazo, esperarTodas, pollWorkLimiter, type PollWorkLimiter } from './pollWork'
import { NO_PROMOTIONS_FINGERPRINT, peekCarouselFingerprint, readCarouselCached } from './promotionCarousel.service'
import { planFingerprintPart, peekVenuePlanSnapshot, readVenuePlanSnapshot, type VenuePlanSnapshot } from './venuePlanSnapshot'
import { readVenueSignatures, type VenueSignatures } from './venueSignatures'

/**
 * Las tres huellas del sobre del poll (spec §5.7.2, §5.7.4). Cada una en su propio aislamiento: si una falla, tarda o
 * no cabe en el tope, se OMITE (desconocida) y las demás salen. La entrega de la solicitud de inversión nunca espera.
 */

/**
 * Lo del APARATO que entra a la huella `settings` (DD3): lo que `/settings` le entrega de sí mismo. `config` y
 * `configOverrides` los pide el spec; lo demás es el bloque `deviceTerminal` del cuerpo. `Terminal.updatedAt` NO
 * sirve: los latidos lo mueven.
 */
export const SETTINGS_DEVICE_SELECT = {
  config: true,
  configOverrides: true,
  type: true,
  defaultWorkspace: true,
  fulfillmentAreaId: true,
  canIssueAreaTickets: true,
  canCheckoutAreaTickets: true,
  canDeliverAreaTickets: true,
  customerDisplayInverted: true,
} satisfies Prisma.TerminalSelect
export type SettingsDeviceRow = Prisma.TerminalGetPayload<{ select: typeof SETTINGS_DEVICE_SELECT }>

/** La consulta que el poll ya hacía, ampliada (spec §5.7.4, 1): sigue siendo UNA consulta por poll. */
export const POLL_TERMINAL_SELECT = {
  id: true,
  status: true, // decide si el aparato es su propia fuente de ajustes (Codex r1 #9)
  customerDisplayRequest: true,
  customerDisplayRequestExpiresAt: true,
  customerDisplayDesignVersion: true,
  customerDisplayInstallationId: true,
  ...SETTINGS_DEVICE_SELECT,
} satisfies Prisma.TerminalSelect
export type PollTerminal = Prisma.TerminalGetPayload<{ select: typeof POLL_TERMINAL_SELECT }>

const COLUMNAS_DEL_APARATO = Object.keys(SETTINGS_DEVICE_SELECT) as Array<keyof SettingsDeviceRow>

/**
 * 🔴 LA regla de `/settings` para elegir de dónde salen los ajustes (`tpvSettings.mobile.controller.ts:126-129`), UNA vez:
 * la terminal del propio aparato si está en uno de estos estados; si no, la primera `ACTIVE` del negocio en este orden. El
 * cuerpo de `/settings` usa estas MISMAS constantes (Task 10, R11).
 */
export const ESTADOS_DE_FUENTE_PROPIA: readonly TerminalStatus[] = [TerminalStatus.ACTIVE, TerminalStatus.INACTIVE]
export const ORDEN_DEL_RESPALDO: Prisma.TerminalOrderByWithRelationInput[] = [{ name: 'asc' }, { id: 'asc' }]

export type FuenteDeAjustes =
  | { propia: true; id: string; aparato: SettingsDeviceRow }
  | { propia: false; respaldo: { id: string; config: Prisma.JsonValue; configOverrides: Prisma.JsonValue } | null }

/** Sin consultar nada en el caso normal (la fila del binding ya trae `status`); UNA consulta sólo si el aparato no es su fuente. */
export async function leerFuenteDeAjustes(
  venueId: string,
  aparato: { id: string; status: TerminalStatus } & SettingsDeviceRow,
): Promise<FuenteDeAjustes> {
  if (ESTADOS_DE_FUENTE_PROPIA.includes(aparato.status)) {
    // Sólo las columnas de los ajustes: ni el `status` (lo mueve la vigilancia de latidos) ni la solicitud ni la instalación.
    const propio = Object.fromEntries(COLUMNAS_DEL_APARATO.map(c => [c, aparato[c]])) as SettingsDeviceRow
    return { propia: true, id: aparato.id, aparato: propio }
  }
  const respaldo = await prisma.terminal.findFirst({
    where: { venueId, status: TerminalStatus.ACTIVE },
    orderBy: ORDEN_DEL_RESPALDO,
    select: { id: true, config: true, configOverrides: true },
  })
  return { propia: false, respaldo }
}

/**
 * LA huella de ajustes: el poll y `/settings` la calculan con esta misma función y la misma fuente (Task 10). Cubre la
 * fuente EFECTIVA con su identidad (Codex r1 #9): cuando el aparato no es su propia fuente, la del respaldo.
 */
export function settingsFingerprint(i: { fuente: FuenteDeAjustes; venue: VenueSignatures; plan: VenuePlanSnapshot }): string {
  const f = i.fuente
  let fuente: Record<string, unknown>
  if (f.propia) {
    const aparato = f.aparato
    fuente = { propia: true, id: f.id, ...Object.fromEntries(COLUMNAS_DEL_APARATO.map(c => [c, aparato[c] ?? null])) }
  } else {
    const r = f.respaldo
    fuente = { propia: false, respaldo: r ? { id: r.id, config: r.config ?? null, configOverrides: r.configOverrides ?? null } : null }
  }
  return fingerprintOf({ fuente, venue: i.venue, plan: planFingerprintPart(i.plan) })
}

/**
 * ¿El servidor sabe qué entiende ESTE aparato en ESTE negocio? Si no —app vieja, primera vez, o recién mudada (el
 * traslado de F0-A borra versión e instalación a propósito)—, el poll pide un reporte YA, sin esperar las 24 h.
 */
export function capabilityReportRequested(t: {
  customerDisplayDesignVersion: number | null
  customerDisplayInstallationId: string | null
}): boolean {
  return t.customerDisplayDesignVersion == null || t.customerDisplayInstallationId == null
}

export interface PollFingerprints {
  customerDisplay?: string
  settings?: string
  promotions?: string
}

export interface PollDeps {
  limiter: PollWorkLimiter
  plazoMs: number
  esperar?: (ms: number) => Promise<void>
  peekFicha: (venueId: string, terminalId: string) => string | undefined
  calcularFicha: (venueId: string, terminalId: string, limiter: PollWorkLimiter) => Promise<string>
  peekPlan: (venueId: string) => VenuePlanSnapshot | undefined
  leerPlan: (venueId: string, limiter: PollWorkLimiter) => Promise<VenuePlanSnapshot>
  leerFuente: (venueId: string, terminal: PollTerminal) => Promise<FuenteDeAjustes>
  leerFirmas: (venueId: string) => Promise<VenueSignatures | null>
  peekCarrusel: (venueId: string) => string | undefined
  leerCarrusel: (venueId: string, limiter: PollWorkLimiter) => Promise<string>
}

/** Exportadas para las integraciones: `{ ...POLL_DEPS_REALES, plazoMs: 30_000 }` evita que la carga de la máquina omita una huella. */
export const POLL_DEPS_REALES: PollDeps = {
  limiter: pollWorkLimiter,
  plazoMs: POLL_BUDGET_MS,
  peekFicha: peekEffectiveFingerprint,
  calcularFicha: (venueId, terminalId, limiter) =>
    getEffectiveDesign(venueId, terminalId, { cache: true, limiter }).then(r => r.ficha.fingerprint),
  peekPlan: peekVenuePlanSnapshot,
  leerPlan: (venueId, limiter) => readVenuePlanSnapshot(venueId, { limiter }),
  leerFuente: leerFuenteDeAjustes,
  leerFirmas: readVenueSignatures,
  peekCarrusel: peekCarouselFingerprint,
  leerCarrusel: (venueId, limiter) => readCarouselCached(venueId, { limiter }).then(r => r.fingerprint),
}

type Fuente = keyof PollFingerprints

/** Un `throw` síncrono de una dependencia se vuelve rechazo: así cae en `alFallar` como cualquier otro error. */
function llamar<T>(trabajo: () => Promise<T>): Promise<T> {
  try {
    return trabajo()
  } catch (error) {
    return Promise.reject(error)
  }
}

export async function collectPollFingerprints(
  input: { venueId: string; terminal: PollTerminal; hasRequest: boolean },
  deps: PollDeps = POLL_DEPS_REALES,
): Promise<PollFingerprints> {
  const { venueId, terminal, hasRequest } = input
  const version = terminal.customerDisplayDesignVersion
  if (version == null) return {} // decisión 1: nadie las leería
  const conPromos = version >= 2

  // 1. Lo que ya está en caché: sin esperar nada.
  const huellas: PollFingerprints = {}
  const fichaGuardada = deps.peekFicha(venueId, terminal.id)
  if (fichaGuardada) huellas.customerDisplay = fichaGuardada
  const planGuardado = deps.peekPlan(venueId)
  if (conPromos && planGuardado) {
    if (!planGuardado.grants.PROMOTIONS) huellas.promotions = NO_PROMOTIONS_FINGERPRINT
    else {
      const promos = deps.peekCarrusel(venueId)
      if (promos) huellas.promotions = promos
    }
  }

  // 2. Lo que falta, arrancado a la vez. Cada caché aplica el tope por dentro (la ficha y el carrusel, con su plan); a
  //    `settings` no la cubre ninguna caché: sus lecturas toman su lugar aquí. Nunca un lugar dentro de otro (Codex r1 #2).
  const tareas: Partial<Record<Fuente, Promise<string>>> = {}
  if (!huellas.customerDisplay) tareas.customerDisplay = llamar(() => deps.calcularFicha(venueId, terminal.id, deps.limiter))
  if (conPromos && !huellas.promotions) {
    tareas.promotions = llamar(async () => {
      const plan = await deps.leerPlan(venueId, deps.limiter)
      return plan.grants.PROMOTIONS ? deps.leerCarrusel(venueId, deps.limiter) : NO_PROMOTIONS_FINGERPRINT
    })
  }
  if (!hasRequest) {
    // Lo que lee la base para `settings` (la fuente —casi siempre sin consulta— y las firmas, UNA tras otra) ocupa SU lugar
    // hasta terminar; sin lugar, `settings` se omite sin arrancar nada. El plan va por su caché, con su propio lugar.
    const enSuLugar = deps.limiter.intentar(async () => {
      const fuente = await deps.leerFuente(venueId, terminal)
      return { fuente, firmas: await deps.leerFirmas(venueId) }
    })
    if (enSuLugar) {
      // `esperarTodas`: aunque el plan falle (o se sature) primero, la huella no se asienta con las firmas vivas.
      const plan = llamar(() => deps.leerPlan(venueId, deps.limiter))
      tareas.settings = esperarTodas([enSuLugar, plan]).then(([{ fuente, firmas }, planLeido]) => {
        if (!firmas) throw new Error('El negocio ya no existe')
        return settingsFingerprint({ fuente, venue: firmas, plan: planLeido })
      })
    }
  }

  const alFallar = (fuente: Fuente, error: unknown) => {
    if (error instanceof PollWorkSaturated) return // el tope haciendo su trabajo, no un error
    logger.warn('[pantalla-del-cliente] una huella del poll no se pudo calcular; se omite', {
      fuente,
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  if (hasRequest) {
    // 🔴 Con solicitud de inversión no se espera NADA (spec §5.7.4): lo que arrancó termina para llenar su caché.
    for (const [fuente, promesa] of Object.entries(tareas) as Array<[Fuente, Promise<string>]>) promesa.catch(e => alFallar(fuente, e))
    return huellas
  }

  const llegaron = await dentroDelPlazo(tareas, deps.plazoMs, { esperar: deps.esperar, alFallar })
  return { ...huellas, ...llegaron }
}
