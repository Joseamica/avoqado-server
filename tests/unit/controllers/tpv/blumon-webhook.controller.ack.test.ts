import { handleBlumonTPVWebhook } from '@/controllers/tpv/blumon-webhook.tpv.controller'
import * as svc from '@/services/tpv/blumon-webhook.service'

jest.mock('@/services/tpv/blumon-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/blumon-webhook.service'),
  processBlumonPaymentWebhook: jest.fn(),
}))

const mockedProcess = svc.processBlumonPaymentWebhook as jest.Mock

function mockRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

const validBody = {
  amount: '100.00',
  reference: '260718120000',
  operationNumber: 99000001,
  codeResponse: '00',
  descriptionResponse: 'APROBADA',
  operationType: 'VENTA',
}

const mockReq = (body: unknown = validBody) => ({ body, header: () => undefined, headers: {} }) as any

/**
 * The catch-all used to answer 200 "to prevent Blumon from retrying". But an
 * exception can happen BEFORE the event row is persisted — acknowledging then
 * loses the charge forever, with a receipt. Retries are safe because
 * ProviderEventLog has @@unique([provider, eventId]), so the honest answer is
 * 503 whenever we cannot prove the event was stored.
 */
describe('Task 4 — ACK only after durable persistence', () => {
  beforeEach(() => mockedProcess.mockReset())

  it('503 when the service threw (event may not be persisted)', async () => {
    mockedProcess.mockRejectedValue(new Error('db down'))
    const res = mockRes()

    await handleBlumonTPVWebhook(mockReq(), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('503 when the result carries no eventLogId (not persisted)', async () => {
    mockedProcess.mockResolvedValue({ success: false, action: 'PENDING', message: 'x' })
    const res = mockRes()

    await handleBlumonTPVWebhook(mockReq(), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('200 when the event was persisted (eventLogId present)', async () => {
    mockedProcess.mockResolvedValue({
      success: true,
      action: 'MATCHED',
      message: 'ok',
      eventLogId: 'evt_1',
      paymentId: 'pay_1',
    })
    const res = mockRes()

    await handleBlumonTPVWebhook(mockReq(), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('an invalid payload still answers 400, not 503', async () => {
    const res = mockRes()

    await handleBlumonTPVWebhook(mockReq({ nonsense: true }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockedProcess).not.toHaveBeenCalled()
  })
})
