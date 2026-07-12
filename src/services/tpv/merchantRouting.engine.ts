/**
 * Motor PURO de reglas de enrutamiento de merchants (MERCHANT_ROUTING_RULES).
 *
 * Sin Prisma ni I/O — todo lo que necesita llega por parámetros para que sea
 * unit-testeable (tests/unit/services/tpv/merchantRouting.engine.test.ts).
 *
 * Semántica (spec Avoqado-HQ/specs/2026-07-10-merchant-routing-rules.md):
 *  - AND entre condiciones presentes; condición sin datos de entrada ⇒ FALLA (no se adivina).
 *  - Merchant sin regla (conditions null) ⇒ siempre elegible.
 *  - Tope de volumen PROYECTADO: acumulado + ticket actual > max ⇒ no elegible (== max pasa).
 *  - Exactamente 1 elegible ⇒ auto-select; 0 elegibles ⇒ fallbackAll (mostrar todos + aviso —
 *    una regla nunca bloquea una venta).
 *  - Horario en TZ del venue; ventana que cruza medianoche se ancla al día de INICIO.
 *  - Montos SIEMPRE en PESOS (unidades mayores, 1:1) — nunca centavos.
 *  - circuitBreaker NO se evalúa aquí: es config que la TPV aplica localmente.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

// ─── Tipos del shape de condiciones (espejo del Json validado por zod) ───────

export type ScheduleWindow = { start: string; end: string } // "HH:mm"
/** days: 0=domingo … 6=sábado (convención JS). */
export type ScheduleCondition = { days: number[]; windows: ScheduleWindow[] }
export type GeofenceCondition = { lat: number; lng: number; radiusM: number }
/** maxAmount en PESOS. Proyectado: acumulado + ticket > max ⇒ falla. */
export type VolumeCapCondition = { period: 'DAY' | 'WEEK' | 'MONTH'; maxAmount?: number; maxTxCount?: number }
/** min/max en PESOS, inclusivos. */
export type TicketAmountCondition = { min?: number; max?: number }
export type StaffCondition = { staffIds?: string[]; roles?: string[] }
/** Config para la TPV (enforcement local); el server solo la transporta. */
export type CircuitBreakerCondition = { consecutiveFailures: number; cooldownMinutes: number }

export type MerchantRoutingConditions = {
  schedule?: ScheduleCondition
  geofence?: GeofenceCondition
  volumeCap?: VolumeCapCondition
  ticketAmount?: TicketAmountCondition
  staff?: StaffCondition
  circuitBreaker?: CircuitBreakerCondition
}

/** Partes de "ahora" ya convertidas a la TZ del venue (ver venueNowParts). */
export type NowParts = { day: number; prevDay: number; minutes: number }

export type EvaluationContext = {
  now: NowParts
  /** Monto del ticket actual en PESOS. */
  amount: number
  location?: { lat: number; lng: number }
  staffId?: string
  staffRole?: string
  /** Acumulados del período para el merchant en evaluación (PESOS / conteo). */
  aggregates?: { grossAmount: number; txCount: number }
}

export const REASON = {
  SCHEDULE: 'SCHEDULE',
  GEOFENCE: 'GEOFENCE',
  GEOFENCE_NO_LOCATION: 'GEOFENCE_NO_LOCATION',
  VOLUME_CAP: 'VOLUME_CAP',
  TICKET_AMOUNT: 'TICKET_AMOUNT',
  STAFF: 'STAFF',
} as const
export type ReasonCode = (typeof REASON)[keyof typeof REASON]

// ─── Condiciones individuales ────────────────────────────────────────────────

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Inicio inclusivo, fin exclusivo. Ventana que cruza medianoche (end <= start):
 * matchea si arrancó HOY (day ∈ days && t >= start) o si arrancó AYER
 * (prevDay ∈ days && t < end) — la ventana pertenece al día en que INICIA.
 */
export function evaluateSchedule(cond: ScheduleCondition, now: NowParts): boolean {
  const t = now.minutes
  return cond.windows.some(w => {
    const start = toMinutes(w.start)
    const end = toMinutes(w.end)
    if (start < end) {
      return cond.days.includes(now.day) && t >= start && t < end
    }
    // cruza medianoche
    return (cond.days.includes(now.day) && t >= start) || (cond.days.includes(now.prevDay) && t < end)
  })
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Sin ubicación ⇒ falla (la condición no se puede comprobar; no se adivina). */
export function evaluateGeofence(cond: GeofenceCondition, location?: { lat: number; lng: number }): boolean {
  if (!location) return false
  return haversineMeters(cond.lat, cond.lng, location.lat, location.lng) <= cond.radiusM
}

/** Límites inclusivos, en PESOS. */
export function evaluateTicketAmount(cond: TicketAmountCondition, amount: number): boolean {
  if (cond.min !== undefined && amount < cond.min) return false
  if (cond.max !== undefined && amount > cond.max) return false
  return true
}

export function evaluateStaff(cond: StaffCondition, staffId?: string, staffRole?: string): boolean {
  const byId = !!staffId && !!cond.staffIds?.includes(staffId)
  const byRole = !!staffRole && !!cond.roles?.includes(staffRole)
  return byId || byRole
}

/**
 * Tope PROYECTADO: si al sumar el ticket actual se rebasa el tope, el merchant
 * deja de ser elegible ANTES de rebasarlo. Igualar el tope exacto sí pasa.
 * Sin agregados (fallo de datos) ⇒ falla cerrado.
 */
export function evaluateVolumeCap(
  cond: VolumeCapCondition,
  aggregates: { grossAmount: number; txCount: number } | undefined,
  ticketAmount: number,
): boolean {
  if (!aggregates) return false
  if (cond.maxAmount !== undefined && aggregates.grossAmount + ticketAmount > cond.maxAmount) return false
  if (cond.maxTxCount !== undefined && aggregates.txCount + 1 > cond.maxTxCount) return false
  return true
}

// ─── Evaluación de una regla completa (AND) ─────────────────────────────────

export function evaluateConditions(
  conditions: MerchantRoutingConditions,
  ctx: EvaluationContext,
): { eligible: boolean; reasons: ReasonCode[] } {
  const reasons: ReasonCode[] = []

  if (conditions.schedule && !evaluateSchedule(conditions.schedule, ctx.now)) {
    reasons.push(REASON.SCHEDULE)
  }
  if (conditions.geofence) {
    if (!ctx.location) reasons.push(REASON.GEOFENCE_NO_LOCATION)
    else if (!evaluateGeofence(conditions.geofence, ctx.location)) reasons.push(REASON.GEOFENCE)
  }
  if (conditions.volumeCap && !evaluateVolumeCap(conditions.volumeCap, ctx.aggregates, ctx.amount)) {
    reasons.push(REASON.VOLUME_CAP)
  }
  if (conditions.ticketAmount && !evaluateTicketAmount(conditions.ticketAmount, ctx.amount)) {
    reasons.push(REASON.TICKET_AMOUNT)
  }
  if (conditions.staff && !evaluateStaff(conditions.staff, ctx.staffId, ctx.staffRole)) {
    reasons.push(REASON.STAFF)
  }
  // circuitBreaker: intencionalmente NO evaluado aquí (config para la TPV).

  return { eligible: reasons.length === 0, reasons }
}

// ─── Evaluación del set completo del venue ──────────────────────────────────

export type MerchantForEvaluation = {
  merchantAccountId: string
  /** null ⇒ sin regla activa ⇒ siempre elegible. */
  conditions: MerchantRoutingConditions | null
  /** Acumulados del período de SU volumeCap (los topes son por merchant). */
  aggregates?: { grossAmount: number; txCount: number }
}

export type MerchantEligibility = {
  merchantAccountId: string
  eligible: boolean
  reasons: ReasonCode[]
}

export type EligibilitySetResult = {
  merchants: MerchantEligibility[]
  /** Set cuando queda EXACTAMENTE 1 elegible (D7: auto-selección). */
  autoSelectMerchantAccountId: string | null
  /** true cuando 0 quedaron elegibles (D6): mostrar todos + aviso; razones se conservan para auditoría. */
  fallbackAll: boolean
}

export function evaluateEligibilitySet(merchants: MerchantForEvaluation[], ctx: EvaluationContext): EligibilitySetResult {
  const evaluated: MerchantEligibility[] = merchants.map(m => {
    if (!m.conditions) return { merchantAccountId: m.merchantAccountId, eligible: true, reasons: [] }
    const r = evaluateConditions(m.conditions, m.aggregates ? { ...ctx, aggregates: m.aggregates } : ctx)
    return { merchantAccountId: m.merchantAccountId, eligible: r.eligible, reasons: r.reasons }
  })

  const eligibleIds = evaluated.filter(m => m.eligible).map(m => m.merchantAccountId)
  const fallbackAll = merchants.length > 0 && eligibleIds.length === 0

  if (fallbackAll) {
    // La venta nunca se bloquea: todos visibles, razones conservadas para el snapshot.
    for (const m of evaluated) m.eligible = true
  }

  return {
    merchants: evaluated,
    autoSelectMerchantAccountId: !fallbackAll && eligibleIds.length === 1 ? eligibleIds[0] : null,
    fallbackAll,
  }
}

// ─── Helpers de fecha en TZ del venue (host-tz-independientes) ──────────────

/**
 * Partes de "ahora" en la TZ del venue. Usa formatInTimeZone (string-based),
 * nunca el tz del host — regla crítica del repo (bare YYYY-MM-DD trap).
 */
export function venueNowParts(venueTz: string, now: Date = new Date()): NowParts {
  const isoDay = Number(formatInTimeZone(now, venueTz, 'i')) // 1=lunes … 7=domingo
  const day = isoDay % 7 // JS: 0=domingo … 6=sábado
  const prevDay = (day + 6) % 7
  const minutes = Number(formatInTimeZone(now, venueTz, 'HH')) * 60 + Number(formatInTimeZone(now, venueTz, 'mm'))
  return { day, prevDay, minutes }
}

/**
 * Inicio del período (DAY | WEEK ISO-lunes | MONTH) como instante UTC real,
 * calculado sobre el calendario venue-local. Patrón sancionado del repo:
 * fromZonedTime con STRING venue-local (independiente del tz del host).
 */
export function periodStartUtc(period: 'DAY' | 'WEEK' | 'MONTH', venueTz: string, now: Date = new Date()): Date {
  const localDate = formatInTimeZone(now, venueTz, 'yyyy-MM-dd')

  if (period === 'DAY') {
    return fromZonedTime(`${localDate}T00:00:00.000`, venueTz)
  }

  if (period === 'MONTH') {
    return fromZonedTime(`${localDate.slice(0, 7)}-01T00:00:00.000`, venueTz)
  }

  // WEEK: lunes ISO de la fecha venue-local. Ancla a MEDIODÍA UTC para que la
  // resta de días nunca cruce de fecha por tz (belt-and-suspenders; MX ya no tiene DST).
  const isoDay = Number(formatInTimeZone(now, venueTz, 'i')) // 1=lunes
  const [y, m, d] = localDate.split('-').map(Number)
  const anchor = new Date(Date.UTC(y, m - 1, d, 12))
  anchor.setUTCDate(anchor.getUTCDate() - (isoDay - 1))
  const mondayLocal = anchor.toISOString().slice(0, 10)
  return fromZonedTime(`${mondayLocal}T00:00:00.000`, venueTz)
}
