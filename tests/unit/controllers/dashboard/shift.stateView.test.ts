import { Request, Response } from 'express'
import { getShift } from '@/controllers/dashboard/shift.dashboard.controller'
import { prismaMock } from '../../../__helpers__/setup'

const venueId = 'c000000000000000000000001'
const shiftId = 'c000000000000000000000002'

function request(view?: unknown) {
  const req = { params: { venueId, shiftId }, query: view === undefined ? {} : { view } } as unknown as Request
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  const next = jest.fn()
  return { req, res, next }
}

beforeEach(() => jest.clearAllMocks())

describe('GET shift by identity · compact state without loading the report', () => {
  it('returns the identified CLOSED shift using only id, tenant and status', async () => {
    const state = { id: shiftId, venueId, status: 'CLOSED' }
    prismaMock.shift.findFirst.mockResolvedValue(state as any)
    const { req, res, next } = request('state')

    await getShift(req, res, next)

    expect(prismaMock.shift.findFirst).toHaveBeenCalledTimes(1)
    expect(prismaMock.shift.findFirst).toHaveBeenCalledWith({
      where: { id: shiftId, venueId },
      select: { id: true, venueId: true, status: true },
    })
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(state)
  })

  it('keeps an absent identity as 404 rather than inventing CLOSED', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)
    const { req, res, next } = request('state')

    await getShift(req, res, next)

    expect(prismaMock.shift.findFirst).toHaveBeenCalledWith({
      where: { id: shiftId, venueId },
      select: { id: true, venueId: true, status: true },
    })
    expect(res.status).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  it.each([{ view: undefined }, { view: 'detail' }, { view: ['state'] }])(
    'preserves the legacy detailed query for %j',
    async ({ view }) => {
      prismaMock.shift.findFirst.mockResolvedValue(null)
      const { req, res, next } = request(view)

      await getShift(req, res, next)

      const query = prismaMock.shift.findFirst.mock.calls[0][0]!
      expect(query.where).toEqual({ id: shiftId, venueId })
      expect(query).not.toHaveProperty('select')
      expect(query.include).toEqual(expect.objectContaining({ payments: expect.any(Object), orders: expect.any(Object) }))
      expect(res.status).toHaveBeenCalledWith(404)
      expect(next).not.toHaveBeenCalled()
    },
  )

  it('propagates a failed read without returning a false state', async () => {
    const failure = new Error('database unavailable')
    prismaMock.shift.findFirst.mockRejectedValue(failure)
    const { req, res, next } = request('state')

    await getShift(req, res, next)

    expect(next).toHaveBeenCalledWith(failure)
    expect(res.json).not.toHaveBeenCalled()
  })
})
