/** Prepared only: run through the H1 disposable-database wrapper. */
import { Client } from 'pg'

const fixtureKey = `${process.pid}-${Date.now()}`
const organizationId = `h1a-staff-race-org-${fixtureKey}`
const deletionFirstStaffId = `h1a-staff-race-delete-${fixtureKey}`
const writerFirstStaffId = `h1a-staff-race-write-${fixtureKey}`
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

async function insertActor(staffId: string): Promise<void> {
  await setup.query(
    `INSERT INTO "Staff" ("id", "email", "firstName", "lastName", "updatedAt")
     VALUES ($1, $2, 'Race', 'Actor', CURRENT_TIMESTAMP)`,
    [staffId, `${staffId}@example.test`],
  )
}

function provenanceInsert(connection: Client, staffId: string, suffix: string) {
  return connection.query(
    `INSERT INTO "ActivityLog"
      ("id", "organizationId", "action", "actorType", "staffId", "actorStaffId")
     VALUES ($1, $2, 'H1A_STAFF_DELETE_RACE', 'HUMAN', $3, $3)`,
    [`h1a-staff-race-${suffix}-${fixtureKey}`, organizationId, staffId],
  )
}

beforeAll(async () => {
  assertDisposableDatabase()
  setup = await client(`h1a-staff-race-setup-${fixtureKey}`)
  await setup.query(
    `INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
     VALUES ($1, 'H1A Staff race', $2, '5500000000', CURRENT_TIMESTAMP)`,
    [organizationId, `h1a-staff-race-${fixtureKey}@example.test`],
  )
  await insertActor(deletionFirstStaffId)
  await insertActor(writerFirstStaffId)
})

afterAll(async () => {
  if (!setup) return
  assertDisposableDatabase()
  await setup.query(`DELETE FROM "ActivityLog" WHERE "organizationId" = $1`, [organizationId])
  await setup.query(`DELETE FROM "Staff" WHERE "id" = ANY($1::text[])`, [[deletionFirstStaffId, writerFirstStaffId]])
  await setup.query(`DELETE FROM "Organization" WHERE "id" = $1`, [organizationId])
  await setup.end()
})

describe('Staff H1 provenance deletion serialization', () => {
  it('runs production deletion first and rejects the deterministically blocked provenance writer', async () => {
    const writerName = `h1a-staff-race-writer-${fixtureKey}`
    const writer = await client(writerName)
    const observer = await client(`h1a-staff-race-observer-${fixtureKey}`)
    let releaseLock!: () => void
    let reportLock!: () => void
    const locked = new Promise<void>(resolve => (reportLock = resolve))
    const release = new Promise<void>(resolve => (releaseLock = resolve))
    const { createStaffDeletionService } = await import('@/services/superadmin/staffDeletion.service')
    const deletion = createStaffDeletionService({
      afterStaffLock: async () => {
        reportLock()
        await release
      },
    })
    try {
      const deleting = deletion(deletionFirstStaffId)
      await locked
      await writer.query('BEGIN')
      const inserting = provenanceInsert(writer, deletionFirstStaffId, 'delete-first')
      const insertionAssertion = expect(inserting).rejects.toMatchObject({ code: '23503' })
      await waitForBlockedActivity(observer, { applicationName: writerName })
      releaseLock()
      await expect(deleting).resolves.toMatchObject({ retainedForAudit: false })
      await insertionAssertion
      await writer.query('ROLLBACK')
      await expect(observer.query(`SELECT id FROM "Staff" WHERE id = $1`, [deletionFirstStaffId])).resolves.toMatchObject({ rowCount: 0 })
    } finally {
      releaseLock?.()
      await Promise.allSettled([writer.query('ROLLBACK'), writer.end(), observer.end()])
    }
  })

  it('runs production deletion after a deterministically observed provenance-writer lock and retains Staff', async () => {
    const writer = await client(`h1a-staff-race-first-${fixtureKey}`)
    const observer = await client(`h1a-staff-race-observer2-${fixtureKey}`)
    let releaseLock!: () => void
    let reportLock!: () => void
    const locked = new Promise<void>(resolve => (reportLock = resolve))
    const release = new Promise<void>(resolve => (releaseLock = resolve))
    const { createStaffDeletionService } = await import('@/services/superadmin/staffDeletion.service')
    const deletion = createStaffDeletionService({
      afterStaffLock: async () => {
        reportLock()
        await release
      },
    })
    try {
      await writer.query('BEGIN')
      await provenanceInsert(writer, writerFirstStaffId, 'writer-first')
      const writerPid = await backendPid(writer)
      const deleting = deletion(writerFirstStaffId)
      await waitForBlockedActivity(observer, { blockerPid: writerPid, queryFragment: 'FROM "Staff"' })
      await writer.query('COMMIT')
      await locked
      releaseLock()
      await expect(deleting).resolves.toMatchObject({ retainedForAudit: true })
      const retained = await observer.query<{ active: boolean }>(`SELECT active FROM "Staff" WHERE id = $1`, [writerFirstStaffId])
      expect(retained.rows).toEqual([{ active: false }])
    } finally {
      releaseLock?.()
      await Promise.allSettled([writer.query('ROLLBACK'), writer.end(), observer.end()])
    }
  })
})
