/**
 * Cash Out (PlayTelecom) ORG-scoped controller handlers — thin HTTP layer unit tests.
 * Proves each handler delegates to the correct org-scoped service function with
 * req.params.orgId + { staffId: authContext.userId }, and that putOrgCommissionRates
 * maps CashOutValidationError -> 400 { success:false, message, errors }.
 */
jest.mock('@/services/dashboard/cash-out/cash-out.config.service', () => ({
  listCommissionRatesForOrg: jest.fn(),
  replaceCommissionRatesForOrg: jest.fn(),
  listActiveDaysForOrg: jest.fn(),
  setActiveDaysForOrg: jest.fn(),
  CashOutValidationError: class CashOutValidationError extends Error {
    errors: string[]
    constructor(errors: string[]) {
      super(errors.join(' '))
      this.name = 'CashOutValidationError'
      this.errors = errors
    }
  },
}))

jest.mock('@/services/dashboard/cash-out/cash-out.org.service', () => ({
  listWithdrawalsForOrg: jest.fn(),
  generateOrgDispersionReport: jest.fn(),
}))

// The controller also imports these venue-scoped services at module load time —
// mock them so importing the controller has no unrelated side effects.
jest.mock('@/services/dashboard/cash-out/cash-out.ledger.service', () => ({
  materializeEntries: jest.fn(),
  getSaldo: jest.fn(),
}))
jest.mock('@/services/dashboard/cash-out/cash-out.withdrawal.service', () => ({
  createWithdrawal: jest.fn(),
  listWithdrawals: jest.fn(),
}))
jest.mock('@/services/dashboard/cash-out/cash-out.report.service', () => ({
  generateDispersionReport: jest.fn(),
}))

import type { NextFunction, Request, Response } from 'express'
import * as configService from '@/services/dashboard/cash-out/cash-out.config.service'
import { CashOutValidationError } from '@/services/dashboard/cash-out/cash-out.config.service'
import * as orgService from '@/services/dashboard/cash-out/cash-out.org.service'
import {
  getOrgCommissionRates,
  putOrgCommissionRates,
  getOrgActiveDays,
  putOrgActiveDays,
  getOrgWithdrawals,
  postOrgReport,
} from '@/controllers/dashboard/cash-out.dashboard.controller'

function makeRes(): Response {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response
}

function makeReq(overrides: Partial<any> = {}): Request {
  return {
    params: { orgId: 'org1' },
    query: {},
    body: {},
    authContext: { userId: 's1' },
    ...overrides,
  } as unknown as Request
}

beforeEach(() => jest.clearAllMocks())

describe('getOrgCommissionRates', () => {
  it('delegates to listCommissionRatesForOrg with req.params.orgId', async () => {
    const rates = [{ id: 'r1' }]
    ;(configService.listCommissionRatesForOrg as jest.Mock).mockResolvedValue(rates)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getOrgCommissionRates(makeReq(), res, next)

    expect(configService.listCommissionRatesForOrg).toHaveBeenCalledWith('org1')
    expect(res.json).toHaveBeenCalledWith({ data: rates })
    expect(next).not.toHaveBeenCalled()
  })

  it('forwards service errors to next()', async () => {
    const err = new Error('boom')
    ;(configService.listCommissionRatesForOrg as jest.Mock).mockRejectedValue(err)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getOrgCommissionRates(makeReq(), res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
})

describe('putOrgCommissionRates', () => {
  it('delegates to replaceCommissionRatesForOrg with orgId, body.rates, and actor', async () => {
    const rates = [{ saleType: 'LINEA_NUEVA', minCount: 1, maxCount: null, amount: 10 }]
    ;(configService.replaceCommissionRatesForOrg as jest.Mock).mockResolvedValue(rates)
    const req = makeReq({ body: { rates } })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await putOrgCommissionRates(req, res, next)

    expect(configService.replaceCommissionRatesForOrg).toHaveBeenCalledWith('org1', rates, { staffId: 's1' })
    expect(res.json).toHaveBeenCalledWith({ data: rates })
    expect(next).not.toHaveBeenCalled()
  })

  it('maps CashOutValidationError to 400 with success:false, message, errors', async () => {
    const validationError = new CashOutValidationError(['La comisión no puede ser negativa.'])
    ;(configService.replaceCommissionRatesForOrg as jest.Mock).mockRejectedValue(validationError)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await putOrgCommissionRates(makeReq({ body: { rates: [] } }), res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: validationError.message,
      errors: ['La comisión no puede ser negativa.'],
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('forwards non-validation errors to next()', async () => {
    const err = new Error('DB down')
    ;(configService.replaceCommissionRatesForOrg as jest.Mock).mockRejectedValue(err)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await putOrgCommissionRates(makeReq({ body: { rates: [] } }), res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.status).not.toHaveBeenCalled()
  })
})

describe('getOrgActiveDays', () => {
  it('delegates to listActiveDaysForOrg with orgId, from, to', async () => {
    const days = ['2026-07-06']
    ;(configService.listActiveDaysForOrg as jest.Mock).mockResolvedValue(days)
    const req = makeReq({ query: { from: '2026-07-01', to: '2026-07-31' } })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getOrgActiveDays(req, res, next)

    expect(configService.listActiveDaysForOrg).toHaveBeenCalledWith('org1', '2026-07-01', '2026-07-31')
    expect(res.json).toHaveBeenCalledWith({ data: days })
  })

  it('forwards service errors to next()', async () => {
    const err = new Error('boom')
    ;(configService.listActiveDaysForOrg as jest.Mock).mockRejectedValue(err)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getOrgActiveDays(makeReq(), res, next)

    expect(next).toHaveBeenCalledWith(err)
  })
})

describe('putOrgActiveDays', () => {
  it('delegates to setActiveDaysForOrg with orgId, body.days, and actor', async () => {
    const days = ['2026-07-06', '2026-07-07']
    ;(configService.setActiveDaysForOrg as jest.Mock).mockResolvedValue(days)
    const req = makeReq({ body: { days } })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await putOrgActiveDays(req, res, next)

    expect(configService.setActiveDaysForOrg).toHaveBeenCalledWith('org1', days, { staffId: 's1' })
    expect(res.json).toHaveBeenCalledWith({ data: days })
  })

  it('forwards service errors to next()', async () => {
    const err = new Error('boom')
    ;(configService.setActiveDaysForOrg as jest.Mock).mockRejectedValue(err)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await putOrgActiveDays(makeReq({ body: { days: [] } }), res, next)

    expect(next).toHaveBeenCalledWith(err)
  })
})

describe('getOrgWithdrawals', () => {
  it('delegates to orgService.listWithdrawalsForOrg with orgId, businessDate, status', async () => {
    const items = [{ id: 'w1' }]
    ;(orgService.listWithdrawalsForOrg as jest.Mock).mockResolvedValue(items)
    const req = makeReq({ query: { businessDate: '2026-07-06', status: 'REQUESTED' } })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getOrgWithdrawals(req, res, next)

    expect(orgService.listWithdrawalsForOrg).toHaveBeenCalledWith('org1', { businessDate: '2026-07-06', status: 'REQUESTED' })
    expect(res.json).toHaveBeenCalledWith({ data: items })
  })

  it('forwards service errors to next()', async () => {
    const err = new Error('boom')
    ;(orgService.listWithdrawalsForOrg as jest.Mock).mockRejectedValue(err)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getOrgWithdrawals(makeReq(), res, next)

    expect(next).toHaveBeenCalledWith(err)
  })
})

describe('postOrgReport', () => {
  it('delegates to orgService.generateOrgDispersionReport with orgId, businessDate, and actor', async () => {
    const rep = { orgId: 'org1', rows: [], totalNet: '0', count: 0 }
    ;(orgService.generateOrgDispersionReport as jest.Mock).mockResolvedValue(rep)
    const req = makeReq({ body: { businessDate: '2026-07-06' } })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await postOrgReport(req, res, next)

    expect(orgService.generateOrgDispersionReport).toHaveBeenCalledWith('org1', { businessDate: '2026-07-06' }, { staffId: 's1' })
    expect(res.json).toHaveBeenCalledWith({ data: rep })
  })

  it('forwards service errors to next()', async () => {
    const err = new Error('boom')
    ;(orgService.generateOrgDispersionReport as jest.Mock).mockRejectedValue(err)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await postOrgReport(makeReq({ body: {} }), res, next)

    expect(next).toHaveBeenCalledWith(err)
  })
})
