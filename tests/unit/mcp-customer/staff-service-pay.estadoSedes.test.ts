// tests/unit/mcp-customer/staff-service-pay.estadoSedes.test.ts — fase 3, B13 (diseño r5.1, r3.7(1); revisión de B12 #7): lo que
// el MCP ya devolvía crudo (`porSede`, `pendientes`, `avisoPendientes`) se dice en palabras del dueño, `staff_service_pay_config`
// trae las sedes de la pantalla 1, y TODO eso se acota a las sedes del alcance de la CONEXIÓN (además del permiso del usuario).
// Los servicios van simulados (sus reglas se prueban en integración). B14-fix2: el cierre con una sede fuera de la conexión ya no se
// acota: al dueño se le avisa y ve todo lo que confirma; a los demás se les niega (`staff-service-pay.fueraDeLaConexion.test.ts`).
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import type { McpScope } from '../../../src/mcp/scope'

const mockTiene = jest.fn()
const mockPreview = jest.fn()
const mockPreviewAjuste = jest.fn()
const mockEstadoSedes = jest.fn()
const mockEsDueno = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v ?? 'v1'] } }
    },
    tienePermiso: (permiso: string, venueId: string) => mockTiene(permiso, venueId),
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
jest.mock('@/services/dashboard/staffPay/sedes.service', () => ({ estadoSedes: (...a: unknown[]) => mockEstadoSedes(...a) }))
jest.mock('@/mcp/tools/staffPay.alcanceDeLaAccion', () => ({
  esDueno: (...a: unknown[]) => mockEsDueno(...a),
  nombresDeSedes: async (_o: string, ids: string[]) =>
    new Map(ids.map(id => [id, ({ v1: 'PN', b: 'Bosques', c: 'Condesa' } as Record<string, string>)[id]] as const)),
}))
jest.mock('@/services/dashboard/staffPay/participacion', () => ({ activarSede: jest.fn(), desactivarSede: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/participacion.vistaPrevia', () => ({ vistaPreviaParticipacion: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/activacion.service', () => ({
  estadoActivacion: jest.fn().mockResolvedValue({ activado: true, startDate: '2026-09-01', propinasEncendidas: true }),
  accesoActivacion: jest.fn().mockResolvedValue({ periodicidad: 'MONTHLY', periodicidadFija: false, inicioAlActivar: '2026-10-01' }),
  previewActivacion: jest.fn(),
  activarPagoAlPersonal: jest.fn(),
  cambiarPropinas: jest.fn(),
  ventanasDePropinas: jest.fn().mockResolvedValue([]),
  sedesParaActivar: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/reporte.service', () => ({ reportePeriodo: jest.fn(), detallePersona: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/niveles.service', () => ({
  listarNiveles: jest.fn().mockResolvedValue([]),
  nivelesVigentes: jest.fn().mockResolvedValue([]),
}))
jest.mock('@/services/dashboard/staffPay/tablas.service', () => ({ listarTablas: jest.fn().mockResolvedValue([]) }))
jest.mock('@/services/dashboard/staffPay/cierre.service', () => ({
  previewCierre: (...a: unknown[]) => mockPreview(...a),
  cerrarPeriodo: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/ajustesManuales.service', () => ({
  agregarAjusteManual: jest.fn(),
  previewAjusteManual: (...a: unknown[]) => mockPreviewAjuste(...a),
}))
jest.mock('@/services/dashboard/staffPay/recibos.service', () => ({
  marcarPagado: jest.fn(),
  previewPagado: jest.fn(),
  reciboDePersona: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/periodosGuardados', () => ({ periodoQueContieneFecha: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/liquidacion.service', () => ({ previewLiquidacion: jest.fn(), liquidarDiferencia: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/diferencias.service', () => ({ diferenciasDelPeriodo: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/ajustesClase.service', () => ({
  pagoDeClase: jest.fn(),
  previewAjusteDeClase: jest.fn(),
  guardarAjusteDeClase: jest.fn(),
}))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City', name: 'PN' }) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
// La CONEXIÓN sólo alcanza a v1 y a c (no a b), aunque el usuario tenga permiso en b.
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  scopes: ['mcp:read', 'mcp:write'],
  allowedVenueIds: ['v1', 'c'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
beforeAll(() =>
  registerStaffPayTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => {
  jest.clearAllMocks()
  mockTiene.mockReturnValue(true)
  mockEsDueno.mockResolvedValue(true)
})

const monto = (n: number, total: string) => ({ n, total })
const cuenta = (
  clases: [number, string, number?],
  comisiones: [number, string] = [0, '0.00'],
  propinas: [number, string] = [0, '0.00'],
) => ({
  clases: { ...monto(clases[0], clases[1]), pendientesDeValoracion: clases[2] ?? 0 },
  comisiones: monto(...comisiones),
  propinas: monto(...propinas),
})
const OCTUBRE = { tipo: 'AL_CERRAR', periodo: { start: '2026-10-01', end: '2026-10-31' } }
const SEPTIEMBRE_CERRADO = { tipo: 'PERIODO_POSTERIOR_A', origen: { start: '2026-09-01', end: '2026-09-30' } }

describe('close_service_pay_period: por sede y pendientes en palabras, acotados a la conexión', () => {
  const preview = {
    periodo: { id: null, start: '2026-11-01', end: '2026-11-30', venueIds: ['v1', 'b', 'c'] },
    puedeCerrar: true,
    bloqueos: [],
    clases: 3,
    comisiones: 1,
    propinas: 0,
    reversos: 0,
    personas: 2,
    total: '1600.00',
    huella: 'h'.repeat(64),
    huerfanas: 0,
    propinasSinDueno: { n: 0, total: '0.00' },
    comisionesPorRevisar: 0,
    porSede: [
      {
        venueId: 'v1',
        nombre: 'PN',
        estado: 'ACTIVA',
        entra: cuenta([3, '1500.00'], [1, '100.00']),
        fuera: cuenta([0, '0.00']),
        pendientes: monto(1, '-50.00'),
      },
      {
        venueId: 'b',
        nombre: 'Bosques',
        estado: 'SIN_ACTIVAR',
        entra: cuenta([0, '0.00']),
        fuera: cuenta([2, '1000.00']),
        pendientes: monto(1, '-30.00'),
      },
      {
        venueId: 'c',
        nombre: 'Condesa',
        estado: 'SIN_ACTIVAR',
        entra: cuenta([0, '0.00']),
        fuera: cuenta([0, '0.00', 1], [0, '0.00'], [1, '70.00']),
        pendientes: monto(0, '0.00'),
      },
    ],
    pendientes: {
      n: 3,
      total: '-100.00',
      porDestino: [
        {
          seDescuenta: OCTUBRE,
          n: 2,
          total: '-80.00',
          porSede: [monto(1, '-50.00'), monto(1, '-30.00')].map((x, i) => ({ venueId: ['v1', 'b'][i], ...x })),
        },
        { seDescuenta: SEPTIEMBRE_CERRADO, n: 1, total: '-20.00', porSede: [{ venueId: 'b', n: 1, total: '-20.00' }] },
      ],
    },
  }

  it('B14-fix2: con b fuera de la conexión, quien no es dueño no recibe ni porSede ni pendientes ni un monto de b', async () => {
    mockEsDueno.mockResolvedValue(false)
    mockPreview.mockResolvedValue(structuredClone(preview))
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-11-15' }, {}))
    expect(r).toMatchObject({ ok: false, code: 'FUERA_DE_LA_CONEXION' })
    expect(r).not.toHaveProperty('preview')
    expect(JSON.stringify(r)).not.toMatch(/1000\.00|30\.00|20\.00/)
  })

  it('dice por sede qué entra y qué queda fuera, y cuándo se descuenta cada pendiente', async () => {
    mockPreview.mockResolvedValue(structuredClone(preview))
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-11-15' }, {}))
    expect(r.message).toContain('PN (activa): entran 3 clase(s) ($1,500.00) y 1 comisión(es) ($100.00)')
    expect(r.message).toContain(
      'Condesa (sin activar): no entra nada; quedan fuera 1 propina(s) ($70.00) y 1 clase(s) que todavía no se pueden valorar',
    )
    // B14-fix2: el dueño ve también lo de b (fuera de la conexión): −$80.00 = −$50.00 de PN y −$30.00 de Bosques.
    expect(r.message).toContain(
      'Devoluciones pendientes que este cierre no descuenta: −$80.00 se descontará solo al cerrar el periodo de octubre de 2026;',
    )
  })

  it('un pendiente de un periodo ya cerrado se descuenta en un cierre posterior; bloqueado también se explica por sede', async () => {
    mockTiene.mockReturnValue(true)
    const todas = { ...scope, allowedVenueIds: ['v1', 'b', 'c'] } as unknown as McpScope
    const h = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
    registerStaffPayTools({ tool: (...a: unknown[]) => h.set(a[0] as string, a[a.length - 1] as never) } as never, todas)
    mockPreview.mockResolvedValue({ ...structuredClone(preview), puedeCerrar: false, bloqueos: [{ codigo: 'EXCEPCIONES', n: 1 }] })
    const r = parse(await h.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-11-15' }, {}))
    expect(r.error).toMatch(/^Todavía no se puede cerrar: 1 clase\(s\) con excepción por resolver\./)
    expect(r.error).toContain('Bosques (sin activar): no entra nada; quedan fuera 2 clase(s) ($1,000.00)')
    expect(r.error).toContain('−$20.00 se descontará solo al cerrar un periodo posterior al de septiembre de 2026 (ése ya se cerró)')
    expect(r.preview.pendientes.total).toBe('-100.00')
  })

  it('sin porSede ni pendientes (cerrado o sin permiso) no inventa nada', async () => {
    mockPreview.mockResolvedValue({ ...structuredClone(preview), porSede: [], pendientes: { n: 0, total: '0.00', porDestino: [] } })
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-11-15' }, {}))
    expect(r.message).not.toMatch(/Por sede|pendientes que este cierre/)
  })
})

describe('add_service_pay_adjustment: el aviso de devoluciones pendientes, en palabras y acotado a la conexión', () => {
  const pv = (aviso: unknown) => ({
    periodo: { start: '2026-10-01', end: '2026-10-31', estado: 'OPEN' },
    staffId: 'p1',
    persona: 'Ana López',
    sede: 'v1',
    sedeNombre: 'PN',
    amount: '-50.00',
    reason: 'Devolución',
    huella: 'a'.repeat(64),
    avisoPendientes: aviso,
  })
  const pedir = () =>
    handlers.get('add_service_pay_adjustment')!(
      { venueId: 'v1', staffId: 'p1', amount: -50, reason: 'Devolución', idempotencyKey: 'clave-1234' },
      {},
    )

  it('pide el aviso sólo de las sedes de la conexión y lo dice con la frase de r5.1', async () => {
    mockPreviewAjuste.mockResolvedValue(
      pv({ n: 1, total: '-50.00', porDestino: [{ seDescuenta: OCTUBRE, n: 1, total: '-50.00', porSede: [] }], items: [], truncado: false }),
    )
    const r = parse(await pedir())
    expect(mockPreviewAjuste).toHaveBeenCalledWith(expect.objectContaining({ soloSedes: ['v1', 'c'] }))
    expect(r).toMatchObject({ requiresConfirmation: true, preview: { avisoPendientes: { n: 1 } } })
    expect(r.message).toContain(
      'Ana López tiene −$50.00 en devoluciones que se descontarán solas al cerrar el periodo de octubre de 2026. Si este ajuste es por eso, no lo registres.',
    )
  })

  it('con dos destinos los nombra; sin pendientes no dice nada', async () => {
    mockPreviewAjuste.mockResolvedValue(
      pv({
        n: 2,
        total: '-80.00',
        porDestino: [
          { seDescuenta: OCTUBRE, n: 1, total: '-50.00', porSede: [] },
          { seDescuenta: SEPTIEMBRE_CERRADO, n: 1, total: '-30.00', porSede: [] },
        ],
        items: [],
        truncado: false,
      }),
    )
    expect(parse(await pedir()).message).toContain(
      'Ana López tiene −$80.00 en devoluciones que se descontarán solas: −$50.00 al cerrar el periodo de octubre de 2026 y −$30.00 al cerrar un periodo posterior al de septiembre de 2026. Si este ajuste es por eso, no lo registres.',
    )
    mockPreviewAjuste.mockResolvedValue(pv({ n: 0, total: '0.00', porDestino: [], items: [], truncado: false }))
    expect(parse(await pedir()).message).not.toMatch(/devoluciones/)
  })
})

describe('staff_service_pay_config: las sedes de la pantalla 1, acotadas a la conexión', () => {
  it('pide el estado de las sedes con las de la conexión y lo devuelve tal cual (pesos 1:1, fechas por sede)', async () => {
    const sedes = [{ venueId: 'v1', nombre: 'PN', estado: 'ACTIVA', desde: '2026-09-01', hasta: null }]
    mockEstadoSedes.mockResolvedValue({
      activado: true,
      startDate: '2026-09-01',
      periodo: { start: '2026-10-01', end: '2026-10-31' },
      sedes,
    })
    const r = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(mockEstadoSedes).toHaveBeenCalledWith({ userId: 's1', venueId: 'v1', soloSedes: ['v1', 'c'] })
    expect(r.sedes).toEqual(sedes)
    expect(r.periodoDeLasSedes).toEqual({ start: '2026-10-01', end: '2026-10-31' })
  })
})
