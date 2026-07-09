// Importing server.ts pulls the whole tool+service graph. Mock the import-time-heavy deps so
// the import can't fail on missing DATABASE_URL/env. registerAllTools only stores handlers
// (server.tool) — no query runs — so these stubs suffice. Add more mocks if a tool module has
// another import-time side effect.
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: new Proxy({}, { get: () => () => undefined }) }))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import { registerAllTools } from '../../../src/mcp/server'
import type { McpScope } from '../../../src/mcp/scope'

function collect(scope: McpScope, flags: { serializedEnabled: boolean; whiteLabelEnabled: boolean }): Set<string> {
  const names = new Set<string>()
  const fake = { tool: (...a: unknown[]) => names.add(a[0] as string) } as never
  registerAllTools(fake, scope, flags)
  return names
}
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as unknown as McpScope

it('PT connection (serialized ON) sees serialized + sale-verification + cash-out + promoter tools', () => {
  const names = collect(scope, { serializedEnabled: true, whiteLabelEnabled: true })
  expect(names.has('serialized_inventory')).toBe(true)
  expect(names.has('list_serialized_items')).toBe(true)
  expect(names.has('org_confirmed_sales_report')).toBe(true)
  expect(names.has('list_sale_verifications')).toBe(true)
  expect(names.has('cash_out_org_saldos')).toBe(true)
  expect(names.has('promoters_live_locations')).toBe(true)
  expect(names.has('low_stock')).toBe(true) // generic always present
})

it('scalable connection (all modules OFF) sees NO SIM/PT tools, only generic', () => {
  const names = collect(scope, { serializedEnabled: false, whiteLabelEnabled: false })
  expect(names.has('serialized_inventory')).toBe(false)
  expect(names.has('list_serialized_items')).toBe(false)
  expect(names.has('org_confirmed_sales_report')).toBe(false)
  expect(names.has('list_sale_verifications')).toBe(false)
  expect(names.has('cash_out_org_saldos')).toBe(false)
  expect(names.has('record_serialized_sale')).toBe(false)
  expect(names.has('promoters_live_locations')).toBe(false)
  expect(names.has('promoter_location')).toBe(false)
  expect(names.has('low_stock')).toBe(true) // generic tools stay
})
