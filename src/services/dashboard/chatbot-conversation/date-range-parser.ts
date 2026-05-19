import { DEFAULT_TIMEZONE } from '@/utils/datetime'
import { fromZonedTime } from 'date-fns-tz'
import type { DateRangeSpec } from '../shared-query.service'

const MONTH_INDEX: Record<string, number> = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
}

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const isValidDayMonth = (day: number, monthIndex: number, year: number): boolean => {
  if (!Number.isInteger(day) || !Number.isInteger(year) || day < 1 || day > 31) {
    return false
  }

  const date = new Date(year, monthIndex, day)
  return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day
}

export const isCustomDateRangeSpec = (dateRange?: DateRangeSpec): dateRange is { from: Date; to: Date } =>
  typeof dateRange === 'object' && dateRange !== null && dateRange.from instanceof Date && dateRange.to instanceof Date

export const parseCustomDateRange = (message: string, now: Date = new Date()): DateRangeSpec | undefined => {
  const normalizedMessage = normalize(message)
  if (!normalizedMessage) return undefined

  const datePartPattern =
    /(\d{1,2})(?:\s+de)?\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de|del)?\s*(\d{4}))?/
  const rangePattern = new RegExp(
    `(?:\\b(?:del|desde(?:\\s+la\\s+fecha)?(?:\\s+del)?|from)\\s+)?${datePartPattern.source}\\s+(?:al|a|hasta|to|through|-)\\s+${datePartPattern.source}`,
    'i',
  )
  const match = normalizedMessage.match(rangePattern)
  if (!match) return undefined

  const currentYear = now.getFullYear()
  const startDay = Number(match[1])
  const startMonth = MONTH_INDEX[match[2]]
  const startYear = match[3] ? Number(match[3]) : currentYear
  const endDay = Number(match[4])
  const endMonth = MONTH_INDEX[match[5]]
  let endYear = match[6] ? Number(match[6]) : startYear

  if (startMonth === undefined || endMonth === undefined || !isValidDayMonth(startDay, startMonth, startYear)) {
    return undefined
  }

  if (!match[6] && endMonth < startMonth) {
    endYear = startYear + 1
  }

  if (!isValidDayMonth(endDay, endMonth, endYear)) {
    return undefined
  }

  const fromLocal = new Date(startYear, startMonth, startDay, 0, 0, 0, 0)
  const toLocal = new Date(endYear, endMonth, endDay, 23, 59, 59, 999)
  const from = fromZonedTime(fromLocal, DEFAULT_TIMEZONE)
  const to = fromZonedTime(toLocal, DEFAULT_TIMEZONE)

  if (from.getTime() > to.getTime()) {
    return undefined
  }

  return { from, to }
}
