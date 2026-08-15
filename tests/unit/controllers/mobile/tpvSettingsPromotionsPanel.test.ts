/**
 * Mobile TPV Settings controller — promotions panel block on the venue-settings payload.
 *
 * Context (2026-08-15): the POS apps (iOS + Android) call GET /api/v1/mobile/venues/:venueId/settings
 * at venue-select and need to know WHERE to paint the promotions panel (cashier screen + customer
 * screen). The dashboard already writes VenueSettings.promotionsPanelCashier/promotionsPanelCustomer,
 * but that preference never reached the POS — this is the additive, OPTIONAL `promotions` block that
 * closes the gap:
 *
 *   promotions: { panelCashier: 'HIDDEN'|'TAB'|'SIDE_PANEL', panelCustomer: 'HIDDEN'|'TAB'|'SIDE_PANEL' }
 *
 * It is its own top-level block, a sibling of `settings` — NOT nested inside it — because `settings`
 * is TpvSettings (per-terminal) while this is VenueSettings (per-venue); mixing them would blur two
 * different scopes.
 *
 * Guarantees under test:
 *   1. The venue's configured panel modes are surfaced verbatim as `promotions.panelCashier/panelCustomer`.
 *   2. A venue with no VenueSettings row falls back to the Prisma schema defaults (TAB / SIDE_PANEL).
 *   3. RESILIENCE: same fail-open contract as `plan` on this same endpoint — a promotions-settings
 *      lookup failure must NEVER break venue-select. It is logged and the response falls back to the
 *      design defaults (unlike `plan`, which is omitted entirely on failure — `promotions` cannot be
 *      omitted because the POS needs SOME value to render the panel).
 *   4. Existing fields (terminals) are untouched — additive change only.
 */

import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'
import { getTpvSettings } from '@/services/dashboard/tpv.dashboard.service'

jest.mock('@/services/dashboard/tpv.dashboard.service', () => ({
  getTpvSettings: jest.fn(),
}))

const mockedGetTpvSettings = getTpvSettings as jest.MockedFunction<typeof getTpvSettings>

function makeRes(): Response & { __json: any } {
  const res: any = {}
  res.__json = undefined
  res.status = jest.fn(() => res)
  res.json = jest.fn((body: any) => {
    res.__json = body
    return res
  })
  return res
}

function makeReq(venueId: string): Request {
  return {
    params: { venueId },
    headers: {},
  } as unknown as Request
}

/** Same scaffold as tpvSettings.mobile.controller.test.ts: fake req/res, invoke the handler directly. */
async function callGetVenueTpvSettings({ venueId }: { venueId: string }) {
  const res = makeRes()
  const next = jest.fn() as NextFunction
  await getVenueTpvSettings(makeReq(venueId), res, next)
  expect(next).not.toHaveBeenCalled()
  return res.__json
}

describe('GET /mobile/venues/:venueId/settings — bloque promotions', () => {
  beforeEach(() => {
    // No terminals → settings null, no per-terminal settings lookup. Keeps the focus on `promotions`.
    prismaMock.terminal.findMany.mockResolvedValue([])
    mockedGetTpvSettings.mockResolvedValue({} as Awaited<ReturnType<typeof getTpvSettings>>)
  })

  it('devuelve los modos de panel configurados en el venue', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({
      promotionsPanelCashier: 'SIDE_PANEL',
      promotionsPanelCustomer: 'HIDDEN',
    })

    const body = await callGetVenueTpvSettings({ venueId: 'venue-1' })

    expect(body.success).toBe(true)
    expect(body.data.promotions).toEqual({ panelCashier: 'SIDE_PANEL', panelCustomer: 'HIDDEN' })
  })

  it('cae a los defaults del diseño cuando el venue no tiene fila de settings', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue(null)

    const body = await callGetVenueTpvSettings({ venueId: 'venue-sin-settings' })

    expect(body.data.promotions).toEqual({ panelCashier: 'TAB', panelCustomer: 'SIDE_PANEL' })
  })

  it('NO rompe el endpoint si la lectura de settings falla', async () => {
    prismaMock.venueSettings.findUnique.mockRejectedValue(new Error('db caída'))

    const body = await callGetVenueTpvSettings({ venueId: 'venue-1' })

    // Mismo criterio que `plan`: el POS falla abierto, jamás se queda sin poder vender.
    expect(body.success).toBe(true)
    expect(body.data.promotions).toEqual({ panelCashier: 'TAB', panelCustomer: 'SIDE_PANEL' })
    expect(body.data.terminals).toBeDefined()
    // ...y la falla queda visible en logs (mismo patrón que la resiliencia de `plan`).
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('promotions panel'), expect.objectContaining({ venueId: 'venue-1' }))
  })
})
