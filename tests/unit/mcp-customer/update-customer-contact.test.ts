// update_customer_contact (26-oct-2026, D2): el MCP edita nombre, apellido, teléfono y correo de un cliente — la misma
// capacidad que el dashboard y el POS. Dos pasos: la primera llamada enseña «antes → después»; sólo `confirm:true`
// escribe (cambiar teléfono o correo cambia a quién le llegan avisos y la lealtad).
import { registerCustomerTools } from '../../../src/mcp/tools/customers'
import type { McpScope } from '../../../src/mcp/scope'
import prisma from '@/utils/prismaClient'
import { conectarPorElCatalogo } from '../../__helpers__/mcp-por-el-catalogo'

const mockUpdate = jest.fn()
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
jest.mock('@/services/dashboard/customer.dashboard.service', () => {
  const { BadRequestError } = jest.requireActual('@/errors/AppError')
  return {
    createCustomer: jest.fn(),
    decideCustomerApprovalFromDashboard: jest.fn(),
    updateCustomer: (...a: unknown[]) => mockUpdate(...(a as [])),
    CUSTOMER_PHONE_TAKEN: 'CUSTOMER_PHONE_TAKEN',
    CUSTOMER_EMAIL_TAKEN: 'CUSTOMER_EMAIL_TAKEN',
    __BadRequestError: BadRequestError,
  }
})
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customer: { findMany: jest.fn(), update: jest.fn() }, order: { findMany: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('update_customer_contact')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const findMany = prisma.customer.findMany as jest.Mock

const soloTelefono = { id: 'c1', firstName: null, lastName: null, phone: '+527351748538', email: null }

beforeAll(() => {
  registerCustomerTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('update_customer_contact (write, dos pasos)', () => {
  it('fuera de alcance o sin customers:update no escribe', async () => {
    await expect(call({ venueId: 'foreign', search: '7351', firstName: 'Ana' })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', search: '7351', firstName: 'Ana' })).rejects.toThrow('customers:update')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('sin ningún dato que cambiar no busca ni escribe', async () => {
    const out = parse(await call({ venueId: 'v1', search: '7351' }))
    expect(out.ok).toBe(false)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('varios clientes coinciden: los enseña y no escribe (resolver, no adivinar)', async () => {
    findMany.mockResolvedValueOnce([soloTelefono, { ...soloTelefono, id: 'c2', firstName: 'Beto' }])
    const out = parse(await call({ venueId: 'v1', search: '55', firstName: 'Ana' }))
    expect(out).toMatchObject({ ok: false, ambiguous: true })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('P1 sin confirm enseña «antes → después» y NO escribe', async () => {
    findMany.mockResolvedValueOnce([soloTelefono])
    const out = parse(await call({ venueId: 'v1', search: '7351748538', firstName: 'Ana' }))
    expect(out).toMatchObject({ ok: false, requiresConfirmation: true, expectedCustomerId: 'c1' })
    expect(out.preview).toEqual(['Nombre: (vacío) → Ana'])
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('P1 con confirm escribe SÓLO lo que cambió, con quien lo pidió, audita y devuelve sólo contacto', async () => {
    findMany.mockResolvedValueOnce([soloTelefono])
    mockUpdate.mockResolvedValueOnce({ ...soloTelefono, firstName: 'Ana', password: '$2b$hash', totalSpent: '65.00' })
    const out = parse(await call({ venueId: 'v1', expectedCustomerId: 'c1', firstName: 'Ana', phone: '+52 735 174 8538', confirm: true }))
    expect(mockUpdate).toHaveBeenCalledWith('v1', 'c1', { firstName: 'Ana' }, 's1')
    expect(out).toEqual({
      ok: true,
      customer: { id: 'c1', firstName: 'Ana', lastName: null, phone: '+527351748538', email: null },
    })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'CUSTOMER_CONTACT_UPDATED',
      entity: 'Customer',
      entityId: 'c1',
      venueId: 'v1',
    })
  })

  it('formatos inválidos se dicen en español, sin escribir', async () => {
    findMany.mockResolvedValueOnce([soloTelefono])
    const out = parse(await call({ venueId: 'v1', expectedCustomerId: 'c1', email: 'ana@', confirm: true }))
    expect(out).toMatchObject({ ok: false, error: 'El correo no es válido' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('sin cambios reales lo dice y no escribe', async () => {
    findMany.mockResolvedValueOnce([soloTelefono])
    const out = parse(await call({ venueId: 'v1', expectedCustomerId: 'c1', phone: '+527351748538', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('teléfono de otro cliente: lo dice en español', async () => {
    findMany.mockResolvedValueOnce([soloTelefono])
    const { __BadRequestError: BadRequestError } = jest.requireMock('@/services/dashboard/customer.dashboard.service')
    mockUpdate.mockRejectedValueOnce(new BadRequestError('Customer with phone +525511112222 already exists', 'CUSTOMER_PHONE_TAKEN'))
    const out = parse(await call({ venueId: 'v1', expectedCustomerId: 'c1', phone: '+525511112222', confirm: true }))
    expect(out).toMatchObject({ ok: false, error: 'Ese teléfono ya es de otro cliente.' })
  })

  it('P1 confirm sin el expectedCustomerId de la vista previa no escribe (Codex r4 #1)', async () => {
    const out = parse(await call({ venueId: 'v1', search: 'Ana', firstName: 'Ana', confirm: true }))
    expect(out.ok).toBe(false)
    expect(findMany).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('P1 la confirmación escribe al cliente REVISADO aunque la búsqueda ya apunte a otro (Codex r4 #1)', async () => {
    // Entre la vista previa y la confirmación, A cambió de nombre y B quedó como única coincidencia de «Ana».
    findMany.mockResolvedValueOnce([soloTelefono])
    mockUpdate.mockResolvedValueOnce({ ...soloTelefono, phone: '+525511112222' })
    await call({ venueId: 'v1', search: 'Ana', expectedCustomerId: 'c1', phone: '+525511112222', confirm: true })
    expect(findMany.mock.calls[0][0].where).toMatchObject({ id: 'c1' })
    expect(mockUpdate).toHaveBeenCalledWith('v1', 'c1', { phone: '+525511112222' }, 's1')
  })

  describe('por el catálogo real (vista previa → token → confirmar), como corre en producción', () => {
    it('P1 la vista previa ata expectedCustomerId y la confirmación con el token guarda UNA vez', async () => {
      const c = await conectarPorElCatalogo(server => registerCustomerTools(server as never, scope), scope)
      try {
        findMany.mockResolvedValue([soloTelefono])
        mockUpdate.mockResolvedValueOnce({ ...soloTelefono, firstName: 'Ana' })
        const vista = await c.call('update_customer_contact', { venueId: 'v1', search: '7351748538', firstName: 'Ana' })
        expect(vista.requiresConfirmation).toBe(true)
        expect(vista.confirmationArguments).toEqual({ venueId: 'v1', search: '7351748538', firstName: 'Ana', expectedCustomerId: 'c1' })
        expect(mockUpdate).not.toHaveBeenCalled()

        const sinToken = await c.call('update_customer_contact', { ...vista.confirmationArguments, confirm: true })
        expect(sinToken).toMatchObject({ needsInput: true, field: 'confirmationToken' })
        expect(mockUpdate).not.toHaveBeenCalled()

        const out = await c.call('update_customer_contact', {
          ...vista.confirmationArguments,
          confirm: true,
          confirmationToken: vista.confirmationToken,
        })
        expect(out).toMatchObject({ ok: true, customer: { id: 'c1', firstName: 'Ana' } })
        expect(mockUpdate).toHaveBeenCalledTimes(1)
        expect(mockUpdate).toHaveBeenCalledWith('v1', 'c1', { firstName: 'Ana' }, 's1')
      } finally {
        findMany.mockReset()
        await c.close()
      }
    })
  })
})
