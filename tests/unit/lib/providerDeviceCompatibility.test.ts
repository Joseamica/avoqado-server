/**
 * providerDeviceCompatibility helper tests
 *
 * Catalog + predicate logic is pure (no DB). The DB-aware
 * `assertVenueHasCompatibleTerminal` is exercised with a mocked Prisma
 * client (matches the convention used by every other test in tests/unit/lib).
 */

import prisma from '@/utils/prismaClient'
import {
  PROVIDER_DEVICE_COMPATIBILITY,
  isProviderCompatibleWithBrand,
  assertVenueHasCompatibleTerminal,
} from '@/lib/providerDeviceCompatibility'
import { IncompatibleDeviceError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: {
      count: jest.fn(),
    },
  },
}))

const mockedPrisma = prisma as unknown as {
  terminal: { count: jest.Mock }
}

describe('providerDeviceCompatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('PROVIDER_DEVICE_COMPATIBILITY catalog', () => {
    it('matches the spec-mandated mapping (BLUMON→PAX, ANGELPAY→NEXGO)', () => {
      expect(PROVIDER_DEVICE_COMPATIBILITY).toEqual({
        BLUMON: ['PAX'],
        ANGELPAY: ['NEXGO'],
      })
    })
  })

  describe('isProviderCompatibleWithBrand()', () => {
    it('returns true for BLUMON + PAX', () => {
      expect(isProviderCompatibleWithBrand('BLUMON', 'PAX')).toBe(true)
    })

    it('returns false for ANGELPAY + PAX', () => {
      expect(isProviderCompatibleWithBrand('ANGELPAY', 'PAX')).toBe(false)
    })

    it('returns false for BLUMON + NEXGO', () => {
      expect(isProviderCompatibleWithBrand('BLUMON', 'NEXGO')).toBe(false)
    })

    it('returns true for ANGELPAY + NEXGO', () => {
      expect(isProviderCompatibleWithBrand('ANGELPAY', 'NEXGO')).toBe(true)
    })

    it('is permissive for unknown providers (no entry → allowed)', () => {
      expect(isProviderCompatibleWithBrand('UNKNOWN', 'PAX')).toBe(true)
      expect(isProviderCompatibleWithBrand('STRIPE', 'NEXGO')).toBe(true)
    })

    it('is permissive when brand is null (terminal not yet activated)', () => {
      expect(isProviderCompatibleWithBrand('ANGELPAY', null)).toBe(true)
      expect(isProviderCompatibleWithBrand('BLUMON', null)).toBe(true)
    })
  })

  describe('assertVenueHasCompatibleTerminal()', () => {
    it('throws IncompatibleDeviceError when venue has zero NEXGO terminals (provider=ANGELPAY)', async () => {
      mockedPrisma.terminal.count.mockResolvedValue(0)

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY')).rejects.toBeInstanceOf(
        IncompatibleDeviceError,
      )

      expect(mockedPrisma.terminal.count).toHaveBeenCalledWith({
        where: { venueId: 'venue-1', brand: { in: ['NEXGO'] }, status: 'ACTIVE' },
      })
    })

    it('resolves when venue has at least one ACTIVE NEXGO terminal (provider=ANGELPAY)', async () => {
      mockedPrisma.terminal.count.mockResolvedValue(1)

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY')).resolves.toBeUndefined()
    })

    it('throws IncompatibleDeviceError when venue has zero PAX terminals (provider=BLUMON)', async () => {
      mockedPrisma.terminal.count.mockResolvedValue(0)

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'BLUMON')).rejects.toBeInstanceOf(
        IncompatibleDeviceError,
      )

      expect(mockedPrisma.terminal.count).toHaveBeenCalledWith({
        where: { venueId: 'venue-1', brand: { in: ['PAX'] }, status: 'ACTIVE' },
      })
    })

    it('resolves when venue has at least one ACTIVE PAX terminal (provider=BLUMON)', async () => {
      mockedPrisma.terminal.count.mockResolvedValue(3)

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'BLUMON')).resolves.toBeUndefined()
    })

    it('only counts ACTIVE terminals — INACTIVE/MAINTENANCE/RETIRED are ignored by the where clause', async () => {
      mockedPrisma.terminal.count.mockResolvedValue(0)

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY')).rejects.toBeInstanceOf(
        IncompatibleDeviceError,
      )

      // The query must filter status: 'ACTIVE' — anything else is excluded server-side
      const call = mockedPrisma.terminal.count.mock.calls[0][0]
      expect(call.where.status).toBe('ACTIVE')
    })

    it('is a no-op for unknown providers (no compat entry → skip DB query)', async () => {
      await expect(assertVenueHasCompatibleTerminal('venue-1', 'UNKNOWN_PROVIDER')).resolves.toBeUndefined()
      expect(mockedPrisma.terminal.count).not.toHaveBeenCalled()
    })

    it('includes provider code and required brand(s) in the error message', async () => {
      mockedPrisma.terminal.count.mockResolvedValue(0)

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY')).rejects.toThrow(/ANGELPAY/)
      mockedPrisma.terminal.count.mockResolvedValue(0)
      await expect(assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY')).rejects.toThrow(/NEXGO/)
    })

    it('accepts an optional transaction client (Tx) parameter for use inside prisma.$transaction()', async () => {
      const txMock = {
        terminal: { count: jest.fn().mockResolvedValue(1) },
      } as unknown as Parameters<typeof assertVenueHasCompatibleTerminal>[2]

      await expect(
        assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY', txMock),
      ).resolves.toBeUndefined()

      // Tx mock was used, default prisma client was NOT
      expect((txMock as any).terminal.count).toHaveBeenCalledTimes(1)
      expect(mockedPrisma.terminal.count).not.toHaveBeenCalled()
    })
  })
})
