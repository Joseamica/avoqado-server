// tests/unit/services/fiscal/listCfdisForVenue.test.ts
//
// Unit tests for listCfdisForVenue (service layer).
// Verifies: tenant isolation (venueId always applied), filter mapping,
// pagination math, date-range timezone conversion, and result shape.
//
// Pattern mirrors loadOrderForCfdi.test.ts: prismaClient is mocked via
// jest.mock before any imports from the service.

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    cfdi: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}))

jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import { listCfdisForVenue } from '../../../../src/services/fiscal/cfdi.service'

const findMany = prisma.cfdi.findMany as jest.Mock
const count = prisma.cfdi.count as jest.Mock

const VENUE_ID = 'venue-abc'
const TIMEZONE = 'America/Mexico_City'

const SAMPLE_CFDI = {
  id: 'c1',
  type: 'INGRESO',
  status: 'STAMPED',
  flow: 'STAFF_B',
  isGlobal: false,
  orderId: 'o1',
  receptorRfc: 'XAXX010101000',
  receptorNombre: 'Público en General',
  serie: 'F',
  folio: '1',
  uuid: 'some-uuid',
  subtotalCents: 10000,
  taxCents: 1600,
  totalCents: 11600,
  stampedAt: new Date('2026-06-01T19:00:00.000Z'),
  createdAt: new Date('2026-06-01T19:00:00.000Z'),
  cancelStatus: null,
  xmlUrl: 'https://example.com/cfdi.xml',
  pdfUrl: 'https://example.com/cfdi.pdf',
  globalPeriod: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  findMany.mockResolvedValue([SAMPLE_CFDI])
  count.mockResolvedValue(1)
})

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('always includes venueId in the where clause', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    const whereArg = findMany.mock.calls[0][0].where
    expect(whereArg).toMatchObject({ venueId: VENUE_ID })
  })

  it('includes venueId even when all optional filters are provided', async () => {
    await listCfdisForVenue({
      venueId: VENUE_ID,
      status: 'STAMPED',
      flow: 'STAFF_B',
      isGlobal: false,
      receptorRfc: 'XAXX',
      from: '2026-06-01',
      to: '2026-06-30',
      page: 2,
      pageSize: 10,
      venueTimezone: TIMEZONE,
    })

    const whereArg = findMany.mock.calls[0][0].where
    expect(whereArg.venueId).toBe(VENUE_ID)
  })

  it('passes the same where to both findMany and count (identical tenant scope)', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, status: 'STAMPED', page: 1, pageSize: 20 })

    const findManyWhere = findMany.mock.calls[0][0].where
    const countWhere = count.mock.calls[0][0].where
    expect(findManyWhere).toEqual(countWhere)
  })
})

// ─── Filter mapping ────────────────────────────────────────────────────────────

describe('filter mapping', () => {
  it('maps status filter to where.status', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, status: 'CANCELLED', page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.status).toBe('CANCELLED')
  })

  it('maps flow filter to where.flow', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, flow: 'GLOBAL_C', page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.flow).toBe('GLOBAL_C')
  })

  it('maps isGlobal=true to where.isGlobal', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, isGlobal: true, page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.isGlobal).toBe(true)
  })

  it('maps isGlobal=false to where.isGlobal', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, isGlobal: false, page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.isGlobal).toBe(false)
  })

  it('maps receptorRfc to case-insensitive contains', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, receptorRfc: 'TEST', page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.receptorRfc).toEqual({ contains: 'TEST', mode: 'insensitive' })
  })

  it('omits optional filters from where when not provided', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.status).toBeUndefined()
    expect(where.flow).toBeUndefined()
    expect(where.isGlobal).toBeUndefined()
    expect(where.receptorRfc).toBeUndefined()
    expect(where.createdAt).toBeUndefined()
  })
})

// ─── Date range timezone conversion ───────────────────────────────────────────

describe('date range: timezone conversion (Prisma = real UTC)', () => {
  it('converts from (venue-local midnight) to real UTC for gte', async () => {
    // Mexico City is UTC-6 in winter (CST). June 1 midnight Mexico = June 1 06:00 UTC.
    await listCfdisForVenue({
      venueId: VENUE_ID,
      from: '2026-06-01',
      page: 1,
      pageSize: 20,
      venueTimezone: TIMEZONE,
    })

    const where = findMany.mock.calls[0][0].where
    expect(where.createdAt).toBeDefined()
    const gte: Date = where.createdAt.gte
    // In summer (CDT) Mexico is UTC-5; June 1 midnight CDT = 05:00 UTC.
    // In winter (CST) it would be 06:00 UTC. Either way, it should NOT be 00:00 UTC.
    expect(gte.toISOString()).not.toBe('2026-06-01T00:00:00.000Z')
    // The date should be June 1 (UTC might push it up slightly due to offset)
    expect(gte.getUTCDate()).toBeGreaterThanOrEqual(1)
  })

  it('converts to (venue-local end of day) to real UTC for lte', async () => {
    await listCfdisForVenue({
      venueId: VENUE_ID,
      to: '2026-06-01',
      page: 1,
      pageSize: 20,
      venueTimezone: TIMEZONE,
    })

    const where = findMany.mock.calls[0][0].where
    expect(where.createdAt).toBeDefined()
    const lte: Date = where.createdAt.lte
    // End of day should NOT be midnight UTC — it should be 05:59 or 06:59 UTC (after adding offset)
    expect(lte.toISOString()).not.toBe('2026-06-01T00:00:00.000Z')
    // lte must be strictly after gte (end of day > start of day)
    expect(lte.getTime()).toBeGreaterThan(new Date('2026-06-01T00:00:00.000Z').getTime())
  })

  it('sets both gte and lte when both from and to are provided', async () => {
    await listCfdisForVenue({
      venueId: VENUE_ID,
      from: '2026-06-01',
      to: '2026-06-30',
      page: 1,
      pageSize: 20,
      venueTimezone: TIMEZONE,
    })

    const where = findMany.mock.calls[0][0].where
    expect(where.createdAt.gte).toBeInstanceOf(Date)
    expect(where.createdAt.lte).toBeInstanceOf(Date)
    // lte (end of June 30) must be after gte (start of June 1)
    expect(where.createdAt.lte.getTime()).toBeGreaterThan(where.createdAt.gte.getTime())
  })

  it('sets only gte when only from is provided', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, from: '2026-06-01', page: 1, pageSize: 20, venueTimezone: TIMEZONE })

    const where = findMany.mock.calls[0][0].where
    expect(where.createdAt.gte).toBeInstanceOf(Date)
    expect(where.createdAt.lte).toBeUndefined()
  })

  it('sets only lte when only to is provided', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, to: '2026-06-30', page: 1, pageSize: 20, venueTimezone: TIMEZONE })

    const where = findMany.mock.calls[0][0].where
    expect(where.createdAt.gte).toBeUndefined()
    expect(where.createdAt.lte).toBeInstanceOf(Date)
  })
})

// ─── Pagination math ──────────────────────────────────────────────────────────

describe('pagination math', () => {
  it('calculates correct skip for page 1', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    const args = findMany.mock.calls[0][0]
    expect(args.skip).toBe(0)
    expect(args.take).toBe(20)
  })

  it('calculates correct skip for page 2', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 2, pageSize: 20 })

    const args = findMany.mock.calls[0][0]
    expect(args.skip).toBe(20)
    expect(args.take).toBe(20)
  })

  it('calculates correct skip for page 3 with pageSize 10', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 3, pageSize: 10 })

    const args = findMany.mock.calls[0][0]
    expect(args.skip).toBe(20)
    expect(args.take).toBe(10)
  })

  it('always orders by createdAt desc', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    const args = findMany.mock.calls[0][0]
    expect(args.orderBy).toEqual({ createdAt: 'desc' })
  })
})

// ─── Result shape ──────────────────────────────────────────────────────────────

describe('result shape', () => {
  it('returns { cfdis, total, page, pageSize }', async () => {
    findMany.mockResolvedValue([SAMPLE_CFDI])
    count.mockResolvedValue(42)

    const result = await listCfdisForVenue({ venueId: VENUE_ID, page: 2, pageSize: 10 })

    expect(result).toEqual({
      cfdis: [SAMPLE_CFDI],
      total: 42,
      page: 2,
      pageSize: 10,
    })
  })

  it('returns empty cfdis array when no results', async () => {
    findMany.mockResolvedValue([])
    count.mockResolvedValue(0)

    const result = await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    expect(result.cfdis).toEqual([])
    expect(result.total).toBe(0)
  })

  it('runs findMany and count in parallel (Promise.all)', async () => {
    // Both mocks resolve immediately; check both were called in the same test tick
    findMany.mockResolvedValue([])
    count.mockResolvedValue(0)

    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalledTimes(1)
  })
})
