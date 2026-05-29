/**
 * Settlement Incident controller — confirmedBy attribution tests.
 *
 * Regression guard for the 2026-05-29 production bug: the controller read
 * the actor from `req.user?.id` (which does NOT exist in this codebase —
 * the authenticated actor lives in `req.authContext`) and fell back to the
 * literal string `'unknown'`. That string was then persisted as
 * SettlementConfirmation.confirmedBy / SettlementIncident.resolvedBy AND
 * passed to logAction({ staffId: 'unknown' }), which blew up the
 * ActivityLog_staffId_fkey foreign key on every confirmation.
 *
 * These tests assert the real authenticated staff id is forwarded to the
 * service, and that the legacy `'unknown'` sentinel never reaches it again.
 *
 * The service is mocked — we only verify the controller wiring.
 */

import type { NextFunction, Request, Response } from 'express'

import { confirmIncident, bulkConfirmIncidents } from '@/controllers/dashboard/settlementIncident.dashboard.controller'
import * as settlementIncidentService from '@/services/dashboard/settlementIncident.service'

jest.mock('@/services/dashboard/settlementIncident.service', () => ({
  confirmSettlementIncident: jest.fn(),
  bulkConfirmSettlementIncidents: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

const mockedConfirm = settlementIncidentService.confirmSettlementIncident as jest.Mock
const mockedBulkConfirm = settlementIncidentService.bulkConfirmSettlementIncidents as jest.Mock

function makeRes(): Response {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as Response
}

function makeReq(over: { params?: Record<string, any>; body?: Record<string, any>; authContext?: any }): Request {
  return {
    params: over.params ?? {},
    query: {},
    body: over.body ?? {},
    authContext: over.authContext,
  } as unknown as Request
}

const REAL_STAFF_ID = 'cmoklopgf00nnlh28lx4k63uu'

beforeEach(() => {
  jest.clearAllMocks()
  mockedConfirm.mockResolvedValue({ incident: { id: 'inc-1' } })
  mockedBulkConfirm.mockResolvedValue({ confirmed: 3, failed: 0, results: [] })
})

describe('confirmIncident — confirmedBy attribution', () => {
  it('forwards the authenticated staff id (authContext.userId) as confirmedBy', async () => {
    const req = makeReq({
      params: { venueId: 'venue-1', incidentId: 'inc-1' },
      body: { settlementArrived: true, actualDate: '2026-05-29T00:00:00.000Z' },
      authContext: { userId: REAL_STAFF_ID, venueId: 'venue-1', role: 'ADMIN' },
    })

    await confirmIncident(req as any, makeRes(), jest.fn() as unknown as NextFunction)

    expect(mockedConfirm).toHaveBeenCalledTimes(1)
    // signature: (incidentId, confirmedBy, settlementArrived, actualDate?, notes?)
    expect(mockedConfirm.mock.calls[0][1]).toBe(REAL_STAFF_ID)
  })

  it("regression: never passes the legacy 'unknown' sentinel", async () => {
    const req = makeReq({
      params: { venueId: 'venue-1', incidentId: 'inc-1' },
      body: { settlementArrived: false },
      authContext: { userId: REAL_STAFF_ID, venueId: 'venue-1', role: 'ADMIN' },
    })

    await confirmIncident(req as any, makeRes(), jest.fn() as unknown as NextFunction)

    expect(mockedConfirm.mock.calls[0][1]).not.toBe('unknown')
  })
})

describe('bulkConfirmIncidents — confirmedBy attribution', () => {
  it('forwards the authenticated staff id (authContext.userId) as confirmedBy', async () => {
    const req = makeReq({
      params: { venueId: 'venue-1' },
      body: { incidentIds: ['inc-1', 'inc-2', 'inc-3'], settlementArrived: true },
      authContext: { userId: REAL_STAFF_ID, venueId: 'venue-1', role: 'ADMIN' },
    })

    await bulkConfirmIncidents(req as any, makeRes(), jest.fn() as unknown as NextFunction)

    expect(mockedBulkConfirm).toHaveBeenCalledTimes(1)
    // signature: (venueId, incidentIds, confirmedBy, settlementArrived, actualDate?, notes?)
    expect(mockedBulkConfirm.mock.calls[0][2]).toBe(REAL_STAFF_ID)
  })

  it("regression: never passes the legacy 'unknown' sentinel", async () => {
    const req = makeReq({
      params: { venueId: 'venue-1' },
      body: { incidentIds: ['inc-1'], settlementArrived: true },
      authContext: { userId: REAL_STAFF_ID, venueId: 'venue-1', role: 'ADMIN' },
    })

    await bulkConfirmIncidents(req as any, makeRes(), jest.fn() as unknown as NextFunction)

    expect(mockedBulkConfirm.mock.calls[0][2]).not.toBe('unknown')
  })
})
