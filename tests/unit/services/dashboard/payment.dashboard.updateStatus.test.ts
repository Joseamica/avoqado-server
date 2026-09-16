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
    // Codex R12-5: bajo el mutex del Payment se pregunta `cobrosDelProtocolo` (SQL): [] = un cobro anterior al protocolo.
    prismaMock.$queryRaw.mockResolvedValue([])
  })

  // Codex R12-5: un cobro del protocolo de costo (tarifa congelada u obligación TRANSACTION_COST) no admite cambios genéricos
  // de importe, propina, estado, método ni identidad — 409 con código, sin escribir. Los no-op pasan. Detalle y carrera con la
  // convergencia contra Postgres real: `tests/integration/payments/paymentDashboard.protocolo.integration.test.ts`.
  describe('Codex R12-5 · cobro del protocolo de costo', () => {
    const durable = {
      ...pendingPayment,
      status: TransactionStatus.COMPLETED,
      method: 'CREDIT_CARD',
      cardBrand: 'VISA',
      authorizationNumber: 'A1',
      referenceNumber: 'R1',
      maskedPan: null,
      entryMode: null,
    }
    beforeEach(() => {
      prismaMock.payment.findFirst.mockResolvedValue(durable as any)
      prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
        strings.join('?').includes('FROM "Payment" p') ? [{ id: PAYMENT_ID }] : [],
      )
    })

    it.each([
      ['amount', { amount: 120 }],
      ['tipAmount', { tipAmount: 5 }],
      ['status', { status: TransactionStatus.FAILED }],
      ['method', { method: 'DEBIT_CARD' as any }],
      ['cardBrand', { cardBrand: 'MASTERCARD' as any }],
      ['authorizationNumber', { authorizationNumber: 'A2' }],
      ['referenceNumber', { referenceNumber: 'R2' }],
    ])('rechaza el cambio de %s con 409 PAYMENT_PROTECTED_BY_COST_PROTOCOL sin escribir', async (campo, cambio) => {
      await expect(updatePayment(VENUE_ID, PAYMENT_ID, cambio as any)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PAYMENT_PROTECTED_BY_COST_PROTOCOL',
        details: expect.objectContaining({ fields: [campo] }),
      })
      expect(prismaMock.payment.update).not.toHaveBeenCalled()
    })

    it('un no-op (los mismos valores) pasa sin escribir', async () => {
      prismaMock.payment.findUniqueOrThrow.mockResolvedValue(durable as any)
      await expect(
        updatePayment(VENUE_ID, PAYMENT_ID, { amount: 100, status: TransactionStatus.COMPLETED, referenceNumber: 'R1' }),
      ).resolves.toMatchObject({ id: PAYMENT_ID })
      expect(prismaMock.payment.update).not.toHaveBeenCalled()
    })
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
    let durablePayment: Omit<typeof pendingPayment, 'status'> & { status: TransactionStatus; referenceNumber: string } = {
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
