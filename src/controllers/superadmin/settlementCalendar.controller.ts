import { Request, Response, NextFunction } from 'express'
import { formatInTimeZone } from 'date-fns-tz'

import * as settlementCalendarService from '../../services/superadmin/settlementCalendar.superadmin.service'
import { DEFAULT_TIMEZONE } from '../../utils/datetime'

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Resolves the requested window to two venue-local `yyyy-MM-dd` keys.
 *
 * `month=YYYY-MM` → that whole calendar month. Otherwise `from`/`to`. Defaults to
 * the current month in the platform tz.
 *
 * These are DATE KEYS, not instants: they are never parsed with `new Date(...)`,
 * which would resolve to midnight in the Node HOST timezone (prod runs UTC) and
 * shift the window a whole day — the documented runtime-tz trap in
 * `.claude/rules/critical-warnings.md`.
 */
export function resolveWindow(query: Request['query']): { fromKey: string; toKey: string } {
  const month = typeof query.month === 'string' ? query.month : undefined
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    if (m >= 1 && m <= 12 && y >= 2000 && y <= 2100) {
      // Day 0 of the NEXT month is the last day of this one — handles 28/29/30/31.
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
      return { fromKey: `${month}-01`, toKey: `${month}-${String(lastDay).padStart(2, '0')}` }
    }
  }

  const from = typeof query.from === 'string' && DATE_KEY.test(query.from) ? query.from : undefined
  const to = typeof query.to === 'string' && DATE_KEY.test(query.to) ? query.to : undefined
  if (from && to) return { fromKey: from, toKey: to }

  // Default: current month in the platform timezone.
  const todayKey = formatInTimeZone(new Date(), DEFAULT_TIMEZONE, 'yyyy-MM-dd')
  const [cy, cm] = todayKey.split('-').map(Number)
  const lastDay = new Date(Date.UTC(cy, cm, 0)).getUTCDate()
  const prefix = todayKey.slice(0, 7)
  return { fromKey: `${prefix}-01`, toKey: `${prefix}-${String(lastDay).padStart(2, '0')}` }
}

/** GET /api/v1/superadmin/settlement-calendar?month=YYYY-MM  (or ?from=&to=) */
export async function getSettlementCalendar(req: Request, res: Response, next: NextFunction) {
  try {
    const { fromKey, toKey } = resolveWindow(req.query)
    const data = await settlementCalendarService.getCrossVenueSettlementCalendar(fromKey, toKey)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
