import { resolveActor } from '../../../scripts/mcp/writes'

describe('resolveActor', () => {
  const ORIG = process.env.MCP_ADMIN_STAFF_ID

  afterEach(() => {
    if (ORIG === undefined) delete process.env.MCP_ADMIN_STAFF_ID
    else process.env.MCP_ADMIN_STAFF_ID = ORIG
  })

  it('prefers the explicit performedBy param over the env var', () => {
    process.env.MCP_ADMIN_STAFF_ID = 'env-id'
    expect(resolveActor('param-id')).toBe('param-id')
  })

  it('falls back to MCP_ADMIN_STAFF_ID when no param is given', () => {
    process.env.MCP_ADMIN_STAFF_ID = 'env-id'
    expect(resolveActor()).toBe('env-id')
  })

  it('throws a helpful error when neither is set', () => {
    delete process.env.MCP_ADMIN_STAFF_ID
    expect(() => resolveActor()).toThrow(/actor staff id/i)
  })
})
