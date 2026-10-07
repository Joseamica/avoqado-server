// tests/unit/mcp-customer/staff-service-pay.fueraDeLaConexion.test.ts — fase 3, B14-fix2 (decisión del founder, 7-oct): una
// conexión MCP limitada a A, en una organización con A y B. Cerrar el periodo y marcar pagados recibos ENTEROS abarcan a toda la
// organización: NO se niegan al DUEÑO —su vista previa lo AVISA al inicio del mensaje, trae `sedesFueraDeLaConexion` y la
// confirmación queda atada a esa lista; al confirmar se revalida todo (rol y sedes fuera)—; quien NO es dueño recibe
// FUERA_DE_LA_CONEXION, sin un dato ni un monto de esas sedes, y nada se escribe. Con TODAS las sedes en la conexión, igual que
// antes. Ronda 1: I1 (lo que el cierre trae DESPUÉS de validar la conexión: un rechazo con su vista previa nueva o un «ya
// cerrado») y M1 (activar, propinas, hermanos y catálogo, en `…fueraDeLaConexion.activar.test.ts`; lo común, en `…fixtures.ts`).
import * as mockF from './staff-service-pay.fueraDeLaConexion.fixtures'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
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

const { llamar, sinDatosDeB, HUELLA, B_FUERA, VISTA, CIERRE, PAGADO } = mockF
const {
  preview: mockPreview,
  cerrar: mockCerrar,
  marcar: mockMarcar,
  sedesDelCierre: mockSedesDelCierre,
  sedesDelPagado: mockSedesDelPagado,
  esDueno: mockEsDueno,
  auditMcpWrite,
} = mockF.mocks
const herramientas = (allowedVenueIds: string[]) => {
  const h = new Map<string, Handler>()
  registerStaffPayTools(
    { tool: (...a: unknown[]) => h.set(a[0] as string, a[a.length - 1] as never) } as never,
    mockF.conexion(allowedVenueIds),
  )
  return h
}
const soloA = herramientas(['A'])
const todas = herramientas(['A', 'B'])

beforeEach(mockF.prepararMocks)

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

describe('ronda 1 (I1): lo que el cierre trae DESPUÉS de validar la conexión', () => {
  // Al confirmar, la conexión se validó con sólo A (`sedesDelCierre` ⇒ ['A']: nada fuera, ni se pregunta el rol). Entre esa
  // validación y la transacción, B entra al alcance (p. ej. un `activarSede` en B retiene el candado de periodos) o alguien más
  // cierra el periodo con B: lo que el service devuelve ya trae B.
  const confirmar = (h = soloA) => llamar(h, 'close_service_pay_period', { ...CIERRE, expectedSourceFingerprint: HUELLA, confirm: true })
  const huellaCambio = () =>
    new ConflictError('Los números cambiaron desde que los revisaste: revisa el cierre de nuevo', 'HUELLA_CAMBIO', {
      preview: structuredClone(VISTA),
    })
  const yaCerrado = { periodId: 'p10', start: '2026-10-01', end: '2026-10-31', venueIds: ['A', 'B'], personas: 2, total: '130.00' }
  beforeEach(() => mockSedesDelCierre.mockResolvedValue(['A']))

  it('HUELLA_CAMBIO con B en la vista previa nueva, a quien no es dueño: la negativa, sin 130.00 ni B', async () => {
    mockEsDueno.mockResolvedValue(false)
    mockCerrar.mockRejectedValue(huellaCambio())
    sinDatosDeB(await confirmar())
    expect(mockCerrar).toHaveBeenCalledTimes(1)
    // Las sedes del rechazo son las de SU vista previa (A y B), no las validadas antes (sólo A).
    expect(mockEsDueno).toHaveBeenCalledWith(expect.objectContaining({ staffId: 's1' }), ['A', 'B'])
  })

  it('al dueño: el mismo rechazo con el aviso al inicio y sedesFueraDeLaConexion; la vista previa, acotada como siempre', async () => {
    mockCerrar.mockRejectedValue(huellaCambio())
    const r = await confirmar()
    expect(r).toMatchObject({ ok: false, code: 'HUELLA_CAMBIO', sedesFueraDeLaConexion: B_FUERA })
    expect(r.error).toMatch(
      /^Ojo: esta conexión es sólo de Prado Norte, pero el cierre de este periodo incluye también Bosques\. Si confirmas, se cierran todas\. Los números cambiaron desde que los revisaste/,
    )
    expect(r.preview.porSede.map((s: { venueId: string }) => s.venueId)).toEqual(['A'])
    expect(r).not.toHaveProperty('requiresConfirmation')
  })

  it('un rechazo SIN vista previa (clases con excepción, en curso…): se revisan las sedes del cierre de AHORA', async () => {
    mockSedesDelCierre.mockResolvedValueOnce(['A']).mockResolvedValueOnce(['A', 'B'])
    mockEsDueno.mockResolvedValue(false)
    mockCerrar.mockRejectedValue(
      new BadRequestError('Quedan 3 clase(s) que no se pueden pagar todavía: resuélvelas antes de cerrar', 'HAY_EXCEPCIONES'),
    )
    sinDatosDeB(await confirmar())
    expect(mockSedesDelCierre).toHaveBeenNthCalledWith(2, 'A', '2026-10-15')
  })

  it('sin sedes fuera (conexión con todas): el rechazo de siempre, sin aviso ni lista y sin preguntar el rol', async () => {
    mockSedesDelCierre.mockResolvedValue(['A', 'B'])
    mockCerrar.mockRejectedValue(huellaCambio())
    expect(await confirmar(todas)).toEqual({
      ok: false,
      error: 'Los números cambiaron desde que los revisaste: revisa el cierre de nuevo',
      code: 'HUELLA_CAMBIO',
      preview: VISTA,
    })
    expect(mockEsDueno).not.toHaveBeenCalled()
  })

  it('un error interno (500) se propaga sin volver a leer nada', async () => {
    mockCerrar.mockRejectedValue(new Error('se cayó la base'))
    await expect(confirmar()).rejects.toThrow('se cayó la base')
    expect(mockSedesDelCierre).toHaveBeenCalledTimes(1)
  })

  it('«ya cerrado» por otra persona con B, a quien no es dueño: la negativa, sin el total ni B', async () => {
    mockEsDueno.mockResolvedValue(false)
    mockCerrar.mockResolvedValue({ ...yaCerrado, huella: HUELLA, yaCerrado: true })
    sinDatosDeB(await confirmar())
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('«ya cerrado» al dueño: el resultado con sedesFueraDeLaConexion; con todas las sedes, igual que antes', async () => {
    mockCerrar.mockResolvedValue({ ...yaCerrado, huella: HUELLA, yaCerrado: true })
    expect(await confirmar()).toEqual({ ok: true, ...yaCerrado, huella: HUELLA, yaCerrado: true, sedesFueraDeLaConexion: B_FUERA })
    mockSedesDelCierre.mockResolvedValue(['A', 'B'])
    expect(await confirmar(todas)).toEqual({ ok: true, ...yaCerrado, huella: HUELLA, yaCerrado: true })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
})
