/** Prepared only: run through the H1 disposable-database wrapper. */
import { Client } from 'pg'

const fixtureKey = `${process.pid}-${Date.now()}`
const organizationId = `h1a-demo-race-org-${fixtureKey}`
const updateFirstVenueId = `h1a-demo-race-update-${fixtureKey}`
const cleanupFirstVenueId = `h1a-demo-race-cleanup-${fixtureKey}`
const updateFirstStaffId = `h1a-demo-race-update-staff-${fixtureKey}`
const cleanupFirstStaffId = `h1a-demo-race-cleanup-staff-${fixtureKey}`
let setup: Client

function assertDisposableDatabase(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  for (const candidate of [effective, declared]) {
    expect(['localhost', '127.0.0.1']).toContain(candidate.hostname)
    expect(candidate.pathname).toBe('/avoqado_h1a_test_20260808')
  }
  expect(effective.toString()).toBe(declared.toString())
}

async function client(applicationName: string): Promise<Client> {
  const connection = new Client({ connectionString: process.env.TEST_DATABASE_URL, application_name: applicationName })
  await connection.connect()
  return connection
}

async function backendPid(connection: Client): Promise<number> {
  return (await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
}

async function waitForBlockedActivity(
  observer: Client,
  predicate: { applicationName?: string; blockerPid?: number; queryFragment?: string },
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const activity = await observer.query<{ application_name: string; query: string; blockers: number[]; wait_event_type: string | null }>(
      `SELECT application_name, query, pg_blocking_pids(pid) AS blockers, wait_event_type
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    )
    const blocked = activity.rows.some(
      row =>
        (!predicate.applicationName || row.application_name === predicate.applicationName) &&
        (!predicate.queryFragment || row.query.includes(predicate.queryFragment)) &&
        row.wait_event_type === 'Lock' &&
        row.blockers.length > 0 &&
        (predicate.blockerPid === undefined || row.blockers.includes(predicate.blockerPid)),
    )
    if (blocked) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Expected PostgreSQL blocked activity was not observed')
}

async function insertFixture(venueId: string, staffId: string, suffix: string): Promise<void> {
  await setup.query(
    `INSERT INTO "Staff" ("id", "email", "firstName", "lastName", "updatedAt")
     VALUES ($1, $2, 'Demo', 'Race', CURRENT_TIMESTAMP)`,
    [staffId, `${staffId}@example.test`],
  )
  await setup.query(
    `INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "status", "updatedAt")
     VALUES ($1, $2, $3, $4, 'LIVE_DEMO', CURRENT_TIMESTAMP)`,
    [venueId, organizationId, `H1A Demo ${suffix}`, `h1a-demo-race-${suffix}-${fixtureKey}`],
  )
  await setup.query(
    `INSERT INTO "LiveDemoSession" ("id", "sessionId", "venueId", "staffId", "expiresAt")
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
    [`h1a-demo-race-session-${suffix}-${fixtureKey}`, `h1a-demo-race-cookie-${suffix}-${fixtureKey}`, venueId, staffId],
  )
}

beforeAll(async () => {
  assertDisposableDatabase()
  setup = await client(`h1a-demo-race-setup-${fixtureKey}`)
  await setup.query(
    `INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
     VALUES ($1, 'H1A Demo race', $2, '5500000000', CURRENT_TIMESTAMP)`,
    [organizationId, `h1a-demo-race-${fixtureKey}@example.test`],
  )
  await insertFixture(updateFirstVenueId, updateFirstStaffId, 'update-first')
  await insertFixture(cleanupFirstVenueId, cleanupFirstStaffId, 'cleanup-first')
})

afterAll(async () => {
  if (!setup) return
  assertDisposableDatabase()
  await setup.query(`DELETE FROM "LiveDemoSession" WHERE "venueId" = ANY($1::text[])`, [[updateFirstVenueId, cleanupFirstVenueId]])
  await setup.query(`DELETE FROM "Venue" WHERE "id" = ANY($1::text[])`, [[updateFirstVenueId, cleanupFirstVenueId]])
  await setup.query(`DELETE FROM "Staff" WHERE "id" = ANY($1::text[])`, [[updateFirstStaffId, cleanupFirstStaffId]])
  await setup.query(`DELETE FROM "Organization" WHERE "id" = $1`, [organizationId])
  await setup.end()
})

describe('live-demo cleanup venue-status serialization', () => {
  it('preserves Staff and session when a real-venue transition commits before cleanup obtains the lock', async () => {
    const updater = await client(`h1a-demo-race-updater-first-${fixtureKey}`)
    const observer = await client(`h1a-demo-race-observer-first-${fixtureKey}`)
    const { deleteDisposableDemoSession } = await import('@/services/cleanup/liveDemoCleanup.service')
    try {
      await updater.query('BEGIN')
      await updater.query(`UPDATE "Venue" SET status = 'ACTIVE' WHERE id = $1`, [updateFirstVenueId])
      const updaterPid = await backendPid(updater)
      const deleting = deleteDisposableDemoSession({
        id: `h1a-demo-race-session-update-first-${fixtureKey}`,
        venueId: updateFirstVenueId,
        staffId: updateFirstStaffId,
      })
      await waitForBlockedActivity(observer, { blockerPid: updaterPid, queryFragment: 'FROM "Venue"' })
      await updater.query('COMMIT')
      await expect(deleting).rejects.toMatchObject({ code: 'LIVE_DEMO_VENUE_NOT_DISPOSABLE' })

      await expect(observer.query(`SELECT status FROM "Venue" WHERE id = $1`, [updateFirstVenueId])).resolves.toMatchObject({
        rows: [{ status: 'ACTIVE' }],
      })
      await expect(observer.query(`SELECT id FROM "Staff" WHERE id = $1`, [updateFirstStaffId])).resolves.toMatchObject({ rowCount: 1 })
      await expect(observer.query(`SELECT id FROM "LiveDemoSession" WHERE "venueId" = $1`, [updateFirstVenueId])).resolves.toMatchObject({
        rowCount: 1,
      })
    } finally {
      await Promise.allSettled([updater.query('ROLLBACK'), updater.end(), observer.end()])
    }
  })

  it('blocks a real-venue transition while production cleanup owns the disposable claim', async () => {
    const updaterName = `h1a-demo-race-updater-second-${fixtureKey}`
    const updater = await client(updaterName)
    const observer = await client(`h1a-demo-race-observer-second-${fixtureKey}`)
    let releaseLock!: () => void
    let reportLock!: () => void
    const locked = new Promise<void>(resolve => (reportLock = resolve))
    const release = new Promise<void>(resolve => (releaseLock = resolve))
    const { createDisposableDemoSessionDeletion } = await import('@/services/cleanup/liveDemoCleanup.service')
    const deletion = createDisposableDemoSessionDeletion({
      afterVenueLock: async () => {
        reportLock()
        await release
      },
    })
    try {
      const deleting = deletion({
        id: `h1a-demo-race-session-cleanup-first-${fixtureKey}`,
        venueId: cleanupFirstVenueId,
        staffId: cleanupFirstStaffId,
      })
      await locked
      const updating = updater.query(`UPDATE "Venue" SET status = 'ACTIVE' WHERE id = $1`, [cleanupFirstVenueId])
      await waitForBlockedActivity(observer, { applicationName: updaterName })
      releaseLock()
      await expect(deleting).resolves.toBeUndefined()
      await expect(updating).resolves.toMatchObject({ rowCount: 0 })
      await expect(observer.query(`SELECT id FROM "Venue" WHERE id = $1`, [cleanupFirstVenueId])).resolves.toMatchObject({ rowCount: 0 })
      await expect(observer.query(`SELECT id FROM "Staff" WHERE id = $1`, [cleanupFirstStaffId])).resolves.toMatchObject({ rowCount: 0 })
    } finally {
      releaseLock?.()
      await Promise.allSettled([updater.end(), observer.end()])
    }
  })
})
