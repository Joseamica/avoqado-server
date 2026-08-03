/**
 * CSRF guard for POST /mcp-oauth/approve (isTrustedOrigin). The dashboard `accessToken` cookie is
 * SameSite=None in prod, so a cross-site POST would carry the victim's session; without this guard a
 * malicious page could auto-POST sso=1 and mint an auth code for the victim (account takeover).
 * 🔴 El origen de confianza se DERIVA de `MCP_ISSUER_URL` en tiempo de ejecución — NUNCA se
 * escribe a mano. La versión anterior clavaba el default `http://localhost:12344` asumiendo "sin
 * env", y eso rompía el gate: `npm run pre-deploy` carga `.env` (donde MCP_ISSUER_URL apunta a un
 * túnel ngrok), así que el issuer real dejaba de ser localhost y los 2 casos que esperan `true`
 * fallaban — mientras que corriendo jest a secas pasaban. Un test no puede depender de si el
 * desarrollador tiene cierta variable en su `.env`. (Diagnosticado 2026-08-03: pre-deploy en rojo
 * por esto, sin relación con el cambio que se iba a subir.)
 */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

import { MCP_ISSUER_URL } from '../../../src/mcp/oauth/config'
import { isTrustedOrigin } from '../../../src/mcp/oauth/router'

const reqWith = (headers: Record<string, string | undefined>) => ({
  get: (h: string) => headers[h.toLowerCase()],
})

/** El origen legítimo, sea cual sea el entorno. */
const TRUSTED = MCP_ISSUER_URL.origin
const FOREIGN = 'https://evil.example'

describe('isTrustedOrigin (CSRF guard)', () => {
  // Si el issuer llegara a ser el dominio del atacante, las aserciones de abajo serían vacías.
  it('precondición: el origen de confianza y el del atacante son distintos', () => {
    expect(TRUSTED).not.toBe(FOREIGN)
  })

  it('accepts a same-origin request (Origin matches the issuer)', () => {
    expect(isTrustedOrigin(reqWith({ origin: TRUSTED }))).toBe(true)
  })

  it('REJECTS a cross-site Origin (the attack) — this is the whole point', () => {
    expect(isTrustedOrigin(reqWith({ origin: FOREIGN }))).toBe(false)
  })

  it('rejects even when a valid Referer is present but the Origin is foreign (Origin wins)', () => {
    expect(isTrustedOrigin(reqWith({ origin: FOREIGN, referer: `${TRUSTED}/authorize` }))).toBe(false)
  })

  it('falls back to Referer origin when Origin is absent', () => {
    expect(isTrustedOrigin(reqWith({ referer: `${TRUSTED}/authorize?x=1` }))).toBe(true)
    expect(isTrustedOrigin(reqWith({ referer: `${FOREIGN}/x` }))).toBe(false)
  })

  it('rejects a garbage Referer', () => {
    expect(isTrustedOrigin(reqWith({ referer: 'not a url' }))).toBe(false)
  })

  it('allows when NEITHER header is present (unreachable via a cross-site browser POST — browser always sets Origin)', () => {
    expect(isTrustedOrigin(reqWith({}))).toBe(true)
  })
})
