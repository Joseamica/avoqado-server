import { registerPaymentLinkTools } from '../../../src/mcp/tools/paymentLinks'
import type { McpScope } from '../../../src/mcp/scope'

// Founder 23-oct: a una liga SIN cliente se le puede agregar uno (nunca cambiarlo); el MCP lo hace igual que el panel.
const mockUpdate = jest.fn()
const mockAudit = jest.fn()
const mockLinkFind = jest.fn()
const mockCustomerFind = jest.fn()
const perms: string[] = []

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      perms.push(perm)
      if (v === 'no-perm') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/services/dashboard/paymentLink.service', () => ({ updatePaymentLink: (...a: unknown[]) => mockUpdate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { paymentLink: { findFirst: (...a: unknown[]) => mockLinkFind(...a) }, customer: { findFirst: (...a: unknown[]) => mockCustomerFind(...a) } },
}))

const CUSTOMER = 'cm00000000000000000000001'
const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('add_customer_to_payment_link')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerPaymentLinkTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  perms.length = 0
})

describe('add_customer_to_payment_link', () => {
  it('pide payment-link:update y customers:read, y respeta la sucursal', async () => {
    await expect(call({ venueId: 'foreign', linkId: 'pl1', customerId: CUSTOMER })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', linkId: 'pl1', customerId: CUSTOMER })).rejects.toThrow('Forbidden')
    expect(perms).toContain('payment-link:update')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('sin confirm sólo muestra la vista previa', async () => {
    mockLinkFind.mockResolvedValue({ id: 'pl1', title: 'Anticipo', customerId: null, status: 'ACTIVE', isReusable: false })
    mockCustomerFind.mockResolvedValue({ id: CUSTOMER, firstName: 'Ana', lastName: null, email: null, phone: null })
    const out = parse(await call({ venueId: 'v1', linkId: 'pl1', customerId: CUSTOMER }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({ linkId: 'pl1', title: 'Anticipo', customer: { id: CUSTOMER } })
    expect(perms).toEqual(expect.arrayContaining(['payment-link:update', 'customers:read']))
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('una liga que ya tiene otro cliente no se ofrece cambiar', async () => {
    mockLinkFind.mockResolvedValue({ id: 'pl1', title: 'Anticipo', customerId: 'cm00000000000000000000002', status: 'ACTIVE', isReusable: false })
    const out = parse(await call({ venueId: 'v1', linkId: 'pl1', customerId: CUSTOMER }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/ya tiene un cliente/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('con confirm usa el mismo servicio del panel y audita', async () => {
    // El servicio llama al auditor del MCP sólo cuando de verdad agregó (no en un reintento sin cambio).
    mockUpdate.mockImplementation(async (...a: unknown[]) => {
      await (a[4] as () => Promise<void>)()
      return { id: 'pl1', shortCode: 'AB12', title: 'Anticipo', customer: { id: CUSTOMER }, status: 'ACTIVE' }
    })
    const out = parse(await call({ venueId: 'v1', linkId: 'pl1', customerId: CUSTOMER, confirm: true }))
    expect(mockUpdate).toHaveBeenCalledWith('v1', 'pl1', { customerId: CUSTOMER }, 's1', expect.any(Function))
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'PAYMENT_LINK_CUSTOMER_ADDED', entityId: 'pl1' }))
    expect(out).toMatchObject({ ok: true, paymentLink: { id: 'pl1', customer: { id: CUSTOMER } } })
  })

  it('un error del servicio (409) se devuelve sin auditar', async () => {
    mockUpdate.mockRejectedValue(new Error('Esta liga ya tiene un cliente y no se puede cambiar'))
    const out = parse(await call({ venueId: 'v1', linkId: 'pl1', customerId: CUSTOMER, confirm: true }))
    expect(out).toMatchObject({ ok: false })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
