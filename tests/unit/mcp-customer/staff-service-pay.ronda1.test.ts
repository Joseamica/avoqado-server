// tests/unit/mcp-customer/staff-service-pay.ronda1.test.ts — fase 3, B13 ronda 1 (menores del revisor): la configuración no se
// cae por la pantalla de sedes (R1), los montos negativos se dicen con su signo y el formato del MCP vive en UN módulo (R3), una
// conexión de sólo lectura no ofrece activar ni desactivar (R5) y el aviso de pendientes sólo acompaña a un ajuste negativo (R6).
// Los servicios van simulados (sus reglas se prueban en integración).
import { readFileSync } from 'fs'
import { join } from 'path'
import { ConflictError } from '@/errors/AppError'
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import type { McpScope } from '../../../src/mcp/scope'

const mockPreview = jest.fn()
const mockPreviewAjuste = jest.fn()
const mockEstadoSedes = jest.fn()
const mockVista = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => ({ venueId: { in: [v ?? 'v1'] } }),
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
jest.mock('@/services/dashboard/staffPay/sedes.service', () => ({ estadoSedes: (...a: unknown[]) => mockEstadoSedes(...a) }))
jest.mock('@/services/dashboard/staffPay/participacion', () => ({ activarSede: jest.fn(), desactivarSede: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/participacion.vistaPrevia', () => ({
  vistaPreviaParticipacion: (...a: unknown[]) => mockVista(...a),
}))
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

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const herramientas = (scopes: string[]) => {
  const h = new Map<string, Handler>()
  const scope = {
    staffId: 's1',
    activeOrg: 'o1',
    scopes,
    allowedVenueIds: ['v1'],
    perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
  } as unknown as McpScope
  registerStaffPayTools({ tool: (...a: unknown[]) => h.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  return h
}
const escribe = herramientas(['mcp:read', 'mcp:write'])
const soloLee = herramientas(['mcp:read'])
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
beforeEach(() => jest.clearAllMocks())

const monto = (n: number, total: string) => ({ n, total })
const cuenta = (o: { clases?: [number, string]; comisiones?: [number, string]; propinas?: [number, string] } = {}) => ({
  clases: { ...monto(...(o.clases ?? [0, '0.00'])), pendientesDeValoracion: 0 },
  comisiones: monto(...(o.comisiones ?? [0, '0.00'])),
  propinas: monto(...(o.propinas ?? [0, '0.00'])),
})
const SEDE = {
  venueId: 'v1',
  nombre: 'PN',
  zona: 'America/Mexico_City',
  tienePlan: true,
  estado: 'SIN_ACTIVAR',
  desde: null,
  hasta: null,
  minimo: '2026-10-01',
  puedeActivar: true,
  puedeDesactivar: true,
  fueraEstePeriodo: cuenta(),
}

describe('R1: staff_service_pay_config no se cae por la pantalla de sedes', () => {
  it.each([
    ['DEMASIADAS_SEDES', 'Esta organización tiene más de 500 sedes: no se pueden mostrar todas; contacta a Avoqado.'],
    [
      'STAFF_PAY_DEMASIADAS_VENTANAS',
      'Esta organización tiene demasiadas fechas de activación de sedes para leerlas; pide ayuda a Avoqado.',
    ],
    ['LECTURA_VENCIDA', 'La consulta tardó demasiado y se canceló; intenta de nuevo en un momento'],
  ])('%s ⇒ responde igual, con sedes: null y el motivo en palabras', async (code, mensaje) => {
    mockEstadoSedes.mockRejectedValue(new ConflictError(mensaje, code))
    const r = parse(await escribe.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(r).toMatchObject({ sedes: null, periodoDeLasSedes: null, niveles: [], tablas: [] })
    expect(r.ok).toBeUndefined()
    expect(r.sedesMotivo).toBe(`No se pudo leer el estado de las sedes: ${mensaje}`)
  })

  it('cualquier otro error SÍ se propaga (no se disfraza de «sin sedes»)', async () => {
    mockEstadoSedes.mockRejectedValue(Object.assign(new Error('se cayó la base'), { code: 'P1001' }))
    await expect(escribe.get('staff_service_pay_config')!({ venueId: 'v1' }, {})).rejects.toThrow('se cayó la base')
  })
})

describe('R5: una conexión de sólo lectura no ofrece activar ni desactivar', () => {
  it('con mcp:write, tal cual el service; con sólo mcp:read, puedeActivar y puedeDesactivar en false (lo demás igual)', async () => {
    mockEstadoSedes.mockResolvedValue({ activado: true, startDate: '2026-09-01', periodo: null, sedes: [SEDE] })
    expect(parse(await escribe.get('staff_service_pay_config')!({ venueId: 'v1' }, {})).sedes).toEqual([SEDE])
    expect(parse(await soloLee.get('staff_service_pay_config')!({ venueId: 'v1' }, {})).sedes).toEqual([
      { ...SEDE, puedeActivar: false, puedeDesactivar: false },
    ])
  })
})

describe('R6: el aviso de pendientes sólo acompaña a un ajuste NEGATIVO', () => {
  const aviso = {
    n: 1,
    total: '-50.00',
    porDestino: [
      { seDescuenta: { tipo: 'AL_CERRAR', periodo: { start: '2026-10-01', end: '2026-10-31' } }, n: 1, total: '-50.00', porSede: [] },
    ],
    items: [],
    truncado: false,
  }
  const pedir = (amount: number) => {
    mockPreviewAjuste.mockResolvedValue({
      periodo: { start: '2026-10-01', end: '2026-10-31', estado: 'OPEN' },
      staffId: 'p1',
      persona: 'Ana López',
      sede: 'v1',
      sedeNombre: 'PN',
      amount: String(amount),
      reason: 'Motivo',
      huella: 'a'.repeat(64),
      avisoPendientes: aviso,
    })
    return escribe.get('add_service_pay_adjustment')!(
      { venueId: 'v1', staffId: 'p1', amount, reason: 'Motivo', idempotencyKey: 'clave-1234' },
      {},
    )
  }

  it('un bono (positivo) no lleva la frase; el dato sí va en la vista previa', async () => {
    const r = parse(await pedir(100))
    expect(r.message).not.toMatch(/devoluciones|no lo registres/)
    expect(r.preview.avisoPendientes).toMatchObject({ n: 1, total: '-50.00' })
  })

  it('un descuento (negativo) sí la lleva', async () => {
    expect(parse(await pedir(-50)).message).toContain('Ana López tiene −$50.00 en devoluciones que se descontarán solas')
  })
})

describe('R3: los montos negativos se dicen con su signo, y el formato vive en UN módulo', () => {
  it('por sede del cierre: una comisión neta negativa sale «(−$40.00)», nunca «($-40.00)»', async () => {
    mockPreview.mockResolvedValue({
      periodo: { id: null, start: '2026-10-01', end: '2026-10-31', venueIds: ['v1'] },
      puedeCerrar: true,
      bloqueos: [],
      clases: 0,
      comisiones: 1,
      propinas: 0,
      reversos: 0,
      personas: 1,
      total: '-40.00',
      huella: 'h'.repeat(64),
      huerfanas: 0,
      propinasSinDueno: { n: 0, total: '0.00' },
      comisionesPorRevisar: 0,
      porSede: [
        {
          venueId: 'v1',
          nombre: 'PN',
          estado: 'ACTIVA',
          entra: cuenta({ comisiones: [1, '-40.00'] }),
          fuera: cuenta({ propinas: [2, '-10.00'] }),
          pendientes: monto(0, '0.00'),
        },
      ],
      pendientes: { n: 0, total: '0.00', porDestino: [] },
    })
    const r = parse(await escribe.get('close_service_pay_period')!({ venueId: 'v1', fecha: '2026-10-15' }, {}))
    expect(r.message).toContain('PN (activa): entran 1 comisión(es) (−$40.00); quedan fuera 2 propina(s) (−$10.00)')
    expect(r.message).toMatch(/1 personas, −\$40\.00\./)
    expect(r.message).not.toMatch(/\$-/)
  })

  it('la vista previa de desactivar una sede: lo que deja de entrar en negativo, con su signo', async () => {
    mockVista.mockResolvedValue({
      accion: 'desactivar',
      fecha: '2026-10-15',
      minimo: '2026-09-30',
      maximo: '2026-10-20',
      zona: 'America/Mexico_City',
      dejanDeEntrar: cuenta({ comisiones: [1, '-40.00'] }),
      permanecen: cuenta({ comisiones: [1, '100.00'] }),
    })
    const r = parse(await escribe.get('configure_service_pay')!({ venueId: 'v1', accion: 'sede', activa: false, fecha: '2026-10-15' }, {}))
    expect(r.message).toContain(
      'Dejan de entrar, de los periodos sin cerrar: 0 clase(s) ($0.00), 1 comisión(es) (−$40.00) y 0 propina(s) ($0.00)',
    )
    expect(r.message).not.toMatch(/\$-/)
  })

  it('staffPay.ts, staffPay.participacion.ts y staffPay.sedes.ts importan el formato y no definen el suyo', () => {
    for (const f of ['staffPay.ts', 'staffPay.participacion.ts', 'staffPay.sedes.ts']) {
      const src = readFileSync(join(__dirname, '../../../src/mcp/tools', f), 'utf8')
      expect(src).toMatch(/from '\.\/staffPay\.formato'/)
      // Un formateador es una función (`const pesos = (s…`); `const dia = f ?? hoy…` es un dato, no cuenta.
      expect(src).not.toMatch(/const (pesos|lista|diaUTC|diaLegible|periodoLegible|conSigno|dia) = \(/)
    }
  })
})
