/**
 * Unit tests (mock-first) — cash-out promoter self-service (TPV "Mis Comisiones").
 * Proves: self-scoped saldo + activeToday flag, and that a withdrawal is BLOCKED
 * on a non-active day (date gate) and DELEGATES to createWithdrawal on an active
 * day. Domain date helpers are real; sibling services are mocked.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() }, cashOutScheduleDay: { findMany: jest.fn() } },
}))
jest.mock('@/services/dashboard/cash-out/cash-out.ledger.service', () => ({
  __esModule: true,
  materializeEntries: jest.fn(),
  getSaldo: jest.fn(),
}))
jest.mock('@/services/dashboard/cash-out/cash-out.withdrawal.service', () => ({
  __esModule: true,
  createWithdrawal: jest.fn(),
}))
jest.mock('@/services/dashboard/cash-out/cash-out.config.service', () => ({
  __esModule: true,
  assertCashOutEnabled: jest.fn(),
  resolveActiveDaysForVenue: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { materializeEntries, getSaldo } from '@/services/dashboard/cash-out/cash-out.ledger.service'
import { createWithdrawal } from '@/services/dashboard/cash-out/cash-out.withdrawal.service'
import { assertCashOutEnabled, resolveActiveDaysForVenue } from '@/services/dashboard/cash-out/cash-out.config.service'
import { getPromoterCashOut, withdrawAsPromoter, CashOutNotActiveTodayError } from '@/services/dashboard/cash-out/cash-out.promoter.service'

const mockVenue = (prisma as unknown as { venue: { findUnique: jest.Mock } }).venue.findUnique
const mockScheduleDay = (prisma as unknown as { cashOutScheduleDay: { findMany: jest.Mock } }).cashOutScheduleDay.findMany
const mockMaterialize = materializeEntries as jest.Mock
const mockSaldo = getSaldo as jest.Mock
const mockWithdraw = createWithdrawal as jest.Mock
const mockAssert = assertCashOutEnabled as jest.Mock
const mockDays = resolveActiveDaysForVenue as jest.Mock

// 2026-06-29T01:00Z = 2026-06-28 19:00 in America/Mexico_City (-06) → business day 2026-06-28
const NOW = new Date('2026-06-29T01:00:00.000Z')
const TZ = 'America/Mexico_City'

/**
 * Real venue-override-else-org resolution logic (mirrors cash-out.config.service's
 * resolveActiveDaysForVenue), driven by the mocked prisma calls above. Used only by
 * the org-fallback tests below, to prove the promoter path actually reaches org rows
 * — not just that its own mock returns whatever we hand it.
 */
async function realResolveActiveDaysForVenue(venueId: string): Promise<string[]> {
  const venueRows = await mockScheduleDay({ where: { venueId, active: true }, orderBy: { day: 'asc' } })
  if (venueRows.length) return venueRows.map((r: { day: Date }) => r.day.toISOString().slice(0, 10))
  const venue = await mockVenue({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue?.organizationId) return []
  const orgRows = await mockScheduleDay({
    where: { orgId: venue.organizationId, venueId: null, active: true },
    orderBy: { day: 'asc' },
  })
  return orgRows.map((r: { day: Date }) => r.day.toISOString().slice(0, 10))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAssert.mockResolvedValue(undefined)
  mockMaterialize.mockResolvedValue({ created: 0 })
  mockVenue.mockResolvedValue({ timezone: TZ })
  mockSaldo.mockResolvedValue(new Prisma.Decimal(30))
})

describe('cash-out promoter self-service — getPromoterCashOut', () => {
  it('returns own saldo (pesos) + activeToday=true when today is an active day', async () => {
    mockDays.mockResolvedValue(['2026-06-28'])
    const res = await getPromoterCashOut('v_pt', 'p1', NOW)
    expect(res).toEqual({ saldo: '30', activeToday: true, businessDate: '2026-06-28' })
    expect(mockSaldo).toHaveBeenCalledWith('v_pt', 'p1') // self-scoped
    expect(mockMaterialize).toHaveBeenCalledWith('v_pt')
  })

  it('activeToday=false when today is not in the active-days calendar', async () => {
    mockDays.mockResolvedValue(['2026-06-30'])
    const res = await getPromoterCashOut('v_pt', 'p1', NOW)
    expect(res.activeToday).toBe(false)
    expect(res.businessDate).toBe('2026-06-28')
  })

  it('activeToday=true via ORG fallback when the venue has no active-day rows of its own (money-critical regression)', async () => {
    // Venue query returns [] (no venue-level override); org query returns today's row.
    mockScheduleDay
      .mockResolvedValueOnce([]) // venue rows
      .mockResolvedValueOnce([{ day: new Date('2026-06-28T00:00:00.000Z') }]) // org rows
    mockVenue.mockResolvedValue({ timezone: TZ, organizationId: 'org1' })
    mockDays.mockImplementation(realResolveActiveDaysForVenue)

    const res = await getPromoterCashOut('v_pt', 'p1', NOW)

    expect(res).toEqual({ saldo: '30', activeToday: true, businessDate: '2026-06-28' })
  })
})

describe('cash-out promoter self-service — withdrawAsPromoter', () => {
  it('delegates to createWithdrawal on an active day (self-scoped, venue tz)', async () => {
    mockDays.mockResolvedValue(['2026-06-28'])
    mockWithdraw.mockResolvedValue({ folio: 'CO-X', grossAmount: new Prisma.Decimal(30), netAmount: new Prisma.Decimal(30), entries: 1 })
    const res = await withdrawAsPromoter('v_pt', 'p1', NOW)
    expect(res.folio).toBe('CO-X')
    expect(mockWithdraw).toHaveBeenCalledWith('v_pt', 'p1', { staffId: 'p1', timeZone: TZ })
  })

  it('BLOCKS the withdrawal on a non-active day and never calls createWithdrawal', async () => {
    mockDays.mockResolvedValue([]) // no active days configured
    await expect(withdrawAsPromoter('v_pt', 'p1', NOW)).rejects.toBeInstanceOf(CashOutNotActiveTodayError)
    expect(mockWithdraw).not.toHaveBeenCalled()
  })

  it('propagates the module gate (serialized off → never withdraws)', async () => {
    mockAssert.mockRejectedValue(new Error('module off'))
    mockDays.mockResolvedValue(['2026-06-28'])
    await expect(withdrawAsPromoter('v_pt', 'p1', NOW)).rejects.toThrow(/module off/)
    expect(mockWithdraw).not.toHaveBeenCalled()
  })

  it('does NOT throw CashOutNotActiveTodayError via ORG fallback (money-critical regression: org-only-active venue must be withdrawable)', async () => {
    mockScheduleDay
      .mockResolvedValueOnce([]) // venue rows empty
      .mockResolvedValueOnce([{ day: new Date('2026-06-28T00:00:00.000Z') }]) // org rows: today active
    mockVenue.mockResolvedValue({ timezone: TZ, organizationId: 'org1' })
    mockDays.mockImplementation(realResolveActiveDaysForVenue)
    mockWithdraw.mockResolvedValue({ folio: 'CO-ORG', grossAmount: new Prisma.Decimal(30), netAmount: new Prisma.Decimal(30), entries: 1 })

    const res = await withdrawAsPromoter('v_pt', 'p1', NOW)

    expect(res.folio).toBe('CO-ORG')
    expect(mockWithdraw).toHaveBeenCalledWith('v_pt', 'p1', { staffId: 'p1', timeZone: TZ })
  })

  it('still throws CashOutNotActiveTodayError when NEITHER venue nor org has today active', async () => {
    mockScheduleDay
      .mockResolvedValueOnce([]) // venue rows empty
      .mockResolvedValueOnce([]) // org rows empty too
    mockVenue.mockResolvedValue({ timezone: TZ, organizationId: 'org1' })
    mockDays.mockImplementation(realResolveActiveDaysForVenue)

    await expect(withdrawAsPromoter('v_pt', 'p1', NOW)).rejects.toBeInstanceOf(CashOutNotActiveTodayError)
    expect(mockWithdraw).not.toHaveBeenCalled()
  })
})
