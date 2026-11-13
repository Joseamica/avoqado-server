/**
 * Versiones mínimas de la app del POS desde el MCP (Actualizador del POS, Fase 1): una sola tool de LECTURA que contesta, para ANDROID
 * e iOS, la versión mínima obligatoria y la recomendada, el mensaje y quién la cambió por última vez.
 *
 * 🔴 SOLO SUPERADMIN, con defensa doble: `registerAllTools` no la registra para un cliente, este archivo tampoco y el handler vuelve a
 * comprobarlo. Es una ficha de PLATAFORMA. Sólo en el MCP libre: NO está en `directory/catalog.ts`.
 *
 * Cambiar una versión mínima no entra por MCP: se hace desde el SUPERADMIN.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getPolicies } from '@/services/posAppVersion/policy.service'
import { text } from '../respond'
import type { McpScope } from '../scope'

const SOLO_AVOQADO = 'Sólo el equipo de Avoqado puede consultar las versiones mínimas de la app del POS.'

export function registerPosAppVersionTools(server: McpServer, scope: McpScope): void {
  if (!scope.isSuperAdmin) return

  server.tool(
    'get_pos_app_version_policies',
    'Consulta las versiones mínimas de la app del POS (ANDROID, que también corre en WINDOWS, e iOS): por cada una, la versión mínima ' +
      'obligatoria y la recomendada, cómo se avisa la recomendada, el mensaje que ven los negocios, quién lo cambió y cuándo. ' +
      'No es la terminal de cobro (TPV): esa tiene su propio candado de versión. Sólo lectura: no cambia nada. Sólo para el equipo de Avoqado.',
    {},
    async () => {
      if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
      const politicas = await getPolicies()
      return text({ ok: true, politicas })
    },
  )
}
