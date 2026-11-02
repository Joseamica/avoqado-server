import { registerPaymentLinkTools } from '@/mcp/tools/paymentLinks'
import { DIRECTORY_TIERS } from '@/mcp/directory/catalog'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { prismaMock } from '../../__helpers__/setup'

const mockCreate = jest.fn()
const mockAudit = jest.fn()
const mockPermission = jest.fn()
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venueId: string) => {
      if (venueId === 'foreign') throw new Error('fuera del alcance')
      return { venueId }
    },
    requirePermission: (...a: unknown[]) => mockPermission(...a),
  }),
}))
jest.mock('@/services/dashboard/paymentLink.service', () => ({ createPaymentLink: (...a: unknown[]) => mockCreate(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
const handlers = new Map<string, (a: any) => Promise<any>>()
const scope: any = { staffId: 'staff-fixture', activeOrg: 'org-fixture' }
const call = async (name: string, args: any) => {
  expect(handlers.has(name)).toBe(true)
  return JSON.parse((await handlers.get(name)!(args)).content[0].text)
}
beforeAll(() => registerPaymentLinkTools({ tool: (...a: any[]) => handlers.set(a[0], a[a.length - 1]) } as any, scope))
beforeEach(() => {
  jest.clearAllMocks()
  mockPermission.mockReset()
})

it('las tools nuevas tienen efectos explícitos y quedan fuera del catálogo certificado', () => {
  expect(TOOL_EFFECTS.create_customer_payment_link).toBe('write')
  expect(TOOL_EFFECTS.customer_payment_links).toBe('read')
  const certified = DIRECTORY_TIERS.flatMap(t => t.tools)
  expect(certified).not.toContain('create_customer_payment_link')
  expect(certified).not.toContain('customer_payment_links')
})
it('create exige ambos permisos antes del preview y de escribir', async () => {
  mockPermission.mockImplementation(permission => {
    if (permission === 'customers:read') throw new Error('sin customers:read')
  })
  for (const confirm of [false, true])
    await expect(call('create_customer_payment_link', { venueId: 'v1', customerId: 'c1', title: 'X', confirm })).rejects.toThrow(
      'customers:read',
    )
  expect(mockCreate).not.toHaveBeenCalled()
})
it('preview no crea; confirmar crea en servicio existente y audita cliente/actor', async () => {
  const args = { venueId: 'v1', customerId: 'customer-A', title: 'Anticipo', amount: 100 }
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A', firstName: 'Fixture' })
  expect(await call('create_customer_payment_link', args)).toMatchObject({
    requiresConfirmation: true,
    preview: { customerId: 'customer-A' },
  })
  expect(mockCreate).not.toHaveBeenCalled()
  mockCreate.mockImplementation(async (...args: any[]) => {
    const link = { id: 'pl-fixture', shortCode: 'fixture', customer: { id: 'customer-A' } }
    await args[4](link)
    return link
  })
  expect(await call('create_customer_payment_link', { ...args, confirm: true })).toMatchObject({ ok: true })
  expect(mockCreate).toHaveBeenCalledWith(
    'v1',
    expect.objectContaining({ customerId: 'customer-A' }),
    'staff-fixture',
    undefined,
    expect.any(Function),
  )
  expect(mockAudit).toHaveBeenCalledWith(
    scope,
    expect.objectContaining({ entityId: 'pl-fixture', data: expect.objectContaining({ customerId: 'customer-A' }) }),
  )
})
it('lectura acotada: ambos permisos, tenant, total, orden estable, default50 y máximo100', async () => {
  prismaMock.paymentLink.count.mockResolvedValue(125)
  prismaMock.paymentLink.findMany.mockResolvedValue([])
  for (const limit of [undefined, 1000]) {
    const out = await call('customer_payment_links', { venueId: 'v1', customerId: 'customer-A', limit })
    expect(out).toMatchObject({ total: 125 })
    expect(prismaMock.paymentLink.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { venueId: 'v1', customerId: 'customer-A' },
        take: limit ? 100 : 50,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    )
  }
  expect(mockPermission).toHaveBeenCalledWith('customers:read', 'v1')
  expect(mockPermission).toHaveBeenCalledWith('payment-link:read', 'v1')
  await expect(call('customer_payment_links', { venueId: 'foreign', customerId: 'customer-A' })).rejects.toThrow('alcance')
})
