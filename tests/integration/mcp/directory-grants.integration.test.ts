import prisma from '@/utils/prismaClient'
import { createRefreshToken, consumeRefreshToken } from '@/mcp/oauth/tokenStore'
import { randomUUID } from 'node:crypto'

// The runner creates/migrates/drops its own empty database; never the shared development DB.
describe('catálogo del refresh — PostgreSQL real', () => {
  const clientId = `review-${randomUUID()}`
  afterAll(() => prisma.mcpRefreshToken.deleteMany({ where: { clientId } }))

  it('la rotación conserva el recurso del directorio, incluso con consumo concurrente', async () => {
    const resource = 'http://localhost:12344/mcp/directory'
    const grant = { clientId, staffId: 'demo', activeOrg: 'demo', scopes: ['mcp:read'], resource }
    const { token } = await createRefreshToken(grant)
    const results = await Promise.all([consumeRefreshToken(token), consumeRefreshToken(token)])
    const claimed = results.find(Boolean)!
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(claimed.resource).toBe(resource)
    const replacement = await createRefreshToken({ ...claimed, grantedAt: claimed.issuedAt })
    expect((await consumeRefreshToken(replacement.token))?.resource).toBe(resource)
  })

  it('conexiones existentes sin recurso continúan como manuales, sin ampliar scopes', async () => {
    const { token } = await createRefreshToken({ clientId, staffId: 'demo', activeOrg: 'demo', scopes: ['mcp:read'] })
    const claimed = await consumeRefreshToken(token)
    expect(claimed?.resource).toBeUndefined()
    expect(claimed?.scopes).toEqual(['mcp:read'])
  })
})
