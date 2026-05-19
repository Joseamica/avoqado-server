/**
 * updateTerminal — device-compatibility gate (validation point #2).
 *
 * Verifies the wiring of `assertMerchantsTerminalCompatible` (Task 11) into
 * the terminal update path so that a mutation of `Terminal.assignedMerchantIds`
 * is rejected when any merchant's provider is incompatible with the terminal's
 * brand (e.g. ANGELPAY merchant → PAX terminal, BLUMON merchant → NEXGO).
 *
 * Spec: §3.1 (point 2b), §4.4 (point #2)
 * Plan: Task 11
 */

import prisma from '@/utils/prismaClient'
import { updateTerminal } from '@/services/dashboard/terminals.superadmin.service'
import { assertMerchantsTerminalCompatible } from '@/lib/providerDeviceCompatibility'
import { IncompatibleDeviceError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    merchantAccount: {
      findMany: jest.fn(),
    },
  },
}))

jest.mock('@/lib/providerDeviceCompatibility', () => {
  const actual = jest.requireActual('@/lib/providerDeviceCompatibility')
  return {
    ...actual,
    assertMerchantsTerminalCompatible: jest.fn(),
  }
})

const mockedPrisma = prisma as unknown as {
  terminal: { findUnique: jest.Mock; update: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
}

const mockedAssert = assertMerchantsTerminalCompatible as jest.Mock

describe('updateTerminal — device compatibility guard (Task 11)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAssert.mockResolvedValue(undefined)
    mockedPrisma.terminal.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      ...data,
      venue: { id: 'venue-1', name: 'V', slug: 'v' },
    }))
    // Default: all requested merchants exist (validates merchant count plumbing)
    mockedPrisma.merchantAccount.findMany.mockImplementation(async ({ where }) => {
      const ids = where.id.in as string[]
      return ids.map(id => ({ id, displayName: `Merchant ${id}` }))
    })
  })

  it('rejects ANGELPAY merchant when terminal.brand is PAX', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({ id: 'term-pax', brand: 'PAX' })
    mockedAssert.mockRejectedValue(
      new IncompatibleDeviceError('Cannot assign incompatible merchants to PAX terminal term-pax: ma-angelpay (ANGELPAY)'),
    )

    await expect(updateTerminal('term-pax', { assignedMerchantIds: ['ma-angelpay'] })).rejects.toThrow(IncompatibleDeviceError)

    expect(mockedAssert).toHaveBeenCalledWith('term-pax', ['ma-angelpay'])
    expect(mockedPrisma.terminal.update).not.toHaveBeenCalled()
  })

  it('accepts ANGELPAY merchant when terminal.brand is NEXGO', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({ id: 'term-nexgo', brand: 'NEXGO' })

    await updateTerminal('term-nexgo', { assignedMerchantIds: ['ma-angelpay'] })

    expect(mockedAssert).toHaveBeenCalledWith('term-nexgo', ['ma-angelpay'])
    expect(mockedPrisma.terminal.update).toHaveBeenCalledTimes(1)
    expect(mockedPrisma.terminal.update.mock.calls[0][0].data.assignedMerchantIds).toEqual(['ma-angelpay'])
  })

  it('accepts BLUMON merchant when terminal.brand is PAX (regression guard)', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({ id: 'term-pax', brand: 'PAX' })

    await updateTerminal('term-pax', { assignedMerchantIds: ['ma-blumon'] })

    expect(mockedAssert).toHaveBeenCalledWith('term-pax', ['ma-blumon'])
    expect(mockedPrisma.terminal.update).toHaveBeenCalledTimes(1)
  })

  it('accepts unconstrained provider merchant (e.g. STRIPE/MENTA) regardless of brand', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({ id: 'term-pax', brand: 'PAX' })
    // assertMerchantsTerminalCompatible is a no-op for unconstrained providers — mock as resolved.

    await updateTerminal('term-pax', { assignedMerchantIds: ['ma-stripe'] })

    expect(mockedAssert).toHaveBeenCalledWith('term-pax', ['ma-stripe'])
    expect(mockedPrisma.terminal.update).toHaveBeenCalledTimes(1)
  })

  it('accepts any provider when terminal.brand is null (PENDING_ACTIVATION terminal)', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({ id: 'term-pending', brand: null })

    await updateTerminal('term-pending', { assignedMerchantIds: ['ma-angelpay', 'ma-blumon'] })

    expect(mockedAssert).toHaveBeenCalledWith('term-pending', ['ma-angelpay', 'ma-blumon'])
    expect(mockedPrisma.terminal.update).toHaveBeenCalledTimes(1)
  })
})
