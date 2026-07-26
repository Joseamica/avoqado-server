import { instrumentTools } from '../../../src/mcp/instrument'
import { prismaMock } from '../../__helpers__/setup'

/**
 * The instrumentation monkey-patches `server.tool`. We fake a minimal server whose
 * original `.tool(name, schema, cb)` just stores the (wrapped) handler, then invoke
 * that handler and assert the fire-and-forget McpToolCall persistence.
 */
function makeInstrumentedServer(ctx = { staffId: 'staff_1', org: 'org_1' }) {
  const registered: Record<string, (...a: unknown[]) => unknown> = {}
  const server: any = {
    tool: (name: string, _schema: unknown, cb: (...a: unknown[]) => unknown) => {
      registered[name] = cb
    },
  }
  instrumentTools(server, ctx)
  return { server, registered }
}

const flush = () => new Promise(r => setImmediate(r)) // let the void recordMcpCall() settle

const okResult = (payload: unknown = { ok: true }) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] })

describe('instrumentTools — McpToolCall persistence', () => {
  it('persists an OK call with caller identity, venue and outcome ok', async () => {
    const { server, registered } = makeInstrumentedServer()
    server.tool('daily_sales', {}, async () => okResult({ ok: true }))

    await registered.daily_sales({ venueId: 'venue_9' }, {})
    await flush()

    expect(prismaMock.mcpToolCall.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.mcpToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toolName: 'daily_sales',
          staffId: 'staff_1',
          orgId: 'org_1',
          venueId: 'venue_9',
          outcome: 'ok',
          detail: null,
        }),
      }),
    )
  })

  it('persists a logical failure (ok:false) as outcome error WITH the reason', async () => {
    const { server, registered } = makeInstrumentedServer()
    server.tool('issue_refund', {}, async () => okResult({ ok: false, error: 'permission denied: refunds:create' }))

    await registered.issue_refund({ venueId: 'venue_9' }, {})
    await flush()

    expect(prismaMock.mcpToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ toolName: 'issue_refund', outcome: 'error', detail: 'permission denied: refunds:create' }),
      }),
    )
  })

  it('persists a thrown handler as outcome threw and RE-THROWS to the caller', async () => {
    const { server, registered } = makeInstrumentedServer()
    server.tool('adjust_stock', {}, async () => {
      throw new Error('kaboom')
    })

    await expect(registered.adjust_stock({ venueId: 'v1' }, {})).rejects.toThrow('kaboom')
    await flush()

    expect(prismaMock.mcpToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toolName: 'adjust_stock', outcome: 'threw', detail: 'kaboom' }) }),
    )
  })

  it('records venueId null when the tool has no venue param', async () => {
    const { server, registered } = makeInstrumentedServer()
    server.tool('list_my_venues', {}, async () => okResult({ ok: true }))

    await registered.list_my_venues({}, {})
    await flush()

    expect(prismaMock.mcpToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toolName: 'list_my_venues', venueId: null }) }),
    )
  })

  it('a persistence failure NEVER breaks the tool call (best-effort audit)', async () => {
    prismaMock.mcpToolCall.create.mockRejectedValueOnce(new Error('db down'))
    const { server, registered } = makeInstrumentedServer()
    server.tool('daily_sales', {}, async () => okResult({ ok: true }))

    const result = await registered.daily_sales({ venueId: 'v1' }, {})
    await flush()

    // Tool still returned its result even though the audit insert rejected.
    expect(result).toEqual(okResult({ ok: true }))
  })
})
