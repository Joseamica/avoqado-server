import { randomBytes, createHash } from 'crypto'
import prisma from '@/utils/prismaClient'
import { AUTH_CODE_TTL_SECONDS, REFRESH_TTL_SECONDS } from './config'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const randomToken = () => randomBytes(32).toString('hex')

export interface AuthCodeData {
  clientId: string
  staffId: string
  activeOrg: string
  codeChallenge: string
  redirectUri: string
  scopes: string[]
  resource?: string
}

export async function createAuthCode(d: AuthCodeData): Promise<{ code: string }> {
  const code = randomToken()
  await prisma.mcpAuthCode.create({
    data: {
      codeHash: sha256(code),
      clientId: d.clientId,
      staffId: d.staffId,
      activeOrg: d.activeOrg,
      codeChallenge: d.codeChallenge,
      redirectUri: d.redirectUri,
      scopes: d.scopes,
      resource: d.resource ?? null,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
    },
  })
  return { code }
}

/** Returns the code's bound data and marks it consumed; null if missing/expired/used. */
export async function consumeAuthCode(code: string): Promise<AuthCodeData | null> {
  const codeHash = sha256(code)
  // WHY atomic claim (not findUnique→check→update): an OAuth code is single-use. With a read then a
  // separate write, two concurrent /token exchanges both read consumedAt=null, both pass the check,
  // and both get the code — a replay that mints two token sets from one code. updateMany flips
  // consumedAt in ONE statement gated on `consumedAt: null`; its count tells us if WE won the race.
  const claimed = await prisma.mcpAuthCode.updateMany({
    where: { codeHash, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  })
  if (claimed.count !== 1) return null // missing, expired, or already consumed by a concurrent exchange
  const row = await prisma.mcpAuthCode.findUnique({ where: { codeHash } })
  if (!row) return null // defensive: we just updated it, so this should never be null
  return {
    clientId: row.clientId,
    staffId: row.staffId,
    activeOrg: row.activeOrg,
    codeChallenge: row.codeChallenge,
    redirectUri: row.redirectUri,
    scopes: row.scopes,
    resource: row.resource ?? undefined,
  }
}

/** Returns the bound challenge for a code WITHOUT consuming it (SDK calls this before exchange). */
export async function peekAuthCodeChallenge(code: string): Promise<string | null> {
  const row = await prisma.mcpAuthCode.findUnique({
    where: { codeHash: sha256(code) },
    select: { codeChallenge: true, consumedAt: true, expiresAt: true },
  })
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) return null
  return row.codeChallenge
}

export interface RefreshData {
  clientId: string
  staffId: string
  activeOrg: string
  scopes: string[]
}

export async function createRefreshToken(d: RefreshData): Promise<{ token: string }> {
  const token = randomToken()
  await prisma.mcpRefreshToken.create({
    data: {
      tokenHash: sha256(token),
      clientId: d.clientId,
      staffId: d.staffId,
      activeOrg: d.activeOrg,
      scopes: d.scopes,
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    },
  })
  return { token }
}

/**
 * Atomically consume (revoke) a refresh token and return its data, or null if missing/expired/used.
 * WHY revoke here (not a separate call): rotation must be atomic. The old flow read the token, then
 * the caller revoked it in a second statement — two concurrent refreshes both saw revokedAt=null and
 * both rotated, replaying one token into two live sessions. Flipping revokedAt in ONE updateMany and
 * checking count makes exactly one caller win.
 */
export async function consumeRefreshToken(token: string): Promise<RefreshData | null> {
  const tokenHash = sha256(token)
  const claimed = await prisma.mcpRefreshToken.updateMany({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  })
  if (claimed.count !== 1) return null // missing, expired, or already consumed by a concurrent refresh
  const row = await prisma.mcpRefreshToken.findUnique({ where: { tokenHash } })
  if (!row) return null // defensive
  return { clientId: row.clientId, staffId: row.staffId, activeOrg: row.activeOrg, scopes: row.scopes }
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.mcpRefreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } })
}
