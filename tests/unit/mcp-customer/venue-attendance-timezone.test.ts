import { registerStaffTools } from '@/mcp/tools/staff'
import type { McpScope } from '@/mcp/scope'

const mockVenueFindUnique = jest.fn()
const mockTimeEntryFindMany = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venueId: string) => ({ venueId: { in: [venueId] } }),
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...args: unknown[]) => mockVenueFindUnique(...(args as [])) },
    timeEntry: { findMany: (...args: unknown[]) => mockTimeEntryFindMany(...(args as [])) },
  },
}))

const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'actor-1', activeOrg: 'org-1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope

beforeAll(() => {
  registerStaffTools({ tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as never) } as never, scope)
})

beforeEach(() => {
  jest.clearAllMocks()
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  mockTimeEntryFindMany.mockResolvedValue([])
})

it('venue_attendance convierte el día local del venue a límites UTC', async () => {
  await handlers.get('venue_attendance')!({ venueId: 'v1', startDate: '2026-08-27', endDate: '2026-08-27' }, {})

  const range = mockTimeEntryFindMany.mock.calls[0][0].where.clockInTime
  expect(range.gte).toEqual(new Date('2026-08-27T06:00:00.000Z'))
  expect(range.lte).toEqual(new Date('2026-08-28T05:59:59.999Z'))
})
