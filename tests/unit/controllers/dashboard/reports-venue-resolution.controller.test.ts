/**
 * Regression guard: the Sales Summary / Sales by Item report controllers must
 * scope their DATA query to the request's ACTIVE venue — resolved the same way
 * checkPermission('reports:read') does (`:venueId` param -> `x-venue-id` header
 * -> JWT venue) — NOT the raw JWT venue.
 *
 * Bug (found 2026-06-04 via /full-testing): both controllers read
 * `req.authContext.venueId`, i.e. the login-default venue baked into the JWT.
 * A multi-venue user who reached a non-default venue via URL/deep-link (without a
 * switchVenue call) saw the WRONG venue's sales — the URL said venue A but the
 * report returned venue B's numbers. The dashboard now sends `x-venue-id`; these
 * controllers must honor it.
 *
 * With the bug present, the first assertion fails: the controller passes
 * 'jwt-venue' to the service instead of the header's 'url-venue'.
 */

import type { Request, Response } from 'express'

jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  getSalesSummary: jest.fn().mockResolvedValue({ summary: {} }),
}))
jest.mock('@/services/dashboard/sales-by-item.dashboard.service', () => ({
  getSalesByItem: jest.fn().mockResolvedValue({ items: [] }),
}))
// MINDFORM_NEW_VENUE_ID is only used by the QR_LEGACY guard (not exercised here);
// mock the legacy module so the unit test doesn't pull its heavy load path.
jest.mock('@/services/legacy/qrPayments.legacy.service', () => ({ MINDFORM_NEW_VENUE_ID: 'mindform-venue' }))

import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { salesSummaryReport } from '@/controllers/dashboard/sales-summary.dashboard.controller'
import { salesByItemReport } from '@/controllers/dashboard/sales-by-item.dashboard.controller'
import { prismaMock } from '@tests/__helpers__/setup'

function makeRes(): Response {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response
}

function makeReq(headers: Record<string, string>): Request {
  return {
    authContext: { venueId: 'jwt-venue', userId: 'u1', orgId: 'o1', role: 'OWNER' },
    query: { startDate: '2026-01-01', endDate: '2026-01-31' },
    headers,
    params: {},
  } as unknown as Request
}

describe('reports venue resolution — follows x-venue-id over the stale JWT venue', () => {
  beforeEach(() => {
    ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
  })

  it('sales-summary scopes the data query to the x-venue-id header', async () => {
    await salesSummaryReport(makeReq({ 'x-venue-id': 'url-venue' }), makeRes(), jest.fn())
    expect(getSalesSummary).toHaveBeenCalledWith('url-venue', expect.any(Object))
  })

  it('sales-summary falls back to the JWT venue when no x-venue-id header is sent', async () => {
    await salesSummaryReport(makeReq({}), makeRes(), jest.fn())
    expect(getSalesSummary).toHaveBeenCalledWith('jwt-venue', expect.any(Object))
  })

  it('sales-by-item scopes the data query to the x-venue-id header', async () => {
    await salesByItemReport(makeReq({ 'x-venue-id': 'url-venue' }), makeRes(), jest.fn())
    expect(getSalesByItem).toHaveBeenCalledWith('url-venue', expect.any(Object))
  })
})
