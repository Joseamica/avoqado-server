/**
 * ¿Este JWT es un token de ACCESO a la API?
 *
 * La misma llave (`ACCESS_TOKEN_SECRET`) firma también tokens que NO son de acceso: el del MCP
 * (`aud: 'avoqado-mcp'`), el del selector de organización del MCP (su propia audiencia), el de
 * clientes y consumidores (`type: 'customer' | 'consumer'`) y el refresh de la TPV
 * (`type: 'refresh'`). Verificar sólo firma y algoritmo los dejaba entrar a toda la API: un
 * token del MCP consentido «sólo lectura» para una organización autenticaba escrituras (Codex S2).
 *
 * Los de acceso legítimos no traen `type` y, si traen audiencia, es `avoqado-clients` (TPV).
 */
const AUDIENCIA_DE_LA_API = 'avoqado-clients'

export function esTokenDeLaApi(decoded: unknown): boolean {
  if (!decoded || typeof decoded !== 'object') return false
  const { aud, type } = decoded as { aud?: unknown; type?: unknown }
  if (type !== undefined) return false
  if (aud === undefined) return true
  const audiencias = Array.isArray(aud) ? aud : [aud]
  return audiencias.length > 0 && audiencias.every(a => a === AUDIENCIA_DE_LA_API)
}
