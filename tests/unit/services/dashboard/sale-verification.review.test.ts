/**
 * Sale Verification Back-Office Review Service Tests
 *
 * Covers the PlayTelecom / Walmart documentation-review flow:
 *   - APPROVE on a PENDING verification → COMPLETED
 *   - REJECT with reasons → FAILED, rejectionReasons stored
 *   - Validation: rejection requires reason or notes
 *   - Idempotency / safety: cannot re-review COMPLETED or FAILED
 *   - Tenant isolation: 403 when verification belongs to another venue
 *   - 404 when verification id doesn't exist
 *   - Socket emit is best-effort and never throws
 */

import { reviewSaleVerification } from '@/services/dashboard/sale-verification.dashboard.service'
import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets'
import { SocketEventType } from '@/communication/sockets/types'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    saleVerification: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    broadcastToUser: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const mockedFindUnique = prisma.saleVerification.findUnique as jest.Mock
const mockedUpdate = prisma.saleVerification.update as jest.Mock
const mockedBroadcast = socketManager.broadcastToUser as jest.Mock

const VENUE_ID = 'venue-1'
const STAFF_ID = 'staff-promoter-1'
const REVIEWER_ID = 'staff-admin-1'
const VERIFICATION_ID = 'sv-1'

const baseExisting = {
  id: VERIFICATION_ID,
  venueId: VENUE_ID,
  staffId: STAFF_ID,
  paymentId: 'pay-1',
  status: 'PENDING' as const,
}

function buildUpdatedRow(overrides: Record<string, any> = {}) {
  return {
    id: VERIFICATION_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    paymentId: 'pay-1',
    photos: ['photo1.jpg'],
    scannedProducts: [],
    status: 'COMPLETED',
    inventoryDeducted: false,
    deviceId: null,
    notes: null,
    createdAt: new Date('2026-04-29T10:00:00Z'),
    updatedAt: new Date('2026-04-30T18:00:00Z'),
    reviewedById: REVIEWER_ID,
    reviewedAt: new Date('2026-04-30T18:00:00Z'),
    reviewNotes: null,
    rejectionReasons: [],
    reviewedBy: { id: REVIEWER_ID, firstName: 'Ada', lastName: 'Lovelace' },
    staff: { id: STAFF_ID, firstName: 'Bob', lastName: 'Promoter', email: 'b@x.com', photoUrl: null },
    payment: {
      id: 'pay-1',
      amount: 100,
      status: 'COMPLETED',
      createdAt: new Date('2026-04-29T10:00:00Z'),
      order: { id: 'ord-1', orderNumber: 'SN0001', total: 100, tags: [] },
    },
    ...overrides,
  }
}

describe('reviewSaleVerification', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('marks verification COMPLETED on APPROVE and emits socket event', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(buildUpdatedRow())

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'APPROVE',
    })

    expect(result.status).toBe('COMPLETED')
    expect(result.reviewedById).toBe(REVIEWER_ID)
    expect(result.rejectionReasons).toEqual([])

    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          status: 'COMPLETED',
          reviewedById: REVIEWER_ID,
          rejectionReasons: [],
        }),
      }),
    )

    expect(mockedBroadcast).toHaveBeenCalledWith(
      STAFF_ID,
      SocketEventType.SALE_VERIFICATION_REVIEWED,
      expect.objectContaining({
        saleVerificationId: VERIFICATION_ID,
        status: 'COMPLETED',
        reviewedBy: 'Ada Lovelace',
      }),
    )
  })

  it('marks verification FAILED on REJECT and stores rejection reasons + notes', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(
      buildUpdatedRow({
        status: 'FAILED',
        reviewNotes: 'Falta foto de portabilidad legible',
        rejectionReasons: ['REVIEW_PORTABILIDAD'],
      }),
    )

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'REJECT',
      rejectionReasons: ['REVIEW_PORTABILIDAD'],
      reviewNotes: '  Falta foto de portabilidad legible  ',
    })

    expect(result.status).toBe('FAILED')
    expect(result.rejectionReasons).toEqual(['REVIEW_PORTABILIDAD'])
    expect(result.reviewNotes).toBe('Falta foto de portabilidad legible')

    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          rejectionReasons: ['REVIEW_PORTABILIDAD'],
          reviewNotes: 'Falta foto de portabilidad legible',
        }),
      }),
    )
  })

  it('rejects REJECT with no reasons and no notes (must give feedback)', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'REJECT',
        rejectionReasons: [],
        reviewNotes: '   ',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/at least one reason or notes/i) })

    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedBroadcast).not.toHaveBeenCalled()
  })

  it('blocks double-review when status is already COMPLETED (409)', async () => {
    mockedFindUnique.mockResolvedValue({ ...baseExisting, status: 'COMPLETED' })

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'APPROVE',
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already reviewed/i) })

    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('blocks double-review when status is FAILED (409)', async () => {
    mockedFindUnique.mockResolvedValue({ ...baseExisting, status: 'FAILED' })

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'REJECT',
        rejectionReasons: ['OTHER'],
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('returns 404 when verification does not exist', async () => {
    mockedFindUnique.mockResolvedValue(null)

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: 'nope',
        reviewedById: REVIEWER_ID,
        decision: 'APPROVE',
      }),
    ).rejects.toMatchObject({ statusCode: 404 })

    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('returns 403 when verification belongs to another venue (tenant isolation)', async () => {
    mockedFindUnique.mockResolvedValue({ ...baseExisting, venueId: 'venue-OTHER' })

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'APPROVE',
      }),
    ).rejects.toMatchObject({ statusCode: 403 })

    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('does not propagate socket emit failures (best-effort delivery)', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(buildUpdatedRow())
    mockedBroadcast.mockImplementation(() => {
      throw new Error('socket service down')
    })

    // Should still succeed — socket failure must not roll back the review
    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'APPROVE',
    })

    expect(result.status).toBe('COMPLETED')
  })

  it('clears rejectionReasons even if APPROVE is called with reasons in payload', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(buildUpdatedRow())

    await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'APPROVE',
      // Defensive: caller may send leftover reasons; service must zero them on approve
      rejectionReasons: ['REVIEW_PORTABILIDAD'] as any,
    })

    expect(mockedUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rejectionReasons: [] }) }))
  })
})
