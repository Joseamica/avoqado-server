/**
 * Filtro de las respuestas del catálogo de directorio (`/mcp/directory`). Las herramientas son las mismas del MCP
 * manual; aquí sólo se retira lo que las políticas de los directorios no aceptan: identificadores fiscales
 * (RFC, folio del CFDI), identificadores de integraciones de terceros y la invitación a comprar un plan.
 * El MCP manual nunca pasa por aquí.
 */
const REDACTED_KEYS = new Set([
  'rfc',
  'curp',
  'nss',
  'clabe',
  'fiscalUuid',
  'fiscalReference',
  'ownerAuthorizedClientId',
  'ownerAuthorizedStoreId',
  'ownerAuthorizedByIntentId',
  'ownerAuthorizedEnvironment',
  'activatingIntentId',
  'activationOwner',
  'revocationVersion',
  'externalAccountId',
  'externalLocationId',
  'externalMerchantId',
  'issuerCountryCode',
  'internationalityShadow',
  'providerReference',
  'webhookSecret',
])

const UPSELL = / ?El dueño puede subir de plan en el dashboard \(Configuración → Plan\)\./g

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!REDACTED_KEYS.has(k)) out[k] = scrub(v)
    return out
  }
  if (typeof value === 'string') return value.replace(UPSELL, '')
  return value
}

type ToolResult = { content?: Array<{ type?: string; text?: string }>; [k: string]: unknown }

export function redactDirectoryResult<T extends ToolResult>(result: T): T {
  if (!result?.content) return result
  const content = result.content.map(item => {
    if (item.type !== 'text' || typeof item.text !== 'string') return item
    try {
      return { ...item, text: JSON.stringify(scrub(JSON.parse(item.text)), null, 2) }
    } catch {
      return { ...item, text: item.text.replace(UPSELL, '') }
    }
  })
  return { ...result, content }
}
