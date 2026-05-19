/**
 * updateTerminal — terminal brand-change warning gate (validation point #3).
 *
 * Verifies that mutating `Terminal.brand` triggers `TerminalBrandChangeBlocked`
 * (HTTP 409, code `TERMINAL_BRAND_CHANGE_BLOCKED`) when any currently-assigned
 * merchant becomes incompatible with the new brand. The dashboard catches the
 * error, reads `details.incompatibleMerchants`, prompts the operator
 * ("These merchants will be unassigned. Continue?"), and on confirm re-issues
 * the PATCH with `forceUnassign: true` — which prunes the incompatible
 * merchants atomically with the brand change.
 *
 * Decision: throw vs. union-return. Chose throw so callers (e.g.
 * `updateTerminalForOrg`) keep the original `Terminal` return-type contract.
 *
 * Spec: §3.1 (point 2c), §4.4 (validation point #3)
 * Plan: Task 12
 */

import prisma from '@/utils/prismaClient'
import { updateTerminal } from '@/services/dashboard/terminals.superadmin.service'
import { TerminalBrandChangeBlocked } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => {
  const tx = {
    terminal: { update: jest.fn() },
  }
  return {
    __esModule: true,
    default: {
      terminal: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      merchantAccount: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  }
})

// Keep the real compatibility predicate so we exercise the actual catalog
// (BLUMON↔PAX, ANGELPAY↔NEXGO). Mock only the bulk-assign assert helper that
// Task 11 wires into the assignedMerchantIds path — irrelevant here.
jest.mock('@/lib/providerDeviceCompatibility', () => {
  const actual = jest.requireActual('@/lib/providerDeviceCompatibility')
  return {
    ...actual,
    assertMerchantsTerminalCompatible: jest.fn().mockResolvedValue(undefined),
  }
})

const mockedPrisma = prisma as unknown as {
  terminal: { findUnique: jest.Mock; update: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  $transaction: jest.Mock
  __tx: { terminal: { update: jest.Mock } }
}

describe('updateTerminal — brand-change warning guard (Task 12)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.terminal.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      ...data,
      venue: { id: 'venue-1', name: 'V', slug: 'v' },
    }))
    mockedPrisma.__tx.terminal.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      ...data,
      venue: { id: 'venue-1', name: 'V', slug: 'v' },
    }))
  })

  it('throws TerminalBrandChangeBlocked (no mutation) when changing NEXGO→PAX with an ANGELPAY merchant assigned and forceUnassign:false', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      brand: 'NEXGO',
      assignedMerchantIds: ['ma-angelpay-1'],
    })
    mockedPrisma.merchantAccount.findMany.mockResolvedValue([
      {
        id: 'ma-angelpay-1',
        displayName: 'AngelPay Merchant 1',
        externalMerchantId: 'ext-ap-1',
        provider: { code: 'ANGELPAY' },
      },
    ])

    let caught: unknown
    try {
      await updateTerminal('term-1', { brand: 'PAX' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TerminalBrandChangeBlocked)
    const err = caught as TerminalBrandChangeBlocked
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('TERMINAL_BRAND_CHANGE_BLOCKED')
    expect(err.details.incompatibleMerchants).toEqual([{ id: 'ma-angelpay-1', name: 'AngelPay Merchant 1', code: 'ANGELPAY' }])
    expect(mockedPrisma.terminal.update).not.toHaveBeenCalled()
    expect(mockedPrisma.__tx.terminal.update).not.toHaveBeenCalled()
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('changes brand AND prunes incompatible merchants atomically when forceUnassign:true', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      brand: 'NEXGO',
      assignedMerchantIds: ['ma-angelpay-1', 'ma-stripe-1'],
    })
    mockedPrisma.merchantAccount.findMany.mockResolvedValue([
      {
        id: 'ma-angelpay-1',
        displayName: 'AngelPay Merchant 1',
        externalMerchantId: 'ext-ap-1',
        provider: { code: 'ANGELPAY' },
      },
      {
        id: 'ma-stripe-1',
        displayName: 'Stripe Merchant 1',
        externalMerchantId: 'ext-st-1',
        provider: { code: 'STRIPE' },
      },
    ])

    await updateTerminal('term-1', { brand: 'PAX', forceUnassign: true })

    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockedPrisma.__tx.terminal.update).toHaveBeenCalledTimes(1)
    const updateArgs = mockedPrisma.__tx.terminal.update.mock.calls[0][0]
    expect(updateArgs.where).toEqual({ id: 'term-1' })
    expect(updateArgs.data.brand).toBe('PAX')
    // Incompatible ANGELPAY pruned, compatible STRIPE retained
    expect(updateArgs.data.assignedMerchantIds).toEqual(['ma-stripe-1'])
    // Non-transactional path NOT used
    expect(mockedPrisma.terminal.update).not.toHaveBeenCalled()
  })

  it('changes brand normally when all assigned merchants remain compatible (no warning)', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      brand: 'NEXGO',
      assignedMerchantIds: ['ma-stripe-1'],
    })
    mockedPrisma.merchantAccount.findMany.mockResolvedValue([
      {
        id: 'ma-stripe-1',
        displayName: 'Stripe Merchant 1',
        externalMerchantId: 'ext-st-1',
        provider: { code: 'STRIPE' },
      },
    ])

    await updateTerminal('term-1', { brand: 'PAX' })

    expect(mockedPrisma.terminal.update).toHaveBeenCalledTimes(1)
    expect(mockedPrisma.terminal.update.mock.calls[0][0].data.brand).toBe('PAX')
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('changes brand normally when terminal has no assigned merchants (no warning)', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      brand: 'NEXGO',
      assignedMerchantIds: [],
    })

    await updateTerminal('term-1', { brand: 'PAX' })

    expect(mockedPrisma.merchantAccount.findMany).not.toHaveBeenCalled()
    expect(mockedPrisma.terminal.update).toHaveBeenCalledTimes(1)
    expect(mockedPrisma.terminal.update.mock.calls[0][0].data.brand).toBe('PAX')
  })

  it('skips warning logic when brand is unchanged or omitted (no-op path)', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      brand: 'NEXGO',
      assignedMerchantIds: ['ma-angelpay-1'],
    })

    // brand omitted entirely — pure name update
    await updateTerminal('term-1', { name: 'Renamed Terminal' })
    expect(mockedPrisma.merchantAccount.findMany).not.toHaveBeenCalled()
    expect(mockedPrisma.terminal.update).toHaveBeenCalledTimes(1)

    // brand explicitly equal to current — compat scan must not run
    jest.clearAllMocks()
    mockedPrisma.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      brand: 'NEXGO',
      assignedMerchantIds: ['ma-angelpay-1'],
    })
    mockedPrisma.terminal.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      ...data,
      venue: { id: 'venue-1', name: 'V', slug: 'v' },
    }))

    await updateTerminal('term-1', { brand: 'NEXGO' })
    expect(mockedPrisma.merchantAccount.findMany).not.toHaveBeenCalled()
    expect(mockedPrisma.terminal.update).toHaveBeenCalledTimes(1)
  })
})
