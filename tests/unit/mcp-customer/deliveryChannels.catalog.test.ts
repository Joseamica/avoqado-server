/**
 * Las dos tools de impresión del delivery atravesando el catálogo REAL (`configureToolCatalog`): sin su efecto
 * declarado en TOOL_EFFECTS el registro lanza y se cae todo el MCP; y la escritura sigue el mismo flujo
 * con `confirmationToken` que `set_print_station_kitchen_display`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerDeliveryChannelTools } from '../../../src/mcp/tools/deliveryChannels'

const mockUpdate = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    deliveryChannelLink: {
      findMany: jest.fn().mockResolvedValue([{ id: 'l1', provider: 'RAPPI', status: 'ACTIVE', config: {} }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'l1', provider: 'RAPPI', status: 'ACTIVE', config: {} }),
    },
    printStation: { findMany: jest.fn().mockResolvedValue([{ id: 'st1', active: true, sendsComanda: true }]) },
  },
}))
jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: (v: string) => ({ venueId: v }), requirePermission: jest.fn() }) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: jest.fn() }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/delivery-channels/core/deliveryChannelLink.service', () => ({
  updateChannelLink: (...a: unknown[]) => mockUpdate(...a),
}))

const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map(),
  scopes: ['mcp:read', 'mcp:write'],
} as unknown as McpScope

let server: McpServer
let client: Client
const call = async (name: string, args: Record<string, unknown>) =>
  JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text)

beforeEach(async () => {
  mockUpdate.mockReset().mockResolvedValue({})
  server = new McpServer({ name: 'delivery', version: '1' })
  configureToolCatalog(server, scope)
  registerDeliveryChannelTools(server, scope) // lanzaría sin TOOL_EFFECTS
  client = new Client({ name: 't', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
})
afterEach(async () => {
  await client.close()
  await server.close()
})

const args = { venueId: 'v1', linkId: 'l1', comanda: 'UNA_ESTACION', estacionId: 'st1', empaque: 'NO' }

describe('impresión del delivery por el catálogo real', () => {
  it('la lectura está registrada y responde', async () => {
    const r = await call('delivery_channel_printing', { venueId: 'v1' })
    expect(r.channels[0].impresion.guardada).toEqual({ comanda: 'SALON', empaque: 'NEGOCIO' })
  })

  it('la escritura: vista previa con token y sin escribir', async () => {
    const r = await call('set_delivery_channel_printing', args)
    expect(r).toMatchObject({ requiresConfirmation: true, confirmationToken: expect.any(String) })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('confirm sin token no escribe', async () => {
    expect(await call('set_delivery_channel_printing', { ...args, confirm: true })).toMatchObject({ needsInput: true })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('confirm + token + mismos argumentos escribe una vez', async () => {
    const p = await call('set_delivery_channel_printing', args)
    const r = await call('set_delivery_channel_printing', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
    expect(r.ok).toBe(true)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })
})
