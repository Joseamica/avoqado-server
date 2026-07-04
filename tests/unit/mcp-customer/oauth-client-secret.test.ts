/**
 * Confidential-client authentication for /token & /revoke. The MCP SDK compares client_secret in
 * PLAINTEXT and skips the check entirely when getClient returns no secret — which ours never does
 * (we store only a hash). So a client registered CONFIDENTIAL was accepted with just its client_id.
 * These cover the hash-verifying guard that closes it, and the credential extraction (Basic + body).
 */
import { createHash } from 'crypto'
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

import { confidentialSecretOk, readClientCredentials } from '../../../src/mcp/oauth/router'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

describe('confidentialSecretOk', () => {
  it('lets a PUBLIC client through (no stored hash → no secret required)', () => {
    expect(confidentialSecretOk(null, undefined)).toBe(true)
    expect(confidentialSecretOk(undefined, undefined)).toBe(true)
  })

  it('accepts a confidential client presenting the CORRECT secret (hash matches)', () => {
    expect(confidentialSecretOk(sha256('s3cret'), 's3cret')).toBe(true)
  })

  it('REJECTS a confidential client presenting no secret (the SDK-skips-check bug)', () => {
    expect(confidentialSecretOk(sha256('s3cret'), undefined)).toBe(false)
  })

  it('REJECTS a confidential client presenting the WRONG secret', () => {
    expect(confidentialSecretOk(sha256('s3cret'), 'wrong')).toBe(false)
  })
})

describe('readClientCredentials', () => {
  const req = (headers: Record<string, string | undefined>, body?: unknown) => ({
    get: (h: string) => headers[h.toLowerCase()],
    body,
  })

  it('reads client_id + client_secret from HTTP Basic auth (preferred)', () => {
    const basic = 'Basic ' + Buffer.from('mcp_abc:s3cret').toString('base64')
    expect(readClientCredentials(req({ authorization: basic }))).toEqual({ clientId: 'mcp_abc', clientSecret: 's3cret' })
  })

  it('falls back to the form body when no Basic header', () => {
    expect(readClientCredentials(req({}, { client_id: 'mcp_xyz', client_secret: 'body-secret' }))).toEqual({
      clientId: 'mcp_xyz',
      clientSecret: 'body-secret',
    })
  })

  it('returns an undefined secret for a public client (id only, no secret)', () => {
    const basic = 'Basic ' + Buffer.from('mcp_pub:').toString('base64')
    expect(readClientCredentials(req({ authorization: basic }))).toEqual({ clientId: 'mcp_pub', clientSecret: undefined })
  })
})
