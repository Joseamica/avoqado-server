/**
 * MerchantAccount superadmin controller — venueId wire-through tests
 * (Task 17 — Phase 2).
 *
 * Narrow scope: verify that `createMerchantAccount` (the HTTP handler)
 * forwards `req.body.venueId` to the service, and that omitting it stays
 * backward-compatible (no `venueId` reaches the service, so the Task 10
 * device-compat guard remains dormant for legacy Blumon flows).
 *
 * The service itself is mocked — Task 10 tests already cover the guard
 * behavior end-to-end against the real Prisma layer.
 *
 * Spec ref: §3.2, §4.4.
 */

import type { NextFunction, Request, Response } from 'express'

import { createMerchantAccount } from '@/controllers/superadmin/merchantAccount.controller'
import * as merchantAccountService from '@/services/superadmin/merchantAccount.service'

jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  createMerchantAccount: jest.fn(),
}))

const mockedCreate = merchantAccountService.createMerchantAccount as jest.Mock

interface FakeRes extends Response {
  __status: number
  __json: any
}

function makeRes(): FakeRes {
  const res: any = {}
  res.__status = 200
  res.__json = undefined
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((body: any) => {
    res.__json = body
    return res
  })
  res.end = jest.fn(() => res)
  return res as FakeRes
}

function makeReq(body: Record<string, any>): Request {
  return {
    params: {},
    query: {},
    body,
    user: { uid: 'admin-staff-1' },
  } as unknown as Request
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedCreate.mockResolvedValue({ id: 'acct-new', providerId: 'prov-1' })
})

describe('POST /superadmin/merchant-accounts — venueId forwarding (Task 17)', () => {
  it('forwards req.body.venueId to createMerchantAccount when present (AngelPay path)', async () => {
    const req = makeReq({
      providerId: 'prov-angelpay',
      externalMerchantId: '9814275',
      displayName: 'AngelPay Sucursal Centro',
      venueId: 'venue-xyz',
      credentials: { merchantId: 'placeholder', apiKey: 'placeholder' },
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await createMerchantAccount(req, res, next)

    expect(mockedCreate).toHaveBeenCalledTimes(1)
    const arg = mockedCreate.mock.calls[0][0]
    expect(arg).toMatchObject({
      providerId: 'prov-angelpay',
      externalMerchantId: '9814275',
      venueId: 'venue-xyz',
    })
    expect(res.__status).toBe(201)
    expect(next).not.toHaveBeenCalled()
  })

  it('does NOT pass a truthy venueId when absent — backward compat for Blumon callers', async () => {
    const req = makeReq({
      providerId: 'prov-blumon',
      externalMerchantId: 'blumon_2841548417',
      blumonSerialNumber: '2841548417',
      // intentionally NO venueId — legacy Blumon manual creation flow
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await createMerchantAccount(req, res, next)

    expect(mockedCreate).toHaveBeenCalledTimes(1)
    const arg = mockedCreate.mock.calls[0][0]
    // Either omitted entirely or explicitly undefined — both must keep the
    // service's `if (data.venueId)` guard dormant. Asserting falsy covers both.
    expect(arg.venueId).toBeFalsy()
    expect(arg).toMatchObject({
      providerId: 'prov-blumon',
      externalMerchantId: 'blumon_2841548417',
      blumonSerialNumber: '2841548417',
    })
    expect(next).not.toHaveBeenCalled()
  })
})
