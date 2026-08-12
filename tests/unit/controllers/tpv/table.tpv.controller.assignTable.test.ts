/**
 * table.tpv.controller.ts::assignTable — actor MUST come from the token (open finding #4).
 *
 * Before this fix, `staffId` was read straight off `req.body` — any caller could
 * attribute a table assignment to ANY staffId it chose to send, regardless of who
 * was actually authenticated. The actor must always come from `authContext.userId`
 * (same pattern already used by `openTable` in mobile/table.mobile.controller.ts,
 * which this file re-exports for the sibling route).
 */


// A test file with no top-level import/export is a SCRIPT, not a module, so its
// top-level `const`s land in the global scope and collide across files — two
// suites both declaring `mockSend` broke the typecheck, not the tests. This
// keeps the file a module even when it needs no imports.
export {}
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

describe('table.tpv.controller.assignTable — actor from token (open finding #4)', () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  // NEW FEATURE TEST — the fix itself.
  it('uses authContext.userId as the actor, IGNORING a different staffId sent in the body', async () => {
    const assignTableService = jest.fn().mockResolvedValue({
      order: { id: 'order-1' },
      isNewOrder: true,
    })
    jest.doMock('@/services/tpv/table.tpv.service', () => ({ assignTable: assignTableService }))

    const { assignTable } = await import('@/controllers/tpv/table.tpv.controller')

    const req: any = {
      params: { venueId: 'venue-1' },
      body: { tableId: 'table-1', staffId: 'staff-ATTACKER-SUPPLIED', covers: 2, terminalId: 'term-1' },
      authContext: { userId: 'staff-REAL-TOKEN-OWNER', venueId: 'venue-1', role: 'WAITER' },
    }
    const json = jest.fn()
    const res: any = { status: jest.fn().mockReturnValue({ json }) }

    await assignTable(req, res)

    expect(assignTableService).toHaveBeenCalledWith('venue-1', 'table-1', 'staff-REAL-TOKEN-OWNER', 2, 'term-1')
    expect(res.status).toHaveBeenCalledWith(201)
  })

  // Edge case: no token identity at all → refuse, never silently fall back to the body.
  it('401s when there is no authContext (never falls back to a body-supplied staffId)', async () => {
    const assignTableService = jest.fn()
    jest.doMock('@/services/tpv/table.tpv.service', () => ({ assignTable: assignTableService }))

    const { assignTable } = await import('@/controllers/tpv/table.tpv.controller')

    const req: any = {
      params: { venueId: 'venue-1' },
      body: { tableId: 'table-1', staffId: 'staff-ATTACKER-SUPPLIED', covers: 2 },
      // no authContext
    }
    const json = jest.fn()
    const res: any = { status: jest.fn().mockReturnValue({ json }) }

    await assignTable(req, res)

    expect(assignTableService).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  // REGRESSION — tableId/covers/terminalId still flow through, existing-order (200) path intact.
  it('regression: still resolves an existing order (200, isNewOrder=false) and forwards tableId/covers/terminalId', async () => {
    const assignTableService = jest.fn().mockResolvedValue({ order: { id: 'order-1' }, isNewOrder: false })
    jest.doMock('@/services/tpv/table.tpv.service', () => ({ assignTable: assignTableService }))

    const { assignTable } = await import('@/controllers/tpv/table.tpv.controller')

    const req: any = {
      params: { venueId: 'venue-1' },
      body: { tableId: 'table-9', covers: 4 },
      authContext: { userId: 'staff-1', venueId: 'venue-1', role: 'WAITER' },
    }
    const json = jest.fn()
    const res: any = { status: jest.fn().mockReturnValue({ json }) }

    await assignTable(req, res)

    expect(assignTableService).toHaveBeenCalledWith('venue-1', 'table-9', 'staff-1', 4, undefined)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: { order: { id: 'order-1' }, isNewOrder: false, message: 'Table already has an active order' },
    })
  })
})
