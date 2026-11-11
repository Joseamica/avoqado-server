/**
 * Estación «No lleva comanda» por MCP (plan 2026-11-10, Task 2): `create_no_comanda_print_station` sólo CREA, en dos pasos,
 * con las mismas puertas que `set_print_station_kitchen_display` (venue, `printers:manage` y `mcp:write`). La guarda y la
 * puerta de escritura son las reales: sólo se simulan el servicio y la bitácora.
 */
import { registerPrinterTools } from '../../../src/mcp/tools/printers'
import type { McpScope } from '../../../src/mcp/scope'

const mockList = jest.fn()
const mockCreate = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/printStation.dashboard.service', () => ({
  KITCHEN_DISPLAY_NOT_READY_NOTICE: 'aviso',
  listStations: (...a: unknown[]) => mockList(...(a as [])),
  createStation: (...a: unknown[]) => mockCreate(...(a as [])),
  setKitchenDisplay: jest.fn(),
  getRouting: jest.fn(),
  listPrinters: jest.fn(),
  getGateway: jest.fn(),
  previewRouting: jest.fn(),
}))
jest.mock('@/services/mobile/kds.mobile.service', () => ({ listKdsOrders: jest.fn(), countKdsOrders: jest.fn() }))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const TOOL = 'create_no_comanda_print_station'

function registrar(scope: McpScope) {
  const handlers = new Map<string, Handler>()
  registerPrinterTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  return (args: Record<string, unknown>) => handlers.get(TOOL)!(args, {})
}
const conRol = (role: string, corePermissions: string[], scopes = ['mcp:read', 'mcp:write']) =>
  registrar({
    staffId: 'staff-1',
    activeOrg: 'o1',
    isSuperAdmin: false,
    allowedVenueIds: ['v1'],
    scopes,
    perVenueAccess: new Map([['v1', { role, corePermissions, isSuperAdmin: false }]]),
  } as unknown as McpScope)
const dueno = conRol('OWNER', ['*:*'])

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([{ id: 's1', name: 'Cocina' }])
  mockCreate.mockReset().mockResolvedValue({ id: 'st-tienda', name: 'Tienda', sendsComanda: false })
  mockAudit.mockReset()
})

describe('create_no_comanda_print_station', () => {
  it('mcp_sin_confirm_cero_escrituras: la primera llamada sólo describe qué se crea y qué sigue', async () => {
    const r = parse(await dueno({ venueId: 'v1', name: 'Tienda' }))
    expect(r.requiresConfirmation).toBe(true)
    expect(r.mensaje).toContain('«Tienda»')
    expect(r.mensaje).toContain('No lleva comanda')
    expect(r.seCrea).toEqual(
      expect.objectContaining({ name: 'Tienda', sendsComanda: false, impresora: null, predeterminada: false, pantallaDeCocina: false }),
    )
    expect(r.despues).toMatch(/pestaña Ruteo/)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('mcp_con_confirm_crea_y_audita: crea sin comanda a nombre de quien conectó y deja la bitácora MCP', async () => {
    const r = parse(await dueno({ venueId: 'v1', name: 'Tienda', confirm: true }))
    expect(r.ok).toBe(true)
    expect(r.station).toEqual({ id: 'st-tienda', name: 'Tienda', sendsComanda: false })
    expect(r.siguiente).toMatch(/pestaña Ruteo/)
    expect(mockCreate).toHaveBeenCalledWith('v1', { name: 'Tienda', sendsComanda: false }, 'staff-1')
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff-1' }),
      expect.objectContaining({
        action: 'PRINT_STATION_CREATED',
        entity: 'PrintStation',
        entityId: 'st-tienda',
        venueId: 'v1',
        data: { name: 'Tienda', sendsComanda: false },
      }),
    )
  })

  it('un nombre que ya existe en el negocio se explica sin escribir', async () => {
    const r = parse(await dueno({ venueId: 'v1', name: 'Cocina', confirm: true }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Ya existe')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  describe('mcp_respeta_permisos', () => {
    it.each([
      ['un negocio fuera de su alcance', dueno, { venueId: 'ajeno', name: 'Tienda', confirm: true }],
      ['un rol sin printers:manage', conRol('WAITER', ['printers:read']), { venueId: 'v1', name: 'Tienda', confirm: true }],
      ['una conexión de sólo lectura', conRol('OWNER', ['*:*'], ['mcp:read']), { venueId: 'v1', name: 'Tienda', confirm: true }],
      ['tampoco la vista previa sin printers:manage', conRol('WAITER', ['printers:read']), { venueId: 'v1', name: 'Tienda' }],
    ])('%s ⇒ se rechaza sin escribir ni auditar', async (_caso, llamar, args) => {
      await expect(llamar(args)).rejects.toMatchObject({ name: 'ScopeError' })
      expect(mockCreate).not.toHaveBeenCalled()
      expect(mockAudit).not.toHaveBeenCalled()
      expect(mockList).not.toHaveBeenCalled()
    })
  })
})
