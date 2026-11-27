/**
 * Planes editables (B4, Task 1): `plan_prices`, la lectura de los planes vigentes por el MCP. Dinero en PESOS (nunca centavos), sin
 * datos de Stripe. Se llama por el servidor MCP real (`configureToolCatalog` + `registerAllTools`), como corre en producción.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { registerAllTools } from '@/mcp/server'
import type { McpScope } from '@/mcp/scope'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'

const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map(),
  scopes: ['mcp:read', 'mcp:write'],
} as unknown as McpScope

async function conectar() {
  const server = new McpServer({ name: 'plan-prices', version: '1' })
  configureToolCatalog(server, scope)
  registerAllTools(server, scope, { serializedEnabled: true, whiteLabelEnabled: true, catalogEnabled: true })
  const client = new Client({ name: 'prueba', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, server }
}

beforeEach(() => pointer.mockReset().mockResolvedValue(null))

describe('plan_prices', () => {
  it('está declarada como lectura en TOOL_EFFECTS', () => {
    expect(TOOL_EFFECTS.plan_prices).toBe('read')
  })

  it('registrar el catálogo completo no lanza y la lista incluye plan_prices', async () => {
    const { client, server } = await conectar()
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toContain('plan_prices')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('por el servidor MCP real: Pro mensual de la v2 en PESOS (799 sin IVA, 926.84 con IVA)', async () => {
    pointer.mockResolvedValue(
      punteroA(
        'ver_v2',
        2,
        definicionDePrueba({
          ids: idsDeLaVersion('v2'),
          nombres: { PRO: 'Plus' },
          productos: { PRO: 'Avoqado Plus' },
          netos: { 'PRO:monthly': 79900, 'PRO:annual': 850000 },
          planes: { PRO: { trialDays: 14, requiresCard: false }, PREMIUM: { onSale: false } },
        }),
      ),
    )
    const { client, server } = await conectar()
    try {
      const res = await client.callTool({ name: 'plan_prices', arguments: {} })
      const out = JSON.parse((res.content as Array<{ text: string }>)[0].text)
      expect(out.offerVersion).toBe(2)
      expect(out.currency).toBe('MXN')
      const pro = out.plans.find((p: { tier: string }) => p.tier === 'PRO')
      expect(pro).toMatchObject({
        name: 'Plus',
        onSale: true,
        requiresCard: false,
        trialDays: 14,
        monthly: { priceWithoutTax: 799, priceWithTax: 926.84 },
        annual: { priceWithoutTax: 8500, priceWithTax: 9860 },
      })
      expect(out.plans.find((p: { tier: string }) => p.tier === 'PREMIUM').onSale).toBe(false)
      expect(out.plans.find((p: { tier: string }) => p.tier === 'FREE').name).toBe('Gratis')
      const json = JSON.stringify(out)
      expect(json).not.toContain('Cents')
      expect(json).not.toContain('price_v2')
      expect(json).not.toContain('Avoqado Plus')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('sin versiones: los precios de hoy y offerVersion null', async () => {
    const { client, server } = await conectar()
    try {
      const out = JSON.parse(((await client.callTool({ name: 'plan_prices', arguments: {} })).content as Array<{ text: string }>)[0].text)
      expect(out.offerVersion).toBeNull()
      expect(out.plans.find((p: { tier: string }) => p.tier === 'PRO').monthly).toEqual({ priceWithoutTax: 999, priceWithTax: 1158.84 })
    } finally {
      await client.close()
      await server.close()
    }
  })
})
