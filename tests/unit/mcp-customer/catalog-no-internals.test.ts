/**
 * The tool CATALOG is the one thing every connected customer reads — their AI receives all ~250
 * names + descriptions on connect. This test registers the whole catalog for a NON-SUPERADMIN
 * connection and asserts that:
 *   1. `avoqado_internal_docs` is not in it (it is superadmin-only, and must not even be listed),
 *   2. no description leaks stack / infra / ORM / schema / credential material.
 *
 * It is a guard for every FUTURE tool too: a new tool whose description says "Prisma" or
 * "Payment.processedById" fails here instead of shipping to customers.
 */
import { registerAllTools } from '../../../src/mcp/server'
import type { McpScope } from '../../../src/mcp/scope'

/** Terms that must never appear in a customer-visible tool description. */
const FORBIDDEN: Array<[string, RegExp]> = [
  // NB: a bare `groupBy` is NOT listed — it is a legitimate tool PARAMETER name several report
  // tools document (`groupBy: "month" | "city"`). Only unambiguous ORM call shapes count.
  ['ORM / base de datos', /\bprisma\b|\bpostgres(ql)?\b|schema\.prisma|findMany|findUnique|\$transaction|\.groupBy\(/i],
  [
    'infraestructura',
    /\brabbitmq\b|\bcloudamqp\b|\bredis\b|\bsocket\.io\b|\bdocker\b|\brender\.com\b|\bfly\.io\b|\bfirebase\b|\bexpress\.js\b/i,
  ],
  ['modelos internos', /\bStaffVenue\b|\bSerializedItemCustodyEvent\b|\bJournalLine\b|\bActivityLog\b|\bVenueRolePermission\b/],
  ['campos internos', /\b[A-Z][a-zA-Z]+\.(id|venueId|staffId|createdById|processedById|customerId|slug|total)\b/],
  ['rutas de código / API', /\bsrc\/[a-z]+\/|\/api\/v1\/|\bavoqado-server\b/i],
  ['credenciales', /sk_live|pk_live|api[_-]?key|\bsecret\b|password/i],
  ['docs internos', /ARCHITECTURE_OVERVIEW|PAYMENT_ARCHITECTURE|PERMISSIONS_SYSTEM|DATABASE_SCHEMA|SCHEMA_MAP/],
]

function catalogFor(scope: Partial<McpScope>) {
  const tools: Array<{ name: string; desc: string }> = []
  const server = { tool: (...a: unknown[]) => tools.push({ name: a[0] as string, desc: typeof a[1] === 'string' ? a[1] : '' }) } as never
  registerAllTools(server, { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map(), ...scope } as McpScope, {
    serializedEnabled: true,
    whiteLabelEnabled: true,
    catalogEnabled: true,
  })
  return tools
}

describe('customer tool catalog', () => {
  const customer = catalogFor({ isSuperAdmin: undefined })

  // NEW
  it('registers a large catalog for a normal customer connection', () => {
    expect(customer.length).toBeGreaterThan(100)
    expect(customer.some(t => t.name === 'avoqado_help')).toBe(true)
  })

  it('does NOT list avoqado_internal_docs for a non-superadmin, and DOES for a superadmin', () => {
    expect(customer.some(t => t.name === 'avoqado_internal_docs')).toBe(false)
    expect(catalogFor({ isSuperAdmin: true }).some(t => t.name === 'avoqado_internal_docs')).toBe(true)
  })

  it.each(FORBIDDEN)('no customer-visible tool description exposes %s', (_label, pattern) => {
    const offenders = customer.filter(t => pattern.test(t.desc)).map(t => `${t.name}: ${t.desc.match(pattern)?.[0]}`)
    expect(offenders).toEqual([])
  })

  // REGRESSION — the catalog still describes the product in the operator's language
  it('still describes tools in operator language (Spanish/English business terms, not code)', () => {
    const help = customer.find(t => t.name === 'avoqado_help')!
    expect(help.desc).toMatch(/facturaci/i)
    expect(help.desc).toMatch(/plan/i)
  })
})
