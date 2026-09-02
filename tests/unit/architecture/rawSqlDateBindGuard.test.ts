/**
 * Static guard: date binds in raw SQL over `timestamp without time zone` columns.
 *
 * Every DateTime column in this schema stores real UTC as `timestamp without time zone`.
 * A Prisma `Date` bound into `$queryRaw` / `$queryRawUnsafe` arrives as `timestamptz` and
 * Postgres converts it with the SESSION zone before comparing — directly or through a
 * `::timestamp` cast — so the filter shifts six hours. Audit of 2026-09-01: ~90 binds in
 * 25 files, from the sales reports to the reservation locks and the SIM custody UPDATE.
 * Every one now goes through `src/utils/sqlDates.ts` (`utcTs`, `utcTsOrNull`, `utcTsParam`),
 * and this test keeps it that way: a new bare bind fails here.
 *
 * Accepted forms, and why:
 *   `${utcTs(d)}` / `${utcTsOrNull(d)}` / `${utcTsParam(n)}` — the helpers.
 *   `${nowSql}` etc. — fragments built from `toISOString()::timestamp` (the outboxes):
 *     Postgres drops the `Z` when it casts text to `timestamp`, so the UTC wall clock lands.
 *   `$n::timestamp` — a positional TEXT parameter (sales-summary byPeriod passes ISO text).
 *
 * The allowlist can only shrink. Two entries are biased code owned by another session on
 * the audit day: fix them with `utcTs` and delete them from the list in the same change.
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC_DIR = path.resolve(__dirname, '../../../src')

/** A date-looking column compared to (or assigned) a bound value. */
const DATE_COLUMN_BIND =
  /"([A-Za-z]+(?:At|Time|Date|Until|Expires|Expiry))"\s*(?:>=|<=|<|>|=)\s*(\$\{[^}]*\}(?:::timestamp\b)?|\$\d+(?:::timestamp\b)?)/g

// These schema columns end in "Time" but are numeric durations, not instants.
// Keeping the exception explicit prevents the suffix heuristic from hiding a
// real DateTime bind while avoiding false positives on millisecond/minute data.
const NON_DATE_TIME_COLUMNS = new Set(['prepTime', 'cookTime', 'processingTime', 'executionTime'])

const ALLOWED_BIND = [
  /^\$\{utcTs\(/,
  /^\$\{utcTsOrNull\(/,
  /^\$\{utcTsParam\(/,
  /^\$\{(?:nowSql|leaseSql|claimedAtSql|claimExpiresAtSql)\}$/,
  /^\$\d+::timestamp$/,
]

/** Files exempt from the scan, each with the reason. Only shrinks. */
const ALLOWLIST: Record<string, string> = {
  'src/utils/sqlDates.ts': "the helpers' own documentation shows the wrong forms on purpose",
  'src/services/legacy/qrPayments.legacy.service.ts': 'pg pool with ISO TEXT params (see getLegacyPeriodMetrics), not Prisma binds',
  'src/config/chatbot/tables/order.table.ts': 'prompt examples for text-to-SQL; never executed with a Date bind',
  'src/config/chatbot/tables/payment.table.ts': 'prompt examples for text-to-SQL; never executed with a Date bind',
}

export function findBiasedDateBinds(line: string): string[] {
  const trimmed = line.trim()
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) return []
  const offenders: string[] = []
  for (const match of line.matchAll(DATE_COLUMN_BIND)) {
    const column = match[1]
    const bind = match[2]
    if (NON_DATE_TIME_COLUMNS.has(column)) continue
    if (!ALLOWED_BIND.some(re => re.test(bind))) offenders.push(bind)
  }
  return offenders
}

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listTsFiles(full, acc)
    else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) acc.push(full)
  }
  return acc
}

describe('raw SQL date binds go through sqlDates.ts', () => {
  it('detector: flags the bare and ::timestamp forms, accepts the helpers and ISO-text fragments', () => {
    expect(findBiasedDateBinds('AND o."createdAt" >= ${from}')).toEqual(['${from}'])
    expect(findBiasedDateBinds('AND o."createdAt" <= ${to}::timestamp')).toEqual(['${to}::timestamp'])
    expect(findBiasedDateBinds('AND o."createdAt" >= $2')).toEqual(['$2'])
    expect(findBiasedDateBinds('"assignedSupervisorAt" = ${assignedSupervisorAt},')).toEqual(['${assignedSupervisorAt}'])
    expect(findBiasedDateBinds('AND "startsAt" < ${blockedEndsAt} AND "blockedEndsAt" > ${startsAt}')).toEqual([
      '${blockedEndsAt}',
      '${startsAt}',
    ])

    expect(findBiasedDateBinds('AND o."createdAt" >= ${utcTs(from)}')).toEqual([])
    expect(findBiasedDateBinds('AND o."createdAt" >= ${utcTsParam(2)}')).toEqual([])
    expect(findBiasedDateBinds('"promoterRejectedAt" = ${utcTsOrNull(promoterRejectedAt)},')).toEqual([])
    expect(findBiasedDateBinds('AND d."nextAttemptAt" <= ${nowSql}')).toEqual([])
    expect(findBiasedDateBinds('AND "createdAt" >= $2::timestamp')).toEqual([])
    expect(findBiasedDateBinds('"processingTime" = ${command.processingTime ?? null}')).toEqual([])
    expect(findBiasedDateBinds(' *   WHERE o."createdAt" >= ${fromDate}          -- ❌')).toEqual([])
  })

  it('src/ has no date bind outside sqlDates.ts (allowlist aside)', () => {
    const violations: string[] = []
    for (const file of listTsFiles(SRC_DIR)) {
      const rel = path.relative(path.resolve(SRC_DIR, '..'), file)
      if (ALLOWLIST[rel]) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const bind of findBiasedDateBinds(line)) violations.push(`${rel}:${i + 1} → ${bind}`)
      })
    }
    expect(violations).toEqual([])
  })

  it('the allowlist only names files that still exist (it can only shrink)', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(fs.existsSync(path.resolve(SRC_DIR, '..', rel))).toBe(true)
    }
  })
})
