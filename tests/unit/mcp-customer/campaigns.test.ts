/**
 * Las tools del MCP para campañas de correo (negocio → SUS clientes).
 *
 * 🔴 Lo que estas pruebas fijan, y ninguna es cosmética:
 *
 *  1. Leer exige `marketing:manage`, NO `marketing:read` — ése lo tienen roles de PISO para
 *     ver el aviso de privacidad, y con él un cajero vería todos los borradores y el conteo
 *     de audiencia de cada campaña.
 *  2. La lista NO arrastra el cuerpo del correo.
 *  3. «Nunca configurada» y «pausada» son estados DISTINTOS: guían acciones distintas.
 *  4. Encender pide `marketing:send`; PAUSAR pide el permiso menor, porque parar nunca
 *     puede ser más difícil que arrancar.
 *  5. Encender es de dos pasos.
 */
import { registerCampaignTools } from '../../../src/mcp/tools/campaigns'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindMany = jest.fn()
const mockCount = jest.fn()
const mockObtener = jest.fn()
const mockCambiar = jest.fn()
const mockAudit = jest.fn()
/** Los permisos que se exigieron, para poder afirmar CUÁL se pidió. */
const permisosPedidos: string[] = []

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'ajeno') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      permisosPedidos.push(perm)
      if (v === 'sin-permiso') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/marketing/birthdayAutomation.service', () => ({
  obtenerAutomatizacion: (...a: unknown[]) => mockObtener(...(a as [])),
  cambiarEstadoAutomatizacion: (...a: unknown[]) => mockCambiar(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customerCampaign: {
      findMany: (...a: unknown[]) => mockFindMany(...(a as [])),
      count: (...a: unknown[]) => mockCount(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCampaignTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  permisosPedidos.length = 0
  mockFindMany.mockResolvedValue([])
  mockCount.mockResolvedValue(0)
})

describe('list_customer_campaigns', () => {
  it('🔴 exige marketing:manage, no marketing:read', async () => {
    await call('list_customer_campaigns', { venueId: 'v1' })
    expect(permisosPedidos).toContain('marketing:manage')
    expect(permisosPedidos).not.toContain('marketing:read')
  })

  it('🔴 NO pide el cuerpo del correo: el select va acotado', async () => {
    await call('list_customer_campaigns', { venueId: 'v1' })
    const select = mockFindMany.mock.calls[0][0].select
    expect(select).toBeDefined()
    expect(select.htmlBody ?? false).toBe(false)
    expect(select.textBody ?? false).toBe(false)
  })

  it('ordena con desempate único y se acota al venue', async () => {
    await call('list_customer_campaigns', { venueId: 'v1' })
    const args = mockFindMany.mock.calls[0][0]
    expect(args.where).toEqual({ venueId: 'v1' })
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('un venue fuera de tu alcance no se lee', async () => {
    await expect(call('list_customer_campaigns', { venueId: 'ajeno' })).rejects.toThrow(/ScopeError/)
  })
})

describe('birthday_automation_status — los tres estados', () => {
  it('🔴 nunca configurada NO se reporta como pausada', async () => {
    mockObtener.mockResolvedValue(null)
    const r = parse(await call('birthday_automation_status', { venueId: 'v1' }))
    expect(r.configurada).toBe(false)
    expect(r.estado).toBe('SIN_CONFIGURAR')
  })

  it('encendida lo dice, con sus días de antelación', async () => {
    mockObtener.mockResolvedValue({ status: 'ACTIVE', subject: '¡Feliz cumple!', daysBefore: 7, lastEvaluatedLocalDate: '2026-09-03' })
    const r = parse(await call('birthday_automation_status', { venueId: 'v1' }))
    expect(r.encendida).toBe(true)
    expect(r.diasDeAntelacion).toBe(7)
  })

  it('pausada es un estado propio', async () => {
    mockObtener.mockResolvedValue({ status: 'PAUSED', subject: 'x', daysBefore: 7, lastEvaluatedLocalDate: null })
    const r = parse(await call('birthday_automation_status', { venueId: 'v1' }))
    expect(r.configurada).toBe(true)
    expect(r.encendida).toBe(false)
  })
})

describe('set_birthday_automation', () => {
  beforeEach(() => {
    mockObtener.mockResolvedValue({ status: 'PAUSED', subject: 'x', daysBefore: 7, lastEvaluatedLocalDate: null })
    mockCambiar.mockResolvedValue({ id: 'a1', status: 'ACTIVE' })
  })

  it('🔴 ENCENDER pide marketing:send', async () => {
    await call('set_birthday_automation', { venueId: 'v1', activa: true, confirm: true })
    expect(permisosPedidos).toContain('marketing:send')
  })

  it('🔴 PAUSAR pide el permiso menor: parar no puede ser más difícil que arrancar', async () => {
    mockObtener.mockResolvedValue({ status: 'ACTIVE', subject: 'x', daysBefore: 7, lastEvaluatedLocalDate: null })
    mockCambiar.mockResolvedValue({ id: 'a1', status: 'PAUSED' })

    await call('set_birthday_automation', { venueId: 'v1', activa: false, confirm: true })

    expect(permisosPedidos).toContain('marketing:manage')
    expect(permisosPedidos).not.toContain('marketing:send')
  })

  it('🔴 sin confirm no cambia nada: enseña qué pasaría', async () => {
    const r = parse(await call('set_birthday_automation', { venueId: 'v1', activa: true }))
    expect(r.requiresConfirmation).toBe(true)
    expect(r.preview.a).toBe('ACTIVE')
    expect(mockCambiar).not.toHaveBeenCalled()
  })

  it('con confirm sí cambia, y queda en la bitácora', async () => {
    const r = parse(await call('set_birthday_automation', { venueId: 'v1', activa: true, confirm: true }))
    expect(r.ok).toBe(true)
    expect(mockCambiar).toHaveBeenCalledWith('v1', true, 's1')
    expect(mockAudit).toHaveBeenCalled()
  })

  it('🔴 no se enciende algo que nadie ha escrito: mandaría un correo vacío', async () => {
    mockObtener.mockResolvedValue(null)
    const r = parse(await call('set_birthday_automation', { venueId: 'v1', activa: true, confirm: true }))
    expect(r.ok).toBe(false)
    expect(mockCambiar).not.toHaveBeenCalled()
  })

  it('pedir el estado que ya tiene no hace nada ni pide confirmación', async () => {
    const r = parse(await call('set_birthday_automation', { venueId: 'v1', activa: false }))
    expect(r.sinCambios).toBe(true)
    expect(mockCambiar).not.toHaveBeenCalled()
  })
})
