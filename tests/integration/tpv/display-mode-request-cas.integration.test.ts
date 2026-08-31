/**
 * Real PostgreSQL proof for display-mode compare-and-set persistence.
 *
 * The suite accepts only a caller-provided local database whose name contains
 * "test". It creates one isolated organization/venue/staff/terminal fixture,
 * never migrates or resets the database, and removes only those exact ids.
 */
import { Prisma, type PrismaClient } from '@prisma/client'

const fixtureKey = `${process.pid}-${Date.now()}-display-mode`
const organizationId = `display-mode-org-${fixtureKey}`
const venueId = `display-mode-venue-${fixtureKey}`
const staffId = `display-mode-staff-${fixtureKey}`
const terminalId = `display-mode-terminal-${fixtureKey}`

let prisma: PrismaClient | null = null
let service: typeof import('@/services/display-mode-request.service')
let fixtureCreated = false

function assertDisposableTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  expect(effective.toString()).toBe(declared.toString())
}

function db(): PrismaClient {
  if (!prisma) throw new Error('Display-mode integration database was not initialized')
  return prisma
}

beforeAll(async () => {
  assertDisposableTestDatabase()
  prisma = (await import('@/utils/prismaClient')).default

  const columns = await db().$queryRaw<Array<{ columnName: string }>>(Prisma.sql`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Terminal'
      AND column_name IN (
        'customerDisplayRequest',
        'customerDisplayRequestVersion',
        'customerDisplayRequestExpiresAt'
      )
  `)
  const present = new Set(columns.map(row => row.columnName))
  const missing = ['customerDisplayRequest', 'customerDisplayRequestVersion', 'customerDisplayRequestExpiresAt'].filter(
    column => !present.has(column),
  )
  if (missing.length > 0) {
    throw new Error(`TASK_2_SCHEMA_GATE: disposable TEST_DATABASE_URL is missing Terminal columns: ${missing.join(', ')}`)
  }

  service = await import('@/services/display-mode-request.service')
  await db().organization.create({
    data: {
      id: organizationId,
      name: `Display mode CAS ${fixtureKey}`,
      email: `display-mode-${fixtureKey}@example.test`,
      phone: '5500000000',
    },
  })
  fixtureCreated = true
  await db().venue.create({
    data: {
      id: venueId,
      organizationId,
      name: `Display mode CAS ${fixtureKey}`,
      slug: `display-mode-${fixtureKey}`,
      timezone: 'America/Mexico_City',
      currency: 'MXN',
    },
  })
  await db().staff.create({
    data: {
      id: staffId,
      email: `display-mode-staff-${fixtureKey}@example.test`,
      firstName: 'Display',
      lastName: 'Mode',
    },
  })
  await db().terminal.create({
    data: {
      id: terminalId,
      venueId,
      name: `Display mode terminal ${fixtureKey}`,
      type: 'POS_ANDROID',
      status: 'ACTIVE',
      customerDisplayInverted: false,
    },
  })
})

afterAll(async () => {
  if (!prisma || !fixtureCreated) return
  assertDisposableTestDatabase()
  await db().activityLog.deleteMany({ where: { entity: 'Terminal', entityId: terminalId, venueId } })
  await db().terminal.deleteMany({ where: { id: terminalId, venueId } })
  await db().venue.deleteMany({ where: { id: venueId, organizationId } })
  await db().organization.deleteMany({ where: { id: organizationId } })
  await db().staff.deleteMany({ where: { id: staffId } })
})

describe('display-mode request CAS — real PostgreSQL concurrency', () => {
  it('keeps one current request, records the superseded request, and advances one version per audited mutation', async () => {
    const first = service.createDisplayModeRequest({
      venueId,
      terminalId,
      desiredInverted: true,
      requestedBy: staffId,
    })
    const second = service.createDisplayModeRequest({
      venueId,
      terminalId,
      desiredInverted: false,
      requestedBy: staffId,
    })

    const settled = await Promise.allSettled([first, second])
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.createDisplayModeRequest>>> =>
        result.status === 'fulfilled',
    )
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(0)
    expect(fulfilled.map(result => result.value.version).sort((a, b) => a - b)).toEqual([1, 2])

    const stored = await db().terminal.findFirstOrThrow({
      where: { id: terminalId, venueId },
      select: {
        customerDisplayRequest: true,
        customerDisplayRequestVersion: true,
        customerDisplayRequestExpiresAt: true,
        customerDisplayInverted: true,
      },
    })
    const current = service.parseDisplayModeRequest(stored.customerDisplayRequest)
    expect(current).not.toBeNull()
    expect(current?.status).toBe('PENDING')
    expect(fulfilled.map(result => result.value.request?.requestId)).toContain(current?.requestId)
    expect(stored.customerDisplayRequestVersion).toBe(2)
    expect(stored.customerDisplayRequestExpiresAt?.toISOString()).toBe(current?.expiresAt)
    expect(stored.customerDisplayInverted).toBe(false)

    const audits = await db().activityLog.findMany({
      where: { entity: 'Terminal', entityId: terminalId, venueId, action: 'DISPLAY_MODE_REQUESTED' },
      orderBy: { createdAt: 'asc' },
      select: { action: true, data: true },
    })
    expect(audits).toHaveLength(2)

    const auditData = audits.map(row => row.data as Record<string, unknown>)
    const auditedRequestIds = auditData.map(data => data.requestId)
    for (const result of fulfilled) expect(auditedRequestIds).toContain(result.value.request?.requestId)
    for (const data of auditData) {
      expect(data).toMatchObject({ status: 'PENDING', requestedAt: expect.any(String), requestId: expect.any(String) })
    }

    const supersedingAudit = auditData.find(data => data.requestId === current?.requestId)
    expect(supersedingAudit).toMatchObject({
      supersededRequestId: expect.any(String),
      supersededStatus: 'SUPERSEDED',
    })
    expect(supersedingAudit?.supersededRequestId).not.toBe(current?.requestId)
  })
})
