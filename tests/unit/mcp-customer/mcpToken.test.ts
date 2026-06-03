import { issueMcpToken, verifyMcpToken } from '../../../src/mcp/mcpToken'
import jwt from 'jsonwebtoken'

describe('mcpToken', () => {
  beforeAll(() => {
    process.env.ACCESS_TOKEN_SECRET = 'test-secret'
  })

  it('issues a token bound to the MCP audience and round-trips it', () => {
    const t = issueMcpToken('staff-1', 'org-1', 3600)
    const payload = verifyMcpToken(t)
    expect(payload.sub).toBe('staff-1')
    expect(payload.org).toBe('org-1')
  })

  it('rejects a token that lacks the MCP audience (e.g. a dashboard token)', () => {
    const dashboardToken = jwt.sign({ sub: 'staff-1', orgId: 'org-1' }, 'test-secret', { expiresIn: 3600 })
    expect(() => verifyMcpToken(dashboardToken)).toThrow()
  })
})
