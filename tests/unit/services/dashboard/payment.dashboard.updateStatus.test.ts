import { TransactionStatus } from '@prisma/client'

import { updatePayment as updatePaymentController } from '@/controllers/dashboard/payment.dashboard.controller'
import { BadRequestError } from '@/errors/AppError'
import { updatePayment } from '@/services/dashboard/payment.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-payment-correction'
const PAYMENT_ID = 'payment-pending'

const pendingPayment = {
  id: PAYMENT_ID,
  venueId: VENUE_ID,
  status: TransactionStatus.PENDING,
  method: 'CASH',
  amount: 100,
  tipAmount: 0,
}

describe('dashboard payment correction status boundary', () => {
  beforeEach(() => {
    prismaMock.payment.findFirst.mockResolvedValue(pendingPayment as any)
    prismaMock.payment.update.mockResolvedValue({ ...pendingPayment, status: TransactionStatus.COMPLETED } as any)
  })

  it('rejects a direct service transition into COMPLETED before writing money state', async () => {
    await expect(updatePayment(VENUE_ID, PAYMENT_ID, { status: TransactionStatus.COMPLETED })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_COMPLETION_REQUIRES_CAPTURE_FLOW',
    })

    expect(prismaMock.payment.update).not.toHaveBeenCalled()
  })

  it('does not let an authenticated dashboard request materialize PENDING cash as COMPLETED', async () => {
    const req = {
      params: { venueId: VENUE_ID, paymentId: PAYMENT_ID },
      body: { status: TransactionStatus.COMPLETED },
      authContext: { userId: 'staff-authenticated' },
    } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await updatePaymentController(req, res, next)

    expect(prismaMock.payment.update).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(BadRequestError))
    expect(next.mock.calls[0][0]).toMatchObject({ code: 'PAYMENT_COMPLETION_REQUIRES_CAPTURE_FLOW' })
  })

  it('keeps non-completion metadata corrections working', async () => {
    prismaMock.payment.update.mockResolvedValue({ ...pendingPayment, referenceNumber: 'REF-2' } as any)

    await expect(updatePayment(VENUE_ID, PAYMENT_ID, { referenceNumber: 'REF-2' })).resolves.toMatchObject({
      referenceNumber: 'REF-2',
    })

    expect(prismaMock.payment.update).toHaveBeenCalledTimes(1)
  })

  it('never reasserts an already-COMPLETED status while correcting metadata', async () => {
    let durablePayment = {
      ...pendingPayment,
      status: TransactionStatus.COMPLETED,
      referenceNumber: 'REF-OLD',
    }
    prismaMock.payment.findFirst.mockImplementation(async () => ({ ...durablePayment }) as any)
    prismaMock.payment.update.mockImplementation(async ({ data }: any) => {
      // A different writer wins after the service's initial read. This fake
      // applies exactly the submitted Prisma data to make a stale status
      // reassertion observable instead of merely checking a mock call shape.
      durablePayment = { ...durablePayment, status: TransactionStatus.FAILED }
      durablePayment = { ...durablePayment, ...data }
      return { ...durablePayment } as any
    })

    const result = await updatePayment(VENUE_ID, PAYMENT_ID, {
      status: TransactionStatus.COMPLETED,
      referenceNumber: 'REF-CORRECTED',
    })

    const submittedData = prismaMock.payment.update.mock.calls[0][0].data
    expect(Object.prototype.hasOwnProperty.call(submittedData, 'status')).toBe(false)
    expect(result).toMatchObject({
      status: TransactionStatus.FAILED,
      referenceNumber: 'REF-CORRECTED',
    })
  })
})
