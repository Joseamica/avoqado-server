/**
 * table.tpv.controller.ts::getTables — table-ownership fields (gap fix, 2026-07-29).
 *
 * `GET /tpv/venues/:venueId/tables` used to respond `{ success, data }` only — missing
 * the `settings`/`viewer` envelope fields `/mobile`'s equivalent
 * (`table.mobile.controller.ts::getTables`) already sends. Those two fields are what let
 * a terminal know whether it can edit a given table's check under `enforceTableOwnership`
 * (VenueSettings PRO). Without them, two terminals could open the same table and neither
 * would notice until their intents collided on replay
 * (.claude/rules/offline-first-y-hub-lan.md).
 *
 * Fix: `getTables` is now a literal re-export of `/mobile`'s controller — same pattern
 * already used for `openTable` (this file) and `syncIntents` (sync.tpv.controller.ts).
 * This file pins the re-export itself (so a future edit can't silently fork the two
 * namespaces) AND the actual response shape (so the envelope fields are locked in, not
 * just "some handler runs").
 */

import * as tableTpvController from '@/controllers/tpv/table.tpv.controller'
import * as tableMobileController from '@/controllers/mobile/table.mobile.controller'

describe('table.tpv.controller.getTables — parity with /mobile (no drift)', () => {
  // NEW FEATURE TEST
  it('delegates to the SAME handler as /mobile (re-export, not a copy)', () => {
    expect(tableTpvController.getTables).toBe(tableMobileController.getTables)
  })

  // REGRESSION TEST — catches a broken import / accidental default export that would
  // otherwise pass the `.toBe` comparison only because both sides are `undefined`.
  it('the exported handler is a real function (not undefined)', () => {
    expect(typeof tableTpvController.getTables).toBe('function')
  })
})

describe('table.tpv.controller.getTables — response shape', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('the envelope carries data + settings.enforceTableOwnership + viewer.staffId/canManageAllTables', async () => {
    jest.doMock('@/services/tpv/table.tpv.service', () => ({
      getTablesWithStatus: jest.fn().mockResolvedValue([{ id: 'table-1', number: '5', status: 'AVAILABLE' }]),
    }))
    jest.doMock('@/middlewares/checkTableOwnership.middleware', () => ({
      isTableOwnershipEnforced: jest.fn().mockResolvedValue(true),
      staffCanManageAllTables: jest.fn().mockResolvedValue(false),
    }))
    jest.doMock('@/config/logger', () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }))

    const { getTables } = await import('@/controllers/tpv/table.tpv.controller')

    const req: any = {
      params: { venueId: 'venue-1' },
      authContext: { userId: 'staff-1', venueId: 'venue-1', role: 'WAITER' },
    }
    const json = jest.fn()
    const res: any = { status: jest.fn().mockReturnValue({ json }) }

    await getTables(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: [{ id: 'table-1', number: '5', status: 'AVAILABLE' }],
      settings: { enforceTableOwnership: true },
      viewer: { staffId: 'staff-1', canManageAllTables: false },
    })
  })

  it('regression: data array is untouched (same shape as before the fix, just siblings added)', async () => {
    const tables = [{ id: 'table-1', number: '5', status: 'OCCUPIED', openOrders: [] }]
    jest.doMock('@/services/tpv/table.tpv.service', () => ({
      getTablesWithStatus: jest.fn().mockResolvedValue(tables),
    }))
    jest.doMock('@/middlewares/checkTableOwnership.middleware', () => ({
      isTableOwnershipEnforced: jest.fn().mockResolvedValue(false),
      staffCanManageAllTables: jest.fn().mockResolvedValue(true),
    }))
    jest.doMock('@/config/logger', () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }))

    const { getTables } = await import('@/controllers/tpv/table.tpv.controller')

    const req: any = { params: { venueId: 'venue-1' }, authContext: { userId: 'staff-2', venueId: 'venue-1' } }
    const json = jest.fn()
    const res: any = { status: jest.fn().mockReturnValue({ json }) }

    await getTables(req, res)

    expect(json.mock.calls[0][0].data).toEqual(tables)
  })
})
