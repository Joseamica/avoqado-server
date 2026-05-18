/**
 * AngelPay validation report controller tests (Task 14).
 *
 * Covers spec §4.6 endpoints:
 *   POST /tpv/angelpay/report-validation
 *   POST /tpv/angelpay/report-merchant-switch
 *
 * Mocks @/services/superadmin/angelpayUserAccount.service so tests exercise
 * ONLY the controller's branching + response shape.
 */

import type { NextFunction, Request, Response } from 'express'

import {
  reportAngelPayMerchantSwitch,
  reportAngelPayValidation,
} from '@/controllers/tpv/angelpayValidation.tpv.controller'
import {
  markAngelPayUserAccountValidated,
  recordAngelPayUserAccountError,
} from '@/services/superadmin/angelpayUserAccount.service'

jest.mock('@/services/superadmin/angelpayUserAccount.service', () => ({
  markAngelPayUserAccountValidated: jest.fn(),
  recordAngelPayUserAccountError: jest.fn(),
}))

const mockedMarkValidated = markAngelPayUserAccountValidated as jest.Mock
const mockedRecordError = recordAngelPayUserAccountError as jest.Mock

function makeRes(): Response & { __status: number; __ended: boolean } {
  const res: any = {}
  res.__status = 0
  res.__ended = false
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.end = jest.fn(() => {
    res.__ended = true
    return res
  })
  res.json = jest.fn(() => res)
  return res
}

function makeReq(body: any, authContext: any = { terminalSerialNumber: 'AVQD-NEXGO-1', venueId: 'venue-1' }): Request {
  return { body, authContext } as unknown as Request
}

describe('POST /tpv/angelpay/report-validation — Task 14', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedMarkValidated.mockResolvedValue({ id: 'acct-1' })
    mockedRecordError.mockResolvedValue({ id: 'acct-1' })
  })

  it('AUTHENTICATED → calls markAngelPayUserAccountValidated and returns 204', async () => {
    const req = makeReq({ accountId: 'acct-1', state: 'AUTHENTICATED', externalUserId: 4242 })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayValidation(req, res, next)

    expect(mockedMarkValidated).toHaveBeenCalledWith('acct-1', 4242)
    expect(mockedRecordError).not.toHaveBeenCalled()
    expect(res.__status).toBe(204)
    expect(res.__ended).toBe(true)
    expect(next).not.toHaveBeenCalled()
  })

  it('AUTH_ERROR → calls recordAngelPayUserAccountError with the provided error and returns 204', async () => {
    const req = makeReq({ accountId: 'acct-1', state: 'AUTH_ERROR', error: 'Invalid PIN' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayValidation(req, res, next)

    expect(mockedRecordError).toHaveBeenCalledWith('acct-1', 'Invalid PIN')
    expect(mockedMarkValidated).not.toHaveBeenCalled()
    expect(res.__status).toBe(204)
    expect(res.__ended).toBe(true)
    expect(next).not.toHaveBeenCalled()
  })

  it('CONFIG_MISMATCH → records error with stringified diff arrays and returns 204', async () => {
    const req = makeReq({
      accountId: 'acct-1',
      state: 'CONFIG_MISMATCH',
      missingInAvoqado: [101, 102],
      missingInSdk: [201],
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayValidation(req, res, next)

    expect(mockedRecordError).toHaveBeenCalledTimes(1)
    const [accountIdArg, messageArg] = mockedRecordError.mock.calls[0]
    expect(accountIdArg).toBe('acct-1')
    expect(messageArg).toContain('CONFIG_MISMATCH')
    expect(messageArg).toContain('missingInAvoqado=[101,102]')
    expect(messageArg).toContain('missingInSdk=[201]')
    expect(res.__status).toBe(204)
    expect(res.__ended).toBe(true)
    expect(next).not.toHaveBeenCalled()
  })

  it('Unknown state → forwards BadRequestError via next() (no DB writes)', async () => {
    const req = makeReq({ accountId: 'acct-1', state: 'BOGUS' as any })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayValidation(req, res, next)

    expect(mockedMarkValidated).not.toHaveBeenCalled()
    expect(mockedRecordError).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    const err = (next as jest.Mock).mock.calls[0][0]
    expect(err).toBeDefined()
    expect(err.statusCode).toBe(400)
    expect(err.message).toMatch(/Unknown state/)
  })

  it('AUTHENTICATED without externalUserId → forwards BadRequestError', async () => {
    const req = makeReq({ accountId: 'acct-1', state: 'AUTHENTICATED' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayValidation(req, res, next)

    expect(mockedMarkValidated).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    const err = (next as jest.Mock).mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toMatch(/externalUserId/)
  })

  it('Missing accountId → forwards BadRequestError', async () => {
    const req = makeReq({ state: 'AUTHENTICATED', externalUserId: 1 } as any)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayValidation(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    const err = (next as jest.Mock).mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toMatch(/accountId/)
  })
})

describe('POST /tpv/angelpay/report-merchant-switch — Task 14', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns 204 after logging the switch event with terminal context', async () => {
    const req = makeReq({ fromMerchantId: 'ma-1', toMerchantId: 'ma-2', durationMs: 850 })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayMerchantSwitch(req, res, next)

    expect(res.__status).toBe(204)
    expect(res.__ended).toBe(true)
    expect(next).not.toHaveBeenCalled()
    // No DB writes from the merchant-switch endpoint
    expect(mockedMarkValidated).not.toHaveBeenCalled()
    expect(mockedRecordError).not.toHaveBeenCalled()
  })

  it('accepts null fromMerchantId (first-ever activation) and returns 204', async () => {
    const req = makeReq({ fromMerchantId: null, toMerchantId: 'ma-2', durationMs: 120 })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayMerchantSwitch(req, res, next)

    expect(res.__status).toBe(204)
    expect(next).not.toHaveBeenCalled()
  })

  it('missing toMerchantId → forwards BadRequestError', async () => {
    const req = makeReq({ fromMerchantId: 'ma-1', durationMs: 100 } as any)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reportAngelPayMerchantSwitch(req, res, next)

    expect(res.__ended).toBe(false)
    expect(next).toHaveBeenCalledTimes(1)
    const err = (next as jest.Mock).mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toMatch(/toMerchantId/)
  })
})
