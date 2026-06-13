import jwt from 'jsonwebtoken'
import { ACCESS_TOKEN_SECRET } from '@/config/env'
import prisma from '@/utils/prismaClient'

/**
 * Org picker for the MCP OAuth consent flow. A connection is bound to ONE active
 * organization; multi-org staff choose which on a second consent step. The step-1
 * authentication (password or SSO cookie) is carried to step 2 via this short-lived
 * signed token — the password is NEVER echoed back into the page.
 */
const ORG_PICK_AUDIENCE = 'avoqado-mcp-orgpick'

export function issueOrgPickToken(staffId: string): string {
  return jwt.sign({ sub: staffId }, ACCESS_TOKEN_SECRET, { audience: ORG_PICK_AUDIENCE, expiresIn: '5m', algorithm: 'HS256' })
}

/** Returns the staffId of a valid, unexpired org-pick token, or null. */
export function verifyOrgPickToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET, { audience: ORG_PICK_AUDIENCE, algorithms: ['HS256'] }) as { sub?: string }
    return decoded.sub ?? null
  } catch {
    return null // expired / tampered / wrong audience
  }
}

/** The staff's ACTIVE org memberships, primary first — the picker's option list. */
export async function listActiveOrganizations(staffId: string): Promise<Array<{ id: string; name: string; role: string }>> {
  const rows = await prisma.staffOrganization.findMany({
    where: { staffId, isActive: true },
    select: { role: true, organization: { select: { id: true, name: true } } },
    orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }],
  })
  return rows.map(r => ({ id: r.organization.id, name: r.organization.name, role: r.role }))
}
