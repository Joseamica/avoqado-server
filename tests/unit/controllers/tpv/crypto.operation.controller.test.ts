jest.mock('@/services/b4bit/b4bit.service', () => ({
  initiateCryptoPayment: jest.fn(),
  cancelCryptoPayment: jest.fn(),
  getPaymentStatus: jest.fn(),
  getCryptoOperationForVenue: jest.fn(),
}))
import {
  initiateCryptoPaymentHandler,
  cancelCryptoPaymentHandler,
  getCryptoOperationHandler,
} from '@/controllers/tpv/crypto.tpv.controller'
import { initiateCryptoPayment, cancelCryptoPayment, getCryptoOperationForVenue } from '@/services/b4bit/b4bit.service'
import { initiateCryptoPaymentSchema, getCryptoOperationSchema } from '@/schemas/tpv.schema'
const id = 'c000000000000000000000001'
const req = (body: object = {}) =>
  ({
    params: { venueId: id, idempotencyKey: id },
    body,
    authContext: { userId: 'actor', orgId: 'org', terminalSerialNumber: 'AVQD-auth' },
  }) as any
const res = () => {
  const r: any = { status: jest.fn(), json: jest.fn() }
  r.status.mockReturnValue(r)
  return r
}
beforeEach(() => jest.clearAllMocks())
describe('crypto controller authenticated context and additive schema', () => {
  it('key optional, strict cuid v1 only when supplied; legacy accepted unchanged', () => {
    const input = { params: { venueId: id }, body: { amount: 5000, staffId: id } }
    expect(initiateCryptoPaymentSchema.safeParse(input).success).toBe(true)
    expect(initiateCryptoPaymentSchema.safeParse({ ...input, body: { ...input.body, idempotencyKey: id } }).success).toBe(true)
    expect(initiateCryptoPaymentSchema.safeParse({ ...input, body: { ...input.body, idempotencyKey: 'short' } }).success).toBe(false)
    expect(getCryptoOperationSchema.safeParse({ params: { venueId: id, idempotencyKey: id } }).success).toBe(true)
  })
  it('body actor/serial cannot replace authenticated new context; new projection reaches client', async () => {
    const output = { paymentId: id, requestId: null, paymentUrl: null, operation: { emissionStatus: 'SENDING' } }
    ;(initiateCryptoPayment as jest.Mock).mockResolvedValue(output)
    const response = res(),
      next = jest.fn()
    await initiateCryptoPaymentHandler(
      req({
        idempotencyKey: id,
        amount: 5000,
        staffId: 'declared',
        actorStaffId: 'forged',
        terminalSerialNumber: 'forged',
        deviceSerialNumber: 'forged',
      }),
      response,
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect(initiateCryptoPayment).toHaveBeenCalledWith(
      expect.objectContaining({ actorStaffId: 'actor', terminalSerialNumber: 'AVQD-auth', staffId: 'declared', idempotencyKey: id }),
    )
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ data: output }))
  })
  it('cancel resolves scope and both identifiers in service with authenticated actor', async () => {
    await cancelCryptoPaymentHandler(req({ paymentId: id, requestId: 'request', venueId: 'forged', staffId: 'forged' }), res(), jest.fn())
    expect(cancelCryptoPayment).toHaveBeenCalledWith({ venueId: id, staffId: 'actor', paymentId: id, requestId: 'request' })
  })
  it('exact recovery never accepts body serial or a session without a serial', async () => {
    const r = req({ terminalSerialNumber: 'forged' }),
      next = jest.fn()
    delete r.authContext.terminalSerialNumber
    await getCryptoOperationHandler(r, res(), next)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(getCryptoOperationForVenue).not.toHaveBeenCalled()
  })
  it('legacy response names and success message remain intact', async () => {
    ;(initiateCryptoPayment as jest.Mock).mockResolvedValue({
      requestId: 'r',
      paymentId: id,
      paymentUrl: 'url',
      expiresAt: 'date',
      expiresInSeconds: 900,
    })
    const response = res()
    await initiateCryptoPaymentHandler(req({ amount: 5000, staffId: id }), response, jest.fn())
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      data: {
        requestId: 'r',
        paymentId: id,
        paymentUrl: 'url',
        expiresAt: 'date',
        expiresInSeconds: 900,
        shiftId: null,
        cryptoSymbol: undefined,
        cryptoAddress: undefined,
      },
      message: 'Crypto payment initiated successfully',
    })
  })
})
