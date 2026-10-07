// tests/unit/mcp-customer/staff-service-pay.fueraDeLaConexion.fixtures.ts — lo que comparten las dos pruebas de B14-fix2 (decisión del
// founder, 7-oct; ronda 1, M1: el archivo de 561 líneas se partió en `…fueraDeLaConexion.test.ts` —cierre y marcar pagado— y
// `…fueraDeLaConexion.activar.test.ts` —activar, propinas, hermanos y catálogo—). Una conexión MCP limitada a A, en una organización
// con A «Prado Norte», B «Bosques» y C «Condesa». Aquí: los simulacros (cada prueba los registra con `jest.mock(ruta, () =>
// mockF.modulos.<x>)`; este módulo no importa nada simulado, así que cargarlo primero no carga ningún servicio), los datos y la
// preparación de cada prueba. No es una prueba (`testMatch` sólo toma `*.test.ts`).
import type { McpScope } from '../../../src/mcp/scope'

export const mocks = {
  preview: jest.fn(),
  cerrar: jest.fn(),
  previewPagado: jest.fn(),
  marcar: jest.fn(),
  estado: jest.fn(),
  plan: jest.fn(),
  activar: jest.fn(),
  propinas: jest.fn(),
  sedesParaActivar: jest.fn(),
  todas: jest.fn(),
  previewAjuste: jest.fn(),
  previewLiq: jest.fn(),
  // Las lecturas de B14-fix2: qué sedes abarca cada acción, sus nombres y si quien pide es dueño.
  sedesDelCierre: jest.fn(),
  sedesDelPagado: jest.fn(),
  sedesDeLasPropinas: jest.fn(),
  esDueno: jest.fn(),
  auditMcpWrite: jest.fn(),
}
export const nombres: Record<string, string> = { A: 'Prado Norte', B: 'Bosques', C: 'Condesa' }

/** El cuerpo de cada `jest.mock` (la ruta va en la prueba: `jest.mock` sólo se sube al inicio dentro del archivo de prueba). */
export const modulos = {
  guard: {
    // La conexión manda: una sede fuera de `allowedVenueIds` truena como el guard real.
    createGuard: (s: { allowedVenueIds: string[] }) => ({
      venueFilter: (v?: string) => {
        if (v && !s.allowedVenueIds.includes(v)) throw new Error('ScopeError: venue out of scope')
        return { venueId: { in: v ? [v] : s.allowedVenueIds } }
      },
      tienePermiso: () => true,
    }),
  },
  accessService: { hasPermission: () => true },
  acceso: {
    venueHasServicePayAccess: jest.fn().mockResolvedValue(true),
    organizacionTieneServicePay: jest.fn().mockResolvedValue(true),
    assertPermisoEnTodasLasSedes: (...a: unknown[]) => mocks.todas(...a),
    // C2: lo de dinero exige además la activación (sus pruebas, en `staff-service-pay.activacion.test.ts`).
    organizacionDeLaSedeActivada: jest.fn().mockResolvedValue(true),
    MENSAJE_SIN_ACTIVAR: 'Pago al personal todavía no está activado: actívalo en Pago por servicio → Periodos.',
  },
  alcanceDeLaAccion: {
    sedesDelCierre: (...a: unknown[]) => mocks.sedesDelCierre(...a),
    sedesDelPagado: (...a: unknown[]) => mocks.sedesDelPagado(...a),
    sedesDeLasPropinas: (...a: unknown[]) => mocks.sedesDeLasPropinas(...a),
    esDueno: (...a: unknown[]) => mocks.esDueno(...a),
    nombresDeSedes: async (_org: string, ids: string[]) => new Map(ids.filter(id => nombres[id]).map(id => [id, nombres[id]] as const)),
  },
  cierre: {
    previewCierre: (...a: unknown[]) => mocks.preview(...a),
    cerrarPeriodo: (...a: unknown[]) => mocks.cerrar(...a),
  },
  recibos: {
    previewPagado: (...a: unknown[]) => mocks.previewPagado(...a),
    marcarPagado: (...a: unknown[]) => mocks.marcar(...a),
    reciboDePersona: jest.fn(),
  },
  activacion: {
    estadoActivacion: (...a: unknown[]) => mocks.estado(...a),
    previewActivacion: (...a: unknown[]) => mocks.plan(...a),
    activarPagoAlPersonal: (...a: unknown[]) => mocks.activar(...a),
    cambiarPropinas: (...a: unknown[]) => mocks.propinas(...a),
    ventanasDePropinas: jest.fn().mockResolvedValue([]),
    sedesParaActivar: (...a: unknown[]) => mocks.sedesParaActivar(...a),
  },
  ajustesManuales: { agregarAjusteManual: jest.fn(), previewAjusteManual: (...a: unknown[]) => mocks.previewAjuste(...a) },
  liquidacion: { previewLiquidacion: (...a: unknown[]) => mocks.previewLiq(...a), liquidarDiferencia: jest.fn() },
  reporte: { reportePeriodo: jest.fn(), detallePersona: jest.fn() },
  periodosGuardados: { periodoQueContieneFecha: jest.fn() },
  diferencias: { diferenciasDelPeriodo: jest.fn() },
  ajustesClase: { pagoDeClase: jest.fn(), previewAjusteDeClase: jest.fn(), guardarAjusteDeClase: jest.fn() },
  niveles: { listarNiveles: jest.fn(), nivelesVigentes: jest.fn() },
  tablas: { listarTablas: jest.fn() },
  participacion: { activarSede: jest.fn(), desactivarSede: jest.fn() },
  vistaPrevia: { vistaPreviaParticipacion: jest.fn() },
  sedesService: { estadoSedes: jest.fn() },
  requireWriteScopeAlways: { requireWriteScopeAlways: jest.fn() },
  audit: { auditMcpWrite: mocks.auditMcpWrite },
  prismaClient: {
    __esModule: true,
    default: {
      venue: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City', name: 'Prado Norte', currency: 'MXN' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
  },
}

export type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
/** La conexión de `allowedVenueIds`; el usuario (s1) tiene `staffpay:close` en A, B y C. Si es dueño lo dice `mocks.esDueno`. */
export const conexion = (allowedVenueIds: string[]) =>
  ({
    staffId: 's1',
    activeOrg: 'o1',
    allowedVenueIds,
    perVenueAccess: new Map(['A', 'B', 'C'].map(v => [v, { role: 'MANAGER' }])),
    scopes: ['mcp:read', 'mcp:write'],
  }) as unknown as McpScope
export const llamar = async (h: Map<string, Handler>, tool: string, args: Record<string, unknown>) =>
  JSON.parse((await h.get(tool)!(args, {})).content[0].text)

export const HUELLA = 'h'.repeat(64)
export const B_FUERA = [{ venueId: 'B', nombre: 'Bosques' }]
const cuenta = (total: string) => ({
  clases: { n: 0, total: '0.00', pendientesDeValoracion: 0 },
  comisiones: { n: 1, total },
  propinas: { n: 0, total: '0.00' },
})
/** La vista previa del cierre de A y B: B con su comisión de $100 y su devolución pendiente de −$50. */
export const VISTA = {
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
  huella: HUELLA,
  sedesConDinero: ['A', 'B'],
  porSede: [
    {
      venueId: 'A',
      nombre: 'Prado Norte',
      estado: 'ACTIVA',
      entra: cuenta('30.00'),
      fuera: cuenta('0.00'),
      pendientes: { n: 0, total: '0.00' },
    },
    {
      venueId: 'B',
      nombre: 'Bosques',
      estado: 'ACTIVA',
      entra: cuenta('100.00'),
      fuera: cuenta('0.00'),
      pendientes: { n: 1, total: '-50.00' },
    },
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
export const CIERRE = { venueId: 'A', fecha: '2026-10-15' }
export const PAGADO = { venueId: 'A', periodId: 'p9', staffId: 'sofia' }
const PV_PAGADO = {
  periodo: { start: '2026-09-01', end: '2026-09-30', estado: 'CLOSED' },
  cantidad: 1,
  total: '130.00',
  recibos: [{ staffId: 'sofia', nombre: 'Sofía QA', total: '130.00' }],
  huella: 'p'.repeat(64),
}
export const ACTIVAR = { venueId: 'A', accion: 'activar', periodicidad: 'MONTHLY' }
export const PROPINAS = { venueId: 'A', accion: 'propinas', encender: true }
const NEGATIVA_B =
  'Esta acción incluye Bosques, que no está en esta conexión. Hazla desde el dashboard o con una conexión que incluya todas las sedes.'
/** Lo que la negativa a quien no es dueño NO trae: ni vista previa, ni huella, ni un monto de B. */
export const sinDatosDeB = (r: Record<string, unknown>) => {
  expect(r).toEqual({ ok: false, code: 'FUERA_DE_LA_CONEXION', error: NEGATIVA_B })
  expect(JSON.stringify(r)).not.toMatch(/100\.00|130\.00|-50\.00|\bB\b/)
}

/** El `beforeEach` de las dos pruebas: el dueño, con A y B en todo. */
export function prepararMocks() {
  jest.clearAllMocks()
  mocks.preview.mockResolvedValue(structuredClone(VISTA))
  mocks.cerrar.mockResolvedValue({
    periodId: 'p10',
    start: '2026-10-01',
    end: '2026-10-31',
    venueIds: ['A', 'B'],
    personas: 2,
    total: '130.00',
    huella: HUELLA,
    yaCerrado: false,
  })
  mocks.previewPagado.mockResolvedValue(structuredClone(PV_PAGADO))
  mocks.marcar.mockResolvedValue({ marcados: 1 })
  mocks.estado.mockResolvedValue({ activado: false, startDate: null, propinasEncendidas: false })
  mocks.plan.mockResolvedValue({ periodicidad: 'MONTHLY', periodicidadFija: false, startDate: '2026-10-01' })
  mocks.activar.mockResolvedValue({ startDate: '2026-10-01', yaActivado: false })
  mocks.propinas.mockResolvedValue({ encendidas: true, cambio: true })
  mocks.sedesParaActivar.mockResolvedValue({
    conPlan: [
      { venueId: 'A', nombre: 'Prado Norte' },
      { venueId: 'B', nombre: 'Bosques' },
    ],
    sinPlan: [],
    sinPlanTotal: 0,
  })
  mocks.todas.mockResolvedValue(undefined)
  mocks.sedesDelCierre.mockResolvedValue(['A', 'B'])
  mocks.sedesDelPagado.mockResolvedValue(['A', 'B'])
  mocks.sedesDeLasPropinas.mockResolvedValue(['A', 'B'])
  mocks.esDueno.mockResolvedValue(true)
}
