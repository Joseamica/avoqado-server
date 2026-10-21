// tests/unit/mcp-customer/staff-service-pay.alcanceConexion.test.ts — fase 3, B14-fix F1 (Codex participación r1 #1): el MCP de
// pago al personal NO devuelve datos ni montos de sedes fuera del alcance de la CONEXIÓN, aunque el usuario tenga permiso en
// ellas. Conexión limitada a A; el usuario lee A y B. Los servicios van simulados (su acotamiento se prueba en integración,
// `alcanceConexion.test.ts`): aquí se fija que el MCP les pasa el alcance y que la vista previa de un RECHAZO (`HUELLA_CAMBIO`)
// sale acotada igual que la normal. Ruling de B13 intacto: los TEXTOS de bloqueo pueden nombrar sedes del periodo. B14-fix2: un
// cierre con B fuera de la conexión ya no se acota: al dueño se le avisa y a los demás se les niega (sus pruebas, en
// `staff-service-pay.fueraDeLaConexion.test.ts`); aquí queda lo que no cambió.
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import type { McpScope } from '../../../src/mcp/scope'
import { ConflictError } from '@/errors/AppError'

const mockReporte = jest.fn()
const mockDetalle = jest.fn()
const mockRecibo = jest.fn()
const mockPeriodoDeFecha = jest.fn()
const mockPreview = jest.fn()
const mockCerrar = jest.fn()
const mockDiferencias = jest.fn()
const mockLiquidar = jest.fn()
const mockPreviewLiq = jest.fn()
const mockSedesDelCierre = jest.fn()
const mockEsDueno = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'A') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: ['A'] } }
    },
    tienePermiso: () => true,
  }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true }))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  venueHasServicePayAccess: jest.fn().mockResolvedValue(true),
  organizacionTieneServicePay: jest.fn().mockResolvedValue(true),
  assertPermisoEnTodasLasSedes: jest.fn(),
  // C2: lo de dinero exige además la activación (sus pruebas, en `staff-service-pay.activacion.test.ts`).
  organizacionDeLaSedeActivada: jest.fn().mockResolvedValue(true),
  MENSAJE_SIN_ACTIVAR:
    'Pago al personal todavía no está activado: actívalo en Pago al personal → Periodos. Activarlo pide el permiso de cerrar periodos en todas las sucursales; si no lo tienes, pídeselo al dueño del negocio.',
}))
jest.mock('@/mcp/tools/staffPay.alcanceDeLaAccion', () => ({
  sedesDelCierre: (...a: unknown[]) => mockSedesDelCierre(...a),
  sedesDelPagado: jest.fn(),
  sedesDeLasPropinas: jest.fn(),
  esDueno: (...a: unknown[]) => mockEsDueno(...a),
  nombresDeSedes: async (_o: string, ids: string[]) => new Map(ids.map(id => [id, id] as const)),
}))
jest.mock('@/services/dashboard/staffPay/reporte.service', () => ({
  reportePeriodo: (...a: unknown[]) => mockReporte(...a),
  detallePersona: (...a: unknown[]) => mockDetalle(...a),
}))
jest.mock('@/services/dashboard/staffPay/recibos.service', () => ({
  marcarPagado: jest.fn(),
  previewPagado: jest.fn(),
  reciboDePersona: (...a: unknown[]) => mockRecibo(...a),
}))
jest.mock('@/services/dashboard/staffPay/periodosGuardados', () => ({
  periodoQueContieneFecha: (...a: unknown[]) => mockPeriodoDeFecha(...a),
}))
jest.mock('@/services/dashboard/staffPay/cierre.service', () => ({
  previewCierre: (...a: unknown[]) => mockPreview(...a),
  cerrarPeriodo: (...a: unknown[]) => mockCerrar(...a),
}))
jest.mock('@/services/dashboard/staffPay/diferencias.service', () => ({
  diferenciasDelPeriodo: (...a: unknown[]) => mockDiferencias(...a),
}))
jest.mock('@/services/dashboard/staffPay/liquidacion.service', () => ({
  previewLiquidacion: (...a: unknown[]) => mockPreviewLiq(...a),
  liquidarDiferencia: (...a: unknown[]) => mockLiquidar(...a),
}))
jest.mock('@/services/dashboard/staffPay/ajustesClase.service', () => ({
  pagoDeClase: jest.fn(),
  previewAjusteDeClase: jest.fn(),
  guardarAjusteDeClase: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/niveles.service', () => ({ listarNiveles: jest.fn(), nivelesVigentes: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/tablas.service', () => ({ listarTablas: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/ajustesManuales.service', () => ({
  agregarAjusteManual: jest.fn(),
  previewAjusteManual: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/activacion.service', () => ({
  estadoActivacion: jest.fn(),
  previewActivacion: jest.fn(),
  activarPagoAlPersonal: jest.fn(),
  cambiarPropinas: jest.fn(),
  ventanasDePropinas: jest.fn(),
  sedesParaActivar: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/participacion', () => ({ activarSede: jest.fn(), desactivarSede: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/participacion.vistaPrevia', () => ({ vistaPreviaParticipacion: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/sedes.service', () => ({ estadoSedes: jest.fn() }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City', name: 'A', currency: 'MXN' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
/** La conexión ve SÓLO A; el usuario (s1) tiene permisos en A y en B. */
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['A'],
  perVenueAccess: new Map([
    ['A', { role: 'OWNER' }],
    ['B', { role: 'OWNER' }],
  ]),
  scopes: ['mcp:read', 'mcp:write'],
} as unknown as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const llamar = async (tool: string, args: Record<string, unknown>) => parse(await handlers.get(tool)!(args, {}))

const cuenta = (total: string) => ({
  clases: { n: 0, total: '0.00', pendientesDeValoracion: 0 },
  comisiones: { n: 1, total },
  propinas: { n: 0, total: '0.00' },
})
/** La vista previa COMPLETA de un cierre de A y B: B con su comisión de $100 y su devolución pendiente de −$50. */
const VISTA_COMPLETA = {
  periodo: { id: 'p10', start: '2026-10-01', end: '2026-10-31', venueIds: ['A', 'B'] },
  puedeCerrar: true,
  bloqueos: [],
  clases: 0,
  excluidas: 0,
  personas: 2,
  totalServicios: '0.00',
  totalAjustes: '0.00',
  comisiones: 2,
  propinas: 0,
  reversos: 0,
  totalVentas: '130.00',
  propinasSinDueno: { n: 0, total: '0.00' },
  comisionesPorRevisar: 0,
  total: '130.00',
  huerfanas: 0,
  huella: 'h'.repeat(64),
  sedesConDinero: ['A', 'B'],
  porSede: [
    { venueId: 'A', nombre: 'A', estado: 'ACTIVA', entra: cuenta('30.00'), fuera: cuenta('0.00'), pendientes: { n: 0, total: '0.00' } },
    { venueId: 'B', nombre: 'B', estado: 'ACTIVA', entra: cuenta('100.00'), fuera: cuenta('0.00'), pendientes: { n: 1, total: '-50.00' } },
  ],
  pendientes: {
    n: 1,
    total: '-50.00',
    porDestino: [
      {
        seDescuenta: { tipo: 'AL_CERRAR', periodo: { start: '2026-11-01', end: '2026-11-30' } },
        n: 1,
        total: '-50.00',
        porSede: [{ venueId: 'B', n: 1, total: '-50.00' }],
      },
    ],
  },
}
/** Lo que una respuesta del MCP no debe traer de B: ni su id en `porSede`/pendientes ni sus montos. */
const sinB = (preview: { porSede: Array<{ venueId: string }>; pendientes: { n: number; total: string; porDestino: unknown[] } }) => {
  expect(preview.porSede.map(s => s.venueId)).toEqual(['A'])
  expect(preview.pendientes).toEqual({ n: 0, total: '0.00', porDestino: [] })
  expect(JSON.stringify(preview.porSede)).not.toContain('100.00')
  expect(JSON.stringify(preview.pendientes)).not.toContain('-50.00')
}

beforeAll(() =>
  registerStaffPayTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => {
  jest.clearAllMocks()
  mockPeriodoDeFecha.mockResolvedValue({ id: 'p10', status: 'OPEN' })
  mockPreview.mockResolvedValue(VISTA_COMPLETA)
  mockSedesDelCierre.mockResolvedValue(['A'])
  mockEsDueno.mockResolvedValue(true)
})

describe('B14-fix F1: el MCP acota a la conexión TODO lo de varias sedes', () => {
  it('cierre con B en el periodo: quien no es dueño no recibe ni un número de B (B14-fix2: FUERA_DE_LA_CONEXION)', async () => {
    mockEsDueno.mockResolvedValue(false)
    const r = await llamar('close_service_pay_period', { venueId: 'A', fecha: '2026-10-15' })
    expect(r).toMatchObject({ ok: false, code: 'FUERA_DE_LA_CONEXION' })
    expect(r).not.toHaveProperty('preview')
    expect(JSON.stringify(r)).not.toMatch(/100\.00|-50\.00/)
  })

  it('cierre: la vista previa que trae HUELLA_CAMBIO sale acotada IGUAL (antes: B con $100 y −$50), también al dueño', async () => {
    const { expectedSourceFingerprint } = await llamar('close_service_pay_period', { venueId: 'A', fecha: '2026-10-15' })
    mockSedesDelCierre.mockResolvedValue(['A', 'B'])
    mockCerrar.mockRejectedValue(
      new ConflictError('Los números cambiaron desde que los revisaste: revisa el cierre de nuevo', 'HUELLA_CAMBIO', {
        preview: VISTA_COMPLETA,
      }),
    )
    const r = await llamar('close_service_pay_period', { venueId: 'A', fecha: '2026-10-15', confirm: true, expectedSourceFingerprint })
    expect(r).toMatchObject({ ok: false, code: 'HUELLA_CAMBIO' })
    sinB(r.preview)
  })

  it('un rechazo sin vista previa sigue igual: `preview: null`', async () => {
    mockCerrar.mockRejectedValue(new ConflictError('Ya está cerrado', 'PERIODO_CERRADO'))
    const r = await llamar('close_service_pay_period', { venueId: 'A', fecha: '2026-10-15', confirm: true, expectedSourceFingerprint: 'x' })
    expect(r).toMatchObject({ ok: false, code: 'PERIODO_CERRADO', preview: null })
  })

  it('resumen del periodo: el reporte se pide con el alcance de la conexión', async () => {
    mockReporte.mockResolvedValue({ tarjetas: { total: '30.00' } })
    await llamar('staff_service_pay_summary', { venueId: 'A', fecha: '2026-10-15' })
    expect(mockReporte).toHaveBeenCalledWith(expect.objectContaining({ userId: 's1', venueId: 'A', soloSedes: ['A'] }))
  })

  it('recibo en vivo (vista "recibo"), recibo congelado y desglose: los tres con el alcance de la conexión', async () => {
    mockRecibo.mockResolvedValue({ persona: 'Sofía', renglones: [], total: '30.00', pendientes: null })
    mockDetalle.mockResolvedValue({ items: [], nextCursor: null })
    await llamar('staff_service_pay_detail', { venueId: 'A', staffId: 'sofia', fecha: '2026-10-15', vista: 'recibo' })
    mockPeriodoDeFecha.mockResolvedValue({ id: 'p9', status: 'CLOSED' })
    await llamar('staff_service_pay_detail', { venueId: 'A', staffId: 'sofia', fecha: '2026-09-15' })
    mockPeriodoDeFecha.mockResolvedValue({ id: 'p10', status: 'OPEN' })
    await llamar('staff_service_pay_detail', { venueId: 'A', staffId: 'sofia', fecha: '2026-10-15' })
    expect(mockRecibo).toHaveBeenCalledTimes(2)
    for (const [entrada] of mockRecibo.mock.calls) expect(entrada).toMatchObject({ userId: 's1', staffId: 'sofia', soloSedes: ['A'] })
    expect(mockDetalle).toHaveBeenCalledWith(expect.objectContaining({ userId: 's1', staffId: 'sofia', soloSedes: ['A'] }))
  })

  it('diferencias de un periodo cerrado: con el alcance de la conexión', async () => {
    mockDiferencias.mockResolvedValue({ items: [], nextCursor: null, parcial: true })
    await llamar('staff_service_pay_differences', { venueId: 'A', periodId: 'p9' })
    expect(mockDiferencias).toHaveBeenCalledWith(expect.objectContaining({ userId: 's1', periodId: 'p9', soloSedes: ['A'] }))
  })

  it('pedir la sede B explícita sigue siendo un error de alcance, antes de consultar nada', async () => {
    await expect(handlers.get('staff_service_pay_detail')!({ venueId: 'A', staffId: 'sofia', sede: 'B' }, {})).rejects.toThrow('ScopeError')
    expect(mockRecibo).not.toHaveBeenCalled()
    expect(mockDetalle).not.toHaveBeenCalled()
  })
})
