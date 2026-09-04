/**
 * Regression: a delayed TPV evidence request must not mutate a SaleVerification
 * after the reassignment job moved its Payment from venue A to venue B.
 *
 * `TEST_DATABASE_URL` is intentionally not used here. This is a deterministic
 * stateful interleaving, not a two-session PostgreSQL integration test.
 */

import {
  createOrUpdateProofOfSale,
  createPendingSaleVerification,
  createSaleVerification,
  updateVerificationStatus,
} from '@/services/tpv/sale-verification.service'
import { moduleService } from '@/services/modules/module.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findFirst: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    saleVerification: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'
const PAYMENT_ID = 'payment-1'
const VERIFICATION_ID = 'verification-1'
const STAFF_ID = 'staff-1'
const NOW = new Date('2026-09-04T12:00:00.000Z')

type AuthorityState = {
  paymentVenueId: string
  verificationVenueId: string
}

const completeVerification = (overrides: Record<string, unknown> = {}) => ({
  id: VERIFICATION_ID,
  venueId: VENUE_A,
  paymentId: PAYMENT_ID,
  staffId: STAFF_ID,
  photos: [],
  scannedProducts: [],
  status: 'PENDING',
  inventoryDeducted: false,
  isPortabilidad: false,
  serialNumbers: [],
  deviceId: null,
  notes: null,
  reviewedById: null,
  reviewedAt: null,
  reviewNotes: null,
  rejectionReasons: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
})

function sqlText(query: any): string {
  if (Array.isArray(query?.strings)) return query.strings.join('?')
  if (typeof query?.sql === 'string') return query.sql
  return String(query)
}

function installStatefulTransaction(options: {
  state: AuthorityState
  mutations: string[]
  moveBeforeLock?: boolean
  existingVerification?: ReturnType<typeof completeVerification> | null
}) {
  const lockEvents: Array<{ kind: 'payment' | 'verification'; values: unknown[] }> = []
  const tx = {
    $queryRaw: jest.fn(async (query: any) => {
      const text = sqlText(query)
      const values = Array.isArray(query?.values) ? query.values : []
      if (text.includes('FROM "Payment"')) {
        lockEvents.push({ kind: 'payment', values })
        return options.state.paymentVenueId === VENUE_A ? [{ id: PAYMENT_ID, venueId: VENUE_A }] : []
      }
      if (text.includes('FROM "SaleVerification"')) {
        lockEvents.push({ kind: 'verification', values })
        const existing = options.existingVerification
        return existing && options.state.verificationVenueId === VENUE_A ? [existing] : []
      }
      throw new Error(`Unexpected lock query: ${text}`)
    }),
    saleVerification: {
      create: jest.fn(async ({ data }: any) => {
        options.mutations.push('tx:create')
        return completeVerification(data)
      }),
      update: jest.fn(async ({ data }: any) => {
        options.mutations.push('tx:update')
        return completeVerification(data)
      }),
    },
  }

  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: (client: typeof tx) => unknown) => {
    if (options.moveBeforeLock) {
      options.state.paymentVenueId = VENUE_B
      options.state.verificationVenueId = VENUE_B
    }
    return callback(tx)
  })

  return { tx, lockEvents }
}

describe('SaleVerification authority during Payment venue reassignment', () => {
  let mutations: string[]

  beforeEach(() => {
    jest.resetAllMocks()
    mutations = []
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'staff-venue-1', staffId: STAFF_ID, venueId: VENUE_A })
    ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValue(true)
    ;(prisma.saleVerification.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      mutations.push('root:create')
      return completeVerification(data)
    })
    ;(prisma.saleVerification.update as jest.Mock).mockImplementation(async ({ data }: any) => {
      mutations.push('root:update')
      return completeVerification(data)
    })
  })

  it('preserves the existing duplicate-create fast-fail before staff/module work', async () => {
    const existing = completeVerification()
    ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue({
      id: PAYMENT_ID,
      venueId: VENUE_A,
      saleVerification: existing,
    })

    await expect(
      createSaleVerification(VENUE_A, {
        paymentId: PAYMENT_ID,
        staffId: STAFF_ID,
        photos: ['https://example.test/proof.jpg'],
        scannedProducts: [],
      }),
    ).rejects.toThrow(/verification already exists/i)

    expect(prisma.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(moduleService.isModuleEnabled).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects createSaleVerification when the Payment moved A→B before the transactional lock', async () => {
    const state = { paymentVenueId: VENUE_A, verificationVenueId: VENUE_A }
    ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue({ id: PAYMENT_ID, venueId: VENUE_A, saleVerification: null })
    installStatefulTransaction({ state, mutations, moveBeforeLock: true, existingVerification: null })

    await expect(
      createSaleVerification(VENUE_A, {
        paymentId: PAYMENT_ID,
        staffId: STAFF_ID,
        photos: ['https://example.test/proof.jpg'],
        scannedProducts: [],
      }),
    ).rejects.toThrow(/payment.+not found.+venue/i)

    expect(state).toEqual({ paymentVenueId: VENUE_B, verificationVenueId: VENUE_B })
    expect(mutations).toEqual([])
  })

  it('rejects updateVerificationStatus when the Payment and verification moved A→B before locks', async () => {
    const state = { paymentVenueId: VENUE_A, verificationVenueId: VENUE_A }
    const existing = completeVerification()
    ;(prisma.saleVerification.findFirst as jest.Mock).mockResolvedValue(existing)
    installStatefulTransaction({ state, mutations, moveBeforeLock: true, existingVerification: existing })

    await expect(updateVerificationStatus(VENUE_A, VERIFICATION_ID, 'COMPLETED', true)).rejects.toThrow(/payment.+not found.+venue/i)

    expect(state).toEqual({ paymentVenueId: VENUE_B, verificationVenueId: VENUE_B })
    expect(mutations).toEqual([])
  })

  it('rejects createPendingSaleVerification when its Payment no longer belongs to the requested venue', async () => {
    const state = { paymentVenueId: VENUE_A, verificationVenueId: VENUE_A }
    installStatefulTransaction({ state, mutations, moveBeforeLock: true, existingVerification: null })

    await expect(
      createPendingSaleVerification({
        venueId: VENUE_A,
        paymentId: PAYMENT_ID,
        staffId: STAFF_ID,
        isPortabilidad: false,
        serialNumbers: ['8952000000000000000F'],
        scannedProducts: [],
      }),
    ).rejects.toThrow(/payment.+not found.+venue/i)

    expect(state).toEqual({ paymentVenueId: VENUE_B, verificationVenueId: VENUE_B })
    expect(mutations).toEqual([])
  })

  it('rejects the proof update path when a stale A request reaches locks after the A→B job', async () => {
    const state = { paymentVenueId: VENUE_A, verificationVenueId: VENUE_A }
    const existing = completeVerification()
    ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue({
      id: PAYMENT_ID,
      venueId: VENUE_A,
      saleVerification: existing,
    })
    installStatefulTransaction({ state, mutations, moveBeforeLock: true, existingVerification: existing })

    await expect(
      createOrUpdateProofOfSale(VENUE_A, PAYMENT_ID, ['https://example.test/new-proof.jpg'], STAFF_ID, VERIFICATION_ID),
    ).rejects.toThrow(/payment.+not found.+venue/i)

    expect(state).toEqual({ paymentVenueId: VENUE_B, verificationVenueId: VENUE_B })
    expect(mutations).toEqual([])
  })

  it('rejects the legacy proof create path when a stale A request reaches locks after the A→B job', async () => {
    const state = { paymentVenueId: VENUE_A, verificationVenueId: VENUE_A }
    ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue({ id: PAYMENT_ID, venueId: VENUE_A, saleVerification: null })
    installStatefulTransaction({ state, mutations, moveBeforeLock: true, existingVerification: null })

    await expect(createOrUpdateProofOfSale(VENUE_A, PAYMENT_ID, ['https://example.test/proof.jpg'], STAFF_ID)).rejects.toThrow(
      /payment.+not found.+venue/i,
    )

    expect(state).toEqual({ paymentVenueId: VENUE_B, verificationVenueId: VENUE_B })
    expect(mutations).toEqual([])
  })

  it('locks Payment before SaleVerification and applies a tenant/payment-scoped status update', async () => {
    const state = { paymentVenueId: VENUE_A, verificationVenueId: VENUE_A }
    const existing = completeVerification()
    ;(prisma.saleVerification.findFirst as jest.Mock).mockResolvedValue(existing)
    const { tx, lockEvents } = installStatefulTransaction({ state, mutations, existingVerification: existing })

    const result = await updateVerificationStatus(VENUE_A, VERIFICATION_ID, 'COMPLETED', true)

    expect(result.status).toBe('COMPLETED')
    expect(lockEvents.map(event => event.kind)).toEqual(['payment', 'verification'])
    expect(lockEvents[0].values).toEqual(expect.arrayContaining([PAYMENT_ID, VENUE_A]))
    expect(lockEvents[1].values).toEqual(expect.arrayContaining([VERIFICATION_ID, PAYMENT_ID, VENUE_A]))
    expect(tx.saleVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: VERIFICATION_ID, paymentId: PAYMENT_ID, venueId: VENUE_A }),
      }),
    )
    expect(mutations).toEqual(['tx:update'])
  })
})
