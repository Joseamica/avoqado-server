// F1 (revisión final, pedidos en línea fase 2): el contrato de «Devolver a la tarjeta» — la llave en el encabezado
// `Idempotency-Key` (como la TPV), el monto en PESOS — con el esquema y el controlador REALES; el servicio, simulado.
import express from 'express'
import request from 'supertest'
import { validateRequest } from '@/middlewares/validation'
import { cardRefundSchema } from '@/schemas/online-ordering.schema'

const mockRefund = jest.fn()
jest.mock('@/services/online-ordering/card/refund.service', () => ({
  __esModule: true,
  refundCardOnlineOrder: (...a: unknown[]) => mockRefund(...a),
  listCardRefunds: jest.fn(),
  resolveReversedCardRefund: jest.fn(),
}))

import { refundCardHandler } from '@/controllers/dashboard/onlineOrdering.dashboard.controller'

const app = express()
app.use(express.json())
app.use((req: any, _res, next) => {
  req.authContext = { userId: 'staff-1' }
  next()
})
app.post('/venues/:venueId/online-ordering/orders/:orderId/card-refund', validateRequest(cardRefundSchema), refundCardHandler)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message, code: err.code }))

const URL_ = '/venues/cvenue000000000000000001/online-ordering/orders/corder000000000000000001/card-refund'
const KEY = 'llave-del-panel-0001'
const body = (o: Record<string, unknown> = {}) => ({ amount: '125.50', reason: 'CANCELLED_ORDER', ...o })

beforeEach(() => {
  mockRefund.mockReset()
  mockRefund.mockResolvedValue({ status: 'RECORDED', cardRefundStatus: 'RECORDED', cardRefundId: 'cr1', refundId: 'p1', replay: false })
})

describe('POST …/card-refund: llave y monto', () => {
  it('la llave en el encabezado Idempotency-Key basta (el cuerpo ya no la exige); el monto llega en pesos', async () => {
    const r = await request(app).post(URL_).set('Idempotency-Key', KEY).send(body())
    expect(r.status).toBe(200)
    expect(mockRefund).toHaveBeenCalledTimes(1)
    const arg = mockRefund.mock.calls[0][0]
    expect(arg).toMatchObject({ idempotencyKey: KEY, staffId: 'staff-1', reason: 'CANCELLED_ORDER' })
    expect(arg.amount.toFixed(2)).toBe('125.50') // pesos, nunca centavos
  })

  it('la llave en el cuerpo sigue sirviendo (clientes de antes)', async () => {
    const r = await request(app)
      .post(URL_)
      .send(body({ idempotencyKey: KEY }))
    expect(r.status).toBe(200)
    expect(mockRefund.mock.calls[0][0].idempotencyKey).toBe(KEY)
  })

  it('las dos iguales → pasa; distintas → 400 IDEMPOTENCY_KEY_MISMATCH sin llamar al servicio', async () => {
    expect(
      (
        await request(app)
          .post(URL_)
          .set('Idempotency-Key', KEY)
          .send(body({ idempotencyKey: KEY }))
      ).status,
    ).toBe(200)
    const r = await request(app)
      .post(URL_)
      .set('Idempotency-Key', KEY)
      .send(body({ idempotencyKey: 'otra-llave-0002' }))
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_MISMATCH')
    expect(mockRefund).toHaveBeenCalledTimes(1)
  })

  it('sin llave en ningún lado → 400 sin llamar al servicio', async () => {
    const r = await request(app).post(URL_).send(body())
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(/Idempotency-Key/)
    expect(mockRefund).not.toHaveBeenCalled()
  })

  it('una llave mal formada en el encabezado → 400 sin llamar al servicio', async () => {
    const r = await request(app).post(URL_).set('Idempotency-Key', 'corta').send(body())
    expect(r.status).toBe(400)
    expect(mockRefund).not.toHaveBeenCalled()
  })
})
