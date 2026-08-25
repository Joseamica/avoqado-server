/**
 * Volume ceiling on `POST /mcp` (src/middlewares/mcp-rate-limit.middleware.ts).
 *
 * The MCP had authentication but no rate limit: a valid or stolen token could fuzz ~250 tools at
 * full speed. These tests pin the three scopes, the JSON-RPC shape of the rejection (an MCP client
 * cannot parse a REST error body), the security audit trail, and — most important — that a bug in
 * the limiter can never take the MCP down.
 */
import type { NextFunction, Request, Response } from 'express'
import { MCP_RATE_LIMITS, mcpRateLimitMiddleware, mcpRateLimitStore } from '../../../src/middlewares/mcp-rate-limit.middleware'
import { SecurityAuditLoggerService } from '../../../src/services/dashboard/security-audit-logger.service'
import logger from '@/config/logger'

jest.mock('../../../src/services/dashboard/security-audit-logger.service', () => ({
  SecurityAuditLoggerService: { logRateLimitExceeded: jest.fn() },
}))

const mockedAudit = SecurityAuditLoggerService as unknown as { logRateLimitExceeded: jest.Mock }
const mockedLogger = logger as unknown as { warn: jest.Mock; error: jest.Mock }

/** `null` means the field is genuinely ABSENT (a bare `undefined` would re-trigger the default). */
function makeReq(opts: { staffId?: string | null; activeOrg?: string | null; ip?: string } = {}) {
  const staffId = opts.staffId === null ? undefined : (opts.staffId ?? 'staff-1')
  const activeOrg = opts.activeOrg === null ? undefined : (opts.activeOrg ?? 'org-1')
  const ip = opts.ip ?? '10.1.1.1'
  const extra: Record<string, unknown> = {}
  if (staffId) extra.staffId = staffId
  if (activeOrg) extra.activeOrg = activeOrg
  return { auth: { extra }, ip, socket: { remoteAddress: ip } } as unknown as Request
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; headers: Record<string, string>; body: any }
}

/** Drive the middleware n times with the same request; return how many reached `next()`. */
function drive(n: number, reqOpts: Parameters<typeof makeReq>[0] = {}) {
  let passed = 0
  let lastRes = makeRes()
  for (let i = 0; i < n; i++) {
    lastRes = makeRes()
    const next: NextFunction = () => {
      passed++
    }
    mcpRateLimitMiddleware(makeReq(reqOpts), lastRes, next)
  }
  return { passed, lastRes }
}

beforeEach(() => {
  jest.clearAllMocks()
  mcpRateLimitStore.reset()
})

describe('mcpRateLimitMiddleware', () => {
  const STAFF_MAX = MCP_RATE_LIMITS.STAFF.max

  // NEW
  it('lets normal traffic through and reports the remaining budget', () => {
    const { passed, lastRes } = drive(5)
    expect(passed).toBe(5)
    expect(lastRes.headers['X-RateLimit-Limit']).toBe(String(STAFF_MAX))
    expect(lastRes.headers['X-RateLimit-Remaining']).toBe(String(STAFF_MAX - 5))
    expect(mockedAudit.logRateLimitExceeded).not.toHaveBeenCalled()
  })

  it('blocks the request that exceeds the per-staff ceiling, and every one after it', () => {
    const { passed } = drive(STAFF_MAX + 10)
    expect(passed).toBe(STAFF_MAX) // exactly the ceiling got through
  })

  it('rejects with a JSON-RPC error an MCP client can parse — never a REST body', () => {
    drive(STAFF_MAX)
    const { lastRes } = drive(1)
    expect(lastRes.statusCode).toBe(429)
    expect(lastRes.body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: expect.stringMatching(/Demasiadas solicitudes de tu cuenta/) },
      id: null,
    })
    expect(lastRes.body.error.data.retryAfter).toBeGreaterThan(0)
    expect(lastRes.headers['Retry-After']).toMatch(/^\d+$/)
    expect(lastRes.body).not.toHaveProperty('success') // the chatbot's REST shape must NOT be used here
  })

  it('writes the block to the security audit trail and the logs', () => {
    drive(STAFF_MAX + 1)
    expect(mockedAudit.logRateLimitExceeded).toHaveBeenCalledTimes(1)
    expect(mockedAudit.logRateLimitExceeded).toHaveBeenCalledWith({
      userId: 'staff-1',
      venueId: 'org-1',
      ipAddress: '10.1.1.1',
      limit: STAFF_MAX,
      windowMs: MCP_RATE_LIMITS.STAFF.windowMs,
    })
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      '[MCP] rate limit exceeded (STAFF)',
      expect.objectContaining({ mcp: true, scope: 'STAFF' }),
    )
  })

  it('counts per staff member: one abuser does not lock out their colleague', () => {
    drive(STAFF_MAX + 5, { staffId: 'abuser' })
    const { passed } = drive(3, { staffId: 'colleague', ip: '10.2.2.2' })
    expect(passed).toBe(3)
  })

  it('applies the IP ceiling when the request carries no identity (auth not yet resolved)', () => {
    const { passed } = drive(MCP_RATE_LIMITS.IP.max + 5, { staffId: null, activeOrg: null, ip: '10.9.9.9' })
    expect(passed).toBe(MCP_RATE_LIMITS.IP.max)
    // No staffId → nothing to attribute in the security audit trail, but it is still blocked.
    expect(mockedAudit.logRateLimitExceeded).not.toHaveBeenCalled()
  })

  it('applies the per-organization hourly ceiling across different staff of the same org', () => {
    const orgMax = MCP_RATE_LIMITS.ORG.max
    let blocked = 0
    // Spread across many staff/IPs so neither the staff nor the IP ceiling is what trips.
    for (let i = 0; i <= orgMax; i++) {
      const res = makeRes()
      mcpRateLimitMiddleware(makeReq({ staffId: `s${i}`, activeOrg: 'org-big', ip: `10.0.${i % 250}.${i % 100}` }), res, () => undefined)
      if (res.statusCode === 429) blocked++
    }
    expect(blocked).toBe(1)
    expect(mockedLogger.warn).toHaveBeenCalledWith('[MCP] rate limit exceeded (ORG)', expect.objectContaining({ scope: 'ORG' }))
  })

  // NEW — the property that matters most operationally
  it('NEVER blocks the MCP when the limiter itself fails', () => {
    const brokenReq = {
      get auth(): never {
        throw new Error('boom')
      },
    } as unknown as Request
    const res = makeRes()
    let reached = false
    mcpRateLimitMiddleware(brokenReq, res, () => {
      reached = true
    })
    expect(reached).toBe(true) // request proceeds
    expect(res.statusCode).toBe(0) // nothing was written to the response
    expect(mockedLogger.error).toHaveBeenCalledWith('[MCP] rate limit middleware error', expect.objectContaining({ mcp: true }))
  })

  // REGRESSION — the ceiling must be generous enough for real MCP traffic
  it('leaves room for a realistic session (one question fans out into many tool calls)', () => {
    expect(STAFF_MAX).toBeGreaterThanOrEqual(60) // ≥ 1 request/second sustained
    expect(MCP_RATE_LIMITS.ORG.max).toBeGreaterThan(STAFF_MAX) // the org backstop cannot be tighter than one user
  })
})
