/**
 * Sale Verification Back-Office Review Service Tests
 *
 * Covers the PlayTelecom / Walmart documentation-review flow:
 *   - APPROVE on a PENDING verification → COMPLETED
 *   - REJECT with reasons → FAILED, rejectionReasons stored
 *   - Validation: rejection requires reason or notes
 *   - Idempotency / safety: re-sending the SAME decision on an already-reviewed
 *     verification is a no-op that returns the recorded review (the reviewer
 *     re-clicked because the UI gave no feedback — prod 2026-08-25, 3× 409 in 13 s);
 *     a CONFLICTING decision is still a 409
 *   - Audit: every decision writes an ActivityLog row (the owner audit screen reads
 *     ONLY ActivityLog — before this it was blind to approvals/rejections)
 *   - Tenant isolation: 403 when verification belongs to another venue
 *   - 404 when verification id doesn't exist
 *   - Socket emit is best-effort and never throws
 */

import { reviewSaleVerification } from '@/services/dashboard/sale-verification.dashboard.service'
import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets'
import { SocketEventType } from '@/communication/sockets/types'
import { logAction } from '@/services/dashboard/activity-log.service'

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

jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const mockedFindUnique = prisma.saleVerification.findUnique as jest.Mock
const mockedUpdate = prisma.saleVerification.update as jest.Mock
const mockedBroadcast = socketManager.broadcastToUser as jest.Mock
const mockedLogAction = logAction as jest.Mock

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
        // Conditional write: only lands while the row is still PENDING in THIS venue
        where: { id: VERIFICATION_ID, venueId: VENUE_ID, status: 'PENDING' },
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

  it('marks verification REJECTED (terminal "Rechazada") on REJECT_FINAL — no reasons required, reasons cleared', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(
      buildUpdatedRow({ status: 'REJECTED', reviewNotes: 'No se pudo portar, cliente perdido', rejectionReasons: [] }),
    )

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'REJECT_FINAL',
      reviewNotes: 'No se pudo portar, cliente perdido',
    })

    expect(result.status).toBe('REJECTED')
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REJECTED',
          reviewedById: REVIEWER_ID,
          rejectionReasons: [], // terminal — reasons are only for the fixable "Revisar" path
        }),
      }),
    )
    expect(mockedBroadcast).toHaveBeenCalledWith(
      STAFF_ID,
      SocketEventType.SALE_VERIFICATION_REVIEWED,
      expect.objectContaining({ status: 'REJECTED' }),
    )
  })

  it('allows REJECT_FINAL with no reasons and no notes (lost sale needs no fix feedback)', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(buildUpdatedRow({ status: 'REJECTED', reviewNotes: null, rejectionReasons: [] }))

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'REJECT_FINAL',
    })

    expect(result.status).toBe('REJECTED')
    expect(mockedUpdate).toHaveBeenCalled()
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
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/mínimo 5 caracteres/i) })

    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedBroadcast).not.toHaveBeenCalled()
  })

  it('rejects REJECT with reasons but NO notes (un checkbox pelón no le dice al promotor qué corregir)', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'REJECT',
        rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/mínimo 5 caracteres/i) })

    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('rejects REJECT when notes are shorter than 5 chars', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'REJECT',
        rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'],
        reviewNotes: 'mal',
      }),
    ).rejects.toMatchObject({ statusCode: 400 })

    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Re-review: same decision = idempotent no-op · conflicting decision = 409
  // ---------------------------------------------------------------------------

  it('APPROVE on an already-COMPLETED verification is a no-op that returns the recorded review (no write, no audit, no socket)', async () => {
    const recorded = buildUpdatedRow({ reviewedById: 'staff-first-reviewer', reviewedAt: new Date('2026-08-25T01:33:33Z') })
    mockedFindUnique.mockResolvedValueOnce({ ...baseExisting, status: 'COMPLETED' }).mockResolvedValueOnce(recorded)

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'APPROVE',
    })

    expect(result.status).toBe('COMPLETED')
    expect(result.idempotentNoOp).toBe(true)
    // The FIRST reviewer stays on record — a retry never re-stamps who/when
    expect(result.reviewedById).toBe('staff-first-reviewer')
    expect(result.reviewedAt).toEqual(new Date('2026-08-25T01:33:33Z'))
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedLogAction).not.toHaveBeenCalled()
    expect(mockedBroadcast).not.toHaveBeenCalled()
    // The re-read is tenant-scoped (never another venue's row)
    expect(mockedFindUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: VERIFICATION_ID, venueId: VENUE_ID } }))
  })

  it('a real review does NOT carry the idempotentNoOp flag', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(buildUpdatedRow())

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'APPROVE',
    })

    expect(result.idempotentNoOp).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // Race: two overlapping reviews both read PENDING. The conditional update lets
  // only one land; the loser (P2025) is resolved against what the winner recorded.
  // ---------------------------------------------------------------------------

  it("race loser with the SAME decision: no second write/audit/socket, returns the winner's review", async () => {
    const winnerRow = buildUpdatedRow({ reviewedById: 'staff-winner' })
    mockedFindUnique.mockResolvedValueOnce(baseExisting).mockResolvedValueOnce(winnerRow)
    mockedUpdate.mockRejectedValueOnce(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }))

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'APPROVE',
    })

    expect(result.status).toBe('COMPLETED')
    expect(result.idempotentNoOp).toBe(true)
    expect(result.reviewedById).toBe('staff-winner')
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).not.toHaveBeenCalled()
    expect(mockedBroadcast).not.toHaveBeenCalled()
  })

  it("race loser with a CONFLICTING decision: 409, the winner's decision stands", async () => {
    mockedFindUnique.mockResolvedValueOnce(baseExisting).mockResolvedValueOnce(buildUpdatedRow({ status: 'COMPLETED' }))
    mockedUpdate.mockRejectedValueOnce(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }))

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'REJECT',
        rejectionReasons: ['OTHER'],
        reviewNotes: 'Falta imagen',
      }),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  it('any other update failure still propagates (never swallowed as a no-op)', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockRejectedValueOnce(new Error('connection reset'))

    await expect(
      reviewSaleVerification(VENUE_ID, { saleVerificationId: VERIFICATION_ID, reviewedById: REVIEWER_ID, decision: 'APPROVE' }),
    ).rejects.toThrow('connection reset')
  })

  it('REJECT on an already-FAILED verification is a no-op (same outcome already recorded)', async () => {
    mockedFindUnique
      .mockResolvedValueOnce({ ...baseExisting, status: 'FAILED' })
      .mockResolvedValueOnce(buildUpdatedRow({ status: 'FAILED', rejectionReasons: ['OTHER'], reviewNotes: 'Foto borrosa' }))

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'REJECT',
      rejectionReasons: ['OTHER'],
      reviewNotes: 'Otro comentario distinto',
    })

    expect(result.status).toBe('FAILED')
    expect(result.reviewNotes).toBe('Foto borrosa')
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  it('REJECT_FINAL on an already-REJECTED verification is a no-op', async () => {
    mockedFindUnique
      .mockResolvedValueOnce({ ...baseExisting, status: 'REJECTED' })
      .mockResolvedValueOnce(buildUpdatedRow({ status: 'REJECTED' }))

    const result = await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'REJECT_FINAL',
    })

    expect(result.status).toBe('REJECTED')
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('still blocks a CONFLICTING decision on a COMPLETED verification (REJECT after APPROVE → 409)', async () => {
    mockedFindUnique.mockResolvedValue({ ...baseExisting, status: 'COMPLETED' })

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'REJECT',
        rejectionReasons: ['OTHER'],
        reviewNotes: 'Falta imagen',
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already reviewed/i) })

    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  it('still blocks a CONFLICTING decision on a FAILED verification (APPROVE after REJECT → 409)', async () => {
    mockedFindUnique.mockResolvedValue({ ...baseExisting, status: 'FAILED' })

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'APPROVE',
      }),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('still blocks APPROVE on a terminal REJECTED verification (409)', async () => {
    mockedFindUnique.mockResolvedValue({ ...baseExisting, status: 'REJECTED' })

    await expect(
      reviewSaleVerification(VENUE_ID, {
        saleVerificationId: VERIFICATION_ID,
        reviewedById: REVIEWER_ID,
        decision: 'APPROVE',
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

  // ---------------------------------------------------------------------------
  // Audit trail — the PRIMARY financial decision (Walmart pays PT per approved
  // sale) must land in ActivityLog, not only in reviewedById/reviewedAt (which
  // get overwritten on reopen + re-review). Found in prod 2026-08-25: 0 rows.
  // ---------------------------------------------------------------------------

  it('APPROVE writes an ActivityLog row (SALE_VERIFICATION_APPROVED) with the reviewer as actor and the venue as tenant', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(buildUpdatedRow())

    await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'APPROVE',
    })

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith({
      staffId: REVIEWER_ID,
      venueId: VENUE_ID,
      action: 'SALE_VERIFICATION_APPROVED',
      entity: 'SaleVerification',
      entityId: VERIFICATION_ID,
      data: expect.objectContaining({
        decision: 'APPROVE',
        previousStatus: 'PENDING',
        newStatus: 'COMPLETED',
        paymentId: 'pay-1',
        promoterId: STAFF_ID,
        rejectionReasons: [],
        reviewNotes: null,
      }),
    })
  })

  it('REJECT writes SALE_VERIFICATION_SENT_BACK with the reasons and the feedback the promoter received', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(
      buildUpdatedRow({ status: 'FAILED', rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'], reviewNotes: 'La INE no se lee' }),
    )

    await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'REJECT',
      rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'],
      reviewNotes: '  La INE no se lee  ',
    })

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: REVIEWER_ID,
        venueId: VENUE_ID,
        action: 'SALE_VERIFICATION_SENT_BACK',
        entityId: VERIFICATION_ID,
        data: expect.objectContaining({
          decision: 'REJECT',
          newStatus: 'FAILED',
          rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'],
          reviewNotes: 'La INE no se lee',
        }),
      }),
    )
  })

  it('REJECT_FINAL writes SALE_VERIFICATION_REJECTED', async () => {
    mockedFindUnique.mockResolvedValue(baseExisting)
    mockedUpdate.mockResolvedValue(buildUpdatedRow({ status: 'REJECTED' }))

    await reviewSaleVerification(VENUE_ID, {
      saleVerificationId: VERIFICATION_ID,
      reviewedById: REVIEWER_ID,
      decision: 'REJECT_FINAL',
    })

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SALE_VERIFICATION_REJECTED',
        data: expect.objectContaining({ decision: 'REJECT_FINAL', newStatus: 'REJECTED' }),
      }),
    )
  })

  it('does NOT audit when the review is refused (404 / 403 / validation)', async () => {
    mockedFindUnique.mockResolvedValue({ ...baseExisting, venueId: 'venue-OTHER' })

    await expect(
      reviewSaleVerification(VENUE_ID, { saleVerificationId: VERIFICATION_ID, reviewedById: REVIEWER_ID, decision: 'APPROVE' }),
    ).rejects.toMatchObject({ statusCode: 403 })

    mockedFindUnique.mockResolvedValue(baseExisting)
    await expect(
      reviewSaleVerification(VENUE_ID, { saleVerificationId: VERIFICATION_ID, reviewedById: REVIEWER_ID, decision: 'REJECT' }),
    ).rejects.toMatchObject({ statusCode: 400 })

    expect(mockedLogAction).not.toHaveBeenCalled()
  })
})
