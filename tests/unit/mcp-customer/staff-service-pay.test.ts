import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { auditMcpWrite } from '@/mcp/audit'
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import type { McpScope } from '../../../src/mcp/scope'
import { ConflictError } from '@/errors/AppError'

const mockReporte = jest.fn()
const mockDetalle = jest.fn()
const mockAccess = jest.fn()
const mockHasPermission = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v ?? 'v1'] } }
    },
    tienePermiso: (permiso: string, _venueId: string) => mockHasPermission({ role: 'OWNER' }, permiso),
  }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: (...a: unknown[]) => mockHasPermission(...a) }))
const mockOrgTiene = jest.fn()
const mockTodas = jest.fn()
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  venueHasServicePayAccess: (...a: unknown[]) => mockAccess(...a),
  organizacionTieneServicePay: (...a: unknown[]) => mockOrgTiene(...a),
  assertPermisoEnTodasLasSedes: (...a: unknown[]) => mockTodas(...a),
}))
const mockPreviewLiq = jest.fn()
const mockLiquidar = jest.fn()
jest.mock('@/services/dashboard/staffPay/liquidacion.service', () => ({
  previewLiquidacion: (...a: unknown[]) => mockPreviewLiq(...a),
  liquidarDiferencia: (...a: unknown[]) => mockLiquidar(...a),
}))
const mockCard = jest.fn()
const mockPreviewClase = jest.fn()
const mockGuardarClase = jest.fn()
jest.mock('@/services/dashboard/staffPay/ajustesClase.service', () => ({
  pagoDeClase: (...a: unknown[]) => mockCard(...a),
  previewAjusteDeClase: (...a: unknown[]) => mockPreviewClase(...a),
  guardarAjusteDeClase: (...a: unknown[]) => mockGuardarClase(...a),
}))
const mockDiferencias = jest.fn()
jest.mock('@/services/dashboard/staffPay/diferencias.service', () => ({
  diferenciasDelPeriodo: (...a: unknown[]) => mockDiferencias(...a),
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
const mockPreview = jest.fn()
const mockCerrar = jest.fn()
const mockAjuste = jest.fn()
const mockPagado = jest.fn()
const mockRequireWrite = jest.fn()
jest.mock('@/services/dashboard/staffPay/cierre.service', () => ({
  previewCierre: (...a: unknown[]) => mockPreview(...a),
  cerrarPeriodo: (...a: unknown[]) => mockCerrar(...a),
}))
const mockPreviewAjuste = jest.fn()
const mockPreviewPagado = jest.fn()
jest.mock('@/services/dashboard/staffPay/ajustesManuales.service', () => ({
  agregarAjusteManual: (...a: unknown[]) => mockAjuste(...a),
  previewAjusteManual: (...a: unknown[]) => mockPreviewAjuste(...a),
}))
const mockRecibo = jest.fn()
const mockPeriodoDeFecha = jest.fn()
jest.mock('@/services/dashboard/staffPay/recibos.service', () => ({
  marcarPagado: (...a: unknown[]) => mockPagado(...a),
  previewPagado: (...a: unknown[]) => mockPreviewPagado(...a),
  reciboDePersona: (...a: unknown[]) => mockRecibo(...a),
}))
jest.mock('@/services/dashboard/staffPay/periodosGuardados', () => ({
  periodoQueContieneFecha: (...a: unknown[]) => mockPeriodoDeFecha(...a),
}))
const mockEstado = jest.fn()
const mockActivar = jest.fn()
const mockPropinas = jest.fn()
const mockVentanas = jest.fn()
const mockPlan = jest.fn()
jest.mock('@/services/dashboard/staffPay/activacion.service', () => ({
  estadoActivacion: (...a: unknown[]) => mockEstado(...a),
  previewActivacion: (...a: unknown[]) => mockPlan(...a),
  activarPagoAlPersonal: (...a: unknown[]) => mockActivar(...a),
  cambiarPropinas: (...a: unknown[]) => mockPropinas(...a),
  ventanasDePropinas: (...a: unknown[]) => mockVentanas(...a),
}))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: (...a: unknown[]) => mockRequireWrite(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City', name: 'Avoqado Wellness', currency: 'MXN' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'v1', name: 'Avoqado Wellness', currency: 'MXN' }]),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() =>
  registerStaffPayTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => {
  jest.clearAllMocks()
  mockHasPermission.mockReturnValue(true)
  mockAccess.mockResolvedValue(true)
  mockOrgTiene.mockResolvedValue(true)
  mockEstado.mockResolvedValue({ activado: false, startDate: null, propinasEncendidas: false })
  mockVentanas.mockResolvedValue([])
  mockTodas.mockResolvedValue(undefined)
  mockPlan.mockResolvedValue({ periodicidad: 'MONTHLY', periodicidadFija: false, startDate: '2026-10-01' })
})

// La forma REAL de `previewLiquidacion` (B2): filas de `diferenciasDeClase`, destino legible y `sedeEnDestino`.
const fila = (persona: string | null, personaNombre: string | null, pendiente: string | null, extra: Record<string, unknown> = {}) => ({
  classSessionId: 'c1',
  venueId: 'v1',
  productName: 'Yoga',
  fechaLocal: '2026-08-04',
  persona,
  personaNombre,
  estadoClase: 'OK',
  motivo: null,
  corresponde: '610.00',
  congelado: '570.00',
  conciliado: '0.00',
  pendiente,
  ...extra,
})
const pvLiq = (extra: Record<string, unknown> = {}) => ({
  periodoOrigen: { id: 'p8', start: '2026-08-01', end: '2026-08-31' },
  destino: { start: '2026-09-01', end: '2026-09-30', venueIds: ['v1'] },
  sedeEnDestino: true,
  filas: [fila('a', 'Ana Martínez', '40.00')],
  total: '40.00',
  bloqueada: false,
  huella: 'h'.repeat(64),
  ...extra,
})
const settle = (args: Record<string, unknown>) =>
  handlers.get('settle_service_pay_difference')!({ venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'clave-1234', ...args }, {})

describe('staff_service_pay — feature nueva', () => {
  it('summary devuelve el reporte del periodo en pesos', async () => {
    mockReporte.mockResolvedValue({
      periodo: { start: '2026-10-01', end: '2026-10-31' },
      parcial: false,
      tarjetas: { total: '36620.00' },
      personas: { items: [] },
    })
    const r = parse(await handlers.get('staff_service_pay_summary')!({ venueId: 'v1' }, {}))
    expect(r.tarjetas.total).toBe('36620.00')
    expect(mockReporte).toHaveBeenCalledWith(expect.objectContaining({ userId: 's1', venueId: 'v1' }))
  })
})

describe('staff_service_pay — regresión', () => {
  it('rechaza una sede fuera del alcance', async () => {
    await expect(handlers.get('staff_service_pay_summary')!({ venueId: 'foreign' }, {})).rejects.toThrow('out of scope')
  })
  it('un resumen filtrado por una sede fuera del alcance de la conexión se niega antes de consultar nada', async () => {
    await expect(handlers.get('staff_service_pay_summary')!({ venueId: 'v1', sede: 'foreign' }, {})).rejects.toThrow('out of scope')
    expect(mockAccess).not.toHaveBeenCalled()
    expect(mockReporte).not.toHaveBeenCalled()
  })
  it('sin staffpay:read no lee nada', async () => {
    mockHasPermission.mockReturnValue(false)
    const r = parse(await handlers.get('staff_service_pay_detail')!({ venueId: 'v1', staffId: 'cxxxxxxxxxxxxxxxxxxxxxxxx' }, {}))
    expect(r.ok).toBe(false)
    expect(mockDetalle).not.toHaveBeenCalled()
  })
  it('módulo apagado se explica, no responde vacío', async () => {
    mockAccess.mockResolvedValue(false)
    const r = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no está activo/)
  })
})

describe('staff_service_pay — escritura (spec §9.3)', () => {
  it('cerrar sin confirm devuelve el preview y su huella; no cierra', async () => {
    mockPreview.mockResolvedValue({
      clases: 72,
      comisiones: 0,
      propinas: 0,
      reversos: 0,
      propinasSinDueno: { n: 0, total: '0.00' },
      personas: 4,
      total: '36620.00',
      huella: 'h'.repeat(64),
      puedeCerrar: true,
      bloqueos: [],
      huerfanas: 0,
    })
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-08-15' }, {}))
    expect(r).toMatchObject({ ok: false, requiresConfirmation: true, expectedSourceFingerprint: 'h'.repeat(64) })
    expect(r.message).toMatch(/72 clases.*4 personas.*36,620/)
    expect(mockCerrar).not.toHaveBeenCalled()
    expect(mockRequireWrite).toHaveBeenCalledWith(expect.anything(), 'staffpay:close', expect.any(String))
  })
  it('cerrar con confirm pasa la huella esperada al service', async () => {
    mockCerrar.mockResolvedValue({ periodId: 'p1', total: '36620.00', yaCerrado: false })
    await handlers.get('close_service_pay_period')!(
      { venueId: 'v1', fecha: '2026-08-15', confirm: true, expectedSourceFingerprint: 'h'.repeat(64), confirmarHuerfanas: true },
      {},
    )
    expect(mockCerrar).toHaveBeenCalledWith(expect.objectContaining({ huellaEsperada: 'h'.repeat(64), confirmarHuerfanas: true }))
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SERVICE_PAY_PERIOD_CLOSED', entityId: 'p1' }),
    )
  })
  it('un cierre repetido (yaCerrado) no se vuelve a auditar', async () => {
    mockCerrar.mockResolvedValue({ periodId: 'p1', total: '36620.00', yaCerrado: true })
    await handlers.get('close_service_pay_period')!(
      { venueId: 'v1', fecha: '2026-08-15', confirm: true, expectedSourceFingerprint: 'h'.repeat(64) },
      {},
    )
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
  it('si la huella cambió, devuelve el error con el preview nuevo (no un 500)', async () => {
    mockCerrar.mockRejectedValue(
      Object.assign(new Error('Los números cambiaron'), {
        statusCode: 409,
        code: 'HUELLA_CAMBIO',
        details: { preview: { total: '1.00' } },
      }),
    )
    const r = parse(
      await handlers.get('close_service_pay_period')!(
        { venueId: 'v1', fecha: '2026-08-15', confirm: true, expectedSourceFingerprint: 'x' },
        {},
      ),
    )
    expect(r).toMatchObject({ ok: false, code: 'HUELLA_CAMBIO', preview: { total: '1.00' } })
  })
  it('un periodo ya cerrado o bloqueado no ofrece confirmar (sin huella que confirmar)', async () => {
    mockPreview.mockResolvedValue({
      clases: 72,
      comisiones: 0,
      propinas: 0,
      reversos: 0,
      propinasSinDueno: { n: 0, total: '0.00' },
      personas: 4,
      total: '36620.00',
      huella: '',
      puedeCerrar: false,
      bloqueos: [{ codigo: 'YA_CERRADO' }],
      huerfanas: 0,
    })
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-08-15' }, {}))
    expect(r.requiresConfirmation).toBeUndefined()
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/ya está cerrado/)
  })
  it('con reservas sin horario, pide confirmarlas en la vista previa antes de ofrecer cerrar', async () => {
    mockPreview.mockResolvedValue({
      clases: 72,
      comisiones: 0,
      propinas: 0,
      reversos: 0,
      propinasSinDueno: { n: 0, total: '0.00' },
      personas: 4,
      total: '36620.00',
      huella: 'h'.repeat(64),
      puedeCerrar: true,
      bloqueos: [],
      huerfanas: 3,
    })
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-08-15' }, {}))
    expect(r).toMatchObject({ ok: false, needsInput: true, field: 'confirmarHuerfanas' })
    expect(r.requiresConfirmation).toBeUndefined()
    const ok = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-08-15', confirmarHuerfanas: true }, {}))
    expect(ok).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: 'h'.repeat(64) })
    expect(ok.message).toMatch(/3 reserva\(s\) de clase sin horario no cuentan/)
  })
  it('sin staffpay:close no hay ni preview', async () => {
    mockHasPermission.mockReturnValue(false)
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-08-15' }, {}))
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/staffpay:close/)
    expect(mockPreview).not.toHaveBeenCalled()
  })
  it('el ajuste manual: preview con el periodo destino y su huella; confirmar la exige y la pasa al service', async () => {
    const sinClave = parse(
      await handlers.get('add_service_pay_adjustment')!({ venueId: 'v1', staffId: 's1', amount: 100, reason: 'Bono', confirm: true }, {}),
    )
    expect(sinClave).toMatchObject({ ok: false, needsInput: true, field: 'idempotencyKey' })
    mockPreviewAjuste.mockResolvedValue({
      periodo: { start: '2026-09-01', end: '2026-09-30', estado: 'OPEN' },
      staffId: 's1',
      persona: 'Ana López',
      sede: 'v1',
      sedeNombre: 'Polanco',
      amount: '100.00',
      reason: 'Bono',
      huella: 'a'.repeat(64),
    })
    const pv = parse(
      await handlers.get('add_service_pay_adjustment')!(
        { venueId: 'v1', staffId: 's1', amount: 100, reason: 'Bono', idempotencyKey: 'clave-1234' },
        {},
      ),
    )
    expect(pv).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: 'a'.repeat(64), fecha: '2026-09-01' })
    expect(pv.message).toMatch(/Se agrega un bono de \$100\.00 a Ana López en Polanco con el motivo «Bono» al periodo del 2026-09-01/)
    const desc = parse(
      await handlers.get('add_service_pay_adjustment')!(
        { venueId: 'v1', staffId: 's1', amount: -50, reason: 'Bono', idempotencyKey: 'clave-5678' },
        {},
      ),
    )
    expect(desc.message).toMatch(/Se descuentan \$50\.00 a Ana López en Polanco/)
    const sinHuella = parse(
      await handlers.get('add_service_pay_adjustment')!(
        { venueId: 'v1', staffId: 's1', amount: 100, reason: 'Bono', idempotencyKey: 'clave-1234', confirm: true },
        {},
      ),
    )
    expect(sinHuella).toMatchObject({ needsInput: true, field: 'expectedSourceFingerprint' })
    // Sin fecha, el service usaría «hoy»: un reintento tras la medianoche del cambio de periodo daría CLAVE_REUTILIZADA.
    const sinFecha = parse(
      await handlers.get('add_service_pay_adjustment')!(
        {
          venueId: 'v1',
          staffId: 's1',
          amount: 100,
          reason: 'Bono',
          idempotencyKey: 'clave-1234',
          confirm: true,
          expectedSourceFingerprint: 'a'.repeat(64),
        },
        {},
      ),
    )
    expect(sinFecha).toMatchObject({ needsInput: true, field: 'fecha' })
    expect(mockAjuste).not.toHaveBeenCalled()
    mockAjuste.mockResolvedValue({ id: 'e1', amount: '100.00' })
    await handlers.get('add_service_pay_adjustment')!(
      {
        venueId: 'v1',
        staffId: 's1',
        amount: 100,
        reason: 'Bono',
        fecha: '2026-09-01',
        idempotencyKey: 'clave-1234',
        confirm: true,
        expectedSourceFingerprint: 'a'.repeat(64),
      },
      {},
    )
    expect(mockAjuste).toHaveBeenCalledWith(
      expect.objectContaining({ clientKey: 'mcp-clave-1234', sede: 'v1', fecha: '2026-09-01', huellaEsperada: 'a'.repeat(64) }),
    )
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SERVICE_PAY_MANUAL_ADJUSTMENT', entityId: 'e1' }),
    )
  })
  it('un reintento del ajuste (yaExistia) no se vuelve a auditar', async () => {
    mockAjuste.mockResolvedValue({ id: 'e1', amount: '100.00', yaExistia: true })
    await handlers.get('add_service_pay_adjustment')!(
      {
        venueId: 'v1',
        staffId: 's1',
        amount: 100,
        reason: 'Bono',
        fecha: '2026-09-01',
        idempotencyKey: 'clave-1234',
        confirm: true,
        expectedSourceFingerprint: 'a'.repeat(64),
      },
      {},
    )
    expect(mockAjuste).toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
  it('una sede del ajuste fuera del alcance de la conexión se niega antes de consultar nada', async () => {
    await expect(
      handlers.get('add_service_pay_adjustment')!(
        { venueId: 'v1', sede: 'foreign', staffId: 's1', amount: 100, reason: 'Bono', idempotencyKey: 'clave-1234' },
        {},
      ),
    ).rejects.toThrow('out of scope')
    expect(mockAccess).not.toHaveBeenCalled()
    expect(mockPreviewAjuste).not.toHaveBeenCalled()
  })
  it('un ajuste que cae en un periodo cerrado no ofrece confirmar', async () => {
    mockPreviewAjuste.mockResolvedValue({
      periodo: { start: '2026-08-01', end: '2026-08-31', estado: 'CLOSED' },
      staffId: 's1',
      sede: 'v1',
      amount: '100.00',
      reason: 'Bono',
      huella: 'a'.repeat(64),
    })
    const pv = parse(
      await handlers.get('add_service_pay_adjustment')!(
        { venueId: 'v1', staffId: 's1', amount: 100, reason: 'Bono', fecha: '2026-08-15', idempotencyKey: 'clave-1234' },
        {},
      ),
    )
    expect(pv.requiresConfirmation).toBeUndefined()
    expect(pv.error).toMatch(/ya está cerrado/)
  })
  it('marcar pagado: el preview lista los recibos que se marcarían; confirmar pasa la huella', async () => {
    mockPreviewPagado.mockResolvedValue({
      periodo: { start: '2026-08-01', end: '2026-08-31', estado: 'CLOSED' },
      cantidad: 1,
      total: '570.00',
      recibos: [{ staffId: 'a', nombre: 'Ana', total: '570.00' }],
      huella: 'b'.repeat(64),
    })
    const r = parse(await handlers.get('mark_service_pay_paid')!({ venueId: 'v1', periodId: 'p1' }, {}))
    expect(r).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: 'b'.repeat(64) })
    expect(r.message).toMatch(/1 recibo\(s\) \(todos los pendientes\) por \$570.*Ana \$570/)
    mockPagado.mockResolvedValue({ marcados: 1 })
    await handlers.get('mark_service_pay_paid')!(
      { venueId: 'v1', periodId: 'p1', confirm: true, expectedSourceFingerprint: 'b'.repeat(64) },
      {},
    )
    expect(mockPagado).toHaveBeenCalledWith(expect.objectContaining({ huellaEsperada: 'b'.repeat(64) }))
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SERVICE_PAY_MARKED_PAID', entityId: 'p1' }),
    )
  })
  it('marcar pagado sin nada marcado no audita; con la huella cambiada avisa que puede que ya se haya registrado', async () => {
    mockPagado.mockResolvedValue({ marcados: 0 })
    await handlers.get('mark_service_pay_paid')!(
      { venueId: 'v1', periodId: 'p1', confirm: true, expectedSourceFingerprint: 'b'.repeat(64) },
      {},
    )
    expect(auditMcpWrite).not.toHaveBeenCalled()
    mockPagado.mockRejectedValue(
      Object.assign(new Error('Los recibos cambiaron desde la vista previa: revisa de nuevo'), { statusCode: 409, code: 'HUELLA_CAMBIO' }),
    )
    const r = parse(
      await handlers.get('mark_service_pay_paid')!(
        { venueId: 'v1', periodId: 'p1', confirm: true, expectedSourceFingerprint: 'b'.repeat(64) },
        {},
      ),
    )
    expect(r).toMatchObject({ ok: false, code: 'HUELLA_CAMBIO' })
    expect(r.error).toMatch(/Revisa el preview: puede que ya se haya registrado/)
  })
  it('con más recibos que la muestra, el mensaje dice cuántos faltan por nombrar (nada se calla — Codex R2-Nuevo 1)', async () => {
    mockPreviewPagado.mockResolvedValue({
      periodo: { start: '2026-08-01', end: '2026-08-31', estado: 'CLOSED' },
      cantidad: 101,
      total: '10100.00',
      recibos: Array.from({ length: 100 }, (_, i) => ({ staffId: `s${i}`, nombre: `P${i}`, total: '100.00' })),
      huella: 'b'.repeat(64),
    })
    const r = parse(await handlers.get('mark_service_pay_paid')!({ venueId: 'v1', periodId: 'p1' }, {}))
    expect(r.message).toMatch(/101 recibo\(s\).*por \$10,100\.00.*y 1 más/)
  })
  it('el desglose de un periodo CERRADO devuelve el recibo congelado con cursor, límite y sede (Codex R2-R1-21)', async () => {
    mockPeriodoDeFecha.mockResolvedValue({ id: 'p8', status: 'CLOSED' })
    mockRecibo.mockResolvedValue({ persona: 'Ana', renglones: [], total: '570.00', cantidad: 1, siguiente: null })
    const r = parse(
      await handlers.get('staff_service_pay_detail')!(
        { venueId: 'v1', staffId: 'a', fecha: '2026-08-15', sede: 'v1', cursor: 'c', limit: 20 },
        {},
      ),
    )
    expect(r).toMatchObject({ cerrado: true, recibo: { total: '570.00' } })
    expect(mockRecibo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 's1', venueId: 'v1', staffId: 'a', fecha: '2026-08-15', sede: 'v1', cursor: 'c', limit: 20 }),
    )
    expect(mockDetalle).not.toHaveBeenCalled()
  })
  it('si el periodo se cerró entre la consulta y el desglose en vivo (PERIODO_CERRADO), cae al recibo congelado', async () => {
    mockPeriodoDeFecha.mockResolvedValue({ id: 'p8', status: 'OPEN' })
    mockDetalle.mockRejectedValue(
      Object.assign(new Error('Este periodo ya se cerró: consulta el recibo.'), { statusCode: 409, code: 'PERIODO_CERRADO' }),
    )
    mockRecibo.mockResolvedValue({ persona: 'Ana', renglones: [], total: '570.00', cantidad: 1, siguiente: null })
    const r = parse(await handlers.get('staff_service_pay_detail')!({ venueId: 'v1', staffId: 'a', fecha: '2026-08-15' }, {}))
    expect(r).toMatchObject({ cerrado: true })
  })
  it('un cursor de antes del cierre se explica en texto claro para volver a empezar sin cursor (Codex R3-Nuevo 3)', async () => {
    mockPeriodoDeFecha.mockResolvedValue({ id: 'p8', status: 'CLOSED' })
    mockRecibo.mockRejectedValue(
      Object.assign(new Error('El periodo cambió mientras leías: vuelve a cargar el recibo desde el principio.'), {
        statusCode: 409,
        code: 'RECIBO_CAMBIO',
      }),
    )
    const r = parse(
      await handlers.get('staff_service_pay_detail')!({ venueId: 'v1', staffId: 'a', fecha: '2026-08-15', cursor: 'v1:clase001' }, {}),
    )
    expect(r).toMatchObject({ ok: false, code: 'RECIBO_CAMBIO', reiniciar: true })
    expect(r.message).toMatch(/SIN cursor/)
  })
  it('un recibo cerrado de una sede FUERA del alcance de la conexión se niega ANTES de consultar nada (Codex R2-Nuevo 2)', async () => {
    // La conexión sólo alcanza la organización A; 'foreign' es una sede de la B con su periodo cerrado.
    mockPeriodoDeFecha.mockResolvedValue({ id: 'pB', status: 'CLOSED' })
    await expect(handlers.get('staff_service_pay_detail')!({ venueId: 'foreign', staffId: 'a', fecha: '2026-08-15' }, {})).rejects.toThrow(
      'out of scope',
    )
    expect(mockPeriodoDeFecha).not.toHaveBeenCalled()
    expect(mockRecibo).not.toHaveBeenCalled()
  })
  it('un desglose filtrado por una sede fuera del alcance se niega antes de consultar nada', async () => {
    await expect(
      handlers.get('staff_service_pay_detail')!({ venueId: 'v1', staffId: 'a', fecha: '2026-08-15', sede: 'foreign' }, {}),
    ).rejects.toThrow('out of scope')
    expect(mockAccess).not.toHaveBeenCalled()
    expect(mockPeriodoDeFecha).not.toHaveBeenCalled()
    expect(mockRecibo).not.toHaveBeenCalled()
  })
})

describe('settle_service_pay_difference (liquidar una diferencia, spec §6.4)', () => {
  it('liquidar sin confirm devuelve el preview con la huella; con confirm usa el origen del preview y la clave del MCP', async () => {
    mockPreviewLiq.mockResolvedValue(pvLiq())
    const pv = parse(
      await handlers.get('settle_service_pay_difference')!({ venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'clave-1234' }, {}),
    )
    expect(pv).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: 'h'.repeat(64) })
    mockLiquidar.mockResolvedValue({ lineas: [{ staffId: 'a', amount: '40.00' }], yaLiquidada: false })
    await handlers.get('settle_service_pay_difference')!(
      { venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'clave-1234', confirm: true, expectedSourceFingerprint: 'h'.repeat(64) },
      {},
    )
    expect(mockLiquidar).toHaveBeenCalledWith(
      expect.objectContaining({ periodoOrigenId: 'p8', huellaEsperada: 'h'.repeat(64), solicitudId: 'mcp-clave-1234' }),
    )
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SERVICE_PAY_DIFFERENCE_SETTLED', entity: 'ClassSession', entityId: 'c1' }),
    )
    expect(mockRequireWrite).toHaveBeenCalledWith(expect.anything(), 'staffpay:close', expect.any(String))
  })
  it('el preview NOMBRA a la persona, el monto con signo y moneda, la clase, su fecha, la sede y el periodo destino (A12)', async () => {
    mockPreviewLiq.mockResolvedValue(pvLiq())
    const pv = parse(await settle({}))
    expect(pv.message).toBe(
      'Se liquida una diferencia de +$40.00 MXN a Ana Martínez por Yoga del 4 ago 2026 en Avoqado Wellness; cae en el periodo de septiembre de 2026.',
    )
    // La fecha que el catálogo liga al token: el periodo que se VIO, aunque pase la medianoche.
    expect(pv).toMatchObject({ destinoFecha: '2026-09-01', moneda: 'MXN' })
    expect(mockPreviewLiq).toHaveBeenCalledWith({ userId: 's1', venueId: 'v1', classSessionId: 'c1', destinoFecha: undefined })
    expect(mockLiquidar).not.toHaveBeenCalled()
  })
  it('una sustitución nombra a las dos personas, con su signo, aunque el total sea $0; un pendiente de $0 no se nombra', async () => {
    mockPreviewLiq.mockResolvedValue(
      pvLiq({
        destino: { start: '2026-09-01', end: '2026-09-15', venueIds: ['v1'] },
        filas: [fila('a', 'Ana Martínez', '-570.00'), fila('b', 'Beto Ruiz', '0.00'), fila('c', 'Carla Soto', '570.00')],
        total: '0.00',
      }),
    )
    const pv = parse(await settle({ destinoFecha: '2026-09-10' }))
    expect(pv.requiresConfirmation).toBe(true)
    expect(pv.message).toBe(
      'Se liquidan diferencias de -$570.00 MXN a Ana Martínez, +$570.00 MXN a Carla Soto por Yoga del 4 ago 2026 en Avoqado Wellness; caen en el periodo del 1 sep 2026 al 15 sep 2026.',
    )
    expect(pv.destinoFecha).toBe('2026-09-10')
  })
  it('una clase en excepción no ofrece confirmar y dice el motivo legible', async () => {
    mockPreviewLiq.mockResolvedValue(
      pvLiq({ filas: [fila(null, null, null, { estadoClase: 'EXCEPCION', motivo: 'SIN_TABLA' })], total: '0.00', bloqueada: true }),
    )
    const r = parse(await settle({}))
    expect(r.requiresConfirmation).toBeUndefined()
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/No hay tabla de pagos para esta clase.*resuélvel/)
  })
  it('sin nada pendiente, o sin periodo cerrado de origen, no ofrece confirmar', async () => {
    mockPreviewLiq.mockResolvedValue(pvLiq({ filas: [fila('a', 'Ana Martínez', '0.00')], total: '0.00' }))
    const cero = parse(await settle({}))
    expect(cero.requiresConfirmation).toBeUndefined()
    expect(cero.error).toMatch(/no tiene diferencia pendiente/)
    mockPreviewLiq.mockResolvedValue(pvLiq({ periodoOrigen: null, filas: [], total: '0.00' }))
    const sinOrigen = parse(await settle({}))
    expect(sinOrigen.requiresConfirmation).toBeUndefined()
    expect(sinOrigen.error).toMatch(/no pertenece a un periodo cerrado/)
  })
  it('la sede fuera del periodo destino pide ampliarAlcance ANTES de ofrecer confirmar; con él, el mensaje lo dice', async () => {
    mockPreviewLiq.mockResolvedValue(pvLiq({ sedeEnDestino: false, destino: { start: '2026-09-01', end: '2026-09-30', venueIds: ['v2'] } }))
    const r = parse(await settle({}))
    expect(r).toMatchObject({ ok: false, needsInput: true, field: 'ampliarAlcance' })
    expect(r.requiresConfirmation).toBeUndefined()
    expect(r.question).toMatch(/Avoqado Wellness no está en el periodo de septiembre de 2026.*ampliarAlcance:true/)
    const ok = parse(await settle({ ampliarAlcance: true }))
    expect(ok.requiresConfirmation).toBe(true)
    expect(ok.message).toMatch(/Avoqado Wellness se suma a ese periodo\.$/)
  })
  it('confirmar sin la huella del preview la pide; un reintento ya liquidado no se vuelve a auditar', async () => {
    mockPreviewLiq.mockResolvedValue(pvLiq())
    const sinHuella = parse(await settle({ confirm: true }))
    expect(sinHuella).toMatchObject({ needsInput: true, field: 'expectedSourceFingerprint' })
    expect(mockLiquidar).not.toHaveBeenCalled()
    mockLiquidar.mockResolvedValue({ lineas: [{ staffId: 'a', amount: '40.00' }], yaLiquidada: true })
    const r = parse(
      await settle({ confirm: true, expectedSourceFingerprint: 'h'.repeat(64), destinoFecha: '2026-09-01', ampliarAlcance: true }),
    )
    expect(r).toMatchObject({ ok: true, yaLiquidada: true })
    expect(mockLiquidar).toHaveBeenCalledWith({
      userId: 's1',
      venueId: 'v1',
      classSessionId: 'c1',
      destinoFecha: '2026-09-01',
      ampliarAlcance: true,
      periodoOrigenId: 'p8',
      huellaEsperada: 'h'.repeat(64),
      solicitudId: 'mcp-clave-1234',
    })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
  it.each([
    ['SEDE_FUERA_DEL_PERIODO', 400, /ampliarAlcance: true/],
    ['HUELLA_CAMBIO', 409, /vista previa.*sin confirm/],
    ['ORIGEN_CAMBIO', 409, /vista previa/],
    ['PERIODO_CERRADO', 409, /periodo abierto/],
    ['CLAVE_REUTILIZADA', 409, /idempotencyKey nueva/],
    ['CLASE_EN_EXCEPCION', 400, /coach, nivel, tabla o monto/],
  ])('%s del service ⇒ texto claro con qué hacer (no un 500)', async (code, statusCode, queHacer) => {
    mockPreviewLiq.mockResolvedValue(pvLiq())
    mockLiquidar.mockRejectedValue(
      Object.assign(new Error('mensaje del service'), { statusCode, code, details: { preview: { total: '80.00' } } }),
    )
    const r = parse(await settle({ confirm: true, expectedSourceFingerprint: 'h'.repeat(64) }))
    expect(r).toMatchObject({ ok: false, code, preview: { total: '80.00' } })
    expect(r.error).toMatch(/^mensaje del service\. /)
    expect(r.error).toMatch(queHacer)
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
  it('una sede fuera del alcance de la conexión se niega ANTES de consultar nada', async () => {
    await expect(settle({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockOrgTiene).not.toHaveBeenCalled()
    expect(mockPreviewLiq).not.toHaveBeenCalled()
  })
  it('sin staffpay:close no hay ni preview', async () => {
    mockHasPermission.mockReturnValue(false)
    const r = parse(await settle({}))
    expect(r.error).toMatch(/staffpay:close/)
    expect(mockPreviewLiq).not.toHaveBeenCalled()
  })
})

describe('settle_service_pay_difference — el módulo se exige en la organización, no en la sede de la clase (Codex R2-R1-1)', () => {
  beforeEach(() => {
    mockPreviewLiq.mockResolvedValue(pvLiq())
  })
  it('sede de la clase con el módulo apagado + organización con el módulo en otra sede ⇒ sí da el preview', async () => {
    mockAccess.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(true)
    const pv = parse(
      await handlers.get('settle_service_pay_difference')!({ venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'clave-1234' }, {}),
    )
    expect(pv).toMatchObject({ requiresConfirmation: true })
    expect(mockOrgTiene).toHaveBeenCalledWith('v1')
  })
  it('organización sin el módulo en ninguna sede ⇒ lo explica y no calcula nada', async () => {
    mockAccess.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(false)
    const r = parse(
      await handlers.get('settle_service_pay_difference')!({ venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'clave-1234' }, {}),
    )
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/no está activo en ninguna sede/)
    expect(mockPreviewLiq).not.toHaveBeenCalled()
  })
  it('las otras escrituras siguen exigiendo el módulo en SU sede', async () => {
    mockAccess.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(true)
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-08-15' }, {}))
    expect(r.error).toMatch(/no está activo en este negocio/)
    expect(mockPreview).not.toHaveBeenCalled()
  })
})

describe('staff_service_pay_differences (lista de lo pendiente de un periodo cerrado)', () => {
  const filaCompleta = (extra: Record<string, unknown> = {}) => ({
    ...fila('a', 'Ana Martínez', '40.00'),
    startsAt: new Date('2026-08-04T14:00:00Z'),
    fechaValoracion: '2026-08-04',
    periodoOrigenId: 'p8',
    coachActual: 'a',
    payLevelId: 'l1',
    payLevelName: 'Head Coach',
    tableVersionId: 'tv1',
    countMode: 'BOOKED',
    conteo: 9,
    ...extra,
  })
  it('devuelve por fila clase, fecha local, sede, persona y montos con moneda; cursor y vista parcial', async () => {
    mockDiferencias.mockResolvedValue({
      items: [
        filaCompleta(),
        filaCompleta({
          persona: null,
          personaNombre: null,
          estadoClase: 'EXCEPCION',
          motivo: 'COACH_SIN_NIVEL',
          corresponde: null,
          pendiente: null,
        }),
      ],
      nextCursor: 'v1:c1:a',
      parcial: true,
    })
    const r = parse(
      await handlers.get('staff_service_pay_differences')!({ venueId: 'v1', periodId: 'p8', cursor: 'v1:c0:a', limit: 20 }, {}),
    )
    // Un solo argumento: las opciones de prueba (ahora, tamLote, topeSinAncla) nunca salen del MCP.
    expect(mockDiferencias.mock.calls[0]).toEqual([{ userId: 's1', venueId: 'v1', periodId: 'p8', cursor: 'v1:c0:a', limit: 20 }])
    expect(r.items[0]).toEqual({
      classSessionId: 'c1',
      clase: 'Yoga',
      fecha: '2026-08-04',
      venueId: 'v1',
      sede: 'Avoqado Wellness',
      staffId: 'a',
      persona: 'Ana Martínez',
      corresponde: '610.00',
      congelado: '570.00',
      conciliado: '0.00',
      pendiente: '40.00',
      moneda: 'MXN',
      enExcepcion: false,
      motivo: null,
      causa: null,
    })
    expect(r.items[1]).toMatchObject({ persona: null, pendiente: null, enExcepcion: true, motivo: 'La coach no tiene nivel', causa: null })
    expect(r).toMatchObject({ nextCursor: 'v1:c1:a', parcial: true })
    expect(r.message).toMatch(/Vista parcial/)
  })
  it('cada fila dice POR QUÉ existe, en español, con las palabras del dashboard (QA bloque B, defecto 4)', async () => {
    const casos: Array<[Record<string, unknown>, string | null]> = [
      [{ causa: 'CONTEO', conteoCongelado: 8, conteo: 9 }, 'Conteo corregido: 8 → 9'],
      [{ causa: 'COACH_SALE', coachActualNombre: 'Sofía Ruiz' }, 'Ya no da esta clase (ahora: Sofía Ruiz)'],
      [{ causa: 'COACH_ENTRA' }, 'Ahora da esta clase'],
      [{ causa: 'CANCELADA' }, 'Clase cancelada después del cierre'],
      [{ causa: 'EXCLUIDA' }, 'Clase excluida del pago'],
      [{ causa: 'TARDIA' }, 'Clase registrada después del cierre'],
      [{ causa: 'REINCLUIDA' }, 'Clase que no se pagaba al cerrar y ahora sí'],
      [{ causa: 'MONTO' }, 'Monto de la clase corregido'],
      [{ causa: null }, null],
    ]
    mockDiferencias.mockResolvedValue({ items: casos.map(([extra]) => filaCompleta(extra)), nextCursor: null, parcial: false })
    const r = parse(await handlers.get('staff_service_pay_differences')!({ venueId: 'v1', periodId: 'p8' }, {}))
    expect(r.items.map((i: { causa: string | null }) => i.causa)).toEqual(casos.map(([, texto]) => texto))
  })

  it('sin limit pide 50; sin staffpay:read no lee nada; con el módulo apagado lo explica', async () => {
    mockDiferencias.mockResolvedValue({ items: [], nextCursor: null, parcial: false })
    const vacio = parse(await handlers.get('staff_service_pay_differences')!({ venueId: 'v1', periodId: 'p8' }, {}))
    expect(mockDiferencias).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }))
    expect(vacio).toMatchObject({ items: [], nextCursor: null, parcial: false })
    expect(vacio.message).toBeUndefined()
    mockDiferencias.mockClear()
    mockHasPermission.mockReturnValue(false)
    expect(parse(await handlers.get('staff_service_pay_differences')!({ venueId: 'v1', periodId: 'p8' }, {})).error).toMatch(
      /staffpay:read/,
    )
    mockHasPermission.mockReturnValue(true)
    mockAccess.mockResolvedValue(false)
    expect(parse(await handlers.get('staff_service_pay_differences')!({ venueId: 'v1', periodId: 'p8' }, {})).error).toMatch(
      /no está activo/,
    )
    expect(mockDiferencias).not.toHaveBeenCalled()
  })
  it('una sede fuera del alcance se niega antes de consultar nada; un periodo que no existe es una respuesta, no un 500', async () => {
    await expect(handlers.get('staff_service_pay_differences')!({ venueId: 'foreign', periodId: 'p8' }, {})).rejects.toThrow('out of scope')
    expect(mockDiferencias).not.toHaveBeenCalled()
    mockDiferencias.mockRejectedValue(Object.assign(new Error('Periodo no encontrado'), { statusCode: 404 }))
    expect(parse(await handlers.get('staff_service_pay_differences')!({ venueId: 'v1', periodId: 'p8' }, {}))).toMatchObject({
      ok: false,
      error: 'Periodo no encontrado',
    })
  })
})

describe('staff_service_pay — por el catálogo real (dos pasos con confirmationToken)', () => {
  it('el ajuste confirma con la fecha del periodo que mostró el preview, nunca con «hoy»', async () => {
    const server = new McpServer({ name: 'staffpay', version: '1' })
    const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
    configureToolCatalog(server, s)
    registerStaffPayTools(server, s)
    const client = new Client({ name: 'staffpay-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      const call = async (args: Record<string, unknown>) =>
        JSON.parse(
          ((await client.callTool({ name: 'add_service_pay_adjustment', arguments: args })).content as Array<{ text: string }>)[0].text,
        )
      mockPreviewAjuste.mockResolvedValue({
        periodo: { start: '2026-09-01', end: '2026-09-30', estado: 'OPEN' },
        staffId: 's1',
        sede: 'v1',
        amount: '100.00',
        reason: 'Bono',
        huella: 'a'.repeat(64),
      })
      const p = await call({ venueId: 'v1', staffId: 's1', amount: 100, reason: 'Bono', idempotencyKey: 'clave-1234' })
      expect(p.confirmationArguments).toMatchObject({ fecha: '2026-09-01', expectedSourceFingerprint: 'a'.repeat(64) })
      mockAjuste.mockResolvedValue({ id: 'e1', amount: '100.00', yaExistia: false })
      const r = await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
      expect(r).toMatchObject({ ok: true, id: 'e1' })
      expect(mockAjuste).toHaveBeenCalledWith(
        expect.objectContaining({ fecha: '2026-09-01', clientKey: 'mcp-clave-1234', huellaEsperada: 'a'.repeat(64) }),
      )
    } finally {
      await client.close()
      await server.close()
    }
  })
  it('liquidar confirma con la clase, la fecha destino y la ampliación que se vieron; con otras, el token no sirve', async () => {
    const server = new McpServer({ name: 'staffpay', version: '1' })
    const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
    configureToolCatalog(server, s)
    registerStaffPayTools(server, s)
    const client = new Client({ name: 'staffpay-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      const call = async (args: Record<string, unknown>) =>
        JSON.parse(
          ((await client.callTool({ name: 'settle_service_pay_difference', arguments: args })).content as Array<{ text: string }>)[0].text,
        )
      mockPreviewLiq.mockResolvedValue(pvLiq())
      const p = await call({ venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'clave-1234' })
      expect(p.confirmationArguments).toEqual({
        venueId: 'v1',
        classSessionId: 'c1',
        idempotencyKey: 'clave-1234',
        destinoFecha: '2026-09-01',
        expectedSourceFingerprint: 'h'.repeat(64),
      })
      for (const cambio of [{ destinoFecha: '2026-10-01' }, { ampliarAlcance: true }, { classSessionId: 'c2' }]) {
        const r = await call({ ...p.confirmationArguments, ...cambio, confirm: true, confirmationToken: p.confirmationToken })
        expect(r).toMatchObject({ needsInput: true, field: 'confirmationToken' })
      }
      expect(mockLiquidar).not.toHaveBeenCalled()
      mockLiquidar.mockResolvedValue({ lineas: [{ staffId: 'a', amount: '40.00' }], yaLiquidada: false })
      const r = await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
      expect(r).toMatchObject({ ok: true, lineas: [{ staffId: 'a', amount: '40.00' }] })
      expect(mockLiquidar).toHaveBeenCalledWith(
        expect.objectContaining({
          classSessionId: 'c1',
          destinoFecha: '2026-09-01',
          periodoOrigenId: 'p8',
          huellaEsperada: 'h'.repeat(64),
          solicitudId: 'mcp-clave-1234',
        }),
      )
    } finally {
      await client.close()
      await server.close()
    }
  })
  it('reusar la idempotencyKey cuando la clase tiene una diferencia NUEVA: el agente recibe qué pasó y que use una nueva (I-1)', async () => {
    const server = new McpServer({ name: 'staffpay', version: '1' })
    const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
    configureToolCatalog(server, s)
    registerStaffPayTools(server, s)
    const client = new Client({ name: 'staffpay-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      const call = async (args: Record<string, unknown>) =>
        JSON.parse(
          ((await client.callTool({ name: 'settle_service_pay_difference', arguments: args })).content as Array<{ text: string }>)[0].text,
        )
      const liquidar = async () => {
        const p = await call({ venueId: 'v1', classSessionId: 'c1', idempotencyKey: 'settle-c1' })
        return call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
      }
      mockPreviewLiq.mockResolvedValue(pvLiq({ destino: { start: '2026-10-01', end: '2026-10-31', venueIds: ['v1'] } }))
      mockLiquidar.mockResolvedValueOnce({ lineas: [{ staffId: 'a', amount: '40.00' }], yaLiquidada: false })
      expect(await liquidar()).toMatchObject({ ok: true, yaLiquidada: false })
      // El 10-oct se corrige a 10: la vista previa dice +$40 nuevos y el agente reusa la clave (cae en octubre otra vez).
      const msg =
        'Esa clave ya liquidó +$40.00 en el periodo del 2026-10-01 al 2026-10-31 y la clase tiene una diferencia nueva de +$40.00: usa otra clave'
      mockLiquidar.mockRejectedValueOnce(Object.assign(new Error(msg), { statusCode: 409, code: 'CLAVE_REUTILIZADA' }))
      const r = await liquidar()
      expect(r).toMatchObject({ ok: false, code: 'CLAVE_REUTILIZADA' })
      expect(r.error).toContain(msg)
      expect(r.error).toMatch(/Usa una idempotencyKey nueva/)
      expect(mockLiquidar).toHaveBeenLastCalledWith(expect.objectContaining({ destinoFecha: '2026-10-01', solicitudId: 'mcp-settle-c1' }))
      // Sólo la primera se audita.
      expect(auditMcpWrite).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
      await server.close()
    }
  })
  it('liquidar exige una idempotencyKey que quepa en la clave del service (4 a 96, sin «:»)', async () => {
    const server = new McpServer({ name: 'staffpay', version: '1' })
    const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
    configureToolCatalog(server, s)
    registerStaffPayTools(server, s)
    const client = new Client({ name: 'staffpay-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      // El agente recibe un mensaje en español que dice qué formato usar (no el error de zod en inglés) y no se toca el service.
      for (const idempotencyKey of [undefined, 'abc', 'clave:1234', 'k'.repeat(97)]) {
        const r = await client.callTool({
          name: 'settle_service_pay_difference',
          arguments: { venueId: 'v1', classSessionId: 'c1', idempotencyKey },
        })
        expect(r.isError).toBeFalsy()
        const p = JSON.parse((r.content as Array<{ text: string }>)[0].text)
        expect(p).toMatchObject({ ok: false, needsInput: true, field: 'idempotencyKey' })
        expect(p.question).toMatch(/obligatoria: de 4 a 96 caracteres, sólo letras, números, guion, guion bajo y punto/)
        expect(p.question).toMatch(/la misma en la vista previa y al confirmar/)
      }
      expect(mockPreviewLiq).not.toHaveBeenCalled()
      expect(mockLiquidar).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
    }
  })
  it('el ajuste manual exige una idempotencyKey con formato y lo dice en español (no el error de zod en inglés)', async () => {
    const server = new McpServer({ name: 'staffpay', version: '1' })
    const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
    configureToolCatalog(server, s)
    registerStaffPayTools(server, s)
    const client = new Client({ name: 'staffpay-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      for (const idempotencyKey of [undefined, 'abc', 'clave:1234', 'k'.repeat(101)]) {
        const r = await client.callTool({
          name: 'add_service_pay_adjustment',
          arguments: { venueId: 'v1', staffId: 's1', amount: 100, reason: 'Bono', idempotencyKey },
        })
        expect(r.isError).toBeFalsy()
        const p = JSON.parse((r.content as Array<{ text: string }>)[0].text)
        expect(p).toMatchObject({ ok: false, needsInput: true, field: 'idempotencyKey' })
        expect(p.question).toMatch(/obligatoria: de 4 a 100 caracteres, sólo letras, números, guion, guion bajo y punto/)
        expect(p.question).toMatch(/la misma en la vista previa y al confirmar/)
      }
      expect(mockPreviewAjuste).not.toHaveBeenCalled()
      expect(mockAjuste).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
    }
  })
})

// Revisión final, M-1: resolver UNA clase por MCP (lo que la ruta `PUT /class-sessions/:id/pay-adjustments` ya hace).
describe('adjust_service_pay_class', () => {
  const tarjeta = (extra: Record<string, unknown> = {}) => ({
    classSessionId: 'c1',
    estado: 'OK',
    motivo: null,
    monto: '570.00',
    conteo: 8,
    staffName: 'Ana Martínez',
    ajuste: null,
    anclada: true,
    llegoTarde: false,
    ...extra,
  })
  const efecto = (extra: Record<string, unknown> = {}) => ({
    clase: { productName: 'Yoga', fechaLocal: '2026-09-28' },
    antes: tarjeta(),
    despues: tarjeta({ conteo: 9, monto: '610.00' }),
    periodoCerrado: { start: '2026-09-01', end: '2026-09-30' },
    pendiente: '40.00',
    huella: 'e'.repeat(64),
    ...extra,
  })
  const ajustar = (args: Record<string, unknown>) =>
    handlers.get('adjust_service_pay_class')!(
      { venueId: 'v1', classSessionId: 'c1', reason: 'Eran nueve', idempotencyKey: 'ajuste-c1', ...args },
      {},
    )
  beforeEach(() => {
    mockCard.mockResolvedValue(tarjeta())
    mockPreviewClase.mockResolvedValue(efecto())
  })

  it('la vista previa dice qué cambia en dinero y lo que queda por liquidar; no escribe', async () => {
    const r = parse(await ajustar({ payCountOverride: 9 }))
    expect(r).toMatchObject({ ok: false, requiresConfirmation: true, expectedSourceFingerprint: 'e'.repeat(64) })
    expect(r.message).toBe(
      'La clase Yoga del 28 sep 2026 de Ana Martínez pasa de $570.00 a $610.00; como el periodo de septiembre de 2026 ya se cerró, queda una diferencia de +$40.00 MXN por liquidar (settle_service_pay_difference).',
    )
    expect(mockPreviewClase).toHaveBeenCalledWith({
      venueId: 'v1',
      classSessionId: 'c1',
      payCountOverride: 9,
      payAmountOverride: null,
      payExcluded: false,
      reason: 'Eran nueve',
      actorId: 's1',
    })
    expect(mockGuardarClase).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('lo que no se manda conserva su valor actual (null vuelve al cálculo)', async () => {
    mockCard.mockResolvedValue(tarjeta({ ajuste: { payCountOverride: 9, payAmountOverride: '600.00', payExcluded: false } }))
    await ajustar({ payExcluded: true })
    expect(mockPreviewClase).toHaveBeenCalledWith(
      expect.objectContaining({ payCountOverride: 9, payAmountOverride: 600, payExcluded: true }),
    )
    await ajustar({ payAmountOverride: null })
    expect(mockPreviewClase).toHaveBeenLastCalledWith(
      expect.objectContaining({ payCountOverride: 9, payAmountOverride: null, payExcluded: false }),
    )
  })

  it('sin cambio real no ofrece confirmar', async () => {
    mockCard.mockResolvedValue(tarjeta({ ajuste: { payCountOverride: 9, payAmountOverride: null, payExcluded: false } }))
    const r = parse(await ajustar({ payCountOverride: 9 }))
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/ya tiene esos valores/)
    expect(mockPreviewClase).not.toHaveBeenCalled()
  })

  it('confirmar pasa la huella y la clave al service, con el cambio completo; audita sólo si aplicó', async () => {
    mockGuardarClase.mockResolvedValue({ ...tarjeta({ conteo: 9, monto: '610.00' }), yaAplicado: false })
    const r = parse(await ajustar({ payCountOverride: 9, confirm: true, expectedSourceFingerprint: 'e'.repeat(64) }))
    expect(r).toMatchObject({ ok: true, monto: '610.00', yaAplicado: false })
    expect(mockGuardarClase).toHaveBeenCalledWith({
      venueId: 'v1',
      classSessionId: 'c1',
      payCountOverride: 9,
      payAmountOverride: null,
      payExcluded: false,
      reason: 'Eran nueve',
      actorId: 's1',
      clientKey: 'mcp-ajuste-c1',
      huellaEsperada: 'e'.repeat(64),
    })
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SERVICE_PAY_CLASS_ADJUSTED', entity: 'ClassSession', entityId: 'c1', venueId: 'v1' }),
    )
    jest.clearAllMocks()
    mockHasPermission.mockReturnValue(true)
    mockOrgTiene.mockResolvedValue(true)
    mockCard.mockResolvedValue(tarjeta({ ajuste: { payCountOverride: 9, payAmountOverride: null, payExcluded: false } }))
    mockGuardarClase.mockResolvedValue({ ...tarjeta({ conteo: 9, monto: '610.00' }), yaAplicado: true })
    expect(parse(await ajustar({ payCountOverride: 9, confirm: true, expectedSourceFingerprint: 'e'.repeat(64) }))).toMatchObject({
      ok: true,
      yaAplicado: true,
    })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('permisos: staffpay:manage siempre; si la clase ya se contabilizó, además staffpay:close', async () => {
    mockHasPermission.mockImplementation((_a: unknown, p: string) => p !== 'staffpay:close')
    const anclada = parse(await ajustar({ payCountOverride: 9 }))
    expect(anclada.error).toMatch(/ya se contabilizó.*staffpay:close/)
    expect(mockPreviewClase).not.toHaveBeenCalled()
    // Sin ancla basta staffpay:manage (lo mismo que la ruta).
    mockCard.mockResolvedValue(tarjeta({ anclada: false }))
    expect(parse(await ajustar({ payCountOverride: 9 }))).toMatchObject({ requiresConfirmation: true })
    mockHasPermission.mockImplementation((_a: unknown, p: string) => p !== 'staffpay:manage')
    expect(parse(await ajustar({ payCountOverride: 9 })).error).toMatch(/staffpay:manage/)
  })

  it('el módulo se exige en la organización: una sede que lo apagó resuelve sus clases; sin módulo en ninguna, no', async () => {
    mockAccess.mockResolvedValue(false)
    expect(parse(await ajustar({ payCountOverride: 9 }))).toMatchObject({ requiresConfirmation: true })
    expect(mockAccess).not.toHaveBeenCalled()
    mockOrgTiene.mockResolvedValue(false)
    expect(parse(await ajustar({ payCountOverride: 9 })).error).toMatch(/no está activo en ninguna sede/)
  })

  it('la sede fuera del alcance se niega antes de consultar nada; la clave mal formada se pide en español', async () => {
    await expect(ajustar({ venueId: 'foreign', payCountOverride: 9 })).rejects.toThrow('out of scope')
    expect(mockCard).not.toHaveBeenCalled()
    for (const idempotencyKey of [undefined, 'abc', 'clave:1234']) {
      const r = parse(await ajustar({ payCountOverride: 9, idempotencyKey }))
      expect(r).toMatchObject({ ok: false, needsInput: true, field: 'idempotencyKey' })
      expect(r.question).toMatch(/obligatoria: de 4 a 100 caracteres/)
    }
    expect(mockCard).not.toHaveBeenCalled()
  })

  it.each([
    ['HUELLA_CAMBIO', 409, /vista previa.*sin confirm/],
    ['CLAVE_REUTILIZADA', 409, /idempotencyKey nueva/],
  ])('%s del service ⇒ texto claro con qué hacer', async (code, statusCode, queHacer) => {
    mockGuardarClase.mockRejectedValue(Object.assign(new Error('mensaje del service'), { statusCode, code }))
    const r = parse(await ajustar({ payCountOverride: 9, confirm: true, expectedSourceFingerprint: 'e'.repeat(64) }))
    expect(r).toMatchObject({ ok: false, code })
    expect(r.error).toMatch(queHacer)
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('una clase en excepción al liquidar remite a esta tool', async () => {
    mockPreviewLiq.mockResolvedValue(pvLiq())
    mockLiquidar.mockRejectedValue(Object.assign(new Error('mensaje del service'), { statusCode: 400, code: 'CLASE_EN_EXCEPCION' }))
    const r = parse(await settle({ confirm: true, expectedSourceFingerprint: 'h'.repeat(64) }))
    expect(r.error).toMatch(/adjust_service_pay_class/)
  })

  it('por el catálogo real: el token liga el cambio; con otro conteo no sirve', async () => {
    const server = new McpServer({ name: 'staffpay', version: '1' })
    const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
    configureToolCatalog(server, s)
    registerStaffPayTools(server, s)
    const client = new Client({ name: 'staffpay-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      const call = async (args: Record<string, unknown>) =>
        JSON.parse(
          ((await client.callTool({ name: 'adjust_service_pay_class', arguments: args })).content as Array<{ text: string }>)[0].text,
        )
      const p = await call({ venueId: 'v1', classSessionId: 'c1', payCountOverride: 9, reason: 'Eran nueve', idempotencyKey: 'ajuste-c1' })
      expect(p.confirmationArguments).toMatchObject({ payCountOverride: 9, expectedSourceFingerprint: 'e'.repeat(64) })
      const otro = await call({ ...p.confirmationArguments, payCountOverride: 10, confirm: true, confirmationToken: p.confirmationToken })
      expect(otro).toMatchObject({ needsInput: true, field: 'confirmationToken' })
      expect(mockGuardarClase).not.toHaveBeenCalled()
      mockGuardarClase.mockResolvedValue({ ...tarjeta({ conteo: 9, monto: '610.00' }), yaAplicado: false })
      expect(await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({ ok: true })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

// full-testing A6/A8/C14: el MCP pasa por los MISMOS services; sus 400 le llegan al agente en español y un no-cambio no se audita.
describe('reglas del service por MCP (full-testing)', () => {
  it('ajuste manual con fecha fuera de rango: el agente recibe el rango, sin preview ni escritura', async () => {
    mockPreviewAjuste.mockRejectedValue(
      Object.assign(new Error('La fecha del ajuste debe estar entre 4 oct 2025 y 31 oct 2026'), {
        statusCode: 400,
        code: 'FECHA_FUERA_DE_RANGO',
      }),
    )
    const r = parse(
      await handlers.get('add_service_pay_adjustment')!(
        { venueId: 'v1', staffId: 's1', amount: 100, reason: 'Bono', fecha: '2999-01-01', idempotencyKey: 'clave-1234' },
        {},
      ),
    )
    expect(r).toMatchObject({
      ok: false,
      code: 'FECHA_FUERA_DE_RANGO',
      error: 'La fecha del ajuste debe estar entre 4 oct 2025 y 31 oct 2026',
    })
    expect(mockAjuste).not.toHaveBeenCalled()
  })
  it('ajustar una clase con un monto de 3 decimales: el 400 del service llega tal cual', async () => {
    mockCard.mockResolvedValue({ classSessionId: 'c1', estado: 'OK', monto: '570.00', ajuste: null, anclada: false })
    mockPreviewClase.mockRejectedValue(Object.assign(new Error('El monto admite hasta 2 decimales'), { statusCode: 400 }))
    const r = parse(
      await handlers.get('adjust_service_pay_class')!(
        { venueId: 'v1', classSessionId: 'c1', payAmountOverride: 10.005, reason: 'Acordado', idempotencyKey: 'ajuste-c1' },
        {},
      ),
    )
    expect(r).toMatchObject({ ok: false, error: 'El monto admite hasta 2 decimales' })
  })
  it('ajustar una clase sin cambios reales (sinCambios) no se audita', async () => {
    mockCard.mockResolvedValue({ classSessionId: 'c1', estado: 'OK', monto: '610.00', ajuste: null, anclada: false })
    mockGuardarClase.mockResolvedValue({ classSessionId: 'c1', monto: '610.00', yaAplicado: false, sinCambios: true })
    const r = parse(
      await handlers.get('adjust_service_pay_class')!(
        {
          venueId: 'v1',
          classSessionId: 'c1',
          payCountOverride: 9,
          reason: 'Eran nueve',
          idempotencyKey: 'ajuste-c1',
          confirm: true,
          expectedSourceFingerprint: 'e'.repeat(64),
        },
        {},
      ),
    )
    expect(r).toMatchObject({ ok: true, sinCambios: true })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
})

describe('pago al personal con ventas por MCP (spec fase 3 §12)', () => {
  it('el preview del cierre nombra clases, comisiones y propinas, las anulaciones y las propinas sin persona', async () => {
    mockPreview.mockResolvedValue({
      clases: 72,
      comisiones: 41,
      propinas: 230,
      reversos: 1,
      personas: 9,
      total: '36620.00',
      huella: 'h'.repeat(64),
      puedeCerrar: true,
      bloqueos: [],
      huerfanas: 0,
      propinasSinDueno: { n: 3, total: '240.00' },
    })
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-09-15' }, {}))
    expect(r).toMatchObject({ requiresConfirmation: true })
    expect(r.message).toMatch(/72 clases, 41 comisiones y 230 propinas de 9 personas, \$36,620\.00/)
    expect(r.message).toMatch(/1 anulación/)
    expect(r.message).toMatch(/3 propina\(s\) sin persona \(\$240\.00\) no entran al recibo/)
  })

  it('el preview avisa de los cobros o devoluciones con comisión por revisar (resolución 16), sin bloquear', async () => {
    mockPreview.mockResolvedValue({
      clases: 2,
      comisiones: 0,
      propinas: 0,
      reversos: 0,
      personas: 1,
      total: '200.00',
      huella: 'h'.repeat(64),
      puedeCerrar: true,
      bloqueos: [],
      huerfanas: 0,
      propinasSinDueno: { n: 0, total: '0.00' },
      comisionesPorRevisar: 2,
    })
    const r = parse(await handlers.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-09-15' }, {}))
    expect(r).toMatchObject({ requiresConfirmation: true })
    expect(r.message).toMatch(/^Se congelan 2 clases de 1 personas/)
    expect(r.message).toMatch(/2 cobro\(s\) o devolución\(es\) con comisión por revisar/)
  })

  it('config incluye si está activado, desde cuándo y las ventanas de propinas', async () => {
    mockEstado.mockResolvedValue({ activado: true, startDate: '2026-10-01', propinasEncendidas: true })
    mockVentanas.mockResolvedValue([{ desde: '2026-10-03T18:00:00.000Z', hasta: null }])
    const r = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(r.activacion).toEqual({
      activado: true,
      startDate: '2026-10-01',
      propinasEncendidas: true,
      ventanasDePropinas: [{ desde: '2026-10-03T18:00:00.000Z', hasta: null }],
      ventanasTruncadas: false,
      timezone: 'America/Mexico_City',
    })
    expect(mockEstado).toHaveBeenCalledWith(expect.anything(), 'o1')
    // Pide una de más para saber si hay más de las que devuelve.
    expect(mockVentanas).toHaveBeenCalledWith('o1', 21)
  })

  it('config: con más ventanas de propinas de las que caben, devuelve las 20 más nuevas y avisa que hay más', async () => {
    mockVentanas.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({ desde: `2026-09-${String(i + 1).padStart(2, '0')}T18:00:00.000Z`, hasta: null })),
    )
    const r = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(r.activacion.ventanasDePropinas).toHaveLength(20)
    expect(r.activacion.ventanasTruncadas).toBe(true)
  })

  it('el desglose de un periodo ABIERTO con vista «recibo» devuelve el recibo en vivo (con comisiones y propinas)', async () => {
    mockPeriodoDeFecha.mockResolvedValue({ id: 'p9', status: 'OPEN' })
    mockRecibo.mockResolvedValue({
      persona: 'Carla',
      renglones: [],
      total: '170.00',
      cantidad: 4,
      siguiente: null,
      totalesPorTipo: { PROPINA: '80.00' },
    })
    const r = parse(
      await handlers.get('staff_service_pay_detail')!({ venueId: 'v1', staffId: 'c', fecha: '2026-08-15', vista: 'recibo' }, {}),
    )
    expect(r).toMatchObject({ cerrado: false, recibo: { total: '170.00', totalesPorTipo: { PROPINA: '80.00' } } })
    expect(mockDetalle).not.toHaveBeenCalled()
    // Sin `vista`, el periodo abierto sigue dando el desglose clase por clase.
    mockDetalle.mockResolvedValue({ items: [], nextCursor: null })
    parse(await handlers.get('staff_service_pay_detail')!({ venueId: 'v1', staffId: 'c', fecha: '2026-08-15' }, {}))
    expect(mockDetalle).toHaveBeenCalledTimes(1)
    expect(mockRecibo).toHaveBeenCalledTimes(1)
  })

  describe('configure_service_pay', () => {
    const conf = (args: Record<string, unknown>) => handlers.get('configure_service_pay')!({ venueId: 'v1', ...args }, {})

    it('activar: la vista previa dice actual → nuevo y no escribe; confirmar activa y audita una vez', async () => {
      const p = parse(await conf({ accion: 'activar', periodicidad: 'SEMIMONTHLY' }))
      expect(p).toMatchObject({
        ok: false,
        requiresConfirmation: true,
        actual: { activado: false, periodicidad: 'MONTHLY', periodicidadFija: false },
        nuevo: { activado: true, periodicidad: 'SEMIMONTHLY', startDate: '2026-10-01' },
        // La fecha que se muestra viaja firmada en el token (Codex bloque B #3).
        expectedSourceFingerprint: '2026-10-01',
      })
      expect(mockPlan).toHaveBeenCalledWith({ venueId: 'v1', periodicidad: 'SEMIMONTHLY' })
      expect(mockTodas).toHaveBeenCalledWith('s1', 'o1', 'staffpay:close')
      expect(p.message).toMatch(/quincenal/)
      expect(p.message).toMatch(/Desde el 2026-10-01/)
      expect(p.message).toMatch(/agrégalo como ajuste/)
      expect(mockActivar).not.toHaveBeenCalled()
      expect(auditMcpWrite).not.toHaveBeenCalled()
      mockActivar.mockResolvedValue({ startDate: '2026-10-01', yaActivado: false })
      const r = parse(
        await conf({ accion: 'activar', periodicidad: 'SEMIMONTHLY', expectedSourceFingerprint: '2026-10-01', confirm: true }),
      )
      expect(r).toMatchObject({ ok: true, startDate: '2026-10-01' })
      expect(mockActivar).toHaveBeenCalledWith({
        userId: 's1',
        venueId: 'v1',
        periodicidad: 'SEMIMONTHLY',
        inicioEsperado: '2026-10-01',
      })
      expect(auditMcpWrite).toHaveBeenCalledTimes(1)
      expect(auditMcpWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'SERVICE_PAY_ACTIVATED', entityId: 'o1' }),
      )
      expect(mockRequireWrite).toHaveBeenCalledWith(expect.anything(), 'staffpay:close', expect.any(String))
    })

    it('si otra persona activó entre la vista previa y el confirmar (yaActivado), no se audita de nuevo', async () => {
      mockActivar.mockResolvedValue({ startDate: '2026-09-01', yaActivado: true })
      expect(
        parse(await conf({ accion: 'activar', periodicidad: 'MONTHLY', expectedSourceFingerprint: '2026-10-01', confirm: true })),
      ).toMatchObject({ ok: true, yaActivado: true })
      expect(auditMcpWrite).not.toHaveBeenCalled()
    })

    it('activar sin periodicidad la pide; ya activado no ofrece confirmar', async () => {
      expect(parse(await conf({ accion: 'activar' }))).toMatchObject({ ok: false, needsInput: true, field: 'periodicidad' })
      mockEstado.mockResolvedValue({ activado: true, startDate: '2026-09-01', propinasEncendidas: false })
      const r = parse(await conf({ accion: 'activar', periodicidad: 'MONTHLY' }))
      expect(r).toMatchObject({ ok: false, sinCambios: true })
      expect(r.requiresConfirmation).toBeUndefined()
    })

    it('propinas: apagadas → encendidas; confirmar llama al service y audita; repetir el estado actual no ofrece confirmar', async () => {
      mockEstado.mockResolvedValue({ activado: true, startDate: '2026-09-01', propinasEncendidas: false })
      expect(parse(await conf({ accion: 'propinas' }))).toMatchObject({ needsInput: true, field: 'encender' })
      const p = parse(await conf({ accion: 'propinas', encender: true }))
      expect(p).toMatchObject({ requiresConfirmation: true })
      expect(p.message).toMatch(/apagadas → encendidas/)
      expect(mockPropinas).not.toHaveBeenCalled()
      expect(mockTodas).toHaveBeenCalledWith('s1', 'o1', 'staffpay:close')
      mockPropinas.mockResolvedValue({ encendidas: true, cambio: true })
      expect(parse(await conf({ accion: 'propinas', encender: true, confirm: true }))).toMatchObject({ ok: true, encendidas: true })
      expect(mockPropinas).toHaveBeenCalledWith({ userId: 's1', venueId: 'v1', encender: true })
      expect(auditMcpWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'SERVICE_PAY_TIPS_SET' }))
      expect(parse(await conf({ accion: 'propinas', encender: false }))).toMatchObject({ sinCambios: true })
    })

    it('sin activar no se prenden las propinas; sin staffpay:close no hay ni vista previa', async () => {
      expect(parse(await conf({ accion: 'propinas', encender: true }))).toMatchObject({
        ok: false,
        error: expect.stringMatching(/Activa primero/),
      })
      mockHasPermission.mockReturnValue(false)
      expect(parse(await conf({ accion: 'activar', periodicidad: 'MONTHLY' }))).toMatchObject({
        ok: false,
        error: expect.stringMatching(/staffpay:close/),
      })
      expect(mockEstado).toHaveBeenCalledTimes(1)
    })

    it('una sede fuera del alcance de la conexión se rechaza antes de leer o escribir nada', async () => {
      await expect(conf({ venueId: 'foreign', accion: 'activar', periodicidad: 'MONTHLY', confirm: true })).rejects.toThrow('out of scope')
      expect(mockEstado).not.toHaveBeenCalled()
      expect(mockActivar).not.toHaveBeenCalled()
      expect(auditMcpWrite).not.toHaveBeenCalled()
    })

    it('un rechazo del service (falta el permiso en otra sede) es una respuesta, no un 500, y no audita', async () => {
      mockActivar.mockRejectedValue(
        Object.assign(new Error('Esta acción afecta a toda la organización: necesitas staffpay:close en todas las sedes'), {
          statusCode: 403,
        }),
      )
      const r = parse(await conf({ accion: 'activar', periodicidad: 'MONTHLY', expectedSourceFingerprint: '2026-10-01', confirm: true }))
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/todas las sedes/) })
      expect(auditMcpWrite).not.toHaveBeenCalled()
    })

    it('con periodos guardados la periodicidad es fija: otra no se ofrece (daría 409); la misma, sí, y lo dice', async () => {
      mockPlan.mockResolvedValue({ periodicidad: 'MONTHLY', periodicidadFija: true, startDate: '2026-10-01' })
      const otra = parse(await conf({ accion: 'activar', periodicidad: 'SEMIMONTHLY' }))
      expect(otra).toMatchObject({ ok: false, code: 'PERIODICIDAD_FIJA', actual: { periodicidad: 'MONTHLY', periodicidadFija: true } })
      expect(otra.requiresConfirmation).toBeUndefined()
      expect(otra.error).toMatch(/mensual/)
      const misma = parse(await conf({ accion: 'activar', periodicidad: 'MONTHLY' }))
      expect(misma).toMatchObject({ requiresConfirmation: true, actual: { periodicidadFija: true }, nuevo: { startDate: '2026-10-01' } })
      expect(misma.message).toMatch(/ya no cambia/)
      expect(mockActivar).not.toHaveBeenCalled()
    })

    it('sin staffpay:close en OTRA sede, la vista previa ya lo rechaza (activar y propinas), antes de que el humano confirme', async () => {
      const sinPermiso = Object.assign(
        new Error('Esta acción afecta a toda la organización: necesitas staffpay:close en todas las sedes'),
        {
          statusCode: 403,
        },
      )
      mockTodas.mockRejectedValue(sinPermiso)
      const a = parse(await conf({ accion: 'activar', periodicidad: 'MONTHLY' }))
      expect(a).toMatchObject({ ok: false, error: expect.stringMatching(/todas las sedes/) })
      expect(a.requiresConfirmation).toBeUndefined()
      expect(mockPlan).not.toHaveBeenCalled()
      mockEstado.mockResolvedValue({ activado: true, startDate: '2026-09-01', propinasEncendidas: false })
      const p = parse(await conf({ accion: 'propinas', encender: true }))
      expect(p).toMatchObject({ ok: false, error: expect.stringMatching(/todas las sedes/) })
      expect(p.requiresConfirmation).toBeUndefined()
      expect(mockTodas).toHaveBeenCalledTimes(2)
      expect(mockActivar).not.toHaveBeenCalled()
      expect(mockPropinas).not.toHaveBeenCalled()
    })

    it('propinas: si el service no cambió nada (otra persona ya lo hizo), no se audita', async () => {
      mockEstado.mockResolvedValue({ activado: true, startDate: '2026-09-01', propinasEncendidas: false })
      mockPropinas.mockResolvedValue({ encendidas: true, cambio: false })
      expect(parse(await conf({ accion: 'propinas', encender: true, confirm: true }))).toMatchObject({ ok: true, cambio: false })
      expect(auditMcpWrite).not.toHaveBeenCalled()
    })

    it('sin mcp:write el motivo dice que configura el pago al personal, no que registra pagos', async () => {
      mockRequireWrite.mockImplementationOnce((_s: unknown, _p: string, motivo: string) => {
        throw new Error(`ScopeError: ${motivo}`)
      })
      await expect(conf({ accion: 'activar', periodicidad: 'MONTHLY' })).rejects.toThrow(/configura el pago al personal/)
      expect(mockEstado).not.toHaveBeenCalled()
    })

    it('por el catálogo real: confirm:true sin el token de la vista previa no escribe; con él, sí', async () => {
      const server = new McpServer({ name: 'staffpay', version: '1' })
      const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
      configureToolCatalog(server, s)
      registerStaffPayTools(server, s)
      const client = new Client({ name: 'staffpay-test', version: '1' })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(a), client.connect(b)])
      try {
        const call = async (args: Record<string, unknown>) =>
          JSON.parse(
            ((await client.callTool({ name: 'configure_service_pay', arguments: args })).content as Array<{ text: string }>)[0].text,
          )
        mockActivar.mockResolvedValue({ startDate: '2026-10-01', yaActivado: false })
        expect(await call({ venueId: 'v1', accion: 'activar', periodicidad: 'MONTHLY', confirm: true })).toMatchObject({
          needsInput: true,
          field: 'confirmationToken',
        })
        expect(mockActivar).not.toHaveBeenCalled()
        const p = await call({ venueId: 'v1', accion: 'activar', periodicidad: 'MONTHLY' })
        expect(p).toMatchObject({
          requiresConfirmation: true,
          confirmationArguments: { venueId: 'v1', accion: 'activar', periodicidad: 'MONTHLY' },
        })
        // El token es de ESTA periodicidad: con otra no sirve.
        const otra = await call({
          ...p.confirmationArguments,
          periodicidad: 'SEMIMONTHLY',
          confirm: true,
          confirmationToken: p.confirmationToken,
        })
        expect(otra).toMatchObject({ needsInput: true, field: 'confirmationToken' })
        expect(mockActivar).not.toHaveBeenCalled()
        expect(await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({
          ok: true,
        })
        expect(mockActivar).toHaveBeenCalledTimes(1)
      } finally {
        await client.close()
        await server.close()
      }
    })

    it('confirmar activar sin la fecha de la vista previa la pide y no escribe', async () => {
      expect(parse(await conf({ accion: 'activar', periodicidad: 'MONTHLY', confirm: true }))).toMatchObject({
        ok: false,
        needsInput: true,
        field: 'expectedSourceFingerprint',
      })
      expect(mockActivar).not.toHaveBeenCalled()
    })

    it('🔴 vista previa el 30-sep a las 23:59 (inicio 1-sep) y confirmación el 1-oct a las 00:01: no escribe y pide otra vista previa (Codex bloque B #3)', async () => {
      const server = new McpServer({ name: 'staffpay', version: '1' })
      const s = { ...scope, scopes: ['mcp:read', 'mcp:write'] } as unknown as McpScope
      configureToolCatalog(server, s)
      registerStaffPayTools(server, s)
      const client = new Client({ name: 'staffpay-test', version: '1' })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(a), client.connect(b)])
      try {
        const call = async (args: Record<string, unknown>) =>
          JSON.parse(
            ((await client.callTool({ name: 'configure_service_pay', arguments: args })).content as Array<{ text: string }>)[0].text,
          )
        mockPlan.mockResolvedValue({ periodicidad: 'MONTHLY', periodicidadFija: false, startDate: '2026-09-01' }) // 23:59
        const p = await call({ venueId: 'v1', accion: 'activar', periodicidad: 'MONTHLY' })
        expect(p.confirmationArguments).toMatchObject({ expectedSourceFingerprint: '2026-09-01' })
        // La fecha va firmada: confirmar con otra no sirve.
        expect(
          await call({
            ...p.confirmationArguments,
            expectedSourceFingerprint: '2026-10-01',
            confirm: true,
            confirmationToken: p.confirmationToken,
          }),
        ).toMatchObject({ needsInput: true, field: 'confirmationToken' })
        expect(mockActivar).not.toHaveBeenCalled()
        // 00:01: el service ya calcularía el 1-oct y rechaza bajo su candado.
        mockActivar.mockImplementation(async ({ inicioEsperado }: { inicioEsperado?: string }) => {
          if (inicioEsperado !== '2026-10-01') throw new ConflictError('La fecha de inicio cambió; vuelve a revisar.', 'INICIO_CAMBIO')
          return { startDate: '2026-10-01', yaActivado: false }
        })
        const r = await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
        expect(r).toMatchObject({ ok: false, code: 'INICIO_CAMBIO', error: expect.stringMatching(/vista previa nueva/) })
        expect(mockActivar).toHaveBeenCalledWith(expect.objectContaining({ inicioEsperado: '2026-09-01' }))
        expect(auditMcpWrite).not.toHaveBeenCalled()
      } finally {
        await client.close()
        await server.close()
      }
    })
  })
})
