/**
 * Keeps every cron job inside an execution context, so its log lines say which venue they
 * were about instead of arriving anonymous.
 *
 * The invariant is deliberately blunt: **no job may call the schedulers directly.** Every
 * registration goes through `scheduleJob` / `scheduleCron`, which open the context and pass
 * the tick through untouched. That single rule covers both ways this could go wrong:
 *
 * 1. **Forgetting one.** There is no central scheduler here — each job builds its own timer,
 *    so job 44 would ship without a context and nobody would notice until an incident.
 * 2. **Breaking `this`.** 39 of the 43 jobs are classes and 14 hand the scheduler
 *    `this.method.bind(this)`. The first plan was to rewrite each callback into
 *    `runInJobContext('x', () => this.tick())`; get that wrong once and the binding is gone,
 *    the job throws on every tick, forever, and silently — nobody watches a cron tick.
 *    Passing the callback through verbatim instead makes that mistake unreachable, which is
 *    better than making it detectable.
 *
 * 🔴 Why a source check and not a runtime one. The first version imported every job and
 * invoked its tick. It could not work: job bodies run against a mocked Prisma, and a mock
 * missing a model fails with the exact same message as a lost `this` —
 * `Cannot read properties of undefined (reading 'findMany')`. Indistinguishable at runtime,
 * so the check either missed real bugs or flagged a dozen healthy jobs.
 */

import fs from 'node:fs'
import path from 'node:path'

const JOBS_DIR = path.join(__dirname, '../../../src/jobs')

/** Schedules nothing, so it needs no context. */
const NOT_A_JOB = new Set(['jobSchedules.ts'])

/**
 * Not yet migrated because another session was actively editing them (both saved minutes
 * before this ran, 2026-08-09) and editing a file underneath a live session invites a lost
 * change. They still schedule directly, so their log lines have no venue.
 *
 * 🔴 This list only shrinks. Adding to it is a deliberate act that needs a reason in writing.
 */
const PENDING_MIGRATION = new Set(['catalog-publication-outbox-sweeper.job.ts', 'catalog-publication-watchdog.job.ts'])

const listJobFiles = (): string[] =>
  fs
    .readdirSync(JOBS_DIR)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .filter(file => !NOT_A_JOB.has(file))
    .sort()

const read = (file: string): string => fs.readFileSync(path.join(JOBS_DIR, file), 'utf8')

/** A scheduler called directly, bypassing the context helpers. */
const countRawSchedulers = (source: string): number => (source.match(/new CronJob\(|cron\.schedule\(/g) ?? []).length

/**
 * `runInJobContext('name', this.something)` — the callback handed over as a bare member
 * expression, which drops the receiver. Accepted forms keep it: an arrow (`() => this.tick()`)
 * or an explicit `this.tick.bind(this)`. Whitespace is tolerated because prettier reflows
 * these onto several lines.
 */
const UNBOUND_METHOD_ARG = /runInJobContext\(\s*[^,]+,\s*this\.[A-Za-z_$][\w$]*\s*[),]/g
const findUnboundArgs = (source: string): string[] => (source.match(UNBOUND_METHOD_ARG) ?? []).map(m => m.replace(/\s+/g, ' '))

describe('every cron job runs inside an execution context', () => {
  const files = listJobFiles()

  it('finds the job files', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it('🔴 no job calls a scheduler directly', () => {
    const offenders = files
      .filter(file => !PENDING_MIGRATION.has(file))
      .map(file => ({ file, raw: countRawSchedulers(read(file)) }))
      .filter(({ raw }) => raw > 0)
      .map(({ file, raw }) => `${file}: ${raw} registro(s) sin scheduleJob/scheduleCron`)

    expect(offenders).toEqual([])
  })

  it('the pending list is real — those files genuinely still schedule directly', () => {
    // Guards the exclusion itself: once a file is migrated it must leave the list, or the
    // list quietly becomes a place where jobs go to be forgotten.
    const stillPending = [...PENDING_MIGRATION].filter(file => fs.existsSync(path.join(JOBS_DIR, file)) && countRawSchedulers(read(file)) > 0)

    expect(stillPending.sort()).toEqual([...PENDING_MIGRATION].sort())
  })

  it('🔴 no hand-rolled wrap drops the `this` binding', () => {
    const broken = files.flatMap(file => findUnboundArgs(read(file)).map(match => `${file}: ${match}`))

    expect(broken).toEqual([])
  })
})

describe('the guard detects the mistakes it exists for', () => {
  // A guard never shown to fail is not a guard. These run the real matchers against
  // known-bad source, so a later refactor of the regexes cannot quietly neuter them.

  it('flags a direct CronJob construction', () => {
    expect(countRawSchedulers(`this.job = new CronJob(PATTERN, this.tick.bind(this), null, false, 'tz')`)).toBe(1)
  })

  it('flags a direct node-cron schedule', () => {
    expect(countRawSchedulers(`const task = cron.schedule(PATTERN, checkThings, {})`)).toBe(1)
  })

  it('counts BOTH registrations when one file schedules twice', () => {
    // blumon-payment-audit.job.ts does exactly this; a per-file check would call it covered.
    expect(countRawSchedulers(`new CronJob(A, a); new CronJob(B, b)`)).toBe(2)
  })

  it('accepts the migrated form', () => {
    expect(countRawSchedulers(`this.job = scheduleJob('my-job', PATTERN, this.tick.bind(this), null, false, 'tz')`)).toBe(0)
  })

  it('🔴 flags the lost-binding form', () => {
    expect(findUnboundArgs(`() => runInJobContext('my-job', this.tick)`)).toHaveLength(1)
  })

  it('🔴 flags it across the line breaks prettier introduces', () => {
    expect(
      findUnboundArgs(`
        scheduleJob(
          'money-integrity-watchdog',
          PATTERN,
          () => runInJobContext('money-integrity-watchdog', this.run),
        )`),
    ).toHaveLength(1)
  })

  it('accepts an arrow, which keeps the receiver', () => {
    expect(findUnboundArgs(`runInJobContext('my-job', () => this.tick())`)).toEqual([])
  })

  it('accepts an explicitly bound method', () => {
    expect(findUnboundArgs(`runInJobContext('my-job', this.tick.bind(this))`)).toEqual([])
  })
})
