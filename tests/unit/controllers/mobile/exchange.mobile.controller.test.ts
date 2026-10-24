import express from 'express'
import request from 'supertest'
import type { z } from 'zod'
import type { CreateExchangeBody } from '@/services/exchanges/exchange.service'

jest.mock('@/services/exchanges/exchange.service', () => ({ createExchange: jest.fn() }))

import { globalErrorHandler } from '@/app'
import { validateRequest } from '@/middlewares/validation'
import { createExchangeSchema } from '@/schemas/mobile/exchange.mobile.schema'
import { createExchange } from '@/controllers/mobile/exchange.mobile.controller'
import * as service from '@/services/exchanges/exchange.service'
import { ExchangeError } from '@/services/exchanges/exchangeErrors'

const venueId = 'c0000000000000000000000001'
const staffId = 'c0000000000000000000000002'
const itemId = 'c0000000000000000000000003'
const productId = 'c0000000000000000000000004'
const paymentId = 'c0000000000000000000000005'
const validBody = () => ({
  idempotencyKey: 'exchange-0001',
  originalPaymentId: paymentId,
  returned: [{ orderItemId: itemId, quantity: 1, restock: true, reason: 'SIZE' }],
  taken: [{ productId, quantity: 1 }],
  staffId,
  deviceId: 'caja-1',
  createdAtLocal: '2026-10-24T03:00:00-06:00',
  settlement: { kind: 'EVEN', method: null, expectedDifferenceCents: 0 },
})
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.authContext = { userId: staffId, venueId, orgId: 'c0000000000000000000000006', role: 'CASHIER' }
  next()
})
app.post('/venues/:venueId/exchanges', validateRequest(createExchangeSchema), createExchange)
app.use(globalErrorHandler)
const post = (body: object, venue = venueId) => request(app).post(`/venues/${venue}/exchanges`).send(body)
const mockCreate = jest.mocked(service.createExchange)

beforeEach(() => jest.resetAllMocks())

describe('exchange mobile endpoint', () => {
  it.each([false, true])('returns the exchange envelope with replay=%s', async replay => {
    const exchange = { id: 'c0000000000000000000000007', status: 'COMPLETED' }
    mockCreate.mockResolvedValue({ exchange, replay } as Awaited<ReturnType<typeof service.createExchange>>)
    const body = validBody()
    const response = await post(body)
    expect(response.status).toBe(replay ? 200 : 201)
    expect(response.body).toEqual({ success: true, data: { exchange } })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith({ venueId, actorStaffId: staffId, body })
  })

  it('preserves displayed prices, optional references and the service body type', () => {
    const body: CreateExchangeBody = createExchangeSchema.parse({
      params: { venueId },
      query: {},
      body: {
        ...validBody(),
        isOfflineReplay: false,
        taken: [
          { productId, quantity: 1, inheritsFromOrderItemId: null, displayedUnitPriceCents: 45000, catalogAt: '2026-10-24T03:00:00-06:00' },
        ],
      },
    }).body satisfies z.infer<typeof createExchangeSchema>['body']
    expect(body.taken[0].displayedUnitPriceCents).toBe(45000)
    expect(body.taken[0].catalogAt).toBe('2026-10-24T03:00:00-06:00')
  })

  it.each([
    ['difference changed', 'EXCHANGE_DIFFERENCE_CHANGED', 409, { expectedDifferenceCents: 100 }],
    ['disabled', 'EXCHANGES_DISABLED', 422, undefined],
    ['actor mismatch', 'ACTOR_MISMATCH', 400, undefined],
  ] as const)('forwards %s through the global error handler', async (_case, code, status, details) => {
    mockCreate.mockRejectedValue(new ExchangeError(code, 'No se puede completar el cambio.', status, details))
    const body = { ...validBody(), staffId: productId }
    const response = await post(body)
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ code, message: 'No se puede completar el cambio.', ...(details ? { details } : {}) })
    expect(mockCreate).toHaveBeenCalledWith({ venueId, actorStaffId: staffId, body })
  })

  it.each([
    ['EVEN with a nonzero difference', { settlement: { kind: 'EVEN', method: null, expectedDifferenceCents: 100 } }],
    ['EVEN with a method', { settlement: { kind: 'EVEN', method: 'CASH', expectedDifferenceCents: 0 } }],
    ['COLLECT with a negative difference', { settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: -1 } }],
    ['PAYOUT with a positive difference', { settlement: { kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: 1 } }],
    ['COLLECT without a method', { settlement: { kind: 'COLLECT', method: null, expectedDifferenceCents: 1 } }],
    ['PAYOUT without a method', { settlement: { kind: 'PAYOUT', method: null, expectedDifferenceCents: -1 } }],
    ['TENDER without revision', { settlement: { kind: 'COLLECT', method: 'TENDER', expectedDifferenceCents: 1, tenderTypeId: productId } }],
    ['TENDER without id', { settlement: { kind: 'COLLECT', method: 'TENDER', expectedDifferenceCents: 1, tenderRevision: 1 } }],
    [
      'PAYOUT with TENDER',
      { settlement: { kind: 'PAYOUT', method: 'TENDER', expectedDifferenceCents: -1, tenderTypeId: productId, tenderRevision: 1 } },
    ],
    ['cash override on COLLECT', { settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: 1, cashFromNonCash: true } }],
    [
      'cash override on transfer',
      { settlement: { kind: 'PAYOUT', method: 'BANK_TRANSFER', expectedDifferenceCents: -1, cashFromNonCash: false } },
    ],
    ['fractional cents', { settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: 1.5 } }],
    ['unsafe cents', { settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: Number.MAX_SAFE_INTEGER + 1 } }],
    ['offline replay', { isOfflineReplay: true }],
    ['unknown reason', { returned: [{ orderItemId: itemId, quantity: 1, restock: true, reason: 'COLOR' }] }],
    ['zero quantity', { taken: [{ productId, quantity: 0 }] }],
    ['fractional quantity', { returned: [{ orderItemId: itemId, quantity: 1.5, restock: true, reason: 'SIZE' }] }],
    ['excess quantity', { taken: [{ productId, quantity: 1000 }] }],
    ['empty taken', { taken: [] }],
    ['empty returned', { returned: [] }],
    ['null taken line', { taken: [null] }],
    ['null returned line', { returned: [null] }],
    ['too many taken', { taken: Array.from({ length: 101 }, () => ({ productId, quantity: 1 })) }],
    [
      'too many returned',
      {
        returned: Array.from({ length: 101 }, (_, index) => ({
          orderItemId: `c${String(index).padStart(24, '0')}`,
          quantity: 1,
          restock: true,
          reason: 'SIZE',
        })),
      },
    ],
    ['fractional displayed price', { taken: [{ productId, quantity: 1, displayedUnitPriceCents: 1.5 }] }],
    ['negative displayed price', { taken: [{ productId, quantity: 1, displayedUnitPriceCents: -1 }] }],
    ['catalog without timezone', { taken: [{ productId, quantity: 1, catalogAt: '2026-10-24T03:00:00' }] }],
    ['local date without timezone', { createdAtLocal: '2026-10-24T03:00:00' }],
    ['long device id', { deviceId: 'a'.repeat(129) }],
    ['empty device id', { deviceId: '' }],
    ['invalid key', { idempotencyKey: 'bad key!' }],
    ['short key', { idempotencyKey: '1234567' }],
    ['long key', { idempotencyKey: 'a'.repeat(65) }],
    ['invalid payment id', { originalPaymentId: 'invalid' }],
    ['missing staff id', { staffId: undefined }],
    ['non-boolean restock', { returned: [{ orderItemId: itemId, quantity: 1, restock: 'true', reason: 'SIZE' }] }],
    ['invalid kind', { settlement: { kind: 'OTHER', method: null, expectedDifferenceCents: 0 } }],
    ['invalid method', { settlement: { kind: 'COLLECT', method: 'OTHER', expectedDifferenceCents: 1 } }],
  ])('rejects %s with 400 and Spanish validation', async (_case, changes) => {
    const response = await post({ ...validBody(), ...changes })
    expect(response.status).toBe(400)
    expect(response.body.message).toMatch(/Error de validación|artículo.*repetido/)
    expect(response.body.message).not.toMatch(/Required|Expected|Invalid|must|should/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects returned[] with a repeated orderItemId', async () => {
    const body = validBody()
    body.returned.push({ ...body.returned[0], restock: false })
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ code: 'EXCHANGE_DUPLICATE_LINE', message: expect.stringMatching(/artículo.*repetido/) })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects an invalid venue before calling the service', async () => {
    expect((await post(validBody(), 'invalid')).status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: 1 },
    { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 1, terminalId: productId },
    { kind: 'COLLECT', method: 'BANK_TRANSFER', expectedDifferenceCents: 1 },
    { kind: 'COLLECT', method: 'GIFT_CARD_BALANCE', expectedDifferenceCents: 1 },
    { kind: 'COLLECT', method: 'TENDER', expectedDifferenceCents: 1, tenderTypeId: productId, tenderRevision: 1 },
    { kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: -1, cashFromNonCash: true, cashDrawerSessionId: productId },
    { kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: -1 },
    { kind: 'PAYOUT', method: 'BANK_TRANSFER', expectedDifferenceCents: -1 },
    { kind: 'PAYOUT', method: 'CARD_TERMINAL', expectedDifferenceCents: -1 },
    { kind: 'PAYOUT', method: 'GIFT_CARD_BALANCE', expectedDifferenceCents: -1 },
  ])('accepts the settlement shape $kind/$method without redoing service rules', async settlement => {
    mockCreate.mockResolvedValue({ exchange: {}, replay: false } as Awaited<ReturnType<typeof service.createExchange>>)
    const body = { ...validBody(), settlement }
    expect((await post(body)).status).toBe(201)
    expect(mockCreate).toHaveBeenCalledWith({ venueId, actorStaffId: staffId, body })
  })
})
