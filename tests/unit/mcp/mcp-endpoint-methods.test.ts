import request from 'supertest'
import app from '../../../src/app'

/**
 * The MCP endpoint is JSON-RPC over POST only (stateless Streamable HTTP: no GET/SSE
 * stream, and we never issue session ids so there is nothing to DELETE). The
 * Streamable HTTP spec prescribes 405 + `Allow: POST` for BOTH GET and DELETE —
 * an Express 404 makes us look like a broken/absent endpoint instead of an MCP one.
 */
describe('/mcp — HTTP method handling', () => {
  it.each(['get', 'delete'] as const)('%s /mcp → 405 with Allow: POST and a JSON-RPC error body', async method => {
    const res = await request(app)[method]('/mcp')

    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: null })
    expect(res.body.error.code).toBe(-32000)
  })

  it('REGRESSION — POST /mcp is NOT swallowed by the 405 handler (still hits auth, not 405)', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 })

    // Unauthenticated → the bearer-auth middleware rejects it (401). The ONLY thing
    // this asserts is that POST never falls through to the Method-Not-Allowed handler.
    expect(res.status).not.toBe(405)
    expect(res.status).toBe(401)
  })
})
