// tests/unit/mcp-customer/staff-service-pay.fueraDeLaConexion.test.ts — fase 3, B14-fix2 (decisión del founder, 7-oct): una
// conexión MCP limitada a A, en una organización con A y B. Las escrituras que por naturaleza abarcan a toda la organización —
// cerrar el periodo, marcar pagados recibos ENTEROS, activar sin elegir sedes y (hermano) cambiar las propinas— NO se niegan al
// DUEÑO: su vista previa lo AVISA al inicio del mensaje, trae `sedesFueraDeLaConexion` y la confirmación queda atada a esa lista;
// al confirmar se revalida todo (rol y sedes fuera). Quien NO es dueño recibe FUERA_DE_LA_CONEXION, sin un dato ni un monto de
// esas sedes, y nada se escribe. Con TODAS las sedes en la conexión, todo igual que antes. Los servicios y las lecturas van
// simulados (las lecturas se prueban en `staff-service-pay.alcanceDeLaAccion.test.ts`).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { auditMcpWrite } from '@/mcp/audit'
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import { huellaDeActivar } from '../../../src/mcp/tools/staffPay.participacion'
import type { McpScope } from '../../../src/mcp/scope'

const mockPreview = jest.fn()
const mockCerrar = jest.fn()
const mockPreviewPagado = jest.fn()
const mockMarcar = jest.fn()
const mockEstado = jest.fn()
const mockPlan = jest.fn()
const mockActivar = jest.fn()
const mockPropinas = jest.fn()
const mockSedesParaActivar = jest.fn()
const mockTodas = jest.fn()
const mockPreviewAjuste = jest.fn()
const mockPreviewLiq = jest.fn()
// Las lecturas de B14-fix2: qué sedes abarca cada acción, sus nombres y si quien pide es dueño.
const mockSedesDelCierre = jest.fn()
const mockSedesDelPagado = jest.fn()
const mockSedesDeLasPropinas = jest.fn()
const mockEsDueno = jest.fn()
const mockNombres: Record<string, string> = { A: 'Prado Norte', B: 'Bosques', C: 'Condesa' }

jest.mock('@/mcp/guard', () => ({
  // La conexión manda: una sede fuera de `allowedVenueIds` truena como el guard real.
  createGuard: (s: { allowedVenueIds: string[] }) => ({
    venueFilter: (v?: string) => {
      if (v && !s.allowedVenueIds.includes(v)) throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: v ? [v] : s.allowedVenueIds } }
    },
    tienePermiso: () => true,
  }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true }))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  venueHasServicePayAccess: jest.fn().mockResolvedValue(true),
  organizacionTieneServicePay: jest.fn().mockResolvedValue(true),
  assertPermisoEnTodasLasSedes: (...a: unknown[]) => mockTodas(...a),
  // C2: lo de dinero exige además la activación (sus pruebas, en `staff-service-pay.activacion.test.ts`).
  organizacionDeLaSedeActivada: jest.fn().mockResolvedValue(true),
  MENSAJE_SIN_ACTIVAR: 'Pago al personal todavía no está activado: actívalo en Pago por servicio → Periodos.',
}))
jest.mock('@/mcp/tools/staffPay.alcanceDeLaAccion', () => ({
  sedesDelCierre: (...a: unknown[]) => mockSedesDelCierre(...a),
  sedesDelPagado: (...a: unknown[]) => mockSedesDelPagado(...a),
  sedesDeLasPropinas: (...a: unknown[]) => mockSedesDeLasPropinas(...a),
  esDueno: (...a: unknown[]) => mockEsDueno(...a),
  nombresDeSedes: async (_org: string, ids: string[]) =>
    new Map(ids.filter(id => mockNombres[id]).map(id => [id, mockNombres[id]] as const)),
}))
jest.mock('@/services/dashboard/staffPay/cierre.service', () => ({
  previewCierre: (...a: unknown[]) => mockPreview(...a),
  cerrarPeriodo: (...a: unknown[]) => mockCerrar(...a),
}))
jest.mock('@/services/dashboard/staffPay/recibos.service', () => ({
  previewPagado: (...a: unknown[]) => mockPreviewPagado(...a),
  marcarPagado: (...a: unknown[]) => mockMarcar(...a),
  reciboDePersona: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/activacion.service', () => ({
  estadoActivacion: (...a: unknown[]) => mockEstado(...a),
  previewActivacion: (...a: unknown[]) => mockPlan(...a),
  activarPagoAlPersonal: (...a: unknown[]) => mockActivar(...a),
  cambiarPropinas: (...a: unknown[]) => mockPropinas(...a),
  ventanasDePropinas: jest.fn().mockResolvedValue([]),
  sedesParaActivar: (...a: unknown[]) => mockSedesParaActivar(...a),
}))
jest.mock('@/services/dashboard/staffPay/ajustesManuales.service', () => ({
  agregarAjusteManual: jest.fn(),
  previewAjusteManual: (...a: unknown[]) => mockPreviewAjuste(...a),
}))
jest.mock('@/services/dashboard/staffPay/liquidacion.service', () => ({
  previewLiquidacion: (...a: unknown[]) => mockPreviewLiq(...a),
  liquidarDiferencia: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/reporte.service', () => ({ reportePeriodo: jest.fn(), detallePersona: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/periodosGuardados', () => ({ periodoQueContieneFecha: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/diferencias.service', () => ({ diferenciasDelPeriodo: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/ajustesClase.service', () => ({
  pagoDeClase: jest.fn(),
  previewAjusteDeClase: jest.fn(),
  guardarAjusteDeClase: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/niveles.service', () => ({ listarNiveles: jest.fn(), nivelesVigentes: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/tablas.service', () => ({ listarTablas: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/participacion', () => ({ activarSede: jest.fn(), desactivarSede: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/participacion.vistaPrevia', () => ({ vistaPreviaParticipacion: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/sedes.service', () => ({ estadoSedes: jest.fn() }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City', name: 'Prado Norte', currency: 'MXN' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
/** La conexión de `allowedVenueIds`; el usuario (s1) tiene `staffpay:close` en A, B y C. Si es dueño lo dice `mockEsDueno`. */
const conexion = (allowedVenueIds: string[]) =>
  ({
    staffId: 's1',
    activeOrg: 'o1',
    allowedVenueIds,
    perVenueAccess: new Map(['A', 'B', 'C'].map(v => [v, { role: 'MANAGER' }])),
    scopes: ['mcp:read', 'mcp:write'],
  }) as unknown as McpScope
const herramientas = (allowedVenueIds: string[]) => {
  const h = new Map<string, Handler>()
  registerStaffPayTools({ tool: (...a: unknown[]) => h.set(a[0] as string, a[a.length - 1] as never) } as never, conexion(allowedVenueIds))
  return h
}
const soloA = herramientas(['A'])
const todas = herramientas(['A', 'B'])
const llamar = async (h: Map<string, Handler>, tool: string, args: Record<string, unknown>) =>
  JSON.parse((await h.get(tool)!(args, {})).content[0].text)

const HUELLA = 'h'.repeat(64)
const B_FUERA = [{ venueId: 'B', nombre: 'Bosques' }]
const cuenta = (total: string) => ({
  clases: { n: 0, total: '0.00', pendientesDeValoracion: 0 },
  comisiones: { n: 1, total },
  propinas: { n: 0, total: '0.00' },
})
/** La vista previa del cierre de A y B: B con su comisión de $100 y su devolución pendiente de −$50. */
const VISTA = {
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
const CIERRE = { venueId: 'A', fecha: '2026-10-15' }
const PAGADO = { venueId: 'A', periodId: 'p9', staffId: 'sofia' }
const PV_PAGADO = {
  periodo: { start: '2026-09-01', end: '2026-09-30', estado: 'CLOSED' },
  cantidad: 1,
  total: '130.00',
  recibos: [{ staffId: 'sofia', nombre: 'Sofía QA', total: '130.00' }],
  huella: 'p'.repeat(64),
}
const ACTIVAR = { venueId: 'A', accion: 'activar', periodicidad: 'MONTHLY' }
const PROPINAS = { venueId: 'A', accion: 'propinas', encender: true }
const NEGATIVA_B =
  'Esta acción incluye Bosques, que no está en esta conexión. Hazla desde el dashboard o con una conexión que incluya todas las sedes.'
/** Lo que la negativa a quien no es dueño NO trae: ni vista previa, ni huella, ni un monto de B. */
const sinDatosDeB = (r: Record<string, unknown>) => {
  expect(r).toEqual({ ok: false, code: 'FUERA_DE_LA_CONEXION', error: NEGATIVA_B })
  expect(JSON.stringify(r)).not.toMatch(/100\.00|130\.00|-50\.00|\bB\b/)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPreview.mockResolvedValue(structuredClone(VISTA))
  mockCerrar.mockResolvedValue({
    periodId: 'p10',
    start: '2026-10-01',
    end: '2026-10-31',
    venueIds: ['A', 'B'],
    personas: 2,
    total: '130.00',
    huella: HUELLA,
    yaCerrado: false,
  })
  mockPreviewPagado.mockResolvedValue(structuredClone(PV_PAGADO))
  mockMarcar.mockResolvedValue({ marcados: 1 })
  mockEstado.mockResolvedValue({ activado: false, startDate: null, propinasEncendidas: false })
  mockPlan.mockResolvedValue({ periodicidad: 'MONTHLY', periodicidadFija: false, startDate: '2026-10-01' })
  mockActivar.mockResolvedValue({ startDate: '2026-10-01', yaActivado: false })
  mockPropinas.mockResolvedValue({ encendidas: true, cambio: true })
  mockSedesParaActivar.mockResolvedValue({
    conPlan: [
      { venueId: 'A', nombre: 'Prado Norte' },
      { venueId: 'B', nombre: 'Bosques' },
    ],
    sinPlan: [],
    sinPlanTotal: 0,
  })
  mockTodas.mockResolvedValue(undefined)
  mockSedesDelCierre.mockResolvedValue(['A', 'B'])
  mockSedesDelPagado.mockResolvedValue(['A', 'B'])
  mockSedesDeLasPropinas.mockResolvedValue(['A', 'B'])
  mockEsDueno.mockResolvedValue(true)
})

describe('close_service_pay_period desde una conexión que no tiene todas las sedes del periodo', () => {
  it('dueño: la vista previa lo avisa al inicio, trae sedesFueraDeLaConexion [B] y TODO lo que confirma (también B)', async () => {
    const r = await llamar(soloA, 'close_service_pay_period', CIERRE)
    expect(r).toMatchObject({ ok: false, requiresConfirmation: true, sedesFueraDeLaConexion: B_FUERA })
    expect(r.message).toMatch(
      /^Ojo: esta conexión es sólo de Prado Norte, pero el cierre de este periodo incluye también Bosques\. Si confirmas, se cierran todas\. Se congelan /,
    )
    expect(r.preview.porSede.map((s: { venueId: string }) => s.venueId)).toEqual(['A', 'B'])
    expect(r.message).toContain('Bosques (activa): entran 1 comisión(es) ($100.00)')
    // La huella del service y la firma de la lista de sedes fuera: cabe en el máximo de 128 del parámetro.
    expect(r.expectedSourceFingerprint).toMatch(new RegExp(`^${HUELLA}~[0-9a-f]{40}$`))
    expect(mockEsDueno).toHaveBeenCalledWith(expect.objectContaining({ staffId: 's1', activeOrg: 'o1' }), ['A', 'B']) // R5: todas
  })

  it('dueño: confirmar con esa huella revalida, cierra A y B con la huella del service y audita la lista', async () => {
    const { expectedSourceFingerprint } = await llamar(soloA, 'close_service_pay_period', CIERRE)
    const r = await llamar(soloA, 'close_service_pay_period', { ...CIERRE, expectedSourceFingerprint, confirm: true })
    expect(r).toMatchObject({ ok: true, venueIds: ['A', 'B'] })
    expect(mockSedesDelCierre).toHaveBeenCalledWith('A', '2026-10-15')
    expect(mockEsDueno).toHaveBeenCalledTimes(2) // el rol se lee otra vez al confirmar
    expect(mockCerrar).toHaveBeenCalledWith(expect.objectContaining({ huellaEsperada: HUELLA, venueId: 'A', fecha: '2026-10-15' }))
    expect(auditMcpWrite).toHaveBeenCalledWith(expect.anything(), {
      action: 'SERVICE_PAY_PERIOD_CLOSED',
      entity: 'ServicePayPeriod',
      entityId: 'p10',
      venueId: 'A',
      data: { total: '130.00', personas: 2, sedesFueraDeLaConexion: B_FUERA },
    })
  })

  it('dueño: si entre la vista previa y el confirmar entra otra sede C fuera de la conexión, se rechaza sin cerrar', async () => {
    const { expectedSourceFingerprint } = await llamar(soloA, 'close_service_pay_period', CIERRE)
    mockSedesDelCierre.mockResolvedValue(['A', 'B', 'C'])
    const r = await llamar(soloA, 'close_service_pay_period', { ...CIERRE, expectedSourceFingerprint, confirm: true })
    expect(r).toMatchObject({ ok: false, code: 'SEDES_FUERA_CAMBIARON' })
    expect(r.error).toMatch(/Bosques y Condesa/)
    expect(r.error).toMatch(/vista previa nueva/)
    expect(mockCerrar).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('dueño: confirmar con la huella SIN la firma (la de una vista previa sin sedes fuera) también se rechaza', async () => {
    const r = await llamar(soloA, 'close_service_pay_period', { ...CIERRE, expectedSourceFingerprint: HUELLA, confirm: true })
    expect(r).toMatchObject({ ok: false, code: 'SEDES_FUERA_CAMBIARON' })
    expect(mockCerrar).not.toHaveBeenCalled()
  })

  it('quien era dueño en la vista previa y ya no lo es al confirmar: FUERA_DE_LA_CONEXION, nada se escribe', async () => {
    const { expectedSourceFingerprint } = await llamar(soloA, 'close_service_pay_period', CIERRE)
    mockEsDueno.mockResolvedValue(false)
    sinDatosDeB(await llamar(soloA, 'close_service_pay_period', { ...CIERRE, expectedSourceFingerprint, confirm: true }))
    expect(mockCerrar).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('gerente con staffpay:close en A y B (no dueño): FUERA_DE_LA_CONEXION sin montos de B, en la vista previa y al confirmar', async () => {
    mockEsDueno.mockResolvedValue(false)
    sinDatosDeB(await llamar(soloA, 'close_service_pay_period', CIERRE))
    sinDatosDeB(
      await llamar(soloA, 'close_service_pay_period', {
        ...CIERRE,
        expectedSourceFingerprint: `${HUELLA}~${'0'.repeat(40)}`,
        confirm: true,
      }),
    )
    expect(mockCerrar).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('conexión con TODAS las sedes: igual que hoy (sin aviso, sin lista, la huella del service tal cual; no pregunta el rol)', async () => {
    const r = await llamar(todas, 'close_service_pay_period', CIERRE)
    expect(r).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: HUELLA })
    expect(r).not.toHaveProperty('sedesFueraDeLaConexion')
    expect(r.message).toMatch(/^Se congelan /)
    await llamar(todas, 'close_service_pay_period', { ...CIERRE, expectedSourceFingerprint: HUELLA, confirm: true })
    expect(mockCerrar).toHaveBeenCalledWith(expect.objectContaining({ huellaEsperada: HUELLA }))
    expect(auditMcpWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ data: { total: '130.00', personas: 2 } }))
    expect(mockEsDueno).not.toHaveBeenCalled()
  })

  it('dueño con el cierre bloqueado: dice qué sedes quedan fuera de la conexión, sin ofrecer confirmar', async () => {
    mockPreview.mockResolvedValue({
      ...structuredClone(VISTA),
      puedeCerrar: false,
      bloqueos: [{ codigo: 'EXCEPCIONES', n: 1 }],
      huella: '',
    })
    const r = await llamar(soloA, 'close_service_pay_period', CIERRE)
    expect(r).toMatchObject({ ok: false, sedesFueraDeLaConexion: B_FUERA })
    expect(r).not.toHaveProperty('requiresConfirmation')
    expect(r).not.toHaveProperty('expectedSourceFingerprint')
  })
})

describe('mark_service_pay_paid: recibos ENTEROS con renglones de A y de B', () => {
  it('dueño: la vista previa avisa que se marcan completos, incluidos sus montos de B; la huella lleva la lista', async () => {
    const r = await llamar(soloA, 'mark_service_pay_paid', PAGADO)
    expect(mockSedesDelPagado).toHaveBeenCalledWith('A', 'p9', 'sofia')
    expect(r).toMatchObject({ requiresConfirmation: true, sedesFueraDeLaConexion: B_FUERA })
    expect(r.message).toMatch(
      /^Ojo: esta conexión es sólo de Prado Norte, pero marcar pagados estos recibos incluye también Bosques\. Si confirmas, se marcan pagados esos recibos completos, incluidos sus montos de Bosques\. Se registran como pagados 1 recibo/,
    )
    expect(r.expectedSourceFingerprint).toMatch(new RegExp(`^${'p'.repeat(64)}~[0-9a-f]{40}$`))
  })

  it('dueño: confirmar marca con la huella del service y audita la lista; si entra C, se rechaza sin marcar', async () => {
    const { expectedSourceFingerprint } = await llamar(soloA, 'mark_service_pay_paid', PAGADO)
    mockSedesDelPagado.mockResolvedValueOnce(['A', 'B', 'C'])
    expect(await llamar(soloA, 'mark_service_pay_paid', { ...PAGADO, expectedSourceFingerprint, confirm: true })).toMatchObject({
      ok: false,
      code: 'SEDES_FUERA_CAMBIARON',
    })
    expect(mockMarcar).not.toHaveBeenCalled()
    expect(await llamar(soloA, 'mark_service_pay_paid', { ...PAGADO, expectedSourceFingerprint, confirm: true })).toMatchObject({
      ok: true,
      marcados: 1,
    })
    expect(mockMarcar).toHaveBeenCalledWith(expect.objectContaining({ huellaEsperada: 'p'.repeat(64), staffId: 'sofia' }))
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: { staffId: 'sofia', marcados: 1, sedesFueraDeLaConexion: B_FUERA } }),
    )
  })

  it('gerente (no dueño): FUERA_DE_LA_CONEXION sin el total ni los recibos, y no marca', async () => {
    mockEsDueno.mockResolvedValue(false)
    sinDatosDeB(await llamar(soloA, 'mark_service_pay_paid', PAGADO))
    sinDatosDeB(await llamar(soloA, 'mark_service_pay_paid', { ...PAGADO, expectedSourceFingerprint: 'p'.repeat(64), confirm: true }))
    expect(mockMarcar).not.toHaveBeenCalled()
  })

  it('conexión con TODAS las sedes: la huella del service tal cual, sin aviso ni lista', async () => {
    const r = await llamar(todas, 'mark_service_pay_paid', PAGADO)
    expect(r).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: 'p'.repeat(64) })
    expect(r).not.toHaveProperty('sedesFueraDeLaConexion')
    expect(r.message).toMatch(/^Se registran como pagados/)
    await llamar(todas, 'mark_service_pay_paid', { ...PAGADO, expectedSourceFingerprint: 'p'.repeat(64), confirm: true })
    expect(mockMarcar).toHaveBeenCalledWith(expect.objectContaining({ huellaEsperada: 'p'.repeat(64) }))
    expect(auditMcpWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ data: { staffId: 'sofia', marcados: 1 } }))
    expect(mockEsDueno).not.toHaveBeenCalled()
  })
})

describe('configure_service_pay accion "activar" SIN elegir sedes (activa todas las que tienen el plan)', () => {
  it('dueño: avisa que se activa también B; la huella de activar lleva la lista; confirmar activa A y B y audita la lista', async () => {
    const p = await llamar(soloA, 'configure_service_pay', ACTIVAR)
    expect(p).toMatchObject({ requiresConfirmation: true, sedesFueraDeLaConexion: B_FUERA })
    expect(p.message).toMatch(
      /^Ojo: esta conexión es sólo de Prado Norte, pero activar el pago al personal sin elegir sedes incluye también Bosques\. Si confirmas, se activa también Bosques\. Pago al personal: sin activar → activado/,
    )
    expect(p.expectedSourceFingerprint).toBe(huellaDeActivar('2026-10-01', ['A', 'B'], B_FUERA))
    expect(p.expectedSourceFingerprint).not.toBe(huellaDeActivar('2026-10-01', ['A', 'B']))
    const r = await llamar(soloA, 'configure_service_pay', {
      ...ACTIVAR,
      fecha: p.fecha,
      expectedSourceFingerprint: p.expectedSourceFingerprint,
      confirm: true,
    })
    expect(r).toMatchObject({ ok: true })
    expect(mockActivar).toHaveBeenCalledWith(expect.objectContaining({ sedes: ['A', 'B'], inicioEsperado: '2026-10-01' }))
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'SERVICE_PAY_ACTIVATED',
        data: { startDate: '2026-10-01', periodicidad: 'MONTHLY', sedes: ['A', 'B'], sedesFueraDeLaConexion: B_FUERA },
      }),
    )
  })

  it('dueño: si la conexión cambia entre la vista previa y el confirmar (C también queda fuera), INICIO_CAMBIO sin activar', async () => {
    mockSedesParaActivar.mockResolvedValue({
      conPlan: ['A', 'B', 'C'].map(v => ({ venueId: v, nombre: mockNombres[v] })),
      sinPlan: [],
      sinPlanTotal: 0,
    })
    const p = await llamar(herramientas(['A', 'C']), 'configure_service_pay', ACTIVAR)
    expect(p.sedesFueraDeLaConexion).toEqual(B_FUERA)
    const r = await llamar(soloA, 'configure_service_pay', {
      ...ACTIVAR,
      fecha: p.fecha,
      expectedSourceFingerprint: p.expectedSourceFingerprint,
      confirm: true,
    })
    expect(r).toMatchObject({ ok: false, code: 'INICIO_CAMBIO' })
    expect(mockActivar).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('gerente (no dueño): FUERA_DE_LA_CONEXION y no activa; eligiendo sólo A, igual que hoy', async () => {
    mockEsDueno.mockResolvedValue(false)
    sinDatosDeB(await llamar(soloA, 'configure_service_pay', ACTIVAR))
    sinDatosDeB(
      await llamar(soloA, 'configure_service_pay', {
        ...ACTIVAR,
        fecha: '2026-10-01',
        expectedSourceFingerprint: huellaDeActivar('2026-10-01', ['A', 'B'], B_FUERA),
        confirm: true,
      }),
    )
    expect(mockActivar).not.toHaveBeenCalled()
    const soloLaA = await llamar(soloA, 'configure_service_pay', { ...ACTIVAR, sedes: ['A'] })
    expect(soloLaA).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: huellaDeActivar('2026-10-01', ['A']) })
    expect(soloLaA).not.toHaveProperty('sedesFueraDeLaConexion')
  })

  it('conexión con TODAS las sedes: la huella de siempre (r4.6), sin aviso ni lista', async () => {
    const p = await llamar(todas, 'configure_service_pay', ACTIVAR)
    expect(p.expectedSourceFingerprint).toBe(huellaDeActivar('2026-10-01', ['A', 'B']))
    expect(p).not.toHaveProperty('sedesFueraDeLaConexion')
    expect(p.message).toMatch(/^Pago al personal: sin activar → activado/)
    expect(mockEsDueno).not.toHaveBeenCalled()
  })
})

describe('hermano: configure_service_pay accion "propinas" (cambia las propinas de toda la organización)', () => {
  beforeEach(() => mockEstado.mockResolvedValue({ activado: true, startDate: '2026-09-01', propinasEncendidas: false }))

  it('dueño: avisa que cambian también las propinas de B; confirmar exige la huella de esa lista; audita la lista', async () => {
    const p = await llamar(soloA, 'configure_service_pay', PROPINAS)
    expect(mockSedesDeLasPropinas).toHaveBeenCalledWith('o1')
    expect(p).toMatchObject({ requiresConfirmation: true, sedesFueraDeLaConexion: B_FUERA })
    expect(p.message).toMatch(
      /^Ojo: esta conexión es sólo de Prado Norte, pero cambiar las propinas del recibo incluye también Bosques\. Si confirmas, cambian también las propinas de Bosques\. Propinas en el recibo: apagadas → encendidas\./,
    )
    expect(p.expectedSourceFingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Sin la huella (como si la vista previa no tuviera sedes fuera), o con C también fuera al confirmar: no escribe.
    expect(await llamar(soloA, 'configure_service_pay', { ...PROPINAS, confirm: true })).toMatchObject({ code: 'SEDES_FUERA_CAMBIARON' })
    mockSedesDeLasPropinas.mockResolvedValueOnce(['A', 'B', 'C'])
    expect(
      await llamar(soloA, 'configure_service_pay', { ...PROPINAS, expectedSourceFingerprint: p.expectedSourceFingerprint, confirm: true }),
    ).toMatchObject({ code: 'SEDES_FUERA_CAMBIARON' })
    expect(mockPropinas).not.toHaveBeenCalled()
    const r = await llamar(soloA, 'configure_service_pay', {
      ...PROPINAS,
      expectedSourceFingerprint: p.expectedSourceFingerprint,
      confirm: true,
    })
    expect(r).toMatchObject({ ok: true, encendidas: true })
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SERVICE_PAY_TIPS_SET', data: { encender: true, sedesFueraDeLaConexion: B_FUERA } }),
    )
  })

  it('gerente (no dueño): FUERA_DE_LA_CONEXION y no cambia nada', async () => {
    mockEsDueno.mockResolvedValue(false)
    sinDatosDeB(await llamar(soloA, 'configure_service_pay', PROPINAS))
    sinDatosDeB(await llamar(soloA, 'configure_service_pay', { ...PROPINAS, confirm: true }))
    expect(mockPropinas).not.toHaveBeenCalled()
  })

  it('conexión con TODAS las sedes: igual que hoy (sin huella; confirmar sin ella cambia y audita como siempre)', async () => {
    const p = await llamar(todas, 'configure_service_pay', PROPINAS)
    expect(p).not.toHaveProperty('expectedSourceFingerprint')
    expect(p).not.toHaveProperty('sedesFueraDeLaConexion')
    expect(p.message).toMatch(/^Propinas en el recibo: apagadas → encendidas\./)
    expect(await llamar(todas, 'configure_service_pay', { ...PROPINAS, confirm: true })).toMatchObject({ ok: true })
    expect(auditMcpWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ data: { encender: true } }))
    expect(mockEsDueno).not.toHaveBeenCalled()
  })
})

describe('hermanos que NO abarcan sedes fuera de la conexión', () => {
  it('el ajuste manual y liquidar una diferencia de A no preguntan por sedes fuera ni por el rol', async () => {
    mockPreviewAjuste.mockResolvedValue({
      periodo: { start: '2026-10-01', end: '2026-10-31', estado: 'OPEN' },
      persona: 'Sofía QA',
      sedeNombre: 'Prado Norte',
      huella: 'a'.repeat(64),
      avisoPendientes: { n: 0, total: '0.00', porDestino: [] },
    })
    const a = await llamar(soloA, 'add_service_pay_adjustment', {
      venueId: 'A',
      staffId: 'sofia',
      amount: 50,
      reason: 'Bono',
      idempotencyKey: 'clave-1',
    })
    expect(a).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: 'a'.repeat(64) })
    mockPreviewLiq.mockResolvedValue({ periodoOrigen: null, filas: [] })
    await llamar(soloA, 'settle_service_pay_difference', { venueId: 'A', classSessionId: 'c1', idempotencyKey: 'clave-1' })
    for (const m of [mockEsDueno, mockSedesDelCierre, mockSedesDelPagado, mockSedesDeLasPropinas]) expect(m).not.toHaveBeenCalled()
  })
})

describe('por el catálogo real: la confirmación queda atada a la huella con la lista', () => {
  it('el token firma la huella con la firma de B; confirmar con él cierra con la huella del service; con otra, no', async () => {
    const server = new McpServer({ name: 'staffpay', version: '1' })
    const s = conexion(['A'])
    configureToolCatalog(server, s)
    registerStaffPayTools(server, s)
    const client = new Client({ name: 'staffpay-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      const call = async (args: Record<string, unknown>) =>
        JSON.parse(
          ((await client.callTool({ name: 'close_service_pay_period', arguments: args })).content as Array<{ text: string }>)[0].text,
        )
      const p = await call(CIERRE)
      expect(p.confirmationArguments.expectedSourceFingerprint).toMatch(new RegExp(`^${HUELLA}~[0-9a-f]{40}$`))
      // La huella sola del service (sin la lista) no sirve con ese token.
      expect(
        await call({
          ...p.confirmationArguments,
          expectedSourceFingerprint: HUELLA,
          confirm: true,
          confirmationToken: p.confirmationToken,
        }),
      ).toMatchObject({ needsInput: true, field: 'confirmationToken' })
      expect(await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({ ok: true })
      expect(mockCerrar).toHaveBeenCalledWith(expect.objectContaining({ huellaEsperada: HUELLA }))
    } finally {
      await client.close()
      await server.close()
    }
  })
})
