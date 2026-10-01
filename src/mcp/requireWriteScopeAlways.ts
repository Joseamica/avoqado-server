import logger from '../config/logger'
import { ScopeError } from './errors'
import type { McpScope } from './scope'

export function requireWriteScopeAlways(scope: McpScope, permission: string, motivo?: string): void {
  if (scope.scopes?.includes('mcp:write')) return

  logger.warn('[MCP] escritura sensible bloqueada: el token no trae mcp:write', {
    mcp: true,
    staffId: scope.staffId,
    activeOrg: scope.activeOrg,
    permission,
    grantedScopes: scope.scopes,
    alwaysEnforced: true,
  })
  // 🔴 El motivo lo pone quien llama, y por eso NO tiene un default que hable de nómina: el
  // mensaje viaja al usuario, y uno que diga "mueve dinero de nómina" al pausar una felicitación
  // de cumpleaños es un mensaje que miente. (Pasaba ya con `tpv:update` antes de generalizarlo.)
  throw new ScopeError(
    `Esta conexión es de solo lectura (falta el scope mcp:write). "${permission}" ${
      motivo ?? 'es una escritura sensible'
    } y no se permite sin él.`,
  )
}
