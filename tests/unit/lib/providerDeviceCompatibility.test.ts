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
  assertAngelPayLoginsInVenue,
  assertMerchantsTerminalCompatible,
  assertNuevaLlaveEnLosNegociosDelComercio,
  ANGELPAY_LOGIN_EN_OTRO_NEGOCIO,
} from '@/lib/providerDeviceCompatibility'
import { ConflictError, IncompatibleDeviceError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: {
      count: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    merchantAccount: {
      findMany: jest.fn(),
    },
    angelPayUserAccount: { findUnique: jest.fn() },
    venuePaymentConfig: { findFirst: jest.fn() },
  },
}))

const mockedPrisma = prisma as unknown as {
  terminal: { count: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  angelPayUserAccount: { findUnique: jest.Mock }
  venuePaymentConfig: { findFirst: jest.Mock }
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

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY')).rejects.toBeInstanceOf(IncompatibleDeviceError)

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

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'BLUMON')).rejects.toBeInstanceOf(IncompatibleDeviceError)

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

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY')).rejects.toBeInstanceOf(IncompatibleDeviceError)

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

      await expect(assertVenueHasCompatibleTerminal('venue-1', 'ANGELPAY', txMock)).resolves.toBeUndefined()

      // Tx mock was used, default prisma client was NOT
      expect((txMock as any).terminal.count).toHaveBeenCalledTimes(1)
      expect(mockedPrisma.terminal.count).not.toHaveBeenCalled()
    })
  })

  // IQ, 20-oct-2026: a la Nexgo de IQ se le asignó el comercio «IQ T», cuya llave de AngelPay seguía en Amaena. El panel
  // dijo «guardado» y la terminal no podía cobrar («Faltan credenciales de AngelPay»).
  describe('assertAngelPayLoginsInVenue()', () => {
    const ajeno = {
      id: 'ma-iq-t',
      displayName: 'IQ T',
      externalMerchantId: '1416',
      angelpayUserAccount: { venue: { name: 'Amaena' } },
    }

    it('rechaza un comercio cuya llave de AngelPay es de otro negocio, nombrando el comercio y el negocio', async () => {
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([ajeno])

      const intento = assertAngelPayLoginsInVenue('venue-iq', ['ma-iq-t'])

      await expect(intento).rejects.toBeInstanceOf(ConflictError)
      await expect(intento).rejects.toMatchObject({ code: ANGELPAY_LOGIN_EN_OTRO_NEGOCIO, statusCode: 409 })
      await expect(intento).rejects.toThrow(/IQ T.*Amaena.*IA/)
      expect(mockedPrisma.merchantAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['ma-iq-t'] }, angelpayUserAccount: { venueId: { not: 'venue-iq' } } },
          take: 1,
        }),
      )
    })

    it('deja pasar cuando todas las llaves son del negocio (o el comercio no es de AngelPay)', async () => {
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([])

      await expect(assertAngelPayLoginsInVenue('venue-iq', ['ma-1', 'ma-2'])).resolves.toBeUndefined()
    })

    it('no consulta nada sin comercios (ignora vacíos y repetidos)', async () => {
      await expect(assertAngelPayLoginsInVenue('venue-iq', [])).resolves.toBeUndefined()
      await expect(assertAngelPayLoginsInVenue('venue-iq', [null, undefined])).resolves.toBeUndefined()
      expect(mockedPrisma.merchantAccount.findMany).not.toHaveBeenCalled()

      mockedPrisma.merchantAccount.findMany.mockResolvedValue([])
      await assertAngelPayLoginsInVenue('venue-iq', ['ma-1', 'ma-1'])
      expect(mockedPrisma.merchantAccount.findMany.mock.calls[0][0].where.id.in).toEqual(['ma-1'])
    })
  })

  describe('assertMerchantsTerminalCompatible() — llave de AngelPay del negocio', () => {
    beforeEach(() => {
      mockedPrisma.terminal.findUnique.mockResolvedValue({ id: 't-1', brand: 'NEXGO', venueId: 'venue-iq' })
    })

    it('compara contra el negocio actual de la terminal por default', async () => {
      mockedPrisma.merchantAccount.findMany
        .mockResolvedValueOnce([{ id: 'ma-iq-t', provider: { code: 'ANGELPAY' } }])
        .mockResolvedValueOnce([
          { id: 'ma-iq-t', displayName: 'IQ T', externalMerchantId: '1416', angelpayUserAccount: { venue: { name: 'Amaena' } } },
        ])

      await expect(assertMerchantsTerminalCompatible('t-1', ['ma-iq-t'])).rejects.toMatchObject({ code: ANGELPAY_LOGIN_EN_OTRO_NEGOCIO })
      expect(mockedPrisma.merchantAccount.findMany.mock.calls[1][0].where.angelpayUserAccount).toEqual({ venueId: { not: 'venue-iq' } })
    })

    it('en una migración compara contra el negocio DESTINO, no el actual', async () => {
      mockedPrisma.merchantAccount.findMany
        .mockResolvedValueOnce([{ id: 'ma-1', provider: { code: 'ANGELPAY' } }])
        .mockResolvedValueOnce([])

      await expect(assertMerchantsTerminalCompatible('t-1', ['ma-1'], undefined, 'venue-destino')).resolves.toBeUndefined()
      expect(mockedPrisma.merchantAccount.findMany.mock.calls[1][0].where.angelpayUserAccount).toEqual({
        venueId: { not: 'venue-destino' },
      })
    })
  })

  describe('assertNuevaLlaveEnLosNegociosDelComercio()', () => {
    beforeEach(() => {
      mockedPrisma.angelPayUserAccount.findUnique.mockResolvedValue({ venueId: 'venue-amaena', venue: { name: 'Amaena' } })
      mockedPrisma.terminal.findFirst.mockResolvedValue(null)
      mockedPrisma.venuePaymentConfig.findFirst.mockResolvedValue(null)
    })

    it('rechaza cambiar a una llave de otro negocio si el comercio ya cobra en una terminal', async () => {
      mockedPrisma.terminal.findFirst.mockResolvedValue({ venue: { name: 'IQ' } })

      const intento = assertNuevaLlaveEnLosNegociosDelComercio('ma-iq-t', 'login-amaena')

      await expect(intento).rejects.toMatchObject({ code: ANGELPAY_LOGIN_EN_OTRO_NEGOCIO })
      await expect(intento).rejects.toThrow(/IQ.*Amaena.*IA/)
      expect(mockedPrisma.terminal.findFirst.mock.calls[0][0].where).toEqual({
        assignedMerchantIds: { has: 'ma-iq-t' },
        venueId: { not: 'venue-amaena' },
      })
    })

    it('rechaza si el comercio es cuenta de otro negocio aunque ninguna terminal lo tenga', async () => {
      mockedPrisma.venuePaymentConfig.findFirst.mockResolvedValue({ venue: { name: 'IQ' } })

      await expect(assertNuevaLlaveEnLosNegociosDelComercio('ma-iq-t', 'login-amaena')).rejects.toBeInstanceOf(ConflictError)
    })

    it('deja pasar si el comercio no cobra en otro negocio, o si la llave no existe (la rechaza la base)', async () => {
      await expect(assertNuevaLlaveEnLosNegociosDelComercio('ma-iq-t', 'login-amaena')).resolves.toBeUndefined()

      mockedPrisma.angelPayUserAccount.findUnique.mockResolvedValue(null)
      await expect(assertNuevaLlaveEnLosNegociosDelComercio('ma-iq-t', 'no-existe')).resolves.toBeUndefined()
    })
  })
})
