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
