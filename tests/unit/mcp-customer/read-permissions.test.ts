import { resolveStaffVenuePermissions } from '@/lib/resolveEffectivePermissions'
import { hasPermission as roleHasPermission } from '@/lib/permissions'
import { createGuard } from '@/mcp/guard'
import { StaffRole } from '@prisma/client'
import { registerProductTools } from '@/mcp/tools/products'
import { registerSeatTools } from '@/mcp/tools/seats'
import { registerOverviewTools } from '@/mcp/tools/overview'
import type { McpScope } from '@/mcp/scope'
import prisma from '@/utils/prismaClient'
import { getDowngradePreview, getVenueSeatStatus } from '@/services/dashboard/seatReconciliation.service'

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  getVenueSeatStatus: jest.fn().mockResolvedValue({}),
  getDowngradePreview: jest.fn().mockResolvedValue({ staff: [] }),
  scheduleDowngradeToFree: jest.fn(),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn().mockResolvedValue({ name: 'Centro', timezone: 'America/Mexico_City' }) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 10, tipAmount: 0 }, _count: { _all: 1 } }) },
    order: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingBalance: 0 }, _count: { _all: 0 } }) },
    inventory: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      fields: { minimumStock: 'minimumStock' },
    },
    shift: { count: jest.fn().mockResolvedValue(0) },
    reservation: {
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn().mockResolvedValue({ startsAt: new Date(), guestName: 'Privada' }),
    },
  },
}))

function tools(permissions: string[]) {
  const scope: McpScope = {
    staffId: 'staff',
    activeOrg: 'org',
    scopes: ['mcp:read'],
    allowedVenueIds: ['v1', 'v2'],
    perVenueAccess: new Map([
      ['v1', { role: StaffRole.WAITER, corePermissions: permissions } as never],
      ['v2', { role: StaffRole.WAITER, corePermissions: [] } as never],
    ]),
  }
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<any>>()
  const server = { tool: (...args: unknown[]) => handlers.set(args[0] as string, args.at(-1) as never) } as never
  registerProductTools(server, scope)
  registerSeatTools(server, scope)
  registerOverviewTools(server, scope)
  return (name: string, args = {}) => handlers.get(name)!({ venueId: 'v1', name: 'Sopa', ...args })
}

beforeEach(() => jest.clearAllMocks())

it.each([
  ['product_sales', 'reports:read'],
  ['get_venue_downgrade_preview', 'billing:subscriptions:read'],
  ['get_venue_seat_status', 'teams:read'],
])('%s exige el mismo permiso del dashboard y lo evalúa por sucursal', async (name, permission) => {
  await expect(tools([])(name)).rejects.toThrow(permission)
  expect(prisma.venue.findUnique).not.toHaveBeenCalled()
  expect(getVenueSeatStatus).not.toHaveBeenCalled()
  expect(getDowngradePreview).not.toHaveBeenCalled()
  await expect(tools([permission])(name)).resolves.toBeDefined()
  await expect(tools([permission])(name, { venueId: 'v2' })).rejects.toThrow(permission)
})

it('analytics no otorga datos de reservas, caja, órdenes ni inventario en el resumen', async () => {
  const result = await tools(['analytics:read'])('today_overview')
  const data = JSON.parse(result.content[0].text)
  expect(data.salesToday.gross).toBe(10)
  expect(data.reservationsToday).toBeNull()
  expect(data.openTabs).toBeNull()
  expect(data.openShifts).toBeNull()
  expect(data.lowStockItems).toBeNull()
  expect(data.restrictions.reservationsToday).toMatchObject({ permission: 'reservations:read' })
  expect(prisma.reservation.count).not.toHaveBeenCalled()
  expect(prisma.reservation.findFirst).not.toHaveBeenCalled()
  expect(prisma.shift.count).not.toHaveBeenCalled()
  expect(prisma.inventory.findMany).not.toHaveBeenCalled()
  expect(prisma.order.aggregate).not.toHaveBeenCalled()
})

describe('permisos efectivos: misma fuente que REST', () => {
  it('respeta una exclusión de un comodín en un venue y el permiso en el otro', () => {
    const permitted = resolveStaffVenuePermissions({ role: StaffRole.ADMIN })
    const restricted = resolveStaffVenuePermissions({ role: StaffRole.ADMIN }, { deniedPermissions: ['orders:print'] })
    const guard = createGuard({
      staffId: 's1',
      activeOrg: 'o1',
      scopes: ['mcp:read', 'mcp:write'],
      allowedVenueIds: ['a', 'b'],
      perVenueAccess: new Map([
        ['a', { role: StaffRole.ADMIN, corePermissions: permitted } as never],
        ['b', { role: StaffRole.ADMIN, corePermissions: restricted } as never],
      ]),
    })
    expect(roleHasPermission(StaffRole.ADMIN, null, 'orders:print', ['orders:print'])).toBe(false)
    expect(() => guard.requirePermission('orders:print', 'a')).not.toThrow()
    expect(() => guard.requirePermission('orders:print', 'b')).toThrow('orders:print')
  })

  it('un PermissionSet limitado reemplaza los defaults; un permiso custom usa la misma resolución', () => {
    const limited = resolveStaffVenuePermissions({
      role: StaffRole.ADMIN,
      permissionSetId: 'set',
      permissionSet: { permissions: ['venue:read'] } as never,
    })
    const custom = resolveStaffVenuePermissions({ role: StaffRole.WAITER }, { permissions: ['billing:subscriptions:read'] })
    expect(limited).not.toContain('billing:subscriptions:read')
    expect(custom).toContain('billing:subscriptions:read')
    expect(roleHasPermission(StaffRole.WAITER, ['billing:subscriptions:read'], 'billing:subscriptions:read')).toBe(true)
  })
})
