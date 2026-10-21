// src/services/fiscal/globalPeriod.ts
//
// PURE period math for Flow C (factura global). All functions accept an injectable `now`
// so tests can pass arbitrary dates without mocking Date.now().
//
// Mexico TZ boundaries use date-fns-tz (already in package.json).
//
// SAT c_Periodicidad reference:
//   01 = Diario  (day)
//   02 = Semanal (week — Mon..Sun)
//   03 = Quincenal (fortnight — 1st..15th / 16th..EOM)
//   04 = Mensual (month)
//   05 = Bimestral (two_months — Jan+Feb=13, Mar+Apr=14, May+Jun=15, Jul+Aug=16, Sep+Oct=17, Nov+Dec=18)
//
// SAT c_Meses reference (for GlobalInfo.months):
//   '01'..'12' = Jan..Dec (single months)
//   '13'       = Jan+Feb (bimestral)
//   '14'       = Mar+Apr
//   '15'       = May+Jun
//   '16'       = Jul+Aug
//   '17'       = Sep+Oct
//   '18'       = Nov+Dec

import { GlobalPeriodicity } from '@prisma/client'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { FacturapiPeriodicity, SatPeriodicidadCode } from './providers/fiscal-provider.interface'

const MX_TZ = 'America/Mexico_City'

/** Result of a closed-period calculation. */
export interface ClosedPeriod {
  /** Inclusive start of the closed period (UTC, for Prisma queries). */
  periodStart: Date
  /** Exclusive end of the closed period (UTC, for Prisma queries). */
  periodEnd: Date
  /** SAT c_Meses code (string, e.g. '05', '13'). */
  meses: string
  /** Four-digit year of the period. */
  anio: number
  /** SAT c_Periodicidad code (01..05). */
  satPeriodicidad: SatPeriodicidadCode
  /** facturapi InvoicingPeriod string value. */
  facturaPeriodicity: FacturapiPeriodicity
}

/**
 * Maps our GlobalPeriodicity enum → facturapi InvoicingPeriod + SAT c_Periodicidad.
 * Verified against node_modules/facturapi/dist/enums.d.ts (GlobalInvoicePeriodicity).
 */
const PERIODICITY_MAP: Record<GlobalPeriodicity, { facturaPeriodicity: FacturapiPeriodicity; satPeriodicidad: SatPeriodicidadCode }> = {
  DIARIO: { facturaPeriodicity: 'day', satPeriodicidad: '01' },
  SEMANAL: { facturaPeriodicity: 'week', satPeriodicidad: '02' },
  QUINCENAL: { facturaPeriodicity: 'fortnight', satPeriodicidad: '03' },
  MENSUAL: { facturaPeriodicity: 'month', satPeriodicidad: '04' },
  BIMESTRAL: { facturaPeriodicity: 'two_months', satPeriodicidad: '05' },
}

/** Pad a number to 2 digits. */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Convert a Mexico-local calendar date (year/month/day) to a UTC Date suitable for Prisma.
 * Uses fromZonedTime so that "2026-05-01 00:00 Mexico" → correct UTC offset.
 */
function mxToUtc(year: number, month1: number, day: number): Date {
  // ISO-string "YYYY-MM-DDT00:00:00" interpreted as Mexico local time
  const localIso = `${year}-${pad2(month1)}-${pad2(day)}T00:00:00`
  return fromZonedTime(localIso, MX_TZ)
}

/**
 * Pure. Given a periodicity and a reference Date (inject `now` — do NOT call Date.now() internally),
 * returns the most-recent fully-closed period with all fields needed for stamp + storage.
 *
 * "Fully closed" means the period has already ended before `now` in Mexico time.
 *
 * @example
 *   closedPeriodFor('MENSUAL', new Date('2026-06-03T12:00:00Z'))
 *   // → May 2026: periodStart=2026-05-01T06:00:00Z, periodEnd=2026-06-01T06:00:00Z
 *   //   meses='05', anio=2026, satPeriodicidad='04'
 */
export function closedPeriodFor(periodicity: GlobalPeriodicity, now: Date): ClosedPeriod {
  const { facturaPeriodicity, satPeriodicidad } = PERIODICITY_MAP[periodicity]

  // Work in Mexico local time throughout
  const local = toZonedTime(now, MX_TZ)
  const year = local.getFullYear()
  const month1 = local.getMonth() + 1 // 1..12
  const day = local.getDate()
  const dow = local.getDay() // 0=Sun..6=Sat

  switch (periodicity) {
    case 'DIARIO': {
      // Closed period = yesterday in Mexico time
      const prevYear = day === 1 && month1 === 1 ? year - 1 : year
      const prevMonth = day === 1 ? (month1 === 1 ? 12 : month1 - 1) : month1
      const prevDay = day === 1 ? daysInMonth(prevMonth, prevYear) : day - 1

      const periodStart = mxToUtc(prevYear, prevMonth, prevDay)
      const periodEnd = mxToUtc(year, month1, day) // exclusive: today's start = yesterday's end

      return {
        periodStart,
        periodEnd,
        meses: pad2(prevMonth),
        anio: prevYear,
        satPeriodicidad,
        facturaPeriodicity,
      }
    }

    case 'SEMANAL': {
      // Week = Mon..Sun. "Current week" = the week containing today.
      // Most recent closed week = the one that ended last Sunday (exclusive Monday = start of closed week + 7d).
      // If today is Monday (dow=1), the last closed week ended yesterday (Sunday).
      // Days since last Monday: dow=0(Sun)→6, dow=1(Mon)→0, dow=2(Tue)→1, ...
      const daysSinceThisMonday = (dow + 6) % 7
      // Start of current week's Monday in Mexico local:
      // = today − daysSinceThisMonday days
      const thisMonday = new Date(local)
      thisMonday.setDate(day - daysSinceThisMonday)

      // Closed week = previous week: Mon to Mon (exclusive end)
      const prevMonday = new Date(thisMonday)
      prevMonday.setDate(thisMonday.getDate() - 7)

      const pmYear = prevMonday.getFullYear()
      const pmMonth = prevMonday.getMonth() + 1
      const pmDay = prevMonday.getDate()

      const tmYear = thisMonday.getFullYear()
      const tmMonth = thisMonday.getMonth() + 1
      const tmDay = thisMonday.getDate()

      const periodStart = mxToUtc(pmYear, pmMonth, pmDay)
      const periodEnd = mxToUtc(tmYear, tmMonth, tmDay)

      // SAT c_Meses = month of the Monday that starts the week
      return {
        periodStart,
        periodEnd,
        meses: pad2(pmMonth),
        anio: pmYear,
        satPeriodicidad,
        facturaPeriodicity,
      }
    }

    case 'QUINCENAL': {
      // Two fortnights per month: 1st..15th and 16th..EOM.
      // Closed fortnight when today > 15 → 1st fortnight (1..16 exclusive).
      // Closed fortnight when today <= 15 → 2nd fortnight of prev month (16..EOM+1 exclusive).
      if (day > 15) {
        // Closed: 1st fortnight of current month
        const periodStart = mxToUtc(year, month1, 1)
        const periodEnd = mxToUtc(year, month1, 16)
        return { periodStart, periodEnd, meses: pad2(month1), anio: year, satPeriodicidad, facturaPeriodicity }
      } else {
        // Closed: 2nd fortnight of previous month
        const prevMonth = month1 === 1 ? 12 : month1 - 1
        const prevYear = month1 === 1 ? year - 1 : year
        const lastDay = daysInMonth(prevMonth, prevYear)
        const periodStart = mxToUtc(prevYear, prevMonth, 16)
        const periodEnd = mxToUtc(year, month1, 1) // exclusive: 1st of current month
        return { periodStart, periodEnd, meses: pad2(prevMonth), anio: prevYear, satPeriodicidad, facturaPeriodicity }
      }
    }

    case 'MENSUAL': {
      // Closed period = previous full calendar month.
      // e.g. on Jun 3 → May (2026-05-01 00:00 MX .. 2026-06-01 00:00 MX exclusive)
      const closedMonth = month1 === 1 ? 12 : month1 - 1
      const closedYear = month1 === 1 ? year - 1 : year

      const periodStart = mxToUtc(closedYear, closedMonth, 1)
      const periodEnd = mxToUtc(year, month1, 1) // exclusive: 1st of current month

      return {
        periodStart,
        periodEnd,
        meses: pad2(closedMonth),
        anio: closedYear,
        satPeriodicidad,
        facturaPeriodicity,
      }
    }

    case 'BIMESTRAL': {
      // Bimestral pairs (1-indexed months): Jan+Feb, Mar+Apr, May+Jun, Jul+Aug, Sep+Oct, Nov+Dec
      // SAT c_Meses: '13'...'18' for the 6 bimestral periods.
      // Current bimestral period = the pair that contains THIS month.
      // Closed period = the previous bimestral pair.
      const pairIndex = Math.floor((month1 - 1) / 2) // 0..5 for Jan..Dec

      // Closed pair = one before current
      let closedPairIndex: number
      let closedYear: number
      if (pairIndex === 0) {
        // Current: Jan+Feb → closed: Nov+Dec of previous year
        closedPairIndex = 5
        closedYear = year - 1
      } else {
        closedPairIndex = pairIndex - 1
        closedYear = year
      }

      const closedStartMonth = closedPairIndex * 2 + 1 // 1,3,5,7,9,11
      const closedEndMonth = closedStartMonth + 2 // exclusive start of next pair

      const periodStart = mxToUtc(closedYear, closedStartMonth, 1)
      // Exclusive end: first day of the month after the pair
      const endYear = closedEndMonth > 12 ? closedYear + 1 : closedYear
      const endMonth = closedEndMonth > 12 ? 1 : closedEndMonth
      const periodEnd = mxToUtc(endYear, endMonth, 1)

      // SAT c_Meses: pair 0 (Jan+Feb) = '13', pair 1 (Mar+Apr) = '14', ..., pair 5 (Nov+Dec) = '18'
      const meses = String(13 + closedPairIndex)

      return {
        periodStart,
        periodEnd,
        meses,
        anio: closedYear,
        satPeriodicidad,
        facturaPeriodicity,
      }
    }
  }
}

/** Days in a given month (1-indexed), accounting for leap years. */
function daysInMonth(month1: number, year: number): number {
  return new Date(year, month1, 0).getDate()
}

/** C1 (C1-P8): cuántos periodos cerrados revisa el job en cada pasada (los que no tienen global se emiten tarde: mejor que nunca). */
export const PERIODOS_A_REVISAR: Readonly<Record<GlobalPeriodicity, number>> = Object.freeze({
  DIARIO: 7,
  SEMANAL: 4,
  QUINCENAL: 2,
  MENSUAL: 2,
  BIMESTRAL: 2,
})

/**
 * C1: los `n` periodos cerrados anteriores al periodo que contiene `instante`, el más reciente primero. Con `instante` = el inicio de un
 * periodo, da los anteriores a él (así se pagina). Contiguos: el fin de cada uno es el inicio del anterior en la lista.
 */
export function periodosCerradosRecientes(p: GlobalPeriodicity, instante: Date, n: number = PERIODOS_A_REVISAR[p]): ClosedPeriod[] {
  const r: ClosedPeriod[] = []
  let at = instante
  for (let i = 0; i < n; i++) {
    const q = closedPeriodFor(p, at)
    r.push(q)
    at = q.periodStart
  }
  return r
}

/**
 * C1: el periodo CERRADO (a `now`) que empieza exactamente en `desde`, o null (una fecha inválida, una que no es inicio de periodo, o un
 * periodo todavía abierto). Camina hacia atrás desde 70 días después de `desde` (acotado: a lo más 80 pasos).
 */
export function periodoQueEmpiezaEn(p: GlobalPeriodicity, desde: Date, now: Date): ClosedPeriod | null {
  const t = desde.getTime()
  if (!Number.isFinite(t) || t >= closedPeriodFor(p, now).periodEnd.getTime()) return null
  let q = closedPeriodFor(p, new Date(t + 70 * 86_400_000))
  for (let i = 0; i < 80 && q.periodStart.getTime() > t; i++) q = closedPeriodFor(p, q.periodStart)
  return q.periodStart.getTime() === t ? q : null
}

/** C1 v5 (C1-P16 = B, Codex C1-31): lo que la persona puede emitir a mano: sólo el inicio exacto de uno de los periodos que revisa el job. */
export function periodoRecienteQueEmpiezaEn(p: GlobalPeriodicity, desde: Date, now: Date): ClosedPeriod | null {
  const q = periodoQueEmpiezaEn(p, desde, now)
  return q && periodosCerradosRecientes(p, now, PERIODOS_A_REVISAR[p]).some(r => mismoPeriodo(r, q)) ? q : null
}
export const MOTIVO_PERIODO_VIEJO = 'Ese periodo ya no se emite desde aquí; pídelo a soporte.'

/**
 * C1 (C1-14): mensual y bimestral son un periodo por (meses, año), sin ambigüedad; diario/semanal/quincenal no traen día ⇒ null. Un código
 * que no corresponde a su periodicidad (mes 13 en mensual, '09' en bimestral, año no entero) ⇒ null.
 */
export function periodoDeGlobalPeriod(gp: { periodicidad: string; meses: string; anio: number }): ClosedPeriod | null {
  if (!Number.isSafeInteger(gp?.anio) || typeof gp.meses !== 'string' || !/^\d{2}$/.test(gp.meses)) return null
  const m = Number(gp.meses)
  let q: ClosedPeriod | null = null
  if (gp.periodicidad === '04' && m >= 1 && m <= 12)
    // El mes siguiente, a medio mes: su periodo cerrado es exactamente este mes.
    q = closedPeriodFor('MENSUAL', mxToUtc(m === 12 ? gp.anio + 1 : gp.anio, (m % 12) + 1, 15))
  else if (gp.periodicidad === '05' && m >= 13 && m <= 18) {
    const inicio = (m - 13) * 2 + 1 // '13' ⇒ enero, '18' ⇒ noviembre
    const siguiente = inicio + 2 > 12 ? { anio: gp.anio + 1, mes: 1 } : { anio: gp.anio, mes: inicio + 2 }
    q = closedPeriodFor('BIMESTRAL', mxToUtc(siguiente.anio, siguiente.mes, 15))
  }
  return q && q.meses === gp.meses && q.anio === gp.anio ? q : null
}

/** C1: c_Periodicidad del SAT → la periodicidad del emisor (o null). Sólo códigos propios del mapa (nunca una llave heredada de `Object`). */
export function periodicidadDeCodigo(sat: unknown): GlobalPeriodicity | null {
  const hallada = (Object.keys(PERIODICITY_MAP) as GlobalPeriodicity[]).find(k => PERIODICITY_MAP[k].satPeriodicidad === sat)
  return hallada ?? null
}

/** C1 (Tarea 9): el c_Periodicidad del SAT de una periodicidad del emisor (`BIMESTRAL` ⇒ `'05'`). */
export function satDePeriodicidad(p: GlobalPeriodicity): SatPeriodicidadCode {
  return PERIODICITY_MAP[p].satPeriodicidad
}

/**
 * C1 (Tarea 9, Codex C1-4/C1-19). Guía de llenado del CFDI global, `InformacionGlobal/Periodicidad`: «Cuando el valor de este campo sea
 * "05" el campo RegimenFiscal debe ser "621"».
 */
export const MOTIVO_BIMESTRAL_SOLO_621 =
  'El SAT sólo permite la periodicidad bimestral al régimen 621 (Incorporación Fiscal). Elige otra periodicidad o corrige el régimen fiscal del emisor.'

/**
 * C1 (Tarea 10, m1 de la revisión de la T9): la misma regla, cuando el periodo bimestral YA tiene una global apartada (reservada con sus ventas
 * y nunca enviada). Cambiar la periodicidad no la libera (la fila guarda la suya), así que no se le pide eso al dueño: se manda a soporte.
 */
export const MOTIVO_BIMESTRAL_FILA_APARTADA =
  'Esta factura global bimestral ya tiene ventas apartadas y el RFC ya no tiene el régimen 621 que el SAT exige para la periodicidad bimestral. Cambiar la periodicidad no la libera: escríbenos a soporte para resolverla.'

/**
 * C1 (Tarea 10, ronda 1, m1): la misma regla para una captura bimestral que NO apartó ventas (`VALIDATION_FAILED`, o rechazada en definitiva): no
 * se emitirá, y sus ventas ya están libres para la global de la periodicidad de hoy.
 */
export const MOTIVO_BIMESTRAL_CAPTURA_DESCARTADA =
  'Esta captura bimestral no se emitirá: el RFC ya no tiene el régimen 621. Sus ventas no quedaron apartadas y entran a la global de tu periodicidad actual en los periodos que todavía se revisan solos; las fechas más viejas, pídelas a soporte.'

/**
 * C1 (Tarea 10, ronda 2, N3): la misma regla para una global bimestral ENVIADA y rechazada en definitiva por el SAT (sus ventas ya quedaron libres):
 * no se vuelve a enviar.
 */
export const MOTIVO_BIMESTRAL_RECHAZADA_DESCARTADA =
  'Esta factura global bimestral, que el SAT rechazó, no se volverá a enviar: el RFC ya no tiene el régimen 621. Sus ventas quedaron libres y entran a la global de tu periodicidad actual en los periodos que todavía se revisan solos; las fechas más viejas, pídelas a soporte.'

/** C1 (Tarea 9): el motivo por el que el DOCUMENTO (su c_Periodicidad) no se puede emitir con ese régimen del emisor, o null. */
export function motivoDePeriodicidad(satPeriodicidad: string, regimenFiscal: string): string | null {
  return satPeriodicidad === '05' && regimenFiscal !== '621' ? MOTIVO_BIMESTRAL_SOLO_621 : null
}

/** C1: el mismo periodo (inicio, fin y periodicidad del SAT). */
export function mismoPeriodo(a: ClosedPeriod, b: ClosedPeriod): boolean {
  return (
    a.periodStart.getTime() === b.periodStart.getTime() &&
    a.periodEnd.getTime() === b.periodEnd.getTime() &&
    a.satPeriodicidad === b.satPeriodicidad
  )
}

/**
 * C1 v5/v6 (Codex C1-33, C1-37). Guía de llenado del CFDI global, `InformacionGlobal/Año`: el año del periodo tiene que ser el de la emisión o
 * el anterior. Fuera de esa ventana no se emite desde Avoqado (ni la persona, ni la complementaria, ni el job).
 */
export const MOTIVO_ANIO_FUERA =
  'El SAT sólo admite la factura global de este año o del anterior; la de este periodo ya no se emite desde Avoqado: pídela a soporte.'

/** C1 (Tarea 11): ¿el año `anio` de un periodo se puede declarar hoy? Sí si es el año de `now` en México o el anterior. */
export function anioPermitido(anio: number, now: Date): boolean {
  const actual = toZonedTime(now, MX_TZ).getFullYear()
  return anio === actual || anio === actual - 1
}
