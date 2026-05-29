/**
 * referralCode.service tests — Phase B1, Task 7
 *
 * TDD: this test file is written FIRST. It mocks the default export of
 * `@/utils/prismaClient` (the project convention used by every other
 * mocked-Prisma unit test in this repo).
 */

import prisma from '@/utils/prismaClient'
import { generateReferralCode, normalizeNameForCode, CodeGenerationContext } from '@/services/referrals/referralCode.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: {
      findFirst: jest.fn(),
    },
  },
}))

const mockedPrisma = prisma as unknown as {
  customer: { findFirst: jest.Mock }
}

describe('referralCode.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('normalizeNameForCode', () => {
    it('takes first 4 letters uppercased', () => {
      expect(normalizeNameForCode('María López')).toBe('MARI')
    })

    it('strips accents (NFD normalization)', () => {
      expect(normalizeNameForCode('José Pérez')).toBe('JOSE')
    })

    it('handles spaces and concatenates letters across words', () => {
      expect(normalizeNameForCode('Ana Cristina Torres')).toBe('ANAC')
    })

    it('pads short names with X', () => {
      expect(normalizeNameForCode('Li')).toBe('LIXX')
      expect(normalizeNameForCode('A')).toBe('AXXX')
    })

    it('returns ANON for empty/null name', () => {
      expect(normalizeNameForCode('')).toBe('ANON')
      expect(normalizeNameForCode(null)).toBe('ANON')
      expect(normalizeNameForCode(undefined)).toBe('ANON')
    })

    it('strips ñ via NFD', () => {
      expect(normalizeNameForCode('Iñaki')).toBe('INAK')
    })
  })

  describe('generateReferralCode', () => {
    const baseCtx: CodeGenerationContext = {
      venueId: 'venue_123',
      venuePrefix: 'MINDFORM',
      customerName: 'María López',
    }

    it('generates code with format VENUE-NAMEN-R3', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      const code = await generateReferralCode(baseCtx)
      expect(code).toMatch(/^MINDFORM-MARI[A-HJ-NP-Z2-9]{3}$/)
    })

    it('retries on collision up to 5 times', async () => {
      mockedPrisma.customer.findFirst
        .mockResolvedValueOnce({ id: 'collision-1' })
        .mockResolvedValueOnce({ id: 'collision-2' })
        .mockResolvedValueOnce(null)
      const code = await generateReferralCode(baseCtx)
      expect(code).toMatch(/^MINDFORM-MARI[A-HJ-NP-Z2-9]{3}$/)
      expect(mockedPrisma.customer.findFirst).toHaveBeenCalledTimes(3)
    })

    it('throws after 5 failed attempts', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'always-collides' })
      await expect(generateReferralCode(baseCtx)).rejects.toThrow(/collision/i)
      expect(mockedPrisma.customer.findFirst).toHaveBeenCalledTimes(5)
    })

    it('avoids ambiguous characters in random suffix', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      // Run a handful of generations so the random pool is exercised.
      for (let i = 0; i < 25; i++) {
        const code = await generateReferralCode(baseCtx)
        // Code format is `${prefix}-${name4}${rnd3}`; the random suffix
        // is the trailing 3 characters of the last hyphen-segment.
        const lastSegment = code.split('-').pop()!
        const suffix = lastSegment.slice(-3)
        expect(suffix).toHaveLength(3)
        expect(suffix).not.toMatch(/[0OI1S5]/)
      }
    })

    it('uppercases venuePrefix and caps at 8 chars', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      const code = await generateReferralCode({
        ...baseCtx,
        venuePrefix: 'verylongvenuename',
      })
      expect(code.startsWith('VERYLONG-')).toBe(true)
    })
  })
})
