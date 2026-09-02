/**
 * Integration tests: the org stock-control raw SQL selects the venue day, not a 6h-shifted one.
 *
 * `SerializedItem.createdAt` / `soldAt` are `timestamp without time zone` storing real UTC.
 * A Prisma `Date` bound into `$queryRaw` arrives as `timestamptz` (measured with `pg_typeof`,
 * 2026-09-01) and, compared bare, Postgres converts it with the SESSION zone first. That
 * session zone is NOT the same everywhere we run:
 *
 *   - local Mac Postgres: `America/Mexico_City` → a bare bind shifts the window 6 hours
 *   - production (Render):  `UTC`               → a bare bind happens to be right
 *
 * `utcTs` (`AT TIME ZONE 'UTC'`) gives the same rows under both — that is what the last
 * describe proves, and why the fix is safe to deploy. The other describes pin the three
 * org-stock entry points (`/summary`, `/bulk-groups`, `/by-responsible`) on the boundary.
 *
 * Venue day under test: Tuesday 2025-03-11 in Mexico City = [2025-03-11T06:00Z, 2025-03-12T06:00Z).
 *
 *   NIGHT      20:00 MX on the 11th (02:00Z on the 12th) → inside; a shifted filter DROPS it
 *   LATE_PREV  23:30 MX on the 10th (05:30Z on the 11th) → outside; a shifted filter INCLUDES it
 *   EARLY_NEXT 04:00 MX on the 12th (10:00Z on the 12th) → outside, every filter agrees
 *
 * The two items inside/outside carry OPPOSITE status and custody so that a wrong window
 * changes the answer, not just the count.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern org-stock-date-binds
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { orgStockControlService } from '@/services/organization-dashboard/orgStockControl.service'
import { orgInventoryByResponsibleService } from '@/services/organization-dashboard/orgInventoryByResponsible.service'

const FROM = new Date('2025-03-11T06:00:00.000Z')
const TO = new Date('2025-03-12T05:59:59.999Z')

const NIGHT = new Date('2025-03-12T02:00:00.000Z')
const LATE_PREV = new Date('2025-03-11T05:30:00.000Z')
const EARLY_NEXT = new Date('2025-03-12T10:00:00.000Z')

const suffix = `orgstock-tz-${Date.now()}`
const SERIAL_NIGHT = `NIGHT-${suffix}`
const SERIAL_LATE_PREV = `LATEPREV-${suffix}`
const SERIAL_EARLY_NEXT = `EARLYNEXT-${suffix}`

let orgId: string
let staffId: string
let itemCategoryId: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Org Stock TZ ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id

  const staff = await prisma.staff.create({
    data: { email: `promoter-${suffix}@example.test`, firstName: 'Promotor', lastName: suffix },
    select: { id: true },
  })
  staffId = staff.id

  const category = await prisma.itemCategory.create({ data: { name: `SIM ${suffix}` }, select: { id: true } })
  itemCategoryId = category.id

  const base = { categoryId: itemCategoryId, organizationId: orgId, createdBy: staffId, assignedPromoterId: staffId }
  await prisma.serializedItem.createMany({
    data: [
      // Inside the day: sold, no longer in the promoter's hand.
      { ...base, serialNumber: SERIAL_NIGHT, createdAt: NIGHT, status: 'SOLD', soldAt: NIGHT, custodyState: 'SOLD' },
      // The evening before: still available and in hand — the opposite of NIGHT on every counter.
      { ...base, serialNumber: SERIAL_LATE_PREV, createdAt: LATE_PREV, status: 'AVAILABLE', custodyState: 'PROMOTER_HELD' },
      { ...base, serialNumber: SERIAL_EARLY_NEXT, createdAt: EARLY_NEXT, status: 'AVAILABLE', custodyState: 'PROMOTER_HELD' },
    ],
  })
})

afterAll(async () => {
  if (itemCategoryId) {
    await prisma.serializedItem.deleteMany({ where: { categoryId: itemCategoryId } })
    await prisma.itemCategory.deleteMany({ where: { id: itemCategoryId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('getOrgSummary — the 11th in venue time holds the 20:00 sale, not the 23:30 of the 10th', () => {
  it('counts one SOLD item and zero AVAILABLE', async () => {
    const result = await orgStockControlService.getOrgSummary(orgId, { dateFrom: FROM, dateTo: TO })
    expect(result.summary.totalSims).toBe(1)
    expect(result.summary.sold).toBe(1)
    expect(result.summary.available).toBe(0)
  })

  it('salesLast7Days puts the sale in the bucket its instant belongs to', async () => {
    // `now` is 14:00 MX on the 12th and NIGHT is 20:00 MX on the 11th: the sale
    // belongs in yesterday (index 5), even when Node itself runs in UTC on Render.
    const now = new Date('2025-03-12T20:00:00.000Z')
    const previousTz = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      const result = await orgStockControlService.getOrgSummary(orgId, { dateFrom: FROM, dateTo: TO }, now)
      const [venue] = result.aggregatesBySucursal
      expect(venue.sold).toBe(1)
      expect(venue.salesLast7Days).toEqual([0, 0, 0, 0, 0, 1, 0])
    } finally {
      process.env.TZ = previousTz
    }
  })
})

describe('getOrgBulkGroupsPage — the only upload in the window is the night one', () => {
  it('returns one group whose serial is the 20:00 item', async () => {
    const page = await orgStockControlService.getOrgBulkGroupsPage(orgId, { page: 1, pageSize: 10, dateFrom: FROM, dateTo: TO })
    expect(page.pagination.total).toBe(1)
    expect(page.groups).toHaveLength(1)
    expect(page.groups[0].serialNumberFirst).toBe(SERIAL_NIGHT)
    expect(page.groups[0].soldCount).toBe(1)
  })
})

describe('getInventoryByResponsible — the promoter holds nothing from the 11th, the sale is his', () => {
  it('assigned = 1 (the sold item) and inHandToday = 0', async () => {
    const table = await orgInventoryByResponsibleService.getInventoryByResponsible(orgId, { dateFrom: FROM, dateTo: TO })
    const nodes = [table.unassigned, ...table.cities]
    const assigned = nodes.reduce((sum, node) => sum + node.assigned, 0)
    const inHand = nodes.reduce((sum, node) => sum + node.inHandToday, 0)
    expect(assigned).toBe(1)
    expect(inHand).toBe(0)
  })
})

// ===========================================================================
// Why the fix is safe in production: `utcTs` does not depend on the session zone.
// Same Prisma bind, same rows, whether the session runs in Mexico City (local) or UTC (Render).
// The bare form is shown next to it only to document WHERE the old code was wrong.
// ===========================================================================

describe('utcTs vs bare bind under the local and the production session zones', () => {
  const serialsUnder = (zone: string, where: Prisma.Sql) =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`)
      const rows = await tx.$queryRaw<{ serialNumber: string }[]>(
        Prisma.sql`SELECT "serialNumber" FROM "SerializedItem" WHERE "organizationId" = ${orgId} AND ${where} ORDER BY "serialNumber"`,
      )
      return rows.map(r => r.serialNumber)
    })

  const wrapped = Prisma.sql`"createdAt" >= ${utcTs(FROM)} AND "createdAt" <= ${utcTs(TO)}`
  const bare = Prisma.sql`"createdAt" >= ${FROM} AND "createdAt" <= ${TO}`

  it('utcTs: the same single row in America/Mexico_City and in UTC', async () => {
    expect(await serialsUnder('America/Mexico_City', wrapped)).toEqual([SERIAL_NIGHT])
    expect(await serialsUnder('UTC', wrapped)).toEqual([SERIAL_NIGHT])
  })

  it('bare bind: right in UTC (production), six hours off in America/Mexico_City (local)', async () => {
    expect(await serialsUnder('UTC', bare)).toEqual([SERIAL_NIGHT])
    expect(await serialsUnder('America/Mexico_City', bare)).toEqual([SERIAL_LATE_PREV])
  })
})
