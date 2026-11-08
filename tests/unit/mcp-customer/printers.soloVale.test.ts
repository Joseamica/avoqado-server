/**
 * Aparatos claros, Paso 1: `list_print_stations` no cuenta como problema las categorías «Sólo vale» (su área no manda comanda).
 */
import { registerPrinterTools } from '../../../src/mcp/tools/printers'
import type { McpScope } from '../../../src/mcp/scope'

const mockRouting = jest.fn()
jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: () => ({}), requirePermission: () => undefined }) }))
jest.mock('@/services/dashboard/printStation.dashboard.service', () => ({
  KITCHEN_DISPLAY_NOT_READY_NOTICE: 'aviso',
  listStations: jest.fn().mockResolvedValue([]),
  getRouting: (...a: unknown[]) => mockRouting(...a),
  setKitchenDisplay: jest.fn(),
  listPrinters: jest.fn(),
  getGateway: jest.fn(),
  previewRouting: jest.fn(),
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
async function listar() {
  const handlers = new Map<string, Handler>()
  registerPrinterTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, {
    staffId: 's1',
  } as unknown as McpScope)
  const r = await handlers.get('list_print_stations')!({ venueId: 'v1' }, {})
  return JSON.parse(r.content[0].text)
}
const CREMERIA = [{ id: 'a1', name: 'Cremería' }]

describe('list_print_stations con «Sólo vale»', () => {
  it('si todas las sin ruta son «Sólo vale», no avisa SIN ESTACIÓN: explica que sólo sacan vale', async () => {
    mockRouting.mockResolvedValue({ hasDefault: false, unroutedCategories: 16, areaTicketOnlyUnrouted: 16, areasWithoutComanda: CREMERIA })
    const r = await listar()
    expect(r.unroutedCategories).toBe(16)
    expect(r.areaTicketOnlyUnrouted).toBe(16)
    expect(r.nota).not.toMatch(/^\d+ categoría\(s\) sin ruta/)
    expect(r.nota).toMatch(/Cremería, que sólo sacan vale/)
    // Codex r2 #3: con el mismo límite que dice el DASHBOARD.
    expect(r.nota).toMatch(/Si uno de sus productos se cobra sin vale .*va a la estación del producto o de su categoría; si ninguna tiene, sale marcada "SIN ESTACIÓN"/)
  })

  it('con otras sin ruta, avisa sólo por ésas', async () => {
    mockRouting.mockResolvedValue({ hasDefault: false, unroutedCategories: 18, areaTicketOnlyUnrouted: 16, areasWithoutComanda: CREMERIA })
    expect((await listar()).nota).toMatch(/^2 categoría\(s\) sin ruta/)
  })

  it('un negocio sin vales recibe la nota de siempre', async () => {
    mockRouting.mockResolvedValue({ hasDefault: false, unroutedCategories: 3 })
    const r = await listar()
    expect(r.nota).toBe(
      '3 categoría(s) sin ruta y sin estación default: sus productos imprimirían una comanda marcada "SIN ESTACIÓN". Asigna una estación o marca un default.',
    )
    expect(r.areaTicketOnlyUnrouted).toBeUndefined()
  })
})
