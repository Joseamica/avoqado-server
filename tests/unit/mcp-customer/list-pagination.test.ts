import { registerMenuTools } from '@/mcp/tools/menu'
import { registerStaffTools } from '@/mcp/tools/staff'
import { registerPaymentLinkTools } from '@/mcp/tools/paymentLinks'
import type { McpScope } from '@/mcp/scope'

const mockFind = jest.fn().mockResolvedValue([])
const mockCount = jest.fn().mockResolvedValue(250)
const mockPermission = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: Object.fromEntries(
    ['product', 'staffVenue', 'paymentLink'].map(name => [
      name,
      { findMany: (...a: unknown[]) => mockFind(...a), count: (...a: unknown[]) => mockCount(...a) },
    ]),
  ),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (venueId: string) => ({ venueId }), requirePermission: (...a: unknown[]) => mockPermission(...a) }),
}))
const handlers = new Map<string, (args: Record<string, unknown>) => Promise<any>>()
beforeAll(() => {
  const server = { tool: (...args: any[]) => handlers.set(args[0], args.at(-1)) } as never
  const scope = { staffId: 's', activeOrg: 'o' } as McpScope
  registerMenuTools(server, scope)
  registerStaffTools(server, scope)
  registerPaymentLinkTools(server, scope)
})
beforeEach(() => jest.clearAllMocks())
it.each(['list_menu', 'list_staff', 'list_payment_links'])('%s conserva el total y permite la página siguiente', async name => {
  const out = JSON.parse((await handlers.get(name)!({ venueId: 'v1', limit: 10, offset: 20 })).content[0].text)
  expect(out).toMatchObject({ count: 0, total: 250, hasMore: true, nextOffset: 20 })
  expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 20 }))
  expect(mockCount.mock.calls[0][0].where).toEqual(mockFind.mock.calls[0][0].where)
})
it('los tres lectores de menú deniegan antes de consultar datos sin menu:read', async () => {
  mockPermission.mockImplementation(() => {
    throw new Error('denied')
  })
  for (const name of ['list_menu', 'menu_item_detail', 'menu_categories']) {
    await expect(handlers.get(name)!({ venueId: 'v1', name: 'Café' })).rejects.toThrow('denied')
  }
  expect(mockFind).not.toHaveBeenCalled()
  expect(mockPermission).toHaveBeenCalledWith('menu:read', 'v1')
})
