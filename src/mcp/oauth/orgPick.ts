import jwt from 'jsonwebtoken'
import { ACCESS_TOKEN_SECRET } from '@/config/env'
import prisma from '@/utils/prismaClient'
import { emisionDelToken, motivoDeConcesionInvalidada } from '@/utils/passwordChangeGuard'

/**
 * Org picker for the MCP OAuth consent flow. A connection is bound to ONE active
 * organization; multi-org staff choose which on a second consent step. The step-1
 * authentication (password or SSO cookie) is carried to step 2 via this short-lived
 * signed token — the password is NEVER echoed back into the page.
 */
const ORG_PICK_AUDIENCE = 'avoqado-mcp-orgpick'

/**
 * `verificadoEn`: cuándo se comprobó la identidad (contraseña o sesión). 🔴 El token lleva ESA hora,
 * no la de su emisión: con la de emisión, un cambio de contraseña entre verificar y emitir dejaba al
 * selector —y a la autorización que nace de él— «posterior» al corte (Codex ronda 9, P1).
 */
export function issueOrgPickToken(staffId: string, verificadoEn?: Date): string {
  return jwt.sign({ sub: staffId, emitidoMs: verificadoEn?.getTime() ?? Date.now() }, ACCESS_TOKEN_SECRET, {
    audience: ORG_PICK_AUDIENCE,
    expiresIn: '5m',
    algorithm: 'HS256',
  })
}

/**
 * Returns the staffId of a valid, unexpired org-pick token, or null.
 *
 * 🔴 H4 (Codex gpt-6-astra, 2ª pasada): firma y caducidad no bastan. Si la persona cambió su
 * contraseña o cerró sus sesiones DESPUÉS de emitirse el token, o la dieron de baja, ya no sirve —
 * el corte ESTRICTO de las concesiones diferidas (`motivoDeConcesionInvalidada`, sin margen).
 */
export async function verifyOrgPickToken(token: string): Promise<string | null> {
  return (await verificarTokenDelSelector(token))?.staffId ?? null
}

/** Como `verifyOrgPickToken`, y además entrega la hora en que se verificó la identidad. */
export async function verificarTokenDelSelector(token: string): Promise<{ staffId: string; verificadoEn: Date } | null> {
  let decoded: { sub?: string; iat?: number; emitidoMs?: number }
  try {
    decoded = jwt.verify(token, ACCESS_TOKEN_SECRET, { audience: ORG_PICK_AUDIENCE, algorithms: ['HS256'] }) as {
      sub?: string
      iat?: number
      emitidoMs?: number
    }
  } catch {
    return null // expired / tampered / wrong audience
  }
  if (!decoded.sub) return null
  const staff = await prisma.staff.findUnique({ where: { id: decoded.sub }, select: { active: true } })
  if (!staff?.active) return null
  const emision = emisionDelToken(decoded)
  if (await motivoDeConcesionInvalidada(decoded.sub, emision)) return null
  const verificadoEn = emision instanceof Date ? emision : new Date(typeof emision === 'number' ? emision * 1000 : 0)
  return { staffId: decoded.sub, verificadoEn }
}

/**
 * El token que lleva la página del selector. 🔴 H4: si la persona ya venía de un token de
 * selección, se REUSA ése — reemitir uno nuevo en cada paso lo volvía renovable indefinidamente
 * sin volver a autenticarse. Sólo el paso 1 (contraseña o SSO recién validados) emite uno nuevo.
 */
export function tokenParaElSelector(tokenPrevio: unknown, staffId: string, verificadoEn?: Date): string {
  return typeof tokenPrevio === 'string' && tokenPrevio ? tokenPrevio : issueOrgPickToken(staffId, verificadoEn)
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
