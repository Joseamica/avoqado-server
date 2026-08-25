import { registerCustomerTools } from '../../../src/mcp/tools/customers'
import type { McpScope } from '../../../src/mcp/scope'

const mockCustomerFindMany = jest.fn()
const mockCustomerCount = jest.fn()
const mockDecide = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      if (v === 'no-perm') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  __esModule: true,
  decideCustomerApprovalFromDashboard: (...a: unknown[]) => mockDecide(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: {
      findMany: (...a: unknown[]) => mockCustomerFindMany(...(a as [])),
      count: (...a: unknown[]) => mockCustomerCount(...(a as [])),
      update: jest.fn(),
    },
    order: { findMany: jest.fn() },
  },
}))

/**
 * Fase 1 — la aprobación de clientes, desde el MCP.
 *
 * Regla 🔴 del repo: una capacidad que no se puede alcanzar por el MCP de cliente está
 * incompleta. Aprobar/rechazar es exactamente el tipo de acción que un operador le va a pedir
 * al asistente ("¿quién está esperando aprobación?", "aprueba a Ana").
 *
 * Y es de las que MÁS necesita el confirm de dos pasos: la petición llega en lenguaje suelto
 * y un rechazo mal interpretado le cierra la puerta a un cliente real.
 */
const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCustomerTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('customers_awaiting_approval (lectura)', () => {
  const call = (args: Record<string, unknown>) => handlers.get('customers_awaiting_approval')!(args, {})

  it('🔴 rechaza un venue fuera del alcance del operador', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
  })

  it('🔴 lista sólo PENDING de ESE venue, del más antiguo al más reciente', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([
      {
        id: 'c1',
        firstName: 'Ana',
        lastName: 'López',
        email: 'ana@t.com',
        phone: null,
        approvalVersion: 0,
        approvalRequestedAt: new Date(),
      },
    ])
    mockCustomerCount.mockResolvedValueOnce(1)

    const out = parse(await call({ venueId: 'v1' }))

    const args = mockCustomerFindMany.mock.calls[0][0]
    expect(args.where).toMatchObject({ approvalStatus: 'PENDING' })
    expect(args.orderBy).toEqual([{ approvalRequestedAt: 'asc' }, { id: 'asc' }])
    expect(out.ok).toBe(true)
    expect(out.customers).toHaveLength(1)
  })

  it('🔴 devuelve `approvalVersion`: es lo que hay que pasarle a la decisión para no pisar a otro', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Ana', approvalVersion: 3, approvalRequestedAt: new Date() }])
    mockCustomerCount.mockResolvedValueOnce(1)

    const out = parse(await call({ venueId: 'v1' }))
    expect(out.customers[0].approvalVersion).toBe(3)
  })
})

describe('decide_customer_approval (write con confirm de dos pasos)', () => {
  const call = (args: Record<string, unknown>) => handlers.get('decide_customer_approval')!(args, {})

  it('🔴 exige el permiso `customers:approve`, no `customers:update`', async () => {
    await expect(call({ venueId: 'no-perm', customerId: 'c1', decision: 'APPROVED' })).rejects.toThrow('customers:approve')
    expect(mockDecide).not.toHaveBeenCalled()
  })

  it('🔴 sin `confirm` NO decide: devuelve una vista previa legible', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([
      { id: 'c1', firstName: 'Ana', lastName: 'López', email: 'ana@t.com', approvalStatus: 'PENDING', approvalVersion: 2 },
    ])

    const out = parse(await call({ venueId: 'v1', customerId: 'c1', decision: 'REJECTED', reason: 'No es alumna' }))

    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBe(true)
    expect(out.message).toContain('Ana')
    expect(mockDecide).not.toHaveBeenCalled()
  })

  it('🔴 con `confirm:true` decide, toma la versión de la fila (no del LLM) y audita', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Ana', approvalStatus: 'PENDING', approvalVersion: 2 }])
    mockDecide.mockResolvedValueOnce({ approvalStatus: 'APPROVED', approvalVersion: 3, changed: true })

    const out = parse(await call({ venueId: 'v1', customerId: 'c1', decision: 'APPROVED', confirm: true }))

    expect(mockDecide).toHaveBeenCalledWith(
      'v1',
      'c1',
      expect.objectContaining({ decision: 'APPROVED', expectedVersion: 2, actorStaffId: 'staff-1' }),
    )
    expect(mockAudit).toHaveBeenCalled()
    expect(out.ok).toBe(true)
  })

  it('🔴 cliente inexistente en ESE venue → error claro, no una decisión a ciegas', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([])

    const out = parse(await call({ venueId: 'v1', customerId: 'c-otro', decision: 'APPROVED', confirm: true }))

    expect(out.ok).toBe(false)
    expect(mockDecide).not.toHaveBeenCalled()
  })
})
