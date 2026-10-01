import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerMenuTools } from '@/mcp/tools/menu'
import { registerStaffTools } from '@/mcp/tools/staff'
import type { McpScope } from '@/mcp/scope'

const mockProducts = jest.fn()
const mockMembers = jest.fn()
const mockProductWrite = jest.fn()
const mockMemberWrite = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: (...a: unknown[]) => mockProducts(...a) },
    staffVenue: { findMany: (...a: unknown[]) => mockMembers(...a) },
  },
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ updateProduct: (...a: unknown[]) => mockProductWrite(...a) }))
jest.mock('@/services/dashboard/team.dashboard.service', () => ({ updateTeamMember: (...a: unknown[]) => mockMemberWrite(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

let server: McpServer
let client: Client
const product = { id: 'product-A', name: 'Cafe', price: 30, active: true }
const member = {
  id: 'member-A',
  staffId: 'person-A',
  role: 'WAITER',
  active: true,
  staff: { firstName: 'Juan', lastName: 'Perez', active: true },
}
beforeEach(async () => {
  jest.clearAllMocks()
  mockProducts.mockResolvedValue([product])
  mockMembers.mockResolvedValue([member])
  mockProductWrite.mockResolvedValue({ ...product, price: 45 })
  mockMemberWrite.mockResolvedValue({})
  server = new McpServer({ name: 'identity', version: '1' })
  const scope = {
    staffId: 'owner',
    activeOrg: 'org',
    allowedVenueIds: ['centro'],
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([['centro', { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
  } as unknown as McpScope
  configureToolCatalog(server, scope)
  registerMenuTools(server, scope)
  registerStaffTools(server, scope)
  client = new Client({ name: 'identity-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
})
afterEach(async () => {
  await client.close()
  await server.close()
})
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args })
  return JSON.parse((r.content as Array<{ text: string }>)[0].text)
}

it.each(['set_menu_item_price', 'set_menu_item_active'])('%s liga identidad y estado, sin volver a elegir por nombre', async name => {
  const args = { venueId: 'centro', name: 'Cafe', ...(name.endsWith('price') ? { price: 45 } : { active: false }) }
  const p = await call(name, args)
  mockProducts.mockResolvedValue([{ ...product, id: 'product-B', price: 80 }])
  expect(await call(name, { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({
    needsInput: true,
  })
  expect(mockProductWrite).not.toHaveBeenCalled()
  mockProducts.mockResolvedValue([{ ...product, price: 35 }])
  expect(await call(name, { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({
    needsInput: true,
  })
  mockProducts.mockResolvedValue([product])
  expect(await call(name, { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({
    ok: true,
  })
  expect(mockProducts.mock.calls.at(-1)[0].where).toMatchObject({ id: product.id })
  expect(mockProductWrite.mock.calls[0][1]).toBe(product.id)
  expect(mockProductWrite.mock.calls[0][4]).toEqual({ name: 'Cafe', price: 30, active: true })
})

it('el cambio de acceso liga StaffVenue y estado del local, no el estado global de Staff', async () => {
  const p = await call('update_staff_member', { venueId: 'centro', name: 'Juan', role: 'manager' })
  for (const changed of [
    { ...member, id: 'member-B' },
    { ...member, role: 'CASHIER' },
    { ...member, active: false },
  ]) {
    mockMembers.mockResolvedValue([changed])
    expect(
      await call('update_staff_member', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken }),
    ).toMatchObject({ needsInput: true })
    expect(mockMemberWrite).not.toHaveBeenCalled()
  }
  mockMembers.mockResolvedValue([member])
  expect(
    await call('update_staff_member', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken }),
  ).toMatchObject({ ok: true })
  expect(mockMembers.mock.calls.at(-1)[0].where).toMatchObject({ id: member.id })
  expect(mockMemberWrite.mock.calls[0][2]).toMatchObject({ expectedState: { role: 'WAITER', active: true }, callerRole: 'OWNER' })
  mockMembers.mockResolvedValue([{ ...member, active: false }])
  expect(await call('update_staff_member', { venueId: 'centro', name: 'Juan', active: true })).toMatchObject({
    preview: { changes: { active: { from: false, to: true } } },
  })
})
