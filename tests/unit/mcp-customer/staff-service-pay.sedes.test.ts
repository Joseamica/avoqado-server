// tests/unit/mcp-customer/staff-service-pay.sedes.test.ts — `configure_service_pay` con `accion: 'sede'` (fase 3, B11; diseño
// r4.6, r4.7, r7.3): activar o desactivar UNA sede en dos pasos, con la vista previa con montos, la fecha EXPLÍCITA firmada y
// sin pedir el plan para desactivar. Los servicios van simulados (sus reglas se prueban en integración).
import { createHash } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { auditMcpWrite } from '@/mcp/audit'
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import { huellaDeSede } from '../../../src/mcp/tools/staffPay.participacion'
import type { McpScope } from '../../../src/mcp/scope'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { pagoDeClase, previewAjusteDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'

const mockTiene = jest.fn()
const mockAccess = jest.fn()
const mockOrgTiene = jest.fn()
const mockRequireWrite = jest.fn()
const mockVista = jest.fn()
const mockActivarSede = jest.fn()
const mockDesactivarSede = jest.fn()

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
  venueHasServicePayAccess: (...a: unknown[]) => mockAccess(...a),
  organizacionTieneServicePay: (...a: unknown[]) => mockOrgTiene(...a),
  assertPermisoEnTodasLasSedes: jest.fn(),
  // C2: lo de dinero exige además la activación (sus pruebas, en `staff-service-pay.activacion.test.ts`).
  organizacionDeLaSedeActivada: jest.fn().mockResolvedValue(true),
  MENSAJE_SIN_ACTIVAR: 'Pago al personal todavía no está activado: actívalo en Pago por servicio → Periodos.',
}))
jest.mock('@/services/dashboard/staffPay/participacion', () => ({
  activarSede: (...a: unknown[]) => mockActivarSede(...a),
  desactivarSede: (...a: unknown[]) => mockDesactivarSede(...a),
}))
jest.mock('@/services/dashboard/staffPay/participacion.vistaPrevia', () => ({
  vistaPreviaParticipacion: (...a: unknown[]) => mockVista(...a),
}))
jest.mock('@/services/dashboard/staffPay/activacion.service', () => ({
  estadoActivacion: jest.fn(),
  previewActivacion: jest.fn(),
  activarPagoAlPersonal: jest.fn(),
  cambiarPropinas: jest.fn(),
  ventanasDePropinas: jest.fn(),
  sedesParaActivar: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/reporte.service', () => ({ reportePeriodo: jest.fn(), detallePersona: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/niveles.service', () => ({ listarNiveles: jest.fn(), nivelesVigentes: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/tablas.service', () => ({ listarTablas: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/cierre.service', () => ({ previewCierre: jest.fn(), cerrarPeriodo: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/ajustesManuales.service', () => ({
  agregarAjusteManual: jest.fn(),
  previewAjusteManual: jest.fn(),
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
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: (...a: unknown[]) => mockRequireWrite(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'o1', name: 'Polanco' }) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1', 'b'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const sede = (args: Record<string, unknown>) => handlers.get('configure_service_pay')!({ venueId: 'v1', accion: 'sede', ...args }, {})

const cuenta = (clases: [number, string, number], comisiones: [number, string], propinas: [number, string]) => ({
  clases: { n: clases[0], total: clases[1], pendientesDeValoracion: clases[2] },
  comisiones: { n: comisiones[0], total: comisiones[1] },
  propinas: { n: propinas[0], total: propinas[1] },
})
const VISTA_ACTIVAR = {
  accion: 'activar',
  fecha: '2026-10-20',
  minimo: '2026-10-01',
  maximo: '2026-10-20',
  zona: 'America/Mexico_City',
  entran: cuenta([1, '500.00', 0], [1, '100.00'], [0, '0.00']),
  quedanFuera: cuenta([0, '0.00', 1], [0, '0.00'], [0, '0.00']),
}
const VISTA_DESACTIVAR = {
  accion: 'desactivar',
  fecha: '2026-10-15',
  minimo: '2026-09-30',
  maximo: '2026-10-20',
  zona: 'America/Mexico_City',
  dejanDeEntrar: cuenta([0, '0.00', 0], [0, '0.00'], [1, '70.00']),
  permanecen: cuenta([0, '0.00', 0], [0, '0.00'], [1, '60.00']),
}

beforeAll(() =>
  registerStaffPayTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => {
  jest.clearAllMocks()
  mockTiene.mockReturnValue(true)
  mockAccess.mockResolvedValue(true)
  mockOrgTiene.mockResolvedValue(true)
  mockVista.mockImplementation(async (i: { accion: string }) => (i.accion === 'activar' ? VISTA_ACTIVAR : VISTA_DESACTIVAR))
})

describe('configure_service_pay · accion «sede» (B11)', () => {
  it('activar: la vista previa resuelve «hoy» a una fecha explícita, trae los montos y una huella de 64; no escribe', async () => {
    const p = parse(await sede({ sede: 'b', activa: true }))
    expect(mockVista).toHaveBeenCalledWith({ userId: 's1', venueId: 'v1', sedeId: 'b', accion: 'activar', fecha: undefined })
    expect(p).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      preview: VISTA_ACTIVAR,
      fecha: '2026-10-20',
      expectedSourceFingerprint: huellaDeSede('b', true, '2026-10-20'),
    })
    expect(p.expectedSourceFingerprint).toHaveLength(64)
    // El formato del diseño (r4.6), calculado aparte: la sede, la acción y la fecha EXPLÍCITA.
    expect(p.expectedSourceFingerprint).toBe(createHash('sha256').update('sede|b|true|2026-10-20').digest('hex'))
    expect(p.message).toMatch(/Polanco se activa en pago al personal desde el 20 oct 2026/)
    expect(p.message).toMatch(
      /Entran, de los periodos sin cerrar: 1 clase\(s\) \(\$500\.00\), 1 comisión\(es\) \(\$100\.00\) y 0 propina\(s\)/,
    )
    expect(p.message).toMatch(/1 clase\(s\) que todavía no se pueden valorar/)
    expect(p.message).toMatch(/del 1 oct 2026 al 20 oct 2026/)
    // Activar pide el plan en la ORGANIZACIÓN (el service, en la sede): nunca el de la sede del URL.
    expect(mockOrgTiene).toHaveBeenCalledWith('v1')
    expect(mockAccess).not.toHaveBeenCalled()
    expect(mockActivarSede).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('confirmar activar usa la fecha de la vista previa, escribe una vez y audita', async () => {
    mockActivarSede.mockResolvedValue({ ventana: { venueId: 'b', desde: '2026-10-20', hasta: null }, minimo: '2026-10-01' })
    const r = parse(
      await sede({
        sede: 'b',
        activa: true,
        fecha: '2026-10-20',
        expectedSourceFingerprint: huellaDeSede('b', true, '2026-10-20'),
        confirm: true,
      }),
    )
    expect(r).toMatchObject({ ok: true, ventana: { desde: '2026-10-20' } })
    expect(mockActivarSede).toHaveBeenCalledWith({ userId: 's1', venueId: 'v1', sedeId: 'b', desde: '2026-10-20' })
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SERVICE_PAY_VENUE_ACTIVATED', entity: 'Venue', entityId: 'b', venueId: 'b' }),
    )
  })

  it('desactivar NO pide el plan (ni de la sede ni de la organización): es la salida del bloqueo', async () => {
    mockAccess.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(false)
    const p = parse(await sede({ sede: 'b', activa: false, fecha: '2026-10-15' }))
    expect(p).toMatchObject({ requiresConfirmation: true, fecha: '2026-10-15', preview: VISTA_DESACTIVAR })
    expect(p.message).toMatch(/el 15 oct 2026 es su último día/)
    expect(p.message).toMatch(/Dejan de entrar.*1 propina\(s\) \(\$70\.00\)/)
    expect(p.message).toMatch(/Siguen entrando: .*1 propina\(s\) \(\$60\.00\)/)
    mockDesactivarSede.mockResolvedValue({ ventana: { venueId: 'b', desde: '2026-09-01', hasta: '2026-10-15' } })
    const r = parse(
      await sede({
        sede: 'b',
        activa: false,
        fecha: '2026-10-15',
        expectedSourceFingerprint: huellaDeSede('b', false, '2026-10-15'),
        confirm: true,
      }),
    )
    expect(r).toMatchObject({ ok: true })
    expect(mockDesactivarSede).toHaveBeenCalledWith({ userId: 's1', venueId: 'v1', sedeId: 'b', hasta: '2026-10-15' })
    expect(auditMcpWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'SERVICE_PAY_VENUE_DEACTIVATED' }))
  })

  it('activar sin el plan en ninguna sede de la organización: error, sin vista previa', async () => {
    mockOrgTiene.mockResolvedValue(false)
    expect(parse(await sede({ sede: 'b', activa: true }))).toMatchObject({ ok: false, error: expect.stringMatching(/no está activo/) })
    expect(mockVista).not.toHaveBeenCalled()
  })

  it('sin staffpay:close EN LA SEDE (aunque sí en la del URL), o con una sede fuera del alcance: error y nada escrito', async () => {
    mockTiene.mockImplementation((_p: string, venueId: string) => venueId !== 'b')
    expect(parse(await sede({ sede: 'b', activa: false }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/staffpay:close en esa sede/),
    })
    await expect(sede({ sede: 'foreign', activa: false, confirm: true })).rejects.toThrow('out of scope')
    expect(mockVista).not.toHaveBeenCalled()
    expect(mockDesactivarSede).not.toHaveBeenCalled()
  })

  it('sin `activa` la pide; confirmar sin fecha o sin huella también; una huella de otra fecha ⇒ FECHA_CAMBIO sin escribir', async () => {
    expect(parse(await sede({ sede: 'b' }))).toMatchObject({ needsInput: true, field: 'activa' })
    expect(parse(await sede({ sede: 'b', activa: true, confirm: true }))).toMatchObject({ needsInput: true, field: 'fecha' })
    expect(parse(await sede({ sede: 'b', activa: true, fecha: '2026-10-20', confirm: true }))).toMatchObject({
      needsInput: true,
      field: 'expectedSourceFingerprint',
    })
    const otra = parse(
      await sede({
        sede: 'b',
        activa: true,
        fecha: '2026-10-21',
        expectedSourceFingerprint: huellaDeSede('b', true, '2026-10-20'),
        confirm: true,
      }),
    )
    expect(otra).toMatchObject({ ok: false, code: 'FECHA_CAMBIO', error: expect.stringMatching(/vista previa nueva/) })
    expect(mockActivarSede).not.toHaveBeenCalled()
  })

  it('los rechazos del service son respuestas en palabras del dueño (VENTANA_SE_CRUZA, FECHA_FUERA_DE_RANGO), nunca un 500', async () => {
    mockActivarSede.mockRejectedValueOnce(
      new ConflictError('Esas fechas se cruzan con otros días activos de la sede; revisa y vuelve a intentar', 'VENTANA_SE_CRUZA'),
    )
    const cruza = parse(
      await sede({
        sede: 'b',
        activa: true,
        fecha: '2026-10-20',
        expectedSourceFingerprint: huellaDeSede('b', true, '2026-10-20'),
        confirm: true,
      }),
    )
    expect(cruza).toMatchObject({ ok: false, code: 'VENTANA_SE_CRUZA', error: expect.stringMatching(/otra organización/) })
    mockVista.mockRejectedValueOnce(
      new BadRequestError('Septiembre ya se cerró; lo más atrás es el 1 oct 2026', 'FECHA_FUERA_DE_RANGO', {
        desde: '2026-10-01',
        hasta: '2026-10-20',
      }),
    )
    const rango = parse(await sede({ sede: 'b', activa: true, fecha: '2026-09-15' }))
    expect(rango).toMatchObject({
      ok: false,
      code: 'FECHA_FUERA_DE_RANGO',
      error: expect.stringMatching(/Rango: del 2026-10-01 al 2026-10-20/),
    })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('por el catálogo real: la fecha va firmada; pasada la medianoche, una vista previa nueva da OTRA fecha y otra huella', async () => {
    const server = new McpServer({ name: 'staffpay', version: '1' })
    const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
    configureToolCatalog(server, s)
    registerStaffPayTools(server, s)
    const client = new Client({ name: 'staffpay-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      const call = async (args: Record<string, unknown>) =>
        JSON.parse(((await client.callTool({ name: 'configure_service_pay', arguments: args })).content as Array<{ text: string }>)[0].text)
      const p = await call({ venueId: 'v1', accion: 'sede', sede: 'b', activa: true })
      expect(p.confirmationArguments).toMatchObject({
        fecha: '2026-10-20',
        expectedSourceFingerprint: huellaDeSede('b', true, '2026-10-20'),
      })
      // Otra fecha con el token de ésta: no.
      expect(
        await call({ ...p.confirmationArguments, fecha: '2026-10-21', confirm: true, confirmationToken: p.confirmationToken }),
      ).toMatchObject({
        needsInput: true,
        field: 'confirmationToken',
      })
      // Pasó la medianoche: la vista previa nueva resuelve el 21-oct y su huella es otra.
      mockVista.mockResolvedValueOnce({ ...VISTA_ACTIVAR, fecha: '2026-10-21', maximo: '2026-10-21' })
      const p2 = await call({ venueId: 'v1', accion: 'sede', sede: 'b', activa: true })
      expect(p2.fecha).toBe('2026-10-21')
      expect(p2.expectedSourceFingerprint).not.toBe(p.expectedSourceFingerprint)
      expect(mockActivarSede).not.toHaveBeenCalled()
      // Con el token de la primera, se confirma la fecha que se VIO (el 20-oct): «hoy» no se reinterpreta.
      mockActivarSede.mockResolvedValue({ ventana: { venueId: 'b', desde: '2026-10-20', hasta: null } })
      expect(await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({ ok: true })
      expect(mockActivarSede).toHaveBeenCalledWith(expect.objectContaining({ desde: '2026-10-20' }))
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('la tarjeta FUERA_DEL_SOBRE en el MCP (B11, r5.5)', () => {
  it('ajustar una clase fuera del sobre dice por qué no se paga, no «algo sin resolver»', async () => {
    const fuera = {
      classSessionId: 'c1',
      estado: 'FUERA_DEL_SOBRE',
      motivo: null,
      monto: null,
      montoSiEntrara: '500.00',
      sede: { nombre: 'Polanco', fecha: '2026-10-20' },
      staffName: 'Ana QA',
      regla: null,
      ajuste: null,
      anclada: false,
    }
    ;(pagoDeClase as jest.Mock).mockResolvedValue(fuera)
    ;(previewAjusteDeClase as jest.Mock).mockResolvedValue({
      clase: { productName: 'Reformer', fechaLocal: '2026-10-20' },
      antes: fuera,
      despues: { ...fuera, montoSiEntrara: '540.00' },
      periodoCerrado: null,
      pendiente: null,
      huella: 'h'.repeat(64),
    })
    const r = parse(
      await handlers.get('adjust_service_pay_class')!(
        { venueId: 'v1', classSessionId: 'c1', payAmountOverride: 540, reason: 'Acordado', idempotencyKey: 'clave-1234' },
        {},
      ),
    )
    expect(r.message).toMatch(
      /pasa de fuera del pago al personal \(\$0\.00: la sede Polanco no estaba activa el 20 oct 2026; pagaría \$500\.00\)/,
    )
  })
})
