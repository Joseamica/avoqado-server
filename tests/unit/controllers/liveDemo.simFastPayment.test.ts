/**
 * Live Demo — POST /api/v1/live-demo/sim/fast-payment (Avoqado Tour F2)
 *
 * Controller + Zod schema tests. Mocks @/services/liveDemo.service so these
 * exercise ONLY the controller's branching + response shapes, plus the body
 * schema through the real validateRequest middleware.
 *
 * Service-level behavior (LIVE_DEMO hard check, sim cap, recordFastPayment
 * reuse + socket emission) is covered in
 * tests/unit/services/liveDemo.simFastPayment.service.test.ts
 */

import type { NextFunction, Request, Response } from 'express'

import { simFastPaymentController } from '@/controllers/liveDemo.controller'
import { simulateFastPayment } from '@/services/liveDemo.service'
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '@/errors/AppError'
import { validateRequest } from '@/middlewares/validation'
import { simFastPaymentBodySchema } from '@/schemas/liveDemo.schema'

jest.mock('@/services/liveDemo.service', () => ({
  simulateFastPayment: jest.fn(),
}))

const mockedSimulate = simulateFastPayment as jest.Mock

function makeRes(): Response & { __status: number; __json: any } {
  const res: any = {}
  res.__status = 0
  res.__json = undefined
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((payload: any) => {
    res.__json = payload
    return res
  })
  return res
}

function makeReq(body: any, cookies: Record<string, string> = {}): Request {
  return { body, cookies } as unknown as Request
}

describe('POST /live-demo/sim/fast-payment — controller', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedSimulate.mockResolvedValue({ paymentId: 'pay-sim-1', amountCents: 15000, tipCents: 2000 })
  })

  it('401 without session cookie — service is never called', async () => {
    const req = makeReq({ amountCents: 15000 }, {})
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await simFastPaymentController(req, res, next)

    expect(res.__status).toBe(401)
    expect(res.__json).toEqual({ error: 'No demo session' })
    expect(mockedSimulate).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('401 when the session is expired (service throws UnauthorizedError)', async () => {
    mockedSimulate.mockRejectedValue(new UnauthorizedError('No demo session'))

    const req = makeReq({ amountCents: 15000 }, { liveDemoSessionId: 'expired-session' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await simFastPaymentController(req, res, next)

    expect(mockedSimulate).toHaveBeenCalledWith('expired-session', 15000, 0)
    expect(res.__status).toBe(401)
    expect(res.__json).toEqual({ error: 'No demo session' })
    expect(next).not.toHaveBeenCalled()
  })

  it('403 when the session venue is not LIVE_DEMO (tampered session)', async () => {
    mockedSimulate.mockRejectedValue(new ForbiddenError('Esta operación solo está disponible en venues de demo.'))

    const req = makeReq({ amountCents: 15000 }, { liveDemoSessionId: 'tampered-session' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await simFastPaymentController(req, res, next)

    expect(res.__status).toBe(403)
    expect(res.__json).toEqual({ error: 'Esta operación solo está disponible en venues de demo.' })
    expect(next).not.toHaveBeenCalled()
  })

  it('429 when the per-session sim payment cap is exceeded', async () => {
    mockedSimulate.mockRejectedValue(new TooManyRequestsError('Límite de pagos simulados alcanzado para esta sesión de demo.'))

    const req = makeReq({ amountCents: 15000 }, { liveDemoSessionId: 'busy-session' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await simFastPaymentController(req, res, next)

    expect(res.__status).toBe(429)
    expect(res.__json).toEqual({ error: 'Límite de pagos simulados alcanzado para esta sesión de demo.' })
    expect(next).not.toHaveBeenCalled()
  })

  it('200 happy path — contract response shape { success, data: { paymentId, amountCents, tipCents } }', async () => {
    const req = makeReq({ amountCents: 15000, tipCents: 2000 }, { liveDemoSessionId: 'session-1' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await simFastPaymentController(req, res, next)

    expect(mockedSimulate).toHaveBeenCalledWith('session-1', 15000, 2000)
    expect(res.__status).toBe(200)
    expect(res.__json).toEqual({
      success: true,
      data: { paymentId: 'pay-sim-1', amountCents: 15000, tipCents: 2000 },
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('defaults tipCents to 0 when omitted', async () => {
    const req = makeReq({ amountCents: 5000 }, { liveDemoSessionId: 'session-1' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await simFastPaymentController(req, res, next)

    expect(mockedSimulate).toHaveBeenCalledWith('session-1', 5000, 0)
    expect(res.__status).toBe(200)
  })

  it('forwards unexpected errors to next()', async () => {
    const boom = new Error('db exploded')
    mockedSimulate.mockRejectedValue(boom)

    const req = makeReq({ amountCents: 15000 }, { liveDemoSessionId: 'session-1' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await simFastPaymentController(req, res, next)

    expect(next).toHaveBeenCalledWith(boom)
    expect(res.__status).toBe(0)
  })
})

describe('POST /live-demo/sim/fast-payment — body schema (Zod via validateRequest)', () => {
  const middleware = validateRequest(simFastPaymentBodySchema)

  async function runValidation(body: any): Promise<{ nextArg: any; req: Request }> {
    const req = { body } as unknown as Request
    const res = makeRes()
    const next = jest.fn()
    await middleware(req, res, next as unknown as NextFunction)
    return { nextArg: (next as jest.Mock).mock.calls[0]?.[0], req }
  }

  it('rejects missing amountCents with a Spanish 400', async () => {
    const { nextArg } = await runValidation({})
    expect(nextArg).toBeDefined()
    expect(nextArg.statusCode).toBe(400)
    expect(nextArg.message).toContain('El monto (amountCents) es requerido.')
  })

  it('rejects amountCents = 0', async () => {
    const { nextArg } = await runValidation({ amountCents: 0 })
    expect(nextArg).toBeDefined()
    expect(nextArg.statusCode).toBe(400)
    expect(nextArg.message).toContain('El monto (amountCents) debe ser mayor a 0.')
  })

  it('rejects negative amountCents', async () => {
    const { nextArg } = await runValidation({ amountCents: -500 })
    expect(nextArg).toBeDefined()
    expect(nextArg.statusCode).toBe(400)
    expect(nextArg.message).toContain('El monto (amountCents) debe ser mayor a 0.')
  })

  it('rejects non-integer amountCents', async () => {
    const { nextArg } = await runValidation({ amountCents: 150.5 })
    expect(nextArg).toBeDefined()
    expect(nextArg.statusCode).toBe(400)
  })

  it('rejects amountCents above 5,000,000', async () => {
    const { nextArg } = await runValidation({ amountCents: 5_000_001 })
    expect(nextArg).toBeDefined()
    expect(nextArg.statusCode).toBe(400)
  })

  it('rejects negative tipCents and tipCents above 1,000,000', async () => {
    const negative = await runValidation({ amountCents: 1000, tipCents: -1 })
    expect(negative.nextArg.statusCode).toBe(400)

    const huge = await runValidation({ amountCents: 1000, tipCents: 1_000_001 })
    expect(huge.nextArg.statusCode).toBe(400)
  })

  it('accepts a valid body (tipCents optional)', async () => {
    const withTip = await runValidation({ amountCents: 15000, tipCents: 2000 })
    expect(withTip.nextArg).toBeUndefined()

    const withoutTip = await runValidation({ amountCents: 15000 })
    expect(withoutTip.nextArg).toBeUndefined()
  })
})
