/**
 * AngelPayUserAccountService tests (D3 lifecycle).
 *
 * Mocks @/utils/prismaClient (matches the convention used by every other
 * mocked-Prisma unit test in this repo).
 *
 * Spec: §3.2, §4.1, §18.2
 */

import prisma from '@/utils/prismaClient'
import {
  createAngelPayUserAccount,
  setAngelPayUserAccountPin,
  markAngelPayUserAccountRotationRequired,
  suspendAngelPayUserAccount,
  softDeleteAngelPayUserAccount,
  markAngelPayUserAccountValidated,
  recordAngelPayUserAccountError,
  getAngelPayUserAccountForTerminal,
} from '@/services/superadmin/angelpayUserAccount.service'
import { ValidationError, ConflictError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    angelPayUserAccount: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    terminal: {
      findUnique: jest.fn(),
    },
  },
}))

// Mock the encryptCredentials helper so we don't depend on env vars
jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  encryptCredentials: jest.fn((plaintext: string) => ({
    encrypted: `enc(${plaintext})`,
    iv: 'iv-hex',
  })),
}))

const mockedPrisma = prisma as unknown as {
  angelPayUserAccount: {
    findUnique: jest.Mock
    create: jest.Mock
    update: jest.Mock
  }
  terminal: { findUnique: jest.Mock }
}

describe('AngelPayUserAccountService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ============================================================
  // create()
  // ============================================================

  describe('create()', () => {
    it('rejects PIN that is not 6 numeric digits', async () => {
      mockedPrisma.angelPayUserAccount.findUnique.mockResolvedValue(null)

      await expect(
        createAngelPayUserAccount({
          venueId: 'venue-1',
          email: 'ops@avoqado.io',
          pin: 'abc123',
          environment: 'QA',
        }),
      ).rejects.toThrow(ValidationError)

      await expect(
        createAngelPayUserAccount({
          venueId: 'venue-1',
          email: 'ops@avoqado.io',
          pin: '12345',
          environment: 'QA',
        }),
      ).rejects.toThrow(ValidationError)

      await expect(
        createAngelPayUserAccount({
          venueId: 'venue-1',
          email: 'ops@avoqado.io',
          pin: '1234567',
          environment: 'QA',
        }),
      ).rejects.toThrow(ValidationError)

      expect(mockedPrisma.angelPayUserAccount.create).not.toHaveBeenCalled()
    })

    it('rejects invalid email', async () => {
      mockedPrisma.angelPayUserAccount.findUnique.mockResolvedValue(null)

      await expect(
        createAngelPayUserAccount({
          venueId: 'venue-1',
          email: 'not-an-email',
          environment: 'QA',
        }),
      ).rejects.toThrow(ValidationError)

      expect(mockedPrisma.angelPayUserAccount.create).not.toHaveBeenCalled()
    })

    it('with no PIN → status PENDING_PIN, pin=null', async () => {
      mockedPrisma.angelPayUserAccount.findUnique.mockResolvedValue(null)
      mockedPrisma.angelPayUserAccount.create.mockImplementation(({ data }: any) => ({ id: 'a1', ...data }))

      const result = await createAngelPayUserAccount({
        venueId: 'venue-1',
        email: 'ops@avoqado.io',
        environment: 'QA',
      })

      expect(mockedPrisma.angelPayUserAccount.create).toHaveBeenCalledTimes(1)
      const createArg = mockedPrisma.angelPayUserAccount.create.mock.calls[0][0]
      expect(createArg.data.status).toBe('PENDING_PIN')
      // Plaintext PIN: null when no PIN provisioned yet (status=PENDING_PIN).
      // See spec 2026-05-21-angelpay-merchant-wizard §6.1.
      expect(createArg.data.pin).toBeNull()
      expect(createArg.data.venueId).toBe('venue-1')
      expect(createArg.data.email).toBe('ops@avoqado.io')
      expect(createArg.data.environment).toBe('QA')
      expect(result.status).toBe('PENDING_PIN')
    })

    it('with valid PIN → status ACTIVE, pin stored plaintext', async () => {
      mockedPrisma.angelPayUserAccount.findUnique.mockResolvedValue(null)
      mockedPrisma.angelPayUserAccount.create.mockImplementation(({ data }: any) => ({ id: 'a1', ...data }))

      const result = await createAngelPayUserAccount({
        venueId: 'venue-1',
        email: 'ops@avoqado.io',
        pin: '123456',
        environment: 'QA',
        createdBy: 'staff-1',
      })

      const createArg = mockedPrisma.angelPayUserAccount.create.mock.calls[0][0]
      expect(createArg.data.status).toBe('ACTIVE')
      // Plaintext PIN by decision (spec 2026-05-21-angelpay-merchant-wizard §6.1).
      // The legacy encrypted `pinEncrypted` column is preserved for backwards
      // compat (read fallback in terminal.tpv.controller), but new writes go to `pin`.
      expect(createArg.data.pin).toBe('123456')
      expect(createArg.data.createdBy).toBe('staff-1')
      expect(createArg.data.statusChangedBy).toBe('staff-1')
      expect(result.status).toBe('ACTIVE')
    })

    it('rejects when venue already has an account → ConflictError', async () => {
      mockedPrisma.angelPayUserAccount.findUnique.mockResolvedValue({ id: 'existing', venueId: 'venue-1' })

      await expect(
        createAngelPayUserAccount({
          venueId: 'venue-1',
          email: 'ops@avoqado.io',
          environment: 'QA',
        }),
      ).rejects.toThrow(ConflictError)

      expect(mockedPrisma.angelPayUserAccount.create).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // setPin()
  // ============================================================

  describe('setPin()', () => {
    it('rejects non-6-digit PIN', async () => {
      await expect(setAngelPayUserAccountPin('a1', 'abc123')).rejects.toThrow(ValidationError)
      await expect(setAngelPayUserAccountPin('a1', '12345')).rejects.toThrow(ValidationError)
      expect(mockedPrisma.angelPayUserAccount.update).not.toHaveBeenCalled()
    })

    it('transitions PENDING_PIN → ACTIVE + clears lastValidationErr', async () => {
      mockedPrisma.angelPayUserAccount.update.mockImplementation(({ data }: any) => ({ id: 'a1', ...data }))

      await setAngelPayUserAccountPin('a1', '654321')

      const updateArg = mockedPrisma.angelPayUserAccount.update.mock.calls[0][0]
      expect(updateArg.where).toEqual({ id: 'a1' })
      expect(updateArg.data.status).toBe('ACTIVE')
      // Plaintext PIN by decision (spec 2026-05-21-angelpay-merchant-wizard §6.1).
      expect(updateArg.data.pin).toBe('654321')
      expect(updateArg.data.lastValidationErr).toBeNull()
      expect(updateArg.data.statusReason).toBeNull()
      expect(updateArg.data.statusChangedAt).toBeInstanceOf(Date)
    })
  })

  // ============================================================
  // markRotationRequired()
  // ============================================================

  describe('markRotationRequired()', () => {
    it('sets status + reason + changedBy', async () => {
      mockedPrisma.angelPayUserAccount.update.mockImplementation(({ data }: any) => ({ id: 'a1', ...data }))

      await markAngelPayUserAccountRotationRequired('a1', 'quarterly rotation', 'staff-7')

      const updateArg = mockedPrisma.angelPayUserAccount.update.mock.calls[0][0]
      expect(updateArg.where).toEqual({ id: 'a1' })
      expect(updateArg.data.status).toBe('PIN_ROTATION_REQUIRED')
      expect(updateArg.data.statusReason).toBe('quarterly rotation')
      expect(updateArg.data.statusChangedBy).toBe('staff-7')
      expect(updateArg.data.statusChangedAt).toBeInstanceOf(Date)
    })
  })

  // ============================================================
  // suspend()
  // ============================================================

  describe('suspend()', () => {
    it('sets status=SUSPENDED + reason + changedBy', async () => {
      mockedPrisma.angelPayUserAccount.update.mockImplementation(({ data }: any) => ({ id: 'a1', ...data }))

      await suspendAngelPayUserAccount('a1', 'fraud detection', 'staff-7')

      const updateArg = mockedPrisma.angelPayUserAccount.update.mock.calls[0][0]
      expect(updateArg.data.status).toBe('SUSPENDED')
      expect(updateArg.data.statusReason).toBe('fraud detection')
      expect(updateArg.data.statusChangedBy).toBe('staff-7')
    })
  })

  // ============================================================
  // softDelete()
  // ============================================================

  describe('softDelete()', () => {
    it('sets status=DELETED', async () => {
      mockedPrisma.angelPayUserAccount.update.mockImplementation(({ data }: any) => ({ id: 'a1', ...data }))

      await softDeleteAngelPayUserAccount('a1', 'staff-7')

      const updateArg = mockedPrisma.angelPayUserAccount.update.mock.calls[0][0]
      expect(updateArg.data.status).toBe('DELETED')
      expect(updateArg.data.statusChangedBy).toBe('staff-7')
    })
  })

  // ============================================================
  // markValidated()
  // ============================================================

  describe('markValidated()', () => {
    it('updates lastValidatedAt + externalUserId + clears lastValidationErr', async () => {
      mockedPrisma.angelPayUserAccount.update.mockImplementation(({ data }: any) => ({ id: 'a1', ...data }))

      await markAngelPayUserAccountValidated('a1', 42)

      const updateArg = mockedPrisma.angelPayUserAccount.update.mock.calls[0][0]
      expect(updateArg.where).toEqual({ id: 'a1' })
      expect(updateArg.data.externalUserId).toBe(42)
      expect(updateArg.data.lastValidationErr).toBeNull()
      expect(updateArg.data.lastValidatedAt).toBeInstanceOf(Date)
      expect(updateArg.data.status).toBeUndefined()
    })
  })

  // ============================================================
  // recordError()
  // ============================================================

  describe('recordError()', () => {
    it('updates lastValidationErr; does NOT change status', async () => {
      mockedPrisma.angelPayUserAccount.update.mockImplementation(({ data }: any) => ({ id: 'a1', ...data }))

      await recordAngelPayUserAccountError('a1', 'PIN rejected by SDK')

      const updateArg = mockedPrisma.angelPayUserAccount.update.mock.calls[0][0]
      expect(updateArg.where).toEqual({ id: 'a1' })
      expect(updateArg.data).toEqual({ lastValidationErr: 'PIN rejected by SDK' })
      expect(updateArg.data.status).toBeUndefined()
    })
  })

  // ============================================================
  // getForTerminal()
  // ============================================================

  describe('getForTerminal()', () => {
    it('returns account via terminal→venue join', async () => {
      const account = { id: 'a1', venueId: 'venue-1', email: 'ops@avoqado.io', status: 'ACTIVE' }
      // Multi-account per venue (2026-05-18): the relation changed from
      // `venue.angelpayUserAccount` (singular) to `venue.angelpayUserAccounts`
      // (plural array). The service preserves single-account contract by
      // selecting the oldest non-DELETED row (take: 1, order createdAt asc).
      mockedPrisma.terminal.findUnique.mockResolvedValue({
        id: 'term-1',
        serialNumber: 'NEXGO-001',
        venue: { id: 'venue-1', angelpayUserAccounts: [account] },
      })

      const result = await getAngelPayUserAccountForTerminal('NEXGO-001')

      expect(result).toEqual(account)
      expect(mockedPrisma.terminal.findUnique).toHaveBeenCalledWith({
        where: { serialNumber: 'NEXGO-001' },
        include: {
          venue: {
            include: {
              angelpayUserAccounts: {
                where: { status: { not: 'DELETED' } },
                orderBy: { createdAt: 'asc' },
                take: 1,
              },
            },
          },
        },
      })
    })

    it('returns null if terminal missing', async () => {
      mockedPrisma.terminal.findUnique.mockResolvedValue(null)

      const result = await getAngelPayUserAccountForTerminal('NEXGO-missing')

      expect(result).toBeNull()
    })
  })
})
