/**
 * Keeps every cron job resilient to transient DB connection blips: any job that queries
 * the DB directly MUST reference `retry(..., shouldRetryDbConnectionError)` so a P1001
 * (top-of-hour stampede) or P1017 (network severance, real incident 2026-08-10 20:42 UTC)
 * doesn't kill the tick. The rule lives in `.claude/rules/cron-jobs.md`; the predicate
 * deliberately excludes P2024 pool timeouts and P2xxx data errors.
 *
 * The invariant is deliberately blunt — a source check, not a runtime one (see
 * jobContextGuard.test.ts for why runtime checks of job bodies can't work here). It cannot
 * prove the RIGHT query is wrapped, but it catches the drift that actually happened: 13
 * jobs accumulated over months querying the DB with no retry at all, while the rule said
 * "MUST" the whole time.
 *
 * Jobs that delegate ALL their DB access to a service (no direct `prisma.` reference in
 * the job file) are outside this guard — e.g. terminal-payment-watchdog, whose entry read
 * is wrapped inside `reconcileStaleRequests`. The guard skips them rather than pretending
 * to verify code it doesn't read.
 */

import fs from 'node:fs'
import path from 'node:path'

const JOBS_DIR = path.join(__dirname, '../../../src/jobs')

/** Schedules nothing, so it has no tick to protect. */
const NOT_A_JOB = new Set(['jobSchedules.ts'])

/**
 * Known offenders not yet wrapped. 🔴 This list only shrinks — adding to it is a
 * deliberate act that needs a reason in writing next to the entry.
 */
const PENDING_WRAP = new Set<string>([])

const listJobFiles = (): string[] =>
  fs
    .readdirSync(JOBS_DIR)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .filter(file => !NOT_A_JOB.has(file))
    .sort()

const read = (file: string): string => fs.readFileSync(path.join(JOBS_DIR, file), 'utf8')

/** The job hits the DB itself (rather than delegating to a service). */
const queriesDbDirectly = (source: string): boolean => /\bprisma\./.test(source)

/** The file wired up the connection-retry predicate at least once. */
const hasConnectionRetry = (source: string): boolean => source.includes('shouldRetryDbConnectionError')

describe('every DB-querying cron job retries transient connection errors', () => {
  const files = listJobFiles()

  it('finds the job files', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it('🔴 no job queries the DB without the connection-retry predicate', () => {
    const offenders = files
      .filter(file => !PENDING_WRAP.has(file))
      .filter(file => {
        const source = read(file)
        return queriesDbDirectly(source) && !hasConnectionRetry(source)
      })
      .map(file => `${file}: queries prisma directly but never uses shouldRetryDbConnectionError`)

    expect(offenders).toEqual([])
  })

  it('the pending list is real — those files genuinely still lack the wrapper', () => {
    // Guards the exclusion itself: once a file is wrapped it must leave the list, or the
    // list quietly becomes a place where jobs go to be forgotten.
    const stillPending = [...PENDING_WRAP].filter(file => {
      if (!fs.existsSync(path.join(JOBS_DIR, file))) return false
      const source = read(file)
      return queriesDbDirectly(source) && !hasConnectionRetry(source)
    })

    expect(stillPending.sort()).toEqual([...PENDING_WRAP].sort())
  })
})

describe('the guard detects the mistakes it exists for', () => {
  // A guard never shown to fail is not a guard. These run the real matchers against
  // known-good and known-bad source, so a later refactor cannot quietly neuter them.

  it('flags a bare prisma query', () => {
    const source = `const rows = await prisma.order.findMany({ where: { status: 'OPEN' } })`
    expect(queriesDbDirectly(source)).toBe(true)
    expect(hasConnectionRetry(source)).toBe(false)
  })

  it('accepts a wrapped entry read', () => {
    const source = `
      import { retry, shouldRetryDbConnectionError } from '../utils/retry'
      const rows = await retry(() => prisma.order.findMany({ where: { status: 'OPEN' } }), {
        retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'my-job.findOpen',
      })`
    expect(queriesDbDirectly(source)).toBe(true)
    expect(hasConnectionRetry(source)).toBe(true)
  })

  it('skips a job that delegates its DB access to a service', () => {
    const source = `
      import { reconcileStaleRequests } from '../services/tpv/terminalPayment.service'
      await reconcileStaleRequests()`
    expect(queriesDbDirectly(source)).toBe(false)
  })

  it('does not mistake the prisma import itself for a query', () => {
    expect(queriesDbDirectly(`import prisma from '../utils/prismaClient'`)).toBe(false)
  })
})
