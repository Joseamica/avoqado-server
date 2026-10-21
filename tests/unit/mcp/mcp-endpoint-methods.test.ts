import request from 'supertest'
import app from '../../../src/app'

/**
 * The MCP endpoint is JSON-RPC over POST only (stateless Streamable HTTP: no GET/SSE
 * stream, and we never issue session ids so there is nothing to DELETE). The
 * Streamable HTTP spec prescribes 405 + `Allow: POST` for BOTH GET and DELETE —
 * an Express 404 makes us look like a broken/absent endpoint instead of an MCP one.
 */
describe.each(['/mcp', '/mcp/directory'])('%s — HTTP method handling', endpoint => {
  it.each(['get', 'delete'] as const)('%s /mcp → 405 with Allow: POST and a JSON-RPC error body', async method => {
    const res = await request(app)[method](endpoint)

    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: null })
    expect(res.body.error.code).toBe(-32000)
  })

  it('REGRESSION — POST /mcp is NOT swallowed by the 405 handler (still hits auth, not 405)', async () => {
    const res = await request(app).post(endpoint).send({ jsonrpc: '2.0', method: 'tools/list', id: 1 })

    // Unauthenticated → the bearer-auth middleware rejects it (401). The ONLY thing
    // this asserts is that POST never falls through to the Method-Not-Allowed handler.
    expect(res.status).not.toBe(405)
    expect(res.status).toBe(401)
  })
})

it('anuncia el recurso de directorio en discovery y en el desafío 401', async () => {
  const metadata = await request(app).get('/.well-known/oauth-protected-resource/mcp/directory')
  expect(metadata.status).toBe(200)
  expect(metadata.body.resource).toMatch(/\/mcp\/directory$/)
  const denied = await request(app).post('/mcp/directory').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  expect(denied.status).toBe(401)
  expect(denied.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp/directory')
})
