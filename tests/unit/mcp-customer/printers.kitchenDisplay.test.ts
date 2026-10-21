/**
 * La casilla de pantalla de cocina por MCP (spec 2026-09-24 §4, etapa 1): sólo Avoqado, en dos pasos,
 * y siempre con el aviso de que la pantalla todavía no está lista para clientes.
 */
import { registerPrinterTools } from '../../../src/mcp/tools/printers'
import type { McpScope } from '../../../src/mcp/scope'
import { getRouting } from '../../../src/services/dashboard/printStation.dashboard.service'
import { ForbiddenError } from '../../../src/errors/AppError'

const mockList = jest.fn()
const mockSet = jest.fn()
const mockAudit = jest.fn()
const mockWriteScope = jest.fn()
const mockListKds = jest.fn()
const mockCountKds = jest.fn()
const AVISO = 'La pantalla de cocina todavía no está lista para clientes.'

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'ajeno') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: () => undefined,
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({
  requireWriteScopeAlways: (...a: unknown[]) => mockWriteScope(...(a as [])),
}))
jest.mock('@/services/dashboard/printStation.dashboard.service', () => ({
  KITCHEN_DISPLAY_NOT_READY_NOTICE:
    'La pantalla de cocina todavía no está lista para clientes. Antes de prenderla a un cliente, falta la etapa 3 (docs/superpowers/specs/2026-09-24-pantalla-de-cocina-como-estacion-design.md §6).',
  listStations: (...a: unknown[]) => mockList(...(a as [])),
  setKitchenDisplay: (...a: unknown[]) => mockSet(...(a as [])),
  getRouting: jest.fn().mockResolvedValue({ hasDefault: true, unroutedCategories: 0 }),
  listPrinters: jest.fn(),
  getGateway: jest.fn(),
  previewRouting: jest.fn(),
}))
jest.mock('@/services/mobile/kds.mobile.service', () => ({
  listKdsOrders: (...a: unknown[]) => mockListKds(...(a as [])),
  countKdsOrders: (...a: unknown[]) => mockCountKds(...(a as [])),
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const estacion = { id: 's1', name: 'Cocina', printer: null, copies: 1, isDefault: true, active: true, hasKitchenDisplay: false }

function registrar(scope: McpScope) {
  const handlers = new Map<string, Handler>()
  registerPrinterTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  return (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})
}
const base = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() }
const avoqado = registrar({ ...base, isSuperAdmin: true } as McpScope)
const cliente = registrar({ ...base, isSuperAdmin: false } as McpScope)

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([estacion])
  mockSet.mockReset().mockResolvedValue({ ...estacion, hasKitchenDisplay: true })
  mockAudit.mockReset()
  mockWriteScope.mockReset()
})

describe('set_print_station_kitchen_display', () => {
  it('primera llamada: sólo muestra antes/después y el aviso, no escribe', async () => {
    const r = parse(await avoqado('set_print_station_kitchen_display', { venueId: 'v1', stationId: 's1', enabled: true }))
    expect(r.requiresConfirmation).toBe(true)
    expect(r.aviso).toContain(AVISO)
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('con confirm: escribe, audita y repite el aviso', async () => {
    const r = parse(await avoqado('set_print_station_kitchen_display', { venueId: 'v1', stationId: 's1', enabled: true, confirm: true }))
    expect(r.ok).toBe(true)
    expect(r.aviso).toContain(AVISO)
    expect(mockSet).toHaveBeenCalledWith('v1', 's1', true, 's1')
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'PRINT_STATION_KITCHEN_DISPLAY_SET' }))
    expect(mockWriteScope).toHaveBeenCalled()
  })

  it('una conexión que no es de Avoqado se rechaza sin escribir ni auditar', async () => {
    const r = parse(await cliente('set_print_station_kitchen_display', { venueId: 'v1', stationId: 's1', enabled: true, confirm: true }))
    expect(r.ok).toBe(false)
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('a una conexión de cliente nunca se le enseña una ruta interna del repo', async () => {
    const r = parse(await cliente('set_print_station_kitchen_display', { venueId: 'v1', stationId: 's1', enabled: true }))
    expect(r.aviso).toContain(AVISO)
    expect(JSON.stringify(r)).not.toContain('docs/')
  })

  it('estación que no es de ese venue: error claro, sin escribir', async () => {
    const r = parse(await avoqado('set_print_station_kitchen_display', { venueId: 'v1', stationId: 'otra', enabled: true, confirm: true }))
    expect(r.ok).toBe(false)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('una conexión que no es de Avoqado SÍ puede APAGARLA (con confirm): escribe y audita', async () => {
    const r = parse(await cliente('set_print_station_kitchen_display', { venueId: 'v1', stationId: 's1', enabled: false, confirm: true }))
    expect(r.ok).toBe(true)
    expect(mockSet).toHaveBeenCalledWith('v1', 's1', false, 's1')
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'PRINT_STATION_KITCHEN_DISPLAY_SET' }))
  })

  it('el ForbiddenError del servicio (plan/otra regla) se explica sin escribir ni auditar', async () => {
    mockSet.mockRejectedValueOnce(
      new ForbiddenError('La pantalla de cocina es del plan Pro. Mejora tu plan para prenderla.', 'KITCHEN_DISPLAY_REQUIRES_PRO'),
    )
    const r = parse(await avoqado('set_print_station_kitchen_display', { venueId: 'v1', stationId: 's1', enabled: true, confirm: true }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('La pantalla de cocina es del plan Pro. Mejora tu plan para prenderla.')
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('un error que NO es ForbiddenError se re-lanza (el catch no se traga fallos reales)', async () => {
    mockSet.mockRejectedValueOnce(new Error('db'))
    await expect(
      avoqado('set_print_station_kitchen_display', { venueId: 'v1', stationId: 's1', enabled: true, confirm: true }),
    ).rejects.toThrow('db')
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('list_print_stations', () => {
  it('devuelve hasKitchenDisplay y el aviso cuando alguna estación la tiene', async () => {
    mockList.mockResolvedValue([{ ...estacion, hasKitchenDisplay: true }])
    const r = parse(await cliente('list_print_stations', { venueId: 'v1' }))
    expect(r.stations[0].hasKitchenDisplay).toBe(true)
    expect(r.pantallaDeCocina).toContain(AVISO)
    expect(r.pantallaDeCocina).not.toContain('docs/')
  })

  it('regresión: sin ninguna, no hay aviso y lo demás sale igual', async () => {
    const r = parse(await cliente('list_print_stations', { venueId: 'v1' }))
    expect(r.stations[0]).toEqual(expect.objectContaining({ id: 's1', name: 'Cocina', isDefault: true, hasKitchenDisplay: false }))
    expect(r.pantallaDeCocina).toBeUndefined()
  })
})

describe('list_kitchen_tickets (etapa 3)', () => {
  it('lee las comandas de UNA estación, acotadas, con el total', async () => {
    mockListKds.mockResolvedValue([
      { id: 'k1', orderNumber: 'A1', status: 'NEW', orderType: 'DINE_IN', items: [{}, {}], createdAt: '2026-09-27T12:00:00.000Z' },
    ])
    mockCountKds.mockResolvedValue(7)
    const r = parse(await cliente('list_kitchen_tickets', { venueId: 'v1', stationId: 'st-1' }))
    expect(mockListKds).toHaveBeenCalledWith('v1', undefined, 'st-1')
    expect(r).toEqual(
      expect.objectContaining({ ok: true, total: 7, devueltas: 1, comandas: [expect.objectContaining({ id: 'k1', renglones: 2 })] }),
    )
  })

  it('3.6: la comanda de una mesa dice la mesa y sus tiempos, en orden y sin repetir; sin mesa va en null', async () => {
    mockListKds.mockResolvedValue([
      {
        id: 'k1',
        orderNumber: 'A1',
        status: 'NEW',
        orderType: 'DINE_IN',
        tableNumber: '8',
        items: [{ course: 'Aperitivos' }, { course: null }, { course: 'Principales' }, { course: 'Aperitivos' }],
        createdAt: '2026-09-27T12:00:00.000Z',
      },
      { id: 'k2', orderNumber: 'A2', status: 'NEW', orderType: 'DINE_IN', items: [{}], createdAt: '2026-09-27T12:01:00.000Z' },
    ])
    mockCountKds.mockResolvedValue(2)
    const r = parse(await cliente('list_kitchen_tickets', { venueId: 'v1' }))
    expect(r.comandas[0]).toEqual(expect.objectContaining({ mesa: '8', tiempos: ['Aperitivos', 'Principales'] }))
    expect(r.comandas[1]).toEqual(expect.objectContaining({ mesa: null, tiempos: [] }))
  })

  it('un venue fuera de alcance se rechaza', async () => {
    await expect(cliente('list_kitchen_tickets', { venueId: 'ajeno' })).rejects.toThrow('ScopeError')
  })

  it('un status inválido no truena: se pasa tal cual (el servicio descarta lo que no reconoce)', async () => {
    mockListKds.mockResolvedValue([])
    mockCountKds.mockResolvedValue(0)
    const r = parse(await cliente('list_kitchen_tickets', { venueId: 'v1', status: 'BOGUS' }))
    expect(r.ok).toBe(true)
    expect(mockListKds).toHaveBeenCalledWith('v1', 'BOGUS', undefined)
  })
})

describe('list_print_stations routing summary', () => {
  it('requests only aggregates and preserves the response', async () => {
    const r = parse(await cliente('list_print_stations', { venueId: 'v1' }))
    expect(getRouting).toHaveBeenCalledWith('v1', { section: 'summary' })
    expect(r.hasDefault).toBe(true)
    expect(r.unroutedCategories).toBe(0)
    expect(r.stations[0].id).toBe('s1')
  })
})
