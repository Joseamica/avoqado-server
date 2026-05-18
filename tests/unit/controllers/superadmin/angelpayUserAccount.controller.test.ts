/**
 * AngelPayUserAccount superadmin controller tests (Task 15 — Phase 2).
 *
 * Mocks @/services/superadmin/angelpayUserAccount.service so these tests
 * exercise ONLY the controller's branching, body validation, and response
 * shape. Follows the same pattern as
 * tests/unit/controllers/tpv/angelpayValidation.tpv.controller.test.ts.
 *
 * Spec ref: §4.5.
 */

import type { NextFunction, Request, Response } from 'express'

import {
  createAngelPayUserAccountForVenue,
  deleteAngelPayUserAccountController,
  getAngelPayUserAccountForVenue,
  setAngelPayUserAccountPinController,
  updateAngelPayUserAccountStatusController,
} from '@/controllers/superadmin/angelpayUserAccount.controller'
import {
  createAngelPayUserAccount,
  getAngelPayUserAccountById,
  getAngelPayUserAccountByVenueId,
  markAngelPayUserAccountRotationRequired,
  setAngelPayUserAccountPin,
  softDeleteAngelPayUserAccount,
  suspendAngelPayUserAccount,
} from '@/services/superadmin/angelpayUserAccount.service'

jest.mock('@/services/superadmin/angelpayUserAccount.service', () => ({
  createAngelPayUserAccount: jest.fn(),
  getAngelPayUserAccountById: jest.fn(),
  getAngelPayUserAccountByVenueId: jest.fn(),
  markAngelPayUserAccountRotationRequired: jest.fn(),
  setAngelPayUserAccountPin: jest.fn(),
  softDeleteAngelPayUserAccount: jest.fn(),
  suspendAngelPayUserAccount: jest.fn(),
}))

const mockedCreate = createAngelPayUserAccount as jest.Mock
const mockedGetById = getAngelPayUserAccountById as jest.Mock
const mockedGetByVenue = getAngelPayUserAccountByVenueId as jest.Mock
const mockedMarkRotation = markAngelPayUserAccountRotationRequired as jest.Mock
const mockedSetPin = setAngelPayUserAccountPin as jest.Mock
const mockedSoftDelete = softDeleteAngelPayUserAccount as jest.Mock
const mockedSuspend = suspendAngelPayUserAccount as jest.Mock

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

function makeReq(overrides: Partial<Request> & { user?: any } = {}): Request {
  const base: any = {
    params: {},
    body: {},
    query: {},
    user: { uid: 'admin-staff-1' },
  }
  return { ...base, ...overrides } as Request
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('GET /superadmin/venues/:venueId/angelpay-account', () => {
  it('returns the account (without pinEncrypted) when one exists', async () => {
    mockedGetByVenue.mockResolvedValue({
      id: 'acct-1',
      venueId: 'venue-1',
      email: 'a@b.com',
      pinEncrypted: { encrypted: 'should-not-leak', iv: 'iv' },
      status: 'ACTIVE',
    })

    const req = makeReq({ params: { venueId: 'venue-1' } as any })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getAngelPayUserAccountForVenue(req, res, next)

    expect(mockedGetByVenue).toHaveBeenCalledWith('venue-1')
    expect(res.__status).toBe(200)
    expect(res.__json.success).toBe(true)
    expect(res.__json.data.id).toBe('acct-1')
    expect(res.__json.data.pinEncrypted).toBeUndefined()
    expect(next).not.toHaveBeenCalled()
  })

  it('returns data:null when venue has no account', async () => {
    mockedGetByVenue.mockResolvedValue(null)

    const req = makeReq({ params: { venueId: 'venue-2' } as any })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getAngelPayUserAccountForVenue(req, res, next)

    expect(res.__json).toEqual({ success: true, data: null })
    expect(next).not.toHaveBeenCalled()
  })
})

describe('POST /superadmin/venues/:venueId/angelpay-account', () => {
  it('creates an account and returns 201 with sanitized payload', async () => {
    mockedCreate.mockResolvedValue({
      id: 'acct-new',
      venueId: 'venue-1',
      email: 'ops@venue.com',
      environment: 'QA',
      status: 'PENDING_PIN',
      pinEncrypted: null,
    })

    const req = makeReq({
      params: { venueId: 'venue-1' } as any,
      body: { email: 'ops@venue.com', environment: 'QA' },
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await createAngelPayUserAccountForVenue(req, res, next)

    expect(mockedCreate).toHaveBeenCalledWith({
      venueId: 'venue-1',
      email: 'ops@venue.com',
      pin: undefined,
      environment: 'QA',
      createdBy: 'admin-staff-1',
    })
    expect(res.__status).toBe(201)
    expect(res.__json.data.id).toBe('acct-new')
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects invalid environment via next(BadRequestError)', async () => {
    const req = makeReq({
      params: { venueId: 'venue-1' } as any,
      body: { email: 'a@b.com', environment: 'STAGING' },
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await createAngelPayUserAccountForVenue(req, res, next)

    expect(mockedCreate).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({ statusCode: 400 })
  })
})

describe('PATCH /superadmin/angelpay-accounts/:id/pin', () => {
  it('rotates the PIN when the account exists', async () => {
    mockedGetById.mockResolvedValue({ id: 'acct-1' })
    mockedSetPin.mockResolvedValue({
      id: 'acct-1',
      status: 'ACTIVE',
      pinEncrypted: { encrypted: 'x', iv: 'y' },
    })

    const req = makeReq({ params: { id: 'acct-1' } as any, body: { pin: '654321' } })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await setAngelPayUserAccountPinController(req, res, next)

    expect(mockedSetPin).toHaveBeenCalledWith('acct-1', '654321')
    expect(res.__json.data.pinEncrypted).toBeUndefined()
    expect(res.__json.data.status).toBe('ACTIVE')
  })

  it('returns 404 via next(NotFoundError) when the account does not exist', async () => {
    mockedGetById.mockResolvedValue(null)

    const req = makeReq({ params: { id: 'missing' } as any, body: { pin: '123456' } })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await setAngelPayUserAccountPinController(req, res, next)

    expect(mockedSetPin).not.toHaveBeenCalled()
    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({ statusCode: 404 })
  })
})

describe('PATCH /superadmin/angelpay-accounts/:id/status', () => {
  beforeEach(() => {
    mockedGetById.mockResolvedValue({ id: 'acct-1' })
  })

  it('dispatches to markAngelPayUserAccountRotationRequired for PIN_ROTATION_REQUIRED', async () => {
    mockedMarkRotation.mockResolvedValue({ id: 'acct-1', status: 'PIN_ROTATION_REQUIRED' })

    const req = makeReq({
      params: { id: 'acct-1' } as any,
      body: { status: 'PIN_ROTATION_REQUIRED', reason: 'leaked credentials' },
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await updateAngelPayUserAccountStatusController(req, res, next)

    expect(mockedMarkRotation).toHaveBeenCalledWith('acct-1', 'leaked credentials', 'admin-staff-1')
    expect(mockedSuspend).not.toHaveBeenCalled()
    expect(res.__json.data.status).toBe('PIN_ROTATION_REQUIRED')
  })

  it('dispatches to suspendAngelPayUserAccount for SUSPENDED', async () => {
    mockedSuspend.mockResolvedValue({ id: 'acct-1', status: 'SUSPENDED' })

    const req = makeReq({
      params: { id: 'acct-1' } as any,
      body: { status: 'SUSPENDED', reason: 'fraud investigation' },
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await updateAngelPayUserAccountStatusController(req, res, next)

    expect(mockedSuspend).toHaveBeenCalledWith('acct-1', 'fraud investigation', 'admin-staff-1')
    expect(mockedMarkRotation).not.toHaveBeenCalled()
    expect(res.__json.data.status).toBe('SUSPENDED')
  })

  it('rejects unsupported status transitions via next(BadRequestError)', async () => {
    const req = makeReq({
      params: { id: 'acct-1' } as any,
      body: { status: 'ACTIVE', reason: 'restore please' },
    })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await updateAngelPayUserAccountStatusController(req, res, next)

    expect(mockedMarkRotation).not.toHaveBeenCalled()
    expect(mockedSuspend).not.toHaveBeenCalled()
    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({ statusCode: 400 })
  })
})

describe('DELETE /superadmin/angelpay-accounts/:id', () => {
  it('soft-deletes when the account exists', async () => {
    mockedGetById.mockResolvedValue({ id: 'acct-1' })
    mockedSoftDelete.mockResolvedValue({ id: 'acct-1', status: 'DELETED' })

    const req = makeReq({ params: { id: 'acct-1' } as any })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await deleteAngelPayUserAccountController(req, res, next)

    expect(mockedSoftDelete).toHaveBeenCalledWith('acct-1', 'admin-staff-1')
    expect(res.__json.data.status).toBe('DELETED')
  })
})
