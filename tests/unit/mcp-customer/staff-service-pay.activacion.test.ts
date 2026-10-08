// tests/unit/mcp-customer/staff-service-pay.activacion.test.ts — fase 3, C2 (spec §7.1, §10; pre-flight del Bloque C, filas 3,
// 4, 9 y 10): las herramientas del MCP que leen o mueven DINERO exigen, además del plan, que la organización haya activado pago
// al personal; la configuración y `configure_service_pay` (activar, una sede, propinas) nunca lo exigen —si no, no habría cómo
// activarlo desde aquí—. Los servicios van simulados: lo que se prueba es la puerta y su orden (plan → activación → servicio).
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import type { McpScope } from '../../../src/mcp/scope'

const mockAccess = jest.fn()
const mockOrgTiene = jest.fn()
const mockActivada = jest.fn()
const mockTodas = jest.fn()
const mockReporte = jest.fn()
const mockDetalle = jest.fn()
const mockPreview = jest.fn()
const mockPreviewAjuste = jest.fn()
const mockPreviewPagado = jest.fn()
const mockPreviewLiq = jest.fn()
const mockDiferencias = jest.fn()
const mockCard = jest.fn()
const mockPreviewClase = jest.fn()
const mockVista = jest.fn()
const mockEstado = jest.fn()
const mockPlan = jest.fn()
const mockAcceso = jest.fn()
const mockSedesParaActivar = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => ({ venueId: { in: [v ?? 'v1'] } }),
    tienePermiso: () => true,
  }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true }))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  venueHasServicePayAccess: (...a: unknown[]) => mockAccess(...a),
  organizacionTieneServicePay: (...a: unknown[]) => mockOrgTiene(...a),
  organizacionDeLaSedeActivada: (...a: unknown[]) => mockActivada(...a),
  assertPermisoEnTodasLasSedes: (...a: unknown[]) => mockTodas(...a),
  MENSAJE_SIN_ACTIVAR:
    'Pago al personal todavía no está activado: actívalo en Pago al personal → Periodos. Activarlo pide el permiso de cerrar periodos en todas las sucursales; si no lo tienes, pídeselo al dueño del negocio.',
}))
jest.mock('@/services/dashboard/staffPay/reporte.service', () => ({
  reportePeriodo: (...a: unknown[]) => mockReporte(...a),
  detallePersona: (...a: unknown[]) => mockDetalle(...a),
}))
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
  previewPagado: (...a: unknown[]) => mockPreviewPagado(...a),
  reciboDePersona: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/periodosGuardados', () => ({ periodoQueContieneFecha: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/liquidacion.service', () => ({
  previewLiquidacion: (...a: unknown[]) => mockPreviewLiq(...a),
  liquidarDiferencia: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/diferencias.service', () => ({
  diferenciasDelPeriodo: (...a: unknown[]) => mockDiferencias(...a),
}))
jest.mock('@/services/dashboard/staffPay/ajustesClase.service', () => ({
  pagoDeClase: (...a: unknown[]) => mockCard(...a),
  previewAjusteDeClase: (...a: unknown[]) => mockPreviewClase(...a),
  guardarAjusteDeClase: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/activacion.service', () => ({
  estadoActivacion: (...a: unknown[]) => mockEstado(...a),
  previewActivacion: (...a: unknown[]) => mockPlan(...a),
  accesoActivacion: (...a: unknown[]) => mockAcceso(...a),
  activarPagoAlPersonal: jest.fn(),
  cambiarPropinas: jest.fn(),
  ventanasDePropinas: jest.fn().mockResolvedValue([]),
  sedesParaActivar: (...a: unknown[]) => mockSedesParaActivar(...a),
}))
jest.mock('@/services/dashboard/staffPay/participacion', () => ({ activarSede: jest.fn(), desactivarSede: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/participacion.vistaPrevia', () => ({
  vistaPreviaParticipacion: (...a: unknown[]) => mockVista(...a),
}))
jest.mock('@/services/dashboard/staffPay/sedes.service', () => ({
  estadoSedes: jest.fn().mockResolvedValue({ activado: false, startDate: null, periodo: null, sedes: [] }),
}))
jest.mock('@/mcp/tools/staffPay.alcanceDeLaAccion', () => {
  const soloV1 = async () => ['v1']
  return { sedesDelCierre: soloV1, sedesDelPagado: soloV1, sedesDeLasPropinas: soloV1, esDueno: jest.fn(), nombresDeSedes: jest.fn() }
})
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City', name: 'PN', currency: 'MXN' }),
    },
  },
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  scopes: ['mcp:read', 'mcp:write'],
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const cuenta = () => ({
  clases: { n: 0, total: '0.00', pendientesDeValoracion: 0 },
  comisiones: { n: 0, total: '0.00' },
  propinas: { n: 0, total: '0.00' },
})
const VISTA = {
  fecha: '2026-10-15',
  minimo: '2026-10-01',
  maximo: '2026-10-20',
  zona: 'America/Mexico_City',
  entran: cuenta(),
  quedanFuera: cuenta(),
  dejanDeEntrar: cuenta(),
  permanecen: cuenta(),
}

beforeAll(() =>
  registerStaffPayTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => {
  jest.clearAllMocks()
  mockAccess.mockResolvedValue(true)
  mockOrgTiene.mockResolvedValue(true)
  mockActivada.mockResolvedValue(false)
  mockTodas.mockResolvedValue(undefined)
  mockEstado.mockResolvedValue({ activado: false, startDate: null, propinasEncendidas: false })
  mockPlan.mockResolvedValue({ periodicidad: 'SEMIMONTHLY', periodicidadFija: false, startDate: '2026-10-01' })
  mockAcceso.mockResolvedValue({ periodicidad: 'SEMIMONTHLY', periodicidadFija: false, inicioAlActivar: '2026-10-01' })
  mockSedesParaActivar.mockResolvedValue({ conPlan: [{ venueId: 'v1', nombre: 'PN' }], sinPlan: [], sinPlanTotal: 0 })
  mockVista.mockImplementation(async (i: { accion: string }) => ({ ...VISTA, accion: i.accion }))
})

const DINERO: Array<[string, Record<string, unknown>]> = [
  ['staff_service_pay_summary', { venueId: 'v1' }],
  ['staff_service_pay_detail', { venueId: 'v1', staffId: 'cxxxxxxxxxxxxxxxxxxxxxxxx' }],
  ['staff_service_pay_differences', { venueId: 'v1', periodId: 'p8' }],
  ['close_service_pay_period', { venueId: 'v1', fecha: '2026-08-15' }],
  ['add_service_pay_adjustment', { venueId: 'v1', staffId: 'a', amount: 100, reason: 'Bono', idempotencyKey: 'clave-1234' }],
  ['mark_service_pay_paid', { venueId: 'v1', periodId: 'p8' }],
  ['settle_service_pay_difference', { venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'clave-1234' }],
  [
    'adjust_service_pay_class',
    { venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'clave-1234', reason: 'Monto acordado', payAmountOverride: 600 },
  ],
]
const ningunServicioDeDinero = () => {
  for (const m of [
    mockReporte,
    mockDetalle,
    mockPreview,
    mockPreviewAjuste,
    mockPreviewPagado,
    mockPreviewLiq,
    mockDiferencias,
    mockCard,
    mockPreviewClase,
  ])
    expect(m).not.toHaveBeenCalled()
}

describe('activación (spec fase 3 §10): los datos de dinero la exigen; la configuración no', () => {
  it.each(DINERO)('%s sin activar lo explica (y cómo activarlo desde aquí) y no calcula nada', async (tool, args) => {
    const r = parse(await handlers.get(tool)!(args, {}))
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/no está activado/)
    expect(r.error).toMatch(/configure_service_pay/)
    expect(mockActivada).toHaveBeenCalledWith('v1')
    ningunServicioDeDinero()
  })

  it.each(DINERO)('%s: primero el plan; sin plan lo dice el plan y ni pregunta por la activación', async (tool, args) => {
    mockAccess.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(false)
    const r = parse(await handlers.get(tool)!(args, {}))
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/viene en el plan Pro o se contrata suelto por sucursal/)
    expect(mockActivada).not.toHaveBeenCalled()
    ningunServicioDeDinero()
  })

  // El servicio al que cada herramienta llega en cuanto la puerta la deja pasar.
  const SERVICIO: Record<string, jest.Mock> = {
    staff_service_pay_summary: mockReporte,
    staff_service_pay_detail: mockDetalle,
    staff_service_pay_differences: mockDiferencias,
    close_service_pay_period: mockPreview,
    add_service_pay_adjustment: mockPreviewAjuste,
    mark_service_pay_paid: mockPreviewPagado,
    settle_service_pay_difference: mockPreviewLiq,
    adjust_service_pay_class: mockCard,
  }
  it.each(DINERO)('%s activada: la puerta deja pasar al servicio', async (tool, args) => {
    mockActivada.mockResolvedValue(true)
    // Los servicios simulados no devuelven nada útil: lo que importa es que la puerta ya no corta antes de llamarlos.
    await handlers.get(tool)!(args, {}).catch(() => undefined)
    expect(mockActivada).toHaveBeenCalledWith('v1')
    expect(SERVICIO[tool]).toHaveBeenCalledTimes(1)
  })

  it('la configuración se lee sin activar (el agente puede decir cómo activarlo)', async () => {
    const r = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(r.ok).not.toBe(false)
    expect(r.activacion).toMatchObject({ activado: false })
    expect(mockActivada).not.toHaveBeenCalled()
  })

  it('la configuración dice la periodicidad, si ya es fija y el inicio al activar (lo mismo que GET /access)', async () => {
    mockAcceso.mockResolvedValue({ periodicidad: 'SEMIMONTHLY', periodicidadFija: false, inicioAlActivar: '2026-10-01' })
    const sin = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(sin.activacion).toMatchObject({ periodicidad: 'SEMIMONTHLY', periodicidadFija: false, inicioAlActivar: '2026-10-01' })
    expect(mockAcceso).toHaveBeenCalledWith({ venueId: 'v1' })

    mockEstado.mockResolvedValue({ activado: true, startDate: '2026-10-01', propinasEncendidas: false })
    mockAcceso.mockResolvedValue({ periodicidad: 'MONTHLY', periodicidadFija: true, inicioAlActivar: null })
    const act = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(act.activacion).toMatchObject({ activado: true, periodicidad: 'MONTHLY', periodicidadFija: true, inicioAlActivar: null })
  })

  it('la configuración sí exige el plan', async () => {
    mockAccess.mockResolvedValue(false)
    const r = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/viene en el plan Pro o se contrata suelto por sucursal/)
  })
})

describe('configure_service_pay nunca exige estar activado (NOTA de B6; pre-flight fila 4)', () => {
  const configurar = (args: Record<string, unknown>) => handlers.get('configure_service_pay')!({ venueId: 'v1', ...args }, {})

  it('accion «activar» sin activar: ofrece la vista previa (no MENSAJE_SIN_ACTIVAR)', async () => {
    const r = parse(await configurar({ accion: 'activar', periodicidad: 'SEMIMONTHLY' }))
    expect(r).toMatchObject({ requiresConfirmation: true, nuevo: { activado: true, periodicidad: 'SEMIMONTHLY' } })
    expect(mockActivada).not.toHaveBeenCalled()
    // El plan de la sede sí se exige.
    expect(mockAccess).toHaveBeenCalledWith('v1')
  })

  it('accion «activar» sin el plan: lo dice el plan', async () => {
    mockAccess.mockResolvedValue(false)
    const r = parse(await configurar({ accion: 'activar', periodicidad: 'SEMIMONTHLY' }))
    expect(r.error).toMatch(/viene en el plan Pro o se contrata suelto por sucursal/)
    expect(mockActivada).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'accion «sede» con activa:%s y sin activar: llega a la vista previa (el service dice NO_ACTIVADO)',
    async activa => {
      const r = parse(await configurar({ accion: 'sede', sede: 'v1', activa, fecha: '2026-10-15' }))
      expect(r).toMatchObject({ requiresConfirmation: true })
      expect(mockVista).toHaveBeenCalledWith(expect.objectContaining({ accion: activa ? 'activar' : 'desactivar' }))
      expect(mockActivada).not.toHaveBeenCalled()
    },
  )

  it('accion «sede» desactivar no pide el plan (r4.7) ni la activación', async () => {
    mockAccess.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(false)
    const r = parse(await configurar({ accion: 'sede', sede: 'v1', activa: false, fecha: '2026-10-15' }))
    expect(r).toMatchObject({ requiresConfirmation: true })
    expect(mockOrgTiene).not.toHaveBeenCalled()
    expect(mockActivada).not.toHaveBeenCalled()
  })

  it('accion «sede» activar sí pide el plan de la organización', async () => {
    mockOrgTiene.mockResolvedValue(false)
    const r = parse(await configurar({ accion: 'sede', sede: 'v1', activa: true, fecha: '2026-10-15' }))
    expect(r.error).toMatch(/ninguna sede de este negocio: viene en el plan Pro o se contrata suelto por sucursal/)
    expect(mockVista).not.toHaveBeenCalled()
  })

  it('accion «propinas» sin activar: la respuesta de siempre («accion "activar"»), sin la puerta de dinero', async () => {
    const r = parse(await configurar({ accion: 'propinas', encender: true }))
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/accion "activar"/)
    expect(mockActivada).not.toHaveBeenCalled()
  })
})
