// tests/unit/mcp-customer/staff-service-pay.fueraDeLaConexion.activar.test.ts — fase 3, B14-fix2 (decisión del founder, 7-oct),
// la segunda mitad (ronda 1, M1: de `…fueraDeLaConexion.test.ts`, que se queda con cierre y marcar pagado; lo común, en
// `…fixtures.ts`). Conexión limitada a A, organización con A y B: activar SIN elegir sedes y (hermano) cambiar las propinas abarcan a
// toda la organización —aviso al dueño con la confirmación atada a la lista; FUERA_DE_LA_CONEXION a los demás—; los hermanos que no
// abarcan sedes fuera, y la confirmación por el catálogo real. Ronda 1, M3: si al confirmar activar lo que cambió fue la CONEXIÓN
// (las sedes fuera), SEDES_FUERA_CAMBIARON; INICIO_CAMBIO sólo si cambió la fecha de inicio o las sedes con el plan.
import * as mockF from './staff-service-pay.fueraDeLaConexion.fixtures'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import { huellaDeActivar } from '../../../src/mcp/tools/staffPay.participacion'
import type { Handler } from './staff-service-pay.fueraDeLaConexion.fixtures'

jest.mock('@/mcp/guard', () => mockF.modulos.guard)
jest.mock('@/services/access/access.service', () => mockF.modulos.accessService)
jest.mock('@/services/dashboard/staffPay/acceso', () => mockF.modulos.acceso)
jest.mock('@/mcp/tools/staffPay.alcanceDeLaAccion', () => mockF.modulos.alcanceDeLaAccion)
jest.mock('@/services/dashboard/staffPay/cierre.service', () => mockF.modulos.cierre)
jest.mock('@/services/dashboard/staffPay/recibos.service', () => mockF.modulos.recibos)
jest.mock('@/services/dashboard/staffPay/activacion.service', () => mockF.modulos.activacion)
jest.mock('@/services/dashboard/staffPay/ajustesManuales.service', () => mockF.modulos.ajustesManuales)
jest.mock('@/services/dashboard/staffPay/liquidacion.service', () => mockF.modulos.liquidacion)
jest.mock('@/services/dashboard/staffPay/reporte.service', () => mockF.modulos.reporte)
jest.mock('@/services/dashboard/staffPay/periodosGuardados', () => mockF.modulos.periodosGuardados)
jest.mock('@/services/dashboard/staffPay/diferencias.service', () => mockF.modulos.diferencias)
jest.mock('@/services/dashboard/staffPay/ajustesClase.service', () => mockF.modulos.ajustesClase)
jest.mock('@/services/dashboard/staffPay/niveles.service', () => mockF.modulos.niveles)
jest.mock('@/services/dashboard/staffPay/tablas.service', () => mockF.modulos.tablas)
jest.mock('@/services/dashboard/staffPay/participacion', () => mockF.modulos.participacion)
jest.mock('@/services/dashboard/staffPay/participacion.vistaPrevia', () => mockF.modulos.vistaPrevia)
jest.mock('@/services/dashboard/staffPay/sedes.service', () => mockF.modulos.sedesService)
jest.mock('@/mcp/requireWriteScopeAlways', () => mockF.modulos.requireWriteScopeAlways)
jest.mock('@/mcp/audit', () => mockF.modulos.audit)
jest.mock('@/utils/prismaClient', () => mockF.modulos.prismaClient)

const { conexion, llamar, sinDatosDeB, nombres: mockNombres, HUELLA, B_FUERA, CIERRE, ACTIVAR, PROPINAS } = mockF
const {
  cerrar: mockCerrar,
  estado: mockEstado,
  activar: mockActivar,
  propinas: mockPropinas,
  sedesParaActivar: mockSedesParaActivar,
  previewAjuste: mockPreviewAjuste,
  previewLiq: mockPreviewLiq,
  sedesDelCierre: mockSedesDelCierre,
  sedesDelPagado: mockSedesDelPagado,
  sedesDeLasPropinas: mockSedesDeLasPropinas,
  esDueno: mockEsDueno,
  auditMcpWrite,
} = mockF.mocks
const herramientas = (allowedVenueIds: string[]) => {
  const h = new Map<string, Handler>()
  registerStaffPayTools({ tool: (...a: unknown[]) => h.set(a[0] as string, a[a.length - 1] as never) } as never, conexion(allowedVenueIds))
  return h
}
const soloA = herramientas(['A'])
const todas = herramientas(['A', 'B'])

beforeEach(mockF.prepararMocks)

describe('configure_service_pay accion "activar" SIN elegir sedes (activa todas las que tienen el plan)', () => {
  it('dueño: avisa que se activa también B; la huella de activar lleva la lista; confirmar activa A y B y audita la lista', async () => {
    const p = await llamar(soloA, 'configure_service_pay', ACTIVAR)
    expect(p).toMatchObject({ requiresConfirmation: true, sedesFueraDeLaConexion: B_FUERA })
    expect(p.message).toMatch(
      /^Ojo: esta conexión es sólo de Prado Norte, pero activar el pago al personal sin elegir sedes incluye también Bosques\. Si confirmas, se activa también Bosques\. Pago al personal: sin activar → activado/,
    )
    expect(p.expectedSourceFingerprint).toBe(huellaDeActivar('2026-10-01', ['A', 'B'], B_FUERA))
    // M3: la de siempre (r4.6) y, aparte, la firma de la lista (como la del cierre): cabe en el máximo de 128 del parámetro.
    expect(p.expectedSourceFingerprint).toMatch(new RegExp(`^${huellaDeActivar('2026-10-01', ['A', 'B'])}~[0-9a-f]{40}$`))
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

  it('dueño: si sólo cambia la conexión entre la vista previa y el confirmar (C también queda fuera), SEDES_FUERA_CAMBIARON (M3)', async () => {
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
    expect(r).toMatchObject({ ok: false, code: 'SEDES_FUERA_CAMBIARON' })
    expect(r.error).toMatch(/\(ahora: Bosques y Condesa\)\. Pide una vista previa nueva/)
    expect(r.error).not.toMatch(/fecha de inicio/)
    expect(mockActivar).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('dueño: si cambió la fecha de inicio o las sedes con el plan, INICIO_CAMBIO (aunque también cambien las de fuera)', async () => {
    const p = await llamar(soloA, 'configure_service_pay', ACTIVAR)
    const confirmar = (fecha: string) =>
      llamar(soloA, 'configure_service_pay', { ...ACTIVAR, fecha, expectedSourceFingerprint: p.expectedSourceFingerprint, confirm: true })
    // Otra fecha (pasó la medianoche del cambio de periodo), con la misma huella.
    expect(await confirmar('2026-11-01')).toMatchObject({ ok: false, code: 'INICIO_CAMBIO' })
    // C contrató el plan entretanto: entra a las sedes que se activan (y queda fuera de la conexión).
    mockSedesParaActivar.mockResolvedValue({
      conPlan: ['A', 'B', 'C'].map(v => ({ venueId: v, nombre: mockNombres[v] })),
      sinPlan: [],
      sinPlanTotal: 0,
    })
    expect(await confirmar(p.fecha)).toMatchObject({ ok: false, code: 'INICIO_CAMBIO' })
    expect(mockActivar).not.toHaveBeenCalled()
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
      // M3: la huella de configure_service_pay también es de propinas (cuando la conexión no tiene todas las sedes).
      const { tools } = await client.listTools()
      const configurar = tools.find(t => t.name === 'configure_service_pay')!.inputSchema.properties as Record<
        string,
        { description?: string }
      >
      expect(configurar.expectedSourceFingerprint.description).toMatch(/activar, sede and propinas/)
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
