/** El registro REAL del MCP (server.ts) trae las dos tools de productos por canal: sin su import, el MCP entero no arranca. */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: new Proxy({}, { get: () => () => undefined }) }))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import { registerAllTools } from '../../../src/mcp/server'
import type { McpScope } from '../../../src/mcp/scope'

it('registerAllTools registra delivery_channel_products y set_delivery_channel_product', () => {
  const names = new Set<string>()
  const fake = { tool: (...a: unknown[]) => names.add(a[0] as string) } as never
  const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as unknown as McpScope
  registerAllTools(fake, scope, { serializedEnabled: false, whiteLabelEnabled: false, catalogEnabled: false })
  expect(names.has('delivery_channel_products')).toBe(true)
  expect(names.has('set_delivery_channel_product')).toBe(true)
})
