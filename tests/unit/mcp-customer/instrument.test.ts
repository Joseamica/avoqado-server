import { instrumentTools } from '../../../src/mcp/instrument'
import logger from '@/config/logger'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockedLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock }

/** A fake McpServer exposing just `.tool` (a jest.fn standing in for the SDK's real registration). */
function makeServer() {
  const original = jest.fn()
  const server = { tool: original } as unknown as Parameters<typeof instrumentTools>[0]
  return { server, original }
}

const ctx = { staffId: 'staff-1', org: 'org-1' }
const callTool = (server: ReturnType<typeof makeServer>['server'], ...args: unknown[]) =>
  (server.tool as unknown as (...a: unknown[]) => unknown)(...args)
const okResult = { content: [{ type: 'text', text: JSON.stringify({ ok: true, item: 'x' }) }] }
const failResult = { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'out of scope' }) }] }

describe('instrumentTools', () => {
  beforeEach(() => jest.clearAllMocks())

  it('forwards name + description + schema to the original tool(), wrapping ONLY the handler', () => {
    const { server, original } = makeServer()
    instrumentTools(server, ctx)
    const handler = jest.fn()
    const schema = { venueId: {} }
    callTool(server, 'set_menu_item_price', 'desc', schema, handler)

    expect(original).toHaveBeenCalledTimes(1)
    const passed = original.mock.calls[0]
    expect(passed[0]).toBe('set_menu_item_price')
    expect(passed[1]).toBe('desc')
    expect(passed[2]).toBe(schema)
    expect(passed[3]).not.toBe(handler) // handler is replaced by the logging wrapper
    expect(typeof passed[3]).toBe('function')
  })

  it('logs info and returns the result UNCHANGED on success (transparent)', async () => {
    const { server, original } = makeServer()
    instrumentTools(server, ctx)
    const handler = jest.fn().mockResolvedValue(okResult)
    callTool(server, 'list_sales', {}, handler)
    const wrapped = original.mock.calls[0][2] as (...a: unknown[]) => Promise<unknown>

    const out = await wrapped({ venueId: 'v1' }, { signal: 'x' })

    expect(out).toBe(okResult) // identity preserved — never alters a tool's output
    expect(handler).toHaveBeenCalledWith({ venueId: 'v1' }, { signal: 'x' }) // args passed through
    expect(mockedLogger.info).toHaveBeenCalledTimes(1)
    expect(mockedLogger.warn).not.toHaveBeenCalled()
    expect(mockedLogger.error).not.toHaveBeenCalled()
    expect(mockedLogger.info.mock.calls[0][1]).toMatchObject({
      mcp: true,
      tool: 'list_sales',
      staffId: 'staff-1',
      org: 'org-1',
      venueId: 'v1', // captured from params → enables sector (venue.type) segmentation
    })
  })

  it('captures venueId from the params for sector attribution, and omits it for org-level tools', async () => {
    const { server, original } = makeServer()
    instrumentTools(server, ctx)
    const handler = jest.fn().mockResolvedValue(okResult)
    callTool(server, 'list_my_venues', {}, handler)
    const wrapped = original.mock.calls[0][2] as (...a: unknown[]) => Promise<unknown>

    await wrapped({ venueId: 'venue-abc' }, {}) // venue-scoped call
    await wrapped({}, {}) // org-level call, no venueId

    expect(mockedLogger.info.mock.calls[0][1]).toMatchObject({ venueId: 'venue-abc' })
    expect(mockedLogger.info.mock.calls[1][1]).not.toHaveProperty('venueId')
  })

  it('logs WARN (not error) when a tool returns ok:false, with the error detail', async () => {
    const { server, original } = makeServer()
    instrumentTools(server, ctx)
    const handler = jest.fn().mockResolvedValue(failResult)
    callTool(server, 'cancel_reservation', {}, handler)
    const wrapped = original.mock.calls[0][2] as (...a: unknown[]) => Promise<unknown>

    const out = await wrapped({}, {})

    expect(out).toBe(failResult)
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1)
    expect(mockedLogger.warn.mock.calls[0][1]).toMatchObject({ tool: 'cancel_reservation', detail: 'out of scope' })
    expect(mockedLogger.error).not.toHaveBeenCalled()
  })

  it('logs ERROR and re-throws when the handler throws (e.g. ScopeError / permission denied)', async () => {
    const { server, original } = makeServer()
    instrumentTools(server, ctx)
    const handler = jest.fn().mockRejectedValue(new Error('Venue out of scope'))
    callTool(server, 'set_menu_item_active', {}, handler)
    const wrapped = original.mock.calls[0][2] as (...a: unknown[]) => Promise<unknown>

    await expect(wrapped({}, {})).rejects.toThrow('Venue out of scope') // exception still propagates to the client
    expect(mockedLogger.error).toHaveBeenCalledTimes(1)
    expect(mockedLogger.error.mock.calls[0][1]).toMatchObject({ tool: 'set_menu_item_active', error: 'Venue out of scope' })
  })
})
