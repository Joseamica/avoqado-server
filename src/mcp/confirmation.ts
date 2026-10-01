import jwt from 'jsonwebtoken'
import { operationHash } from '@/utils/operationHash'
import type { McpScope } from './scope'

const audience = 'avoqado-mcp-confirmation'
export const CONFIRMATION_TTL = 600

function secret(): string {
  const key = process.env.ACCESS_TOKEN_SECRET
  if (!key) throw new Error('ACCESS_TOKEN_SECRET is not set')
  return key
}

export function issueConfirmation(scope: McpScope, tool: string, args: unknown): string {
  return jwt.sign({ sub: scope.staffId, org: scope.activeOrg, tool, hash: operationHash(args) }, secret(), {
    algorithm: 'HS256',
    audience,
    expiresIn: CONFIRMATION_TTL,
  })
}

export function validConfirmation(token: unknown, scope: McpScope, tool: string, args: unknown): boolean {
  if (typeof token !== 'string') return false
  try {
    const p = jwt.verify(token, secret(), { audience, algorithms: ['HS256'] }) as jwt.JwtPayload
    return p.sub === scope.staffId && p.org === scope.activeOrg && p.tool === tool && p.hash === operationHash(args)
  } catch {
    return false
  }
}
