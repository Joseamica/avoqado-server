import { registerStaffTools } from '@/mcp/tools/staff'
import type { McpScope } from '@/mcp/scope'

const mockFindMany = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venueId: string) => ({ venueId: { in: [venueId] } }),
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { count: jest.fn().mockResolvedValue(2), findMany: (...args: unknown[]) => mockFindMany(...(args as [])) },
    venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }) },
  },
}))
// RH fase 1a: list_staff agrega los puestos vigentes; aquí no hay ninguno (la prueba de los puestos vive en rh.tools.test.ts).
jest.mock('@/services/dashboard/rh/marcaBlanca', () => ({ pagoGenericoPermitido: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/dashboard/rh/asignaciones.service', () => ({ asignacionesVigentes: jest.fn().mockResolvedValue(new Map()) }))

const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'actor-1', activeOrg: 'org-1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope

beforeAll(() => {
  registerStaffTools({ tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as never) } as never, scope)
})

it('list_staff exposes StaffVenue.id and Staff.id needed by reservation management tools', async () => {
  mockFindMany.mockResolvedValue([
    {
      id: 'staff-venue-1',
      staffId: 'staff-1',
      role: 'MANAGER',
      staff: { firstName: 'Ana', lastName: 'Alfa', active: true },
    },
  ])

  const result = await handlers.get('list_staff')!({ venueId: 'v1' }, {})
  const out = JSON.parse(result.content[0].text)

  expect(out.staff).toEqual([
    {
      staffVenueId: 'staff-venue-1',
      staffId: 'staff-1',
      name: 'Ana Alfa',
      role: 'MANAGER',
      active: true,
      puestos: [],
    },
  ])
})
