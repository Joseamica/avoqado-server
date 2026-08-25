import { instrumentTools, sanitizeThrownError, sanitizeToolResult } from '../../../src/mcp/instrument'
import { ScopeError } from '../../../src/mcp/errors'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockedLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock }
const mockedPrisma = prisma as unknown as { mcpToolCall: { create: jest.Mock } }

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

  it('logs ERROR and re-throws a ScopeError UNCHANGED (its message is written for the operator)', async () => {
    const { server, original } = makeServer()
    instrumentTools(server, ctx)
    const handler = jest.fn().mockRejectedValue(new ScopeError('Venue out of scope'))
    callTool(server, 'set_menu_item_active', {}, handler)
    const wrapped = original.mock.calls[0][2] as (...a: unknown[]) => Promise<unknown>

    await expect(wrapped({}, {})).rejects.toThrow('Venue out of scope') // exception still propagates to the client
    expect(mockedLogger.error).toHaveBeenCalledTimes(1)
    expect(mockedLogger.error.mock.calls[0][1]).toMatchObject({ tool: 'set_menu_item_active', error: 'Venue out of scope' })
  })
})

/**
 * Thrown-error sanitization: the MCP SDK forwards `error.message` to the AI client verbatim, so an
 * unexpected exception (Prisma validation, TypeError…) must NOT reach a customer's assistant with
 * table/column names in it. Superadmins keep the raw error for debugging.
 */
describe('sanitizeThrownError / thrown errors reaching the client', () => {
  const prismaish = new Error(
    'Invalid `prisma.venue.findMany()` invocation: Argument `id`: Invalid value provided. Expected String, provided Int.',
  )
  const wrap = (c: typeof ctx & { isSuperAdmin?: boolean }, err: unknown) => {
    const { server, original } = makeServer()
    instrumentTools(server, c)
    callTool(server, 'daily_sales', {}, jest.fn().mockRejectedValue(err))
    return original.mock.calls[0][2] as (...a: unknown[]) => Promise<unknown>
  }

  // NEW
  it('a customer connection gets a generic Spanish message + reference id, never the raw internals', async () => {
    const wrapped = wrap(ctx, prismaish)
    let thrown: Error | null = null
    await wrapped({ venueId: 'v1' }, {}).catch(e => (thrown = e))
    expect(thrown).not.toBeNull()
    expect(thrown!.message).not.toMatch(/prisma|findMany|Argument/i)
    expect(thrown!.message).toMatch(/error interno de Avoqado \(ref [0-9a-f]{8}\)/)
    expect(thrown!.message).toMatch(/hola@avoqado\.io/)
    // …while the log keeps the full message AND the same ref, so support can correlate.
    const ref = thrown!.message.match(/ref ([0-9a-f]{8})/)![1]
    expect(mockedLogger.error.mock.calls[0][1]).toMatchObject({ tool: 'daily_sales', error: prismaish.message, ref })
  })

  it('every sanitized error gets a fresh reference id', () => {
    const a = sanitizeThrownError(prismaish, 'daily_sales', ctx)
    const b = sanitizeThrownError(prismaish, 'daily_sales', ctx)
    expect(a.ref).toMatch(/^[0-9a-f]{8}$/)
    expect(a.ref).not.toBe(b.ref)
  })

  it('a SUPERADMIN connection gets the raw error (debugging aid)', async () => {
    const wrapped = wrap({ ...ctx, isSuperAdmin: true }, prismaish)
    await expect(wrapped({}, {})).rejects.toThrow(/prisma\.venue\.findMany/)
    expect(sanitizeThrownError(prismaish, 'x', { ...ctx, isSuperAdmin: true })).toEqual({ error: prismaish, ref: null })
  })

  it('operational AppErrors (isOperational:true — BadRequest/NotFound/Conflict, Spanish by design) pass through for everyone', async () => {
    const operational = Object.assign(new Error('La reservación ya fue cancelada'), { isOperational: true, statusCode: 409 })
    await expect(wrap(ctx, operational)({}, {})).rejects.toThrow('La reservación ya fue cancelada')
  })

  it('non-operational AppErrors (isOperational:false, 5xx) are sanitized like any other exception', async () => {
    const internal = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { isOperational: false, statusCode: 500 })
    await expect(wrap(ctx, internal)({}, {})).rejects.toThrow(/error interno de Avoqado/)
    await expect(wrap(ctx, internal)({}, {})).rejects.not.toThrow(/ECONNREFUSED/)
  })

  // REGRESSION
  it('the audit row records the sanitized call as threw with the ref prefixed to the real detail', async () => {
    const wrapped = wrap(ctx, prismaish)
    await wrapped({ venueId: 'v1' }, {}).catch(() => undefined)
    await new Promise(r => setImmediate(r)) // recordMcpCall is fire-and-forget
    const row = mockedPrisma.mcpToolCall.create.mock.calls.at(-1)?.[0]?.data
    expect(row).toMatchObject({ toolName: 'daily_sales', outcome: 'threw', venueId: 'v1' })
    expect(row.detail).toMatch(/^\[[0-9a-f]{8}\] Invalid `prisma/)
  })
})

/**
 * The OTHER error path: ~68 tools `catch` and RETURN `text({ ok:false, error: err.message })`
 * instead of throwing, so the thrown-error sanitizer never sees them. Found by an adversarial
 * probe of the customer connection (2026-08-25).
 */
describe('sanitizeToolResult (errors a tool RETURNS as ok:false)', () => {
  const asText = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] })
  const read = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text)

  // NEW — internal shapes get redacted
  it.each([
    ['Prisma invocation', 'Invalid `prisma.venue.findMany()` invocation: Argument `id`: Invalid value.'],
    ['Prisma error code', 'Foreign key constraint failed on the field: P2003'],
    ['raw SQL', 'error: SELECT "id" FROM "Venue" WHERE "organizationId" = $1'],
    ['driver/connection', "Can't reach database server at 10.0.0.5:5432 (ECONNREFUSED)"],
    ['connection string', 'invalid dsn postgresql://avoqado:pw@db-prod.internal:5432/avoqado'],
    ['stack frame', 'TypeError: undefined is not a function\n    at getStaffSchedule (/app/src/services/x.ts:41:9)'],
  ])('redacts %s into the generic message + ref, keeping the rest of the payload', (_label, message) => {
    const { result, ref } = sanitizeToolResult(asText({ ok: false, error: message, venueId: 'v1' }), 'staff_schedule', ctx)
    const out = read(result)
    expect(ref).toMatch(/^[0-9a-f]{8}$/)
    expect(out.error).toBe(
      `No pude completar "staff_schedule" por un error interno de Avoqado (ref ${ref}). Vuelve a intentarlo; si persiste, escribe a hola@avoqado.io citando la referencia.`,
    )
    expect(out.ok).toBe(false)
    expect(out.venueId).toBe('v1') // the rest of the payload survives
    expect(JSON.stringify(out)).not.toMatch(/prisma|SELECT|ECONNREFUSED|5432|\/app\/src|P2003/i)
  })

  // NEW — operator-facing messages must survive untouched (this is the whole point of the denylist)
  it.each([
    'Este local no está en tu alcance.',
    'No hay nada por retirar en este turno.',
    'La reservación ya fue cancelada.',
    'El programa de lealtad (LOYALTY_PROGRAM) requiere un plan superior.',
    'No encontré ningún producto que coincida con "late". ¿Cuál de estos? Latte, Latte grande',
  ])('leaves the operator-facing message %s EXACTLY as the tool wrote it', message => {
    const input = asText({ ok: false, error: message })
    const { result, ref } = sanitizeToolResult(input, 'find_order', ctx)
    expect(ref).toBeNull()
    expect(result).toBe(input) // identity — a result we do not rewrite is never re-serialized
  })

  it('never touches a successful result, prose content, or a superadmin connection', () => {
    const ok = asText({ ok: true, total: 100 })
    expect(sanitizeToolResult(ok, 't', ctx).result).toBe(ok)
    const prose = { content: [{ type: 'text' as const, text: 'texto libre, no JSON' }] }
    expect(sanitizeToolResult(prose, 't', ctx).result).toBe(prose)
    const internal = asText({ ok: false, error: 'Invalid `prisma.venue.findMany()` invocation' })
    expect(sanitizeToolResult(internal, 't', { ...ctx, isSuperAdmin: true }).result).toBe(internal)
  })

  // NEW — end to end through the wrapper, incl. the audit row
  it('redacts end-to-end through the tool wrapper and logs the ref alongside the real detail', async () => {
    const { server, original } = makeServer()
    instrumentTools(server, ctx)
    const leaky = asText({ ok: false, error: 'Invalid `prisma.staffVenue.findUnique()` invocation' })
    callTool(server, 'staff_schedule', {}, jest.fn().mockResolvedValue(leaky))
    const wrapped = original.mock.calls[0][2] as (...a: unknown[]) => Promise<unknown>

    const out = read(await wrapped({ venueId: 'v1' }, {}))
    expect(out.error).toMatch(/error interno de Avoqado \(ref [0-9a-f]{8}\)/)
    expect(out.error).not.toMatch(/prisma/i)

    await new Promise(r => setImmediate(r))
    const row = mockedPrisma.mcpToolCall.create.mock.calls.at(-1)?.[0]?.data
    expect(row.outcome).toBe('error')
    expect(row.detail).toMatch(/^\[[0-9a-f]{8}\] Invalid `prisma/)
    expect(mockedLogger.warn.mock.calls[0][1]).toMatchObject({ tool: 'staff_schedule', ref: expect.stringMatching(/^[0-9a-f]{8}$/) })
  })

  // REGRESSION — a normal ok:false still flows through unchanged and is still logged as a warning
  it('still returns and warns on an ordinary ok:false without inventing a ref', async () => {
    const { server, original } = makeServer()
    instrumentTools(server, ctx)
    const normal = asText({ ok: false, error: 'Este local no está en tu alcance.' })
    callTool(server, 'daily_sales', {}, jest.fn().mockResolvedValue(normal))
    const wrapped = original.mock.calls[0][2] as (...a: unknown[]) => Promise<unknown>

    expect(await wrapped({}, {})).toBe(normal)
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1)
    expect(mockedLogger.warn.mock.calls[0][1]).not.toHaveProperty('ref')
  })
})
