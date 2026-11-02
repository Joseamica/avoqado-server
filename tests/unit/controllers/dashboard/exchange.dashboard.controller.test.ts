import type { Request, Response } from 'express'
import { getExchange, listExchanges, reviewExchange } from '@/controllers/dashboard/exchange.dashboard.controller'
import { listExchangesSchema, reviewExchangeSchema } from '@/schemas/dashboard/exchange.dashboard.schema'
import { validateRequest } from '@/middlewares/validation'

const mockList = jest.fn()
const mockGet = jest.fn()
const mockReview = jest.fn()
jest.mock('@/services/dashboard/exchange.dashboard.service', () => ({
  getExchangeForDashboard: (...a: unknown[]) => mockGet(...a),
  listExchangesForReview: (...a: unknown[]) => mockList(...a),
  markExchangeReviewed: (...a: unknown[]) => mockReview(...a),
}))
const venueId = 'venue-from-url'
const req = (query = {}, body = {}) =>
  ({
    params: { venueId, exchangeId: 'exchange-id' },
    query,
    body,
    authContext: { userId: 'manager-id', venueId: 'token-other-venue' },
  }) as unknown as Request
const response = () => {
  const res = {} as Response
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

beforeEach(() => jest.clearAllMocks())
describe('dashboard exchange controller', () => {
  it.each([
    [0, 2, 4, true, 2],
    [2, 2, 4, false, null],
    [0, 0, 0, false, null],
  ])('returns pagination at offset %i with %i rows out of %i', async (offset, count, total, hayMas, siguienteOffset) => {
    const request = req({ pendingReview: 'true', limit: '2', offset: String(offset) })
    const res = response()
    const next = jest.fn()
    await validateRequest(listExchangesSchema)(request, res, next)
    expect(next).toHaveBeenCalledWith()
    mockList.mockResolvedValue({ total, items: Array.from({ length: count }, (_, id) => ({ id })) })
    await listExchanges(request, res, next)
    expect(mockList).toHaveBeenCalledWith({
      venueId,
      pendingReview: true,
      limit: 2,
      offset,
      cursor: undefined,
      originalOrderId: undefined,
      status: undefined,
    })
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ total, hayMas, siguienteOffset }) })
  })

  it('uses route venue and authenticated actor, ignoring body identities', async () => {
    const request = req({}, { note: '  Checked with the manager  ', staffId: 'forged', venueId: 'forged' })
    const res = response()
    const next = jest.fn()
    await validateRequest(reviewExchangeSchema)(request, res, next)
    mockReview.mockResolvedValue({ id: 'exchange-id' })
    await reviewExchange(request, res, next)
    expect(mockReview).toHaveBeenCalledWith({ venueId, exchangeId: 'exchange-id', staffId: 'manager-id', note: 'Checked with the manager' })
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it.each([undefined, null, 3, '', 'ab', '   ', 'x'.repeat(501)])(
    'requires a 3 to 500 character note with Spanish errors (%j)',
    async note => {
      const next = jest.fn()
      await validateRequest(reviewExchangeSchema)(req({}, { note }), response(), next)
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/nota/) }))
      expect(mockReview).not.toHaveBeenCalled()
    },
  )

  it.each(['abc', 'x'.repeat(500)])('accepts a boundary note with length %s', note => {
    expect(reviewExchangeSchema.safeParse({ params: { venueId, exchangeId: 'exchange-id' }, body: { note } }).success).toBe(true)
  })

  it('clamps limit and defaults pagination, and parses false as false', () => {
    expect(listExchangesSchema.parse({ params: { venueId }, query: { limit: '9000', pendingReview: 'false' } }).query).toEqual({
      limit: 100,
      offset: 0,
      pendingReview: false,
    })
    expect(listExchangesSchema.parse({ params: { venueId }, query: {} }).query).toEqual({ limit: 25, offset: 0 })
  })

  it.each([{ limit: '-1' }, { limit: '1.5' }, { offset: '-1' }, { offset: 'Infinity' }, { pendingReview: 'maybe' }])(
    'rejects malformed pagination %j',
    query => {
      expect(listExchangesSchema.safeParse({ params: { venueId }, query }).success).toBe(false)
    },
  )

  it('passes service conflicts and missing actor to error middleware', async () => {
    const error = Object.assign(new Error('Este cambio ya fue revisado'), { statusCode: 409, code: 'EXCHANGE_ALREADY_REVIEWED' })
    mockReview.mockRejectedValueOnce(error)
    const next = jest.fn()
    await reviewExchange(req({}, { note: 'Checked' }), response(), next)
    expect(next).toHaveBeenLastCalledWith(error)
    const request = req({}, { note: 'Checked' })
    delete request.authContext
    await reviewExchange(request, response(), next)
    expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ statusCode: 401 }))
    expect(mockReview).toHaveBeenCalledTimes(1)
  })
})

it('forwards cursor and filters to the shared list and uses cursor hasMore', async () => {
  const request = req({ cursor: 'opaque', originalOrderId: 'cm12345678901234567890123', status: 'CANCELLED', limit: '25' })
  const res = response()
  const next = jest.fn()
  await validateRequest(listExchangesSchema)(request, res, next)
  mockList.mockResolvedValue({ total: 99, items: [{ id: 'last' }], nextCursor: null })
  await listExchanges(request, res, next)
  expect(mockList).toHaveBeenCalledWith({
    venueId,
    cursor: 'opaque',
    originalOrderId: 'cm12345678901234567890123',
    status: 'CANCELLED',
    limit: 25,
    offset: 0,
    pendingReview: undefined,
  })
  expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ hayMas: false, nextCursor: null }) })
})
it('in cursor mode never offers an offset, even with more pages', async () => {
  const request = req({ cursor: 'opaque', limit: '25' })
  const res = response()
  const next = jest.fn()
  await validateRequest(listExchangesSchema)(request, res, next)
  mockList.mockResolvedValue({ total: 99, items: [{ id: 'a' }], nextCursor: 'next' })
  await listExchanges(request, res, next)
  expect(res.json).toHaveBeenCalledWith({
    success: true,
    data: expect.objectContaining({ hayMas: true, nextCursor: 'next', siguienteOffset: null }),
  })
})
it('gets a single detail using the route venue and propagates 404', async () => {
  const res = response()
  const next = jest.fn()
  mockGet.mockResolvedValueOnce({ id: 'exchange-id', applied: false })
  await getExchange(req(), res, next)
  expect(mockGet).toHaveBeenCalledWith({ venueId, exchangeId: 'exchange-id' })
  expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'exchange-id', applied: false } })
  const error = Object.assign(new Error('No se encontró el cambio'), { statusCode: 404 })
  mockGet.mockRejectedValueOnce(error)
  await getExchange(req(), res, next)
  expect(next).toHaveBeenLastCalledWith(error)
})
