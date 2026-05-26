/**
 * resolveEffectiveTerminals — the inheritance-aware terminal resolution that
 * backs the superadmin "Terminales (N)" count + readiness chip.
 *
 * A terminal serves a merchant when it either:
 *   (a) lists the merchant explicitly in `assignedMerchantIds`, OR
 *   (b) has an EMPTY `assignedMerchantIds` AND the merchant is slotted in that
 *       terminal's venue (VenuePaymentConfig inheritance fallback).
 *
 * The OR/`isEmpty` filtering is delegated to Prisma (mocked here); these tests
 * pin the in-memory attribution (explicit vs inherited, exclusion of terminals
 * restricted to OTHER merchants, dedup, multi-merchant fan-out). The OLD
 * explicit-only behavior would have failed the inheritance assertions.
 *
 * Bug: merchants routed the normal way (slotted venue + unrestricted terminals)
 * reported "Terminales (0)" + red chip even though those terminals process them.
 */

import prisma from '@/utils/prismaClient'
import { resolveEffectiveTerminals } from '@/services/superadmin/merchantAccount.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findMany: jest.fn() },
  },
}))

const mockedPrisma = prisma as unknown as {
  terminal: { findMany: jest.Mock }
}

describe('resolveEffectiveTerminals — explicit ∪ venue-slot inheritance', () => {
  beforeEach(() => jest.clearAllMocks())

  it('counts explicit assignments AND inherited (empty assignedMerchantIds in a slotted venue), excluding terminals restricted to other merchants', async () => {
    mockedPrisma.terminal.findMany.mockResolvedValue([
      // explicit: lists M (in any venue)
      { id: 't-explicit', serialNumber: 'AVQD-EXP', venueId: 'vX', assignedMerchantIds: ['M'] },
      // inherited: empty + in M's slotted venue V1 → serves M
      { id: 't-inherit', serialNumber: 'AVQD-INH', venueId: 'V1', assignedMerchantIds: [] },
      // restricted to ANOTHER merchant (non-empty, no M) — even though in V1, it does NOT serve M
      { id: 't-other', serialNumber: 'AVQD-OTH', venueId: 'V1', assignedMerchantIds: ['OTHER'] },
    ])

    const result = await resolveEffectiveTerminals(new Map([['M', ['V1']]]))

    expect((result['M'] ?? []).map(t => t.id).sort()).toEqual(['t-explicit', 't-inherit'])
    // flag: explicit → inherited:false, inherited → inherited:true
    expect(result['M']?.find(t => t.id === 't-explicit')?.inherited).toBe(false)
    expect(result['M']?.find(t => t.id === 't-inherit')?.inherited).toBe(true)
  })

  it('attributes an inherited (empty) terminal to every merchant slotted in its venue', async () => {
    mockedPrisma.terminal.findMany.mockResolvedValue([{ id: 't-inh', serialNumber: 'S', venueId: 'V1', assignedMerchantIds: [] }])

    const result = await resolveEffectiveTerminals(
      new Map([
        ['M1', ['V1']],
        ['M2', ['V1']],
      ]),
    )

    expect(result['M1']?.map(t => t.id)).toEqual(['t-inh'])
    expect(result['M2']?.map(t => t.id)).toEqual(['t-inh'])
  })

  it('normalizes a null serialNumber to an empty string', async () => {
    mockedPrisma.terminal.findMany.mockResolvedValue([{ id: 't1', serialNumber: null, venueId: 'V1', assignedMerchantIds: ['M'] }])

    const result = await resolveEffectiveTerminals(new Map([['M', ['V1']]]))

    expect(result['M']).toEqual([{ id: 't1', serialNumber: '', inherited: false }])
  })

  it('dedupes a merchant id that appears twice in a terminal assignment', async () => {
    mockedPrisma.terminal.findMany.mockResolvedValue([{ id: 't1', serialNumber: 'S1', venueId: 'V1', assignedMerchantIds: ['M', 'M'] }])

    const result = await resolveEffectiveTerminals(new Map([['M', ['V1']]]))

    expect(result['M']).toHaveLength(1)
  })

  it('returns {} and skips the DB entirely when no merchants are given', async () => {
    const result = await resolveEffectiveTerminals(new Map())

    expect(result).toEqual({})
    expect(mockedPrisma.terminal.findMany).not.toHaveBeenCalled()
  })
})
