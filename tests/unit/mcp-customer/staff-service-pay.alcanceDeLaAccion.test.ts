// tests/unit/mcp-customer/staff-service-pay.alcanceDeLaAccion.test.ts — fase 3, B14-fix2: lo que el MCP LEE para saber qué
// sedes abarca cada acción de toda la organización. Son las MISMAS en que el service exige el permiso: el cierre, el alcance de
// su periodo (con plan y con ventana, la regla de la vista previa); marcar pagado, las sedes del recibo de esa persona o las del
// periodo; las propinas, las sedes con el plan. Más los nombres (acotados a la organización) y quién es dueño (OWNER de la
// organización con la regla única de la plataforma, o SUPERADMIN). Servicios y base simulados.
import type { McpScope } from '../../../src/mcp/scope'
import {
  esDueno,
  nombresDeSedes,
  sedesDeLasPropinas,
  sedesDelCierre,
  sedesDelPagado,
} from '../../../src/mcp/tools/staffPay.alcanceDeLaAccion'

const mockVenue = jest.fn()
const mockVenues = jest.fn()
const mockPeriodo = jest.fn()
const mockConPlan = jest.fn()
const mockConVentana = jest.fn()
const mockAlcance = jest.fn()
const mockDeRecibo = jest.fn()
const mockDueno = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenue(...a), findMany: (...a: unknown[]) => mockVenues(...a) },
    servicePayPeriod: { findFirst: (...a: unknown[]) => mockPeriodo(...a) },
  },
}))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({ sedesConServicePay: (...a: unknown[]) => mockConPlan(...a) }))
jest.mock('@/services/dashboard/staffPay/participacion', () => ({ sedesConVentana: (...a: unknown[]) => mockConVentana(...a) }))
jest.mock('@/services/dashboard/staffPay/cierre.alcance', () => ({ alcanceDelPreview: (...a: unknown[]) => mockAlcance(...a) }))
jest.mock('@/services/dashboard/staffPay/recibos.service', () => ({ sedesDeRecibo: (...a: unknown[]) => mockDeRecibo(...a) }))
jest.mock('@/services/staffOrganization.service', () => ({ esDuenoDeLaOrganizacion: (...a: unknown[]) => mockDueno(...a) }))

beforeEach(() => {
  jest.clearAllMocks()
  mockVenue.mockResolvedValue({ organizationId: 'o1' })
})

describe('qué sedes abarca cada acción', () => {
  it('el cierre: el alcance del periodo con la regla de la vista previa (sedes con plan ∪ con ventana), de la organización de la sede', async () => {
    mockConPlan.mockResolvedValue(['A'])
    mockConVentana.mockResolvedValue(['B'])
    mockAlcance.mockResolvedValue({ venueIds: ['A', 'B'], sedes: [] })
    expect(await sedesDelCierre('A', '2026-10-15')).toEqual(['A', 'B'])
    expect(mockVenue).toHaveBeenCalledWith({ where: { id: 'A' }, select: { organizationId: true } })
    expect(mockConPlan).toHaveBeenCalledWith('o1')
    expect(mockConVentana).toHaveBeenCalledWith(expect.anything(), 'o1')
    expect(mockAlcance).toHaveBeenCalledWith(expect.anything(), 'o1', '2026-10-15', { activas: ['A'], conVentana: ['B'] })
  })

  it('marcar pagado: con persona, las sedes de SU recibo; sin persona, las del periodo; un periodo de otra organización, ninguna', async () => {
    mockPeriodo.mockResolvedValue({ id: 'p9', venueIds: ['A', 'B', 'C'] })
    mockDeRecibo.mockResolvedValue(['A', 'B'])
    expect(await sedesDelPagado('A', 'p9', 'sofia')).toEqual(['A', 'B'])
    expect(mockPeriodo).toHaveBeenCalledWith({ where: { id: 'p9', organizationId: 'o1' }, select: { id: true, venueIds: true } })
    expect(mockDeRecibo).toHaveBeenCalledWith(expect.anything(), 'p9', 'sofia')
    expect(await sedesDelPagado('A', 'p9')).toEqual(['A', 'B', 'C'])
    mockPeriodo.mockResolvedValue(null)
    mockDeRecibo.mockClear()
    expect(await sedesDelPagado('A', 'p9', 'sofia')).toEqual([])
    expect(mockDeRecibo).not.toHaveBeenCalled()
  })

  it('las propinas: las sedes con el plan (donde el service exige el permiso)', async () => {
    mockConPlan.mockResolvedValue(['A', 'B'])
    expect(await sedesDeLasPropinas('o1')).toEqual(['A', 'B'])
    expect(mockConPlan).toHaveBeenCalledWith('o1')
  })

  it('una sede que no existe no abarca nada', async () => {
    mockVenue.mockResolvedValue(null)
    expect(await sedesDelCierre('X', '2026-10-15')).toEqual([])
    expect(await sedesDelPagado('X', 'p9')).toEqual([])
    expect(mockAlcance).not.toHaveBeenCalled()
    expect(mockPeriodo).not.toHaveBeenCalled()
  })
})

describe('nombres y dueño', () => {
  it('los nombres se leen acotados a la organización y con tope', async () => {
    mockVenues.mockResolvedValue([{ id: 'B', name: 'Bosques' }])
    const n = await nombresDeSedes('o1', ['B', 'B', 'Z'])
    expect(n.get('B')).toBe('Bosques')
    expect(n.has('Z')).toBe(false)
    expect(mockVenues).toHaveBeenCalledWith({
      where: { organizationId: 'o1', id: { in: ['B', 'Z'] } },
      select: { id: true, name: true },
      take: 2,
    })
  })

  it('dueño = OWNER de la organización activa de la conexión (regla única) o SUPERADMIN, leído en cada llamada', async () => {
    const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['A'] } as unknown as McpScope
    mockDueno.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await esDueno(scope)).toBe(true)
    expect(await esDueno(scope)).toBe(false)
    expect(mockDueno).toHaveBeenCalledWith('s1', 'o1')
    mockDueno.mockClear()
    expect(await esDueno({ ...scope, isSuperAdmin: true } as McpScope)).toBe(true)
    expect(mockDueno).not.toHaveBeenCalled()
  })
})
