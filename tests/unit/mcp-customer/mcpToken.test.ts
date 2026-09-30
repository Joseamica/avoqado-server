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

describe('emisionDeCadena — la fecha con la que se juzga el corte de sesión', () => {
  const { emisionDeCadena } = require('../../../src/mcp/mcpToken')
  const fs = require('fs')
  const path = require('path')

  it('usa la concesión original cuando es más vieja que la emisión', () => {
    expect(emisionDeCadena({ iat: 2_000, gat: 1_000 })).toBe(1_000)
  })
  it('nunca rejuvenece: un gat posterior no gana al iat', () => {
    expect(emisionDeCadena({ iat: 1_000, gat: 2_000 })).toBe(1_000)
  })
  it('tokens viejos o de desarrollo sin gat: el iat', () => {
    expect(emisionDeCadena({ iat: 1_500 })).toBe(1_500)
    expect(emisionDeCadena({})).toBeUndefined()
  })
  it('🔴 los DOS caminos (OAuth y servidor de desarrollo) juzgan con la misma fecha', () => {
    const server = fs.readFileSync(path.join(__dirname, '../../../src/mcp/server.ts'), 'utf8')
    const provider = fs.readFileSync(path.join(__dirname, '../../../src/mcp/oauth/provider.ts'), 'utf8')
    expect(server).toMatch(/motivoDeSesionInvalidada\(payload\.sub, emisionDeCadena\(payload\)\)/)
    expect(provider).toMatch(/emisionDeCadena\(/)
  })
})
