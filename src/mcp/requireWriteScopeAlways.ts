/**
 * Exigir `mcp:write` SIN depender del interruptor de despliegue.
 *
 * `enforceWriteScope` (en `guard.ts`) es **observar-y-permitir** de fábrica, y con razón: se
 * desplegó así para no romperle las escrituras a un cliente que pidiera un scope inesperado.
 * Ese matiz vale para el catálogo en general.
 *
 * 🔴 No vale para NÓMINA. Un token de sólo lectura que puede firmar cuánto se le paga a una
 * persona es un agujero de seguridad, no un riesgo de despliegue — lo encontró Codex el
 * 29-ago-2026 auditando las horas extra. Las tools que mueven dinero de nómina usan ESTE
 * guard, que corta siempre.
 *
 * Sigue respetando la excepción legítima de `guard.ts`: un token SIN scopes declarados
 * (servidor de desarrollo, conexiones legacy) conserva acceso completo. Lo que cambia es que
 * un token CON scopes y sin `mcp:write` se rechaza aunque la bandera esté apagada.
 */
import logger from '../config/logger'
import { ScopeError } from './errors'
import type { McpScope } from './scope'

export function requireWriteScopeAlways(scope: McpScope, permission: string): void {
  // `scopes` ausente = token de desarrollo o legacy: mismo trato que en `enforceWriteScope`.
  if (!scope.scopes) return
  if (scope.scopes.includes('mcp:write')) return

  logger.warn('[MCP] escritura de nómina bloqueada: el token no trae mcp:write', {
    mcp: true,
    staffId: scope.staffId,
    activeOrg: scope.activeOrg,
    permission,
    grantedScopes: scope.scopes,
    // Se distingue en el log de las líneas "would be blocked" del guard observador.
    alwaysEnforced: true,
  })
  throw new ScopeError(
    `Esta conexión es de solo lectura (falta el scope mcp:write). "${permission}" mueve dinero de nómina y no se permite sin él.`,
  )
}
