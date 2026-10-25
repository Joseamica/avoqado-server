import { Request, Response } from 'express'
import { BadRequestError } from '@/errors/AppError'
import { validateRequest } from '@/middlewares/validation'
import {
  decodeSalesCursor,
  decodeSalesSince,
  encodeSalesCursor,
  encodeSalesSince,
  recentSalesQuerySchema,
  SalesCursor,
  SalesSince,
} from '@/schemas/mobile/recentSales.mobile.schema'

const since: SalesSince = { v: 1, w: 1792560480000, ws: 1789966800000 }
const cursor: SalesCursor = {
  v: 1,
  m: 'F',
  t0: 1792560600000,
  ws: 1789966800000,
  w: null,
  ws0: null,
  total: 1234,
  at: 1792550000000,
  id: 'cmabcdefghijklmnopqrstuvw',
}
const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

async function validate(query: unknown) {
  const req = { params: { venueId: 'cmabcdefghijklmnopqrstuvw' }, query } as unknown as Request
  const next = jest.fn()
  await validateRequest(recentSalesQuerySchema)(req, {} as Response, next)
  return { req, error: next.mock.calls[0]?.[0] as BadRequestError | undefined }
}

describe('Recent sales tokens', () => {
  it('round-trips a since token using base64url JSON', () => {
    expect(encodeSalesSince(since)).toBe(token(since))
    expect(decodeSalesSince(token(since))).toEqual(since)
  })

  it.each(['F', 'D'] as const)('round-trips a cursor in mode %s', m => {
    const value = { ...cursor, m, w: m === 'D' ? since.w : null, ws0: m === 'D' ? since.ws : null }
    expect(encodeSalesCursor(value)).toBe(token(value))
    expect(decodeSalesCursor(token(value))).toEqual(value)
  })

  it('preserves an old since version for the service to reset', () => {
    expect(decodeSalesSince(token({ ...since, v: 0 }))).toEqual({ ...since, v: 0 })
  })

  it.each(['garbage', '', token(null), token([]), token('text')])('rejects unreadable tokens: %s', value => {
    expect(decodeSalesSince(value)).toBeNull()
    expect(decodeSalesCursor(value)).toBeNull()
  })

  it.each(['v', 'w', 'ws'] as const)('validates the since field %s', field => {
    for (const value of [undefined, null, '1', true, {}, NaN, Infinity, -Infinity]) {
      expect(decodeSalesSince(token({ ...since, [field]: value }))).toBeNull()
    }
  })

  it.each(['v', 't0', 'ws', 'total', 'at'] as const)('validates the required numeric cursor field %s', field => {
    for (const value of [undefined, null, '1', true, {}, NaN, Infinity, -Infinity]) {
      expect(decodeSalesCursor(token({ ...cursor, [field]: value }))).toBeNull()
    }
  })

  it.each(['w', 'ws0'] as const)('validates the nullable numeric cursor field %s', field => {
    expect(decodeSalesCursor(token({ ...cursor, [field]: since.w }))).toEqual({ ...cursor, [field]: since.w })
    for (const value of [undefined, '1', true, {}]) {
      expect(decodeSalesCursor(token({ ...cursor, [field]: value }))).toBeNull()
    }
    const overflowing = JSON.stringify({ ...cursor, [field]: 123 }).replace(`"${field}":123`, `"${field}":1e309`)
    expect(decodeSalesCursor(Buffer.from(overflowing).toString('base64url'))).toBeNull()
  })

  it.each([0, 2])('rejects cursor version %s', v => {
    expect(decodeSalesCursor(token({ ...cursor, v }))).toBeNull()
  })

  it.each([undefined, null, 'X', 1])('rejects invalid cursor mode %s', m => {
    expect(decodeSalesCursor(token({ ...cursor, m }))).toBeNull()
  })

  it.each([undefined, null, 1, 'x'.repeat(65)])('rejects invalid cursor id %s', id => {
    expect(decodeSalesCursor(token({ ...cursor, id }))).toBeNull()
  })

  it('accepts a cursor id at the 64-character boundary', () => {
    expect(decodeSalesCursor(token({ ...cursor, id: 'x'.repeat(64) }))?.id).toHaveLength(64)
  })
})

describe('Recent sales query validation through middleware', () => {
  it.each([undefined, 12, 'invalid'])('rejects venue id %s with a Spanish 400', async venueId => {
    const req = { params: { venueId }, query: {} } as unknown as Request
    const next = jest.fn()
    await validateRequest(recentSalesQuerySchema)(req, {} as Response, next)
    expect(next.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('El identificador de la sucursal no es válido.'),
    })
  })

  it.each([
    [{}, 100],
    [{ limit: '500' }, 100],
    [{ limit: '101' }, 100],
    [{ limit: '7' }, 7],
    [{ limit: '1' }, 1],
  ])('normalizes query %j to limit %s', async (query, limit) => {
    const result = await validate(query)
    expect(result.error).toBeUndefined()
    expect(result.req.query).toEqual({ limit })
  })

  it.each(['0', '-1', 'abc', '1.5', 'Infinity'])('rejects limit %s with a Spanish 400', async limit => {
    const { error } = await validate({ limit })
    expect(error).toBeInstanceOf(BadRequestError)
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toContain('El límite debe ser un número entero positivo.')
  })

  it('rejects since and cursor together with a Spanish 400', async () => {
    const { error } = await validate({ since: token(since), cursor: token(cursor) })
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toContain('Manda since o cursor, no los dos.')
  })

  it('treats even empty since as present when cursor is supplied', async () => {
    const { error } = await validate({ since: '', cursor: token(cursor) })
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toContain('Manda since o cursor, no los dos.')
  })

  it.each(['garbage', '', token({ ...cursor, v: 0 }), 'x'.repeat(513), 12, ['a'], null])(
    'rejects invalid cursor %j with a Spanish 400',
    async value => {
      const { error } = await validate({ cursor: value })
      expect(error?.statusCode).toBe(400)
      expect(error?.message).toContain('El cursor no es válido.')
    },
  )

  it.each(['garbage', '', 'x'.repeat(512), token({ ...since, v: 0 })])('passes since %s through without decoding', async value => {
    const { req, error } = await validate({ since: value })
    expect(error).toBeUndefined()
    expect(req.query).toEqual({ since: value, limit: 100 })
  })

  it.each(['x'.repeat(513), 12, ['a'], null])('rejects invalid since %j with a Spanish 400', async value => {
    const { error } = await validate({ since: value })
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toContain('El sello no es válido.')
  })

  it('passes a valid cursor through and retains the venue parameter', async () => {
    const { req, error } = await validate({ cursor: token(cursor) })
    expect(error).toBeUndefined()
    expect(req.query).toEqual({ cursor: token(cursor), limit: 100 })
    expect(req.params.venueId).toBe('cmabcdefghijklmnopqrstuvw')
  })
})
