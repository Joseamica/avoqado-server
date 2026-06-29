/**
 * Unit tests (mock-first) — cash-out promoter self-service (TPV "Mis Comisiones").
 * Proves: self-scoped saldo + activeToday flag, and that a withdrawal is BLOCKED
 * on a non-active day (date gate) and DELEGATES to createWithdrawal on an active
 * day. Domain date helpers are real; sibling services are mocked.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() } },
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
  listActiveDays: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { materializeEntries, getSaldo } from '@/services/dashboard/cash-out/cash-out.ledger.service'
import { createWithdrawal } from '@/services/dashboard/cash-out/cash-out.withdrawal.service'
import { assertCashOutEnabled, listActiveDays } from '@/services/dashboard/cash-out/cash-out.config.service'
import { getPromoterCashOut, withdrawAsPromoter, CashOutNotActiveTodayError } from '@/services/dashboard/cash-out/cash-out.promoter.service'

const mockVenue = (prisma as unknown as { venue: { findUnique: jest.Mock } }).venue.findUnique
const mockMaterialize = materializeEntries as jest.Mock
const mockSaldo = getSaldo as jest.Mock
const mockWithdraw = createWithdrawal as jest.Mock
const mockAssert = assertCashOutEnabled as jest.Mock
const mockDays = listActiveDays as jest.Mock

// 2026-06-29T01:00Z = 2026-06-28 19:00 in America/Mexico_City (-06) → business day 2026-06-28
const NOW = new Date('2026-06-29T01:00:00.000Z')
const TZ = 'America/Mexico_City'

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
})
