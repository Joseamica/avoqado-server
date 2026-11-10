/**
 * Tokens del celular de campo (App de campo, bloque 1). NO son tokens de la API: llevan su propia llave (derivada de
 * `ACCESS_TOKEN_SECRET`) y su propia audiencia, así que `authenticateTokenMiddleware`, `switch-venue`, `switch-user`, el
 * refresco móvil y el socket los rechazan por firma y por `esTokenDeLaApi`. Sin eso, un token del celular fabricaba
 * sesiones hijas que sobrevivían al desvincular (Codex R2-1).
 */
import { StaffRole } from '@prisma/client'
import { createHmac, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import { UnauthorizedError } from '@/errors/AppError'

const EMISOR = 'avoqado-api'
const AUDIENCIA = 'avoqado-campo'
const DURACION_S = 24 * 60 * 60

export type AccesoDeCampo = { sub: string; orgId: string; venueId: string; role: StaffRole; sid: string; iat: number }

const llave = () => createHmac('sha256', process.env.ACCESS_TOKEN_SECRET!).update('avoqado-campo-v1').digest('hex')

export function firmarAccesoDeCampo(p: { staffId: string; organizationId: string; venueId: string; role: StaffRole; sid: string }): string {
  return jwt.sign({ sub: p.staffId, orgId: p.organizationId, venueId: p.venueId, role: p.role, sid: p.sid }, llave(), {
    algorithm: 'HS256',
    issuer: EMISOR,
    audience: AUDIENCIA,
    expiresIn: DURACION_S,
  })
}

/** Firma, algoritmo, emisor, audiencia y vencimiento. Que la sesión siga viva lo revisa quien llama (el candado). */
export function verificarAccesoDeCampo(token: string): AccesoDeCampo {
  try {
    const d = jwt.verify(token, llave(), { algorithms: ['HS256'], issuer: EMISOR, audience: AUDIENCIA }) as jwt.JwtPayload
    const { sub, sid, venueId, orgId, role } = d
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof venueId !== 'string' || typeof orgId !== 'string') {
      throw new Error('claims inválidos')
    }
    if (!Object.values(StaffRole).includes(role)) throw new Error('rol inválido')
    return { sub, orgId, venueId, role, sid, iat: d.iat! }
  } catch {
    throw new UnauthorizedError('Tu sesión del celular no es válida. Entra de nuevo con tu PIN.', 'SESION_INVALIDA')
  }
}

/** Refresh opaco (no es JWT): sólo vale contra su `RefreshGrant`. */
export const nuevoRefreshDeCampo = (): string => randomBytes(32).toString('hex')
