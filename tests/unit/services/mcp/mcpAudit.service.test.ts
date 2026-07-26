import { detectBadMcpExperiences, summarizeBadMcpReport, McpCallRow } from '../../../../src/services/mcp/mcpAudit.service'

// ─── fixture factory ──────────────────────────────────────────────────────
let seq = 0
function call(overrides: Partial<McpCallRow> = {}): McpCallRow {
  seq += 1
  return {
    toolName: 'daily_sales',
    staffId: 'staff_1',
    orgId: 'org_1',
    venueId: 'venue_1',
    outcome: 'ok',
    detail: null,
    durationMs: 20,
    createdAt: new Date(2026, 6, 23, 10, 0, seq % 60),
    ...overrides,
  }
}

describe('detectBadMcpExperiences', () => {
  it('empty window → no calls, no signal', () => {
    const r = detectBadMcpExperiences([], { windowHours: 12 })
    expect(r.totalCalls).toBe(0)
    expect(r.failedCalls).toBe(0)
    expect(r.errorRate).toBe(0)
    expect(r.hasSignal).toBe(false)
    expect(r.windowHours).toBe(12)
  })

  it('all-OK window → no signal, errorRate 0', () => {
    const r = detectBadMcpExperiences([call(), call(), call()])
    expect(r.totalCalls).toBe(3)
    expect(r.okCalls).toBe(3)
    expect(r.failedCalls).toBe(0)
    expect(r.errorRate).toBe(0)
    expect(r.hasSignal).toBe(false)
  })

  it('counts error + threw as failures and computes errorRate', () => {
    const calls = [call(), call({ outcome: 'error', detail: 'not found' }), call({ outcome: 'threw', detail: 'boom' }), call()]
    const r = detectBadMcpExperiences(calls)
    expect(r.totalCalls).toBe(4)
    expect(r.failedCalls).toBe(2) // error + threw
    expect(r.okCalls).toBe(2)
    expect(r.errorRate).toBeCloseTo(0.5)
    expect(r.hasSignal).toBe(true)
  })

  it('detects permission-denied failures as a distinct group (ES + EN wording)', () => {
    const calls = [
      call({ toolName: 'issue_refund', outcome: 'error', detail: 'permission denied: refunds:create' }),
      call({ toolName: 'payroll_run', outcome: 'error', detail: 'No autorizado para esta acción' }),
      call({ toolName: 'daily_sales', outcome: 'error', detail: 'not found' }), // NOT a permission issue
    ]
    const r = detectBadMcpExperiences(calls)
    const tools = r.permissionDenied.map(g => g.toolName).sort()
    expect(tools).toEqual(['issue_refund', 'payroll_run'])
    // the plain "not found" failure is in failuresByTool but not in permissionDenied
    expect(r.permissionDenied.find(g => g.toolName === 'daily_sales')).toBeUndefined()
    expect(r.failuresByTool.find(g => g.toolName === 'daily_sales')).toBeDefined()
  })

  it('groups failures by tool, most-failing first, deduping reasons', () => {
    const calls = [
      call({ toolName: 'find_customer', outcome: 'error', detail: 'not found' }),
      call({ toolName: 'find_customer', outcome: 'error', detail: 'not found' }), // dup reason
      call({ toolName: 'find_customer', outcome: 'error', detail: 'ambiguous' }),
      call({ toolName: 'top_products', outcome: 'error', detail: 'out of scope' }),
    ]
    const r = detectBadMcpExperiences(calls)
    expect(r.failuresByTool[0]).toMatchObject({ toolName: 'find_customer', count: 3 })
    expect(r.failuresByTool[0].reasons.sort()).toEqual(['ambiguous', 'not found'])
    expect(r.failuresByTool[1]).toMatchObject({ toolName: 'top_products', count: 1 })
  })

  it('flags a retry burst when the same caller hammers the same failing tool', () => {
    const calls = Array.from({ length: 5 }, () => call({ toolName: 'daily_sales', staffId: 'staff_9', outcome: 'error', detail: 'boom' }))
    const r = detectBadMcpExperiences(calls, { retryBurstThreshold: 4 })
    expect(r.retryBursts).toHaveLength(1)
    expect(r.retryBursts[0]).toMatchObject({ staffId: 'staff_9', toolName: 'daily_sales', count: 5 })
  })

  it('does NOT flag a burst below threshold, nor spread across different callers', () => {
    const spread = [
      call({ staffId: 'a', outcome: 'error', detail: 'x' }),
      call({ staffId: 'b', outcome: 'error', detail: 'x' }),
      call({ staffId: 'c', outcome: 'error', detail: 'x' }),
      call({ staffId: 'd', outcome: 'error', detail: 'x' }),
    ]
    const r = detectBadMcpExperiences(spread, { retryBurstThreshold: 4 })
    expect(r.retryBursts).toHaveLength(0) // 4 failures but 4 different callers
    expect(r.failedCalls).toBe(4)
  })

  it('lists affected venues and staff (deduped, nulls dropped)', () => {
    const calls = [
      call({ venueId: 'v1', staffId: 's1', outcome: 'error', detail: 'e' }),
      call({ venueId: 'v1', staffId: 's2', outcome: 'error', detail: 'e' }),
      call({ venueId: 'v2', staffId: 's1', outcome: 'error', detail: 'e' }),
      call({ venueId: null, staffId: null, outcome: 'threw', detail: 'e' }),
      call({ venueId: 'v3', staffId: 's3' }), // ok → not counted
    ]
    const r = detectBadMcpExperiences(calls)
    expect(r.affectedVenueIds.sort()).toEqual(['v1', 'v2'])
    expect(r.affectedStaffIds.sort()).toEqual(['s1', 's2'])
  })
})

describe('summarizeBadMcpReport', () => {
  it('returns a single healthy line when there is no signal', () => {
    const r = detectBadMcpExperiences([call(), call()])
    const lines = summarizeBadMcpReport(r)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('MCP sano')
    expect(lines[0]).toContain('2 llamadas')
  })

  it('describes failures, permission denials and bursts when there is signal', () => {
    const calls = [
      ...Array.from({ length: 4 }, () => call({ toolName: 'issue_refund', staffId: 's9', outcome: 'error', detail: 'permission denied' })),
      call({ toolName: 'find_customer', outcome: 'error', detail: 'not found' }),
      call(),
    ]
    const r = detectBadMcpExperiences(calls, { retryBurstThreshold: 4 })
    const text = summarizeBadMcpReport(r).join('\n')
    expect(text).toContain('Experiencias malas del MCP')
    expect(text).toContain('Permiso denegado')
    expect(text).toContain('issue_refund')
    expect(text).toContain('Reintentos/frustración')
  })
})
