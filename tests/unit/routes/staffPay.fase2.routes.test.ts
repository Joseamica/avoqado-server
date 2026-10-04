import * as schemas from '@/schemas/dashboard/staffPay.schema'

jest.mock('@/services/dashboard/staffPay/periodosGuardados', () => ({ listarPeriodos: jest.fn(), cambiarPeriodicidad: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/cierre.service', () => ({ previewCierre: jest.fn(), cerrarPeriodo: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/ajustesManuales.service', () => ({ agregarAjusteManual: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/recibos.service', () => ({
  marcarPagado: jest.fn(),
  previewPagado: jest.fn(),
  reciboDePersona: jest.fn(),
  exportarRecibo: jest.fn(),
}))
jest.mock('@/services/dashboard/export.helpers', () => ({ sendExport: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/diferencias.service', () => ({ diferenciasDelPeriodo: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/liquidacion.service', () => ({ previewLiquidacion: jest.fn(), liquidarDiferencia: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/ajustesClase.service', () => ({ guardarAjusteDeClase: jest.fn(), pagoDeClase: jest.fn() }))

import * as periodos from '@/services/dashboard/staffPay/periodosGuardados'
import * as cierre from '@/services/dashboard/staffPay/cierre.service'
import * as manuales from '@/services/dashboard/staffPay/ajustesManuales.service'
import * as recibos from '@/services/dashboard/staffPay/recibos.service'
import { sendExport } from '@/services/dashboard/export.helpers'
import * as dif from '@/services/dashboard/staffPay/diferencias.service'
import * as liq from '@/services/dashboard/staffPay/liquidacion.service'
import * as ajustesClase from '@/services/dashboard/staffPay/ajustesClase.service'
import * as controller from '@/controllers/dashboard/staffPay.dashboard.controller'
import router, { servicePayGateOrganizacion } from '@/routes/dashboard/staffPay.routes'

const CUID = 'ckxxxxxxxxxxxxxxxxxxxxxxx'

describe('Zod de la fase 2 (sólo forma, mensajes en español)', () => {
  it('cerrar exige fecha, huella y la confirmación booleana', () => {
    expect(
      schemas.cerrarPeriodoSchema.safeParse({ fecha: '2026-08-15', huellaEsperada: 'a'.repeat(64), confirmarHuerfanas: false }).success,
    ).toBe(true)
    const malo = schemas.cerrarPeriodoSchema.safeParse({ fecha: '15/08/2026', huellaEsperada: '' })
    expect(malo.success).toBe(false)
    if (!malo.success)
      expect(malo.error.errors.map(e => e.message)).toEqual(
        expect.arrayContaining(['Fecha inválida (AAAA-MM-DD)', 'Revisa el cierre antes de confirmarlo']),
      )
  })
  it('el ajuste manual rechaza cero, tres decimales y motivo corto', () => {
    const base = { sede: CUID, staffId: CUID, amount: 100, reason: 'Bono', clientKey: 'k'.repeat(16) }
    expect(schemas.ajusteManualSchema.safeParse(base).success).toBe(true)
    expect(schemas.ajusteManualSchema.safeParse({ ...base, amount: 0 }).success).toBe(false)
    expect(schemas.ajusteManualSchema.safeParse({ ...base, amount: 1.234 }).success).toBe(false)
    expect(schemas.ajusteManualSchema.safeParse({ ...base, reason: 'x' }).success).toBe(false)
  })
  it('exportar sólo acepta pdf o xlsx', () => {
    expect(schemas.exportReciboQuerySchema.safeParse({ fecha: '2026-08-15', format: 'csv' }).success).toBe(false)
    expect(schemas.exportReciboQuerySchema.safeParse({ fecha: '2026-08-15', format: 'pdf' }).success).toBe(true)
  })
  it('el recibo se pide por páginas: limit de 1 a 500, 100 por default (Codex R2-R1-20)', () => {
    expect(schemas.reciboQuerySchema.parse({ fecha: '2026-08-15' })).toMatchObject({ limit: 100 })
    expect(schemas.reciboQuerySchema.safeParse({ fecha: '2026-08-15', limit: '501' }).success).toBe(false)
    expect(schemas.reciboQuerySchema.safeParse({ fecha: '2026-08-15', cursor: '2026-08-04T14:00:00.000Z|ckx', limit: '50' }).success).toBe(
      true,
    )
  })
  it('el recibo acepta un filtro de sede opcional con forma de id (Codex bloque A #5)', () => {
    expect(schemas.reciboQuerySchema.safeParse({ fecha: '2026-08-15', sede: CUID }).success).toBe(true)
    const malo = schemas.reciboQuerySchema.safeParse({ fecha: '2026-08-15', sede: 'pn' })
    expect(malo.success).toBe(false)
    if (!malo.success) expect(malo.error.errors.map(e => e.message)).toEqual(['Sede inválida'])
    // La exportación queda igual: sin sede.
    expect(schemas.exportReciboQuerySchema.parse({ fecha: '2026-08-15', format: 'pdf', sede: CUID })).not.toHaveProperty('sede')
  })
  it('el preview de marcar pagado acepta staffId opcional (Codex bloque A #6)', () => {
    expect(schemas.pagadoPreviewQuerySchema.safeParse({}).success).toBe(true)
    expect(schemas.pagadoPreviewQuerySchema.safeParse({ staffId: CUID }).success).toBe(true)
    expect(schemas.pagadoPreviewQuerySchema.safeParse({ staffId: 'ana' }).success).toBe(false)
  })
  it('periodicidad, marcar pagado y lista de periodos: sólo forma', () => {
    expect(schemas.periodicidadSchema.safeParse({ periodicidad: 'WEEKLY' }).success).toBe(false)
    expect(schemas.periodicidadSchema.safeParse({ periodicidad: 'SEMIMONTHLY' }).success).toBe(true)
    expect(schemas.marcarPagadoSchema.safeParse({}).success).toBe(true)
    expect(schemas.marcarPagadoSchema.safeParse({ staffId: 'no-es-cuid' }).success).toBe(false)
    expect(schemas.marcarPagadoSchema.safeParse({ nota: 'x'.repeat(201) }).success).toBe(false)
    // huellaEsperada opcional, 64 hex como la de cerrar (Codex bloque A, duda 1).
    expect(schemas.marcarPagadoSchema.safeParse({ huellaEsperada: 'c'.repeat(64) }).success).toBe(true)
    const huellaMala = schemas.marcarPagadoSchema.safeParse({ huellaEsperada: 'x' })
    expect(huellaMala.success).toBe(false)
    if (!huellaMala.success) expect(huellaMala.error.errors.map(e => e.message)).toEqual(['Revisa la vista previa antes de confirmar'])
    expect(schemas.listaPeriodosQuerySchema.safeParse({ antesDe: '2026-08-01' }).success).toBe(true)
    expect(schemas.listaPeriodosQuerySchema.safeParse({ antesDe: 'ayer' }).success).toBe(false)
    expect(schemas.periodParamsSchema.safeParse({ venueId: CUID, periodId: CUID }).success).toBe(true)
    expect(schemas.periodParamsSchema.safeParse({ venueId: CUID, periodId: 'x' }).success).toBe(false)
  })
  it('liquidar exige origen, huella y una clave de solicitud', () => {
    const ok = { periodoOrigenId: 'ckxxxxxxxxxxxxxxxxxxxxxxx', huellaEsperada: 'a'.repeat(64), solicitudId: 's'.repeat(16) }
    expect(schemas.liquidarSchema.safeParse(ok).success).toBe(true)
    expect(schemas.liquidarSchema.safeParse({ ...ok, solicitudId: 'x' }).success).toBe(false)
    // «Sumar la sede y liquidar» (SEDE_FUERA_DEL_PERIODO) y una fecha del periodo destino.
    expect(schemas.liquidarSchema.safeParse({ ...ok, ampliarAlcance: true, destinoFecha: '2026-09-10' }).success).toBe(true)
    expect(schemas.liquidarSchema.safeParse({ ...ok, ampliarAlcance: 'si' }).success).toBe(false)
    // Sin `:` (la clave de cada línea es `${solicitudId}:${persona}`).
    expect(schemas.liquidarSchema.safeParse({ ...ok, solicitudId: 'clave:12345678' }).success).toBe(false)
    const malo = schemas.liquidarSchema.safeParse({ ...ok, huellaEsperada: 'x' })
    expect(malo.success).toBe(false)
    if (!malo.success) expect(malo.error.errors.map(e => e.message)).toEqual(['Revisa la diferencia antes de liquidarla'])
  })
  it('la lista de diferencias: limit de 1 a 100, 50 por default, convertido a número (minor de B1)', () => {
    expect(schemas.differencesQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(schemas.differencesQuerySchema.parse({ limit: '20', cursor: 'v:c:p' })).toEqual({ limit: 20, cursor: 'v:c:p' })
    expect(schemas.differencesQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
    expect(schemas.differencesQuerySchema.safeParse({ limit: 'Infinity' }).success).toBe(false)
    expect(schemas.destinoQuerySchema.safeParse({ destinoFecha: 'ayer' }).success).toBe(false)
    expect(schemas.destinoQuerySchema.safeParse({}).success).toBe(true)
  })
  it('cerrar sin confirmarHuerfanas la deja en false', () => {
    expect(schemas.cerrarPeriodoSchema.parse({ fecha: '2026-08-15', huellaEsperada: 'b'.repeat(64) })).toMatchObject({
      confirmarHuerfanas: false,
    })
  })
})

describe('Rutas de la fase 2: método, ruta y permiso', () => {
  const rutas: Array<{ method: string; path: string; permission: string }> = []
  for (const layer of (router as any).stack ?? []) {
    if (!layer.route) continue
    for (const l of layer.route.stack) {
      const permission = (l.handle as any)?.requiredPermission
      if (l.method && permission) rutas.push({ method: l.method, path: layer.route.path, permission })
    }
  }
  const permiso = (method: string, path: string) => rutas.find(r => r.method === method && r.path === path)?.permission

  it.each([
    ['get', '/periods', 'staffpay:read'],
    ['patch', '/periodicity', 'staffpay:close'],
    ['get', '/periods/close-preview', 'staffpay:read'],
    ['post', '/periods/close', 'staffpay:close'],
    ['post', '/periods/:periodId/paid', 'staffpay:close'],
    ['get', '/periods/:periodId/paid-preview', 'staffpay:read'],
    ['post', '/adjustments', 'staffpay:close'],
    ['get', '/staff/:staffId/receipt', 'staffpay:read'],
    ['get', '/staff/:staffId/receipt/export', 'staffpay:read'],
    ['get', '/periods/:periodId/differences', 'staffpay:read'],
    ['get', '/class-sessions/:sessionId/difference', 'staffpay:read'],
    ['post', '/class-sessions/:sessionId/difference/settle', 'staffpay:close'],
  ])('%s %s exige %s', (method, path, permission) => {
    expect(permiso(method, path)).toBe(permission)
  })

  it('las rutas están declaradas DESPUÉS del gate del módulo (nada sin servicePayGate)', () => {
    const stack: any[] = (router as any).stack
    const gate = stack.findIndex(l => !l.route && l.handle?.name === 'servicePayGate')
    const primera = stack.findIndex(l => l.route?.path === '/periods')
    expect(gate).toBeGreaterThan(-1)
    expect(primera).toBeGreaterThan(gate)
  })

  it('las dos rutas de UNA clase van ANTES del gate de la sede, con el de la organización; la lista del periodo, después (Codex R2-R1-1)', () => {
    const stack: any[] = (router as any).stack
    const gate = stack.findIndex(l => !l.route && l.handle?.name === 'servicePayGate')
    const ruta = (method: string, path: string) => stack.findIndex(l => l.route?.path === path && l.route.methods[method])
    for (const [method, path] of [
      ['get', '/class-sessions/:sessionId/difference'],
      ['post', '/class-sessions/:sessionId/difference/settle'],
    ]) {
      const i = ruta(method, path)
      expect({ path, antesDelGate: i > -1 && i < gate }).toEqual({ path, antesDelGate: true })
      expect(stack[i].route.stack[0].handle).toBe(servicePayGateOrganizacion)
    }
    expect(ruta('get', '/periods/:periodId/differences')).toBeGreaterThan(gate)
  })
})

describe('Controller de la fase 2', () => {
  const req = (extra: Record<string, unknown> = {}) =>
    ({ params: { venueId: 'v1' }, query: {}, body: {}, authContext: { userId: 'u1' }, ...extra }) as any
  const res = () => {
    const r: any = { json: jest.fn() }
    return r
  }
  beforeEach(() => jest.clearAllMocks())

  it('la lista de periodos pide páginas de 24', async () => {
    ;(periodos.listarPeriodos as jest.Mock).mockResolvedValue({ ok: 1 })
    const r = res()
    await controller.listPeriods(req({ query: { antesDe: '2026-08-01' } }), r, jest.fn())
    expect(periodos.listarPeriodos).toHaveBeenCalledWith({ venueId: 'v1', userId: 'u1', antesDe: '2026-08-01', limit: 24 })
    expect(r.json).toHaveBeenCalledWith({ ok: 1 })
  })

  it('cerrar pasa sólo fecha, huella y confirmación: ni ahora ni tamLote ni nada del body de más', async () => {
    ;(cierre.cerrarPeriodo as jest.Mock).mockResolvedValue({})
    await controller.postClose(
      req({ body: { fecha: '2026-08-15', huellaEsperada: 'a'.repeat(64), confirmarHuerfanas: true, ahora: '2020-01-01', tamLote: 1 } }),
      res(),
      jest.fn(),
    )
    expect((cierre.cerrarPeriodo as jest.Mock).mock.calls[0][0]).toEqual({
      venueId: 'v1',
      userId: 'u1',
      fecha: '2026-08-15',
      huellaEsperada: 'a'.repeat(64),
      confirmarHuerfanas: true,
    })
  })

  it('el recibo pasa el cursor tal cual y jamás los parámetros de pruebas', async () => {
    ;(recibos.reciboDePersona as jest.Mock).mockResolvedValue({})
    await controller.getReceipt(
      req({ params: { venueId: 'v1', staffId: 's1' }, query: { fecha: '2026-08-15', cursor: 'abc|def', limit: 50, trasPreparar: 'x' } }),
      res(),
      jest.fn(),
    )
    expect((recibos.reciboDePersona as jest.Mock).mock.calls[0][0]).toEqual({
      venueId: 'v1',
      userId: 'u1',
      staffId: 's1',
      fecha: '2026-08-15',
      cursor: 'abc|def',
      limit: 50,
    })
  })

  it('el recibo pasa el filtro de sede al service (Codex bloque A #5)', async () => {
    ;(recibos.reciboDePersona as jest.Mock).mockResolvedValue({})
    await controller.getReceipt(
      req({ params: { venueId: 'v1', staffId: 's1' }, query: { fecha: '2026-08-15', limit: 50, sede: CUID } }),
      res(),
      jest.fn(),
    )
    expect((recibos.reciboDePersona as jest.Mock).mock.calls[0][0]).toMatchObject({ staffId: 's1', fecha: '2026-08-15', sede: CUID })
  })

  it('el preview de marcar pagado lee el periodo de la ruta y el staffId opcional; responde lo del service (Codex bloque A #6)', async () => {
    const pv = {
      periodo: { start: '2026-08-01', end: '2026-08-31', estado: 'CLOSED' },
      cantidad: 2,
      total: '1030.00',
      recibos: [],
      huella: 'h',
    }
    ;(recibos.previewPagado as jest.Mock).mockResolvedValue(pv)
    const r = res()
    await controller.getPaidPreview(req({ params: { venueId: 'v1', periodId: 'p1' }, query: { staffId: 's1', ahora: 'x' } }), r, jest.fn())
    expect((recibos.previewPagado as jest.Mock).mock.calls[0][0]).toEqual({ venueId: 'v1', userId: 'u1', periodId: 'p1', staffId: 's1' })
    expect(r.json).toHaveBeenCalledWith(pv)
    await controller.getPaidPreview(req({ params: { venueId: 'v1', periodId: 'p1' } }), res(), jest.fn())
    expect((recibos.previewPagado as jest.Mock).mock.calls[1][0]).toEqual({ venueId: 'v1', userId: 'u1', periodId: 'p1' })
  })

  it('el ajuste manual pasa sólo los campos del Zod (sin huellaEsperada colada)', async () => {
    ;(manuales.agregarAjusteManual as jest.Mock).mockResolvedValue({})
    const body = {
      sede: CUID,
      staffId: CUID,
      amount: 100,
      reason: 'Bono',
      fecha: '2026-08-15',
      clientKey: 'k'.repeat(16),
      huellaEsperada: 'z',
    }
    await controller.postAdjustment(req({ body }), res(), jest.fn())
    const llamada = (manuales.agregarAjusteManual as jest.Mock).mock.calls[0][0]
    expect(llamada).not.toHaveProperty('huellaEsperada')
    expect(llamada).toMatchObject({
      venueId: 'v1',
      userId: 'u1',
      sede: CUID,
      staffId: CUID,
      amount: 100,
      reason: 'Bono',
      fecha: '2026-08-15',
    })
  })

  it('marcar pagado usa el periodo de la ruta y pasa la huella del preview; sin ella, igual que antes (Codex bloque A, duda 1)', async () => {
    ;(recibos.marcarPagado as jest.Mock).mockResolvedValue({})
    const huella = 'd'.repeat(64)
    await controller.postPaid(
      req({ params: { venueId: 'v1', periodId: 'p1' }, body: { staffId: 's1', nota: 'Transferencia', huellaEsperada: huella, extra: 1 } }),
      res(),
      jest.fn(),
    )
    expect((recibos.marcarPagado as jest.Mock).mock.calls[0][0]).toEqual({
      venueId: 'v1',
      userId: 'u1',
      periodId: 'p1',
      staffId: 's1',
      nota: 'Transferencia',
      huellaEsperada: huella,
    })
    await controller.postPaid(req({ params: { venueId: 'v1', periodId: 'p1' }, body: { nota: 'Transferencia' } }), res(), jest.fn())
    const sinHuella = (recibos.marcarPagado as jest.Mock).mock.calls[1][0]
    expect(sinHuella).toEqual({ venueId: 'v1', userId: 'u1', periodId: 'p1', nota: 'Transferencia' })
    expect(sinHuella).not.toHaveProperty('huellaEsperada')
  })

  it('los errores del service (con su code) pasan intactos a next', async () => {
    const e = Object.assign(new Error('Periodo cerrado'), { code: 'PERIODO_CERRADO' })
    ;(cierre.previewCierre as jest.Mock).mockRejectedValue(e)
    const next = jest.fn()
    await controller.getClosePreview(req({ query: { fecha: '2026-08-15' } }), res(), next)
    expect(next).toHaveBeenCalledWith(e)
  })

  it('la exportación manda el archivo con sendExport y los errores a next', async () => {
    const encoded = { buffer: Buffer.from('x') }
    ;(recibos.exportarRecibo as jest.Mock).mockResolvedValueOnce({ encoded, nombre: 'recibo-ana' })
    const r = res()
    await controller.getReceiptExport(
      req({ params: { venueId: 'v1', staffId: 's1' }, query: { fecha: '2026-08-15', format: 'pdf', tamLote: 1 } }),
      r,
      jest.fn(),
    )
    expect((recibos.exportarRecibo as jest.Mock).mock.calls[0][0]).toEqual({
      venueId: 'v1',
      userId: 'u1',
      staffId: 's1',
      fecha: '2026-08-15',
      format: 'pdf',
    })
    expect(sendExport).toHaveBeenCalledWith(r, encoded, 'recibo-ana')

    const e = Object.assign(new Error('x'), { code: 'RECIBO_CAMBIO' })
    ;(recibos.exportarRecibo as jest.Mock).mockRejectedValueOnce(e)
    const next = jest.fn()
    await controller.getReceiptExport(
      req({ params: { venueId: 'v1', staffId: 's1' }, query: { fecha: '2026-08-15', format: 'xlsx' } }),
      res(),
      next,
    )
    expect(next).toHaveBeenCalledWith(e)
  })

  it('la lista de diferencias pasa periodo, cursor y limit; jamás las opciones de prueba (ahora, tamLote, topeSinAncla)', async () => {
    ;(dif.diferenciasDelPeriodo as jest.Mock).mockResolvedValue({ items: [], nextCursor: null, parcial: false })
    const r = res()
    await controller.getDifferences(
      req({
        params: { venueId: 'v1', periodId: 'p8' },
        query: { cursor: 'v1:c1:a', limit: 20, ahora: '2020-01-01', tamLote: 1, topeSinAncla: 1 },
      }),
      r,
      jest.fn(),
    )
    // Un solo argumento: el segundo (`opts`) nunca sale de la petición.
    expect((dif.diferenciasDelPeriodo as jest.Mock).mock.calls[0]).toEqual([
      { venueId: 'v1', userId: 'u1', periodId: 'p8', cursor: 'v1:c1:a', limit: 20 },
    ])
    expect(r.json).toHaveBeenCalledWith({ items: [], nextCursor: null, parcial: false })
  })

  it('el preview de liquidar pasa la clase y la fecha destino, nada más', async () => {
    ;(liq.previewLiquidacion as jest.Mock).mockResolvedValue({ huella: 'h' })
    await controller.getClassDifference(
      req({ params: { venueId: 'v1', sessionId: 'c1' }, query: { destinoFecha: '2026-09-10', ahora: '2020-01-01' } }),
      res(),
      jest.fn(),
    )
    const llamada = (liq.previewLiquidacion as jest.Mock).mock.calls[0]
    expect(llamada).toEqual([{ venueId: 'v1', userId: 'u1', classSessionId: 'c1', destinoFecha: '2026-09-10' }])
    expect(llamada[0]).not.toHaveProperty('ahora')
  })

  it('liquidar arma la llamada campo por campo: ni ahora ni otro usuario o sede del body llegan al service', async () => {
    ;(liq.liquidarDiferencia as jest.Mock).mockResolvedValue({ lineas: [], yaLiquidada: true })
    const cuerpo = {
      periodoOrigenId: CUID,
      huellaEsperada: 'e'.repeat(64),
      solicitudId: 'solicitud-1234',
      destinoFecha: '2026-09-10',
      ampliarAlcance: true,
    }
    await controller.postSettleDifference(
      req({ params: { venueId: 'v1', sessionId: 'c1' }, body: { ...cuerpo, ahora: '2020-01-01', userId: 'otro', venueId: 'otra' } }),
      res(),
      jest.fn(),
    )
    const llamada = (liq.liquidarDiferencia as jest.Mock).mock.calls[0]
    expect(llamada).toEqual([{ venueId: 'v1', userId: 'u1', classSessionId: 'c1', ...cuerpo }])
    expect(llamada[0]).not.toHaveProperty('ahora')
  })

  it('un error de liquidar (con su code) pasa intacto a next', async () => {
    const e = Object.assign(new Error('Esa sede no está en el periodo destino'), { code: 'SEDE_FUERA_DEL_PERIODO' })
    ;(liq.liquidarDiferencia as jest.Mock).mockRejectedValue(e)
    const next = jest.fn()
    await controller.postSettleDifference(req({ params: { venueId: 'v1', sessionId: 'c1' }, body: {} }), res(), next)
    expect(next).toHaveBeenCalledWith(e)
  })

  it('periodicidad y preview llegan con sus datos', async () => {
    ;(periodos.cambiarPeriodicidad as jest.Mock).mockResolvedValue({})
    await controller.patchPeriodicity(req({ body: { periodicidad: 'SEMIMONTHLY' } }), res(), jest.fn())
    expect(periodos.cambiarPeriodicidad).toHaveBeenCalledWith({ venueId: 'v1', userId: 'u1', periodicidad: 'SEMIMONTHLY' })
    ;(cierre.previewCierre as jest.Mock).mockResolvedValue({})
    await controller.getClosePreview(req({ query: { fecha: '2026-08-15' } }), res(), jest.fn())
    expect((cierre.previewCierre as jest.Mock).mock.calls[0][0]).toEqual({ venueId: 'v1', userId: 'u1', fecha: '2026-08-15' })
  })
  it('«Ajustar monto» pasa la clave de la solicitud al service (full-testing C14) y nada más del body', async () => {
    ;(ajustesClase.guardarAjusteDeClase as jest.Mock).mockResolvedValue({ ok: 1 })
    const sinClave = { payCountOverride: 9, payAmountOverride: null, payExcluded: false, reason: 'Eran nueve' }
    const body = { ...sinClave, clientKey: 'ajuste-clase-1234' }
    await controller.putClassPayAdjustments(
      req({ params: { venueId: 'v1', sessionId: 'c1' }, body: { ...body, huellaEsperada: 'z' } }),
      res(),
      jest.fn(),
    )
    expect((ajustesClase.guardarAjusteDeClase as jest.Mock).mock.calls[0][0]).toEqual({
      venueId: 'v1',
      classSessionId: 'c1',
      ...body,
      actorId: 'u1',
    })
    // Sin clave, como siempre.
    await controller.putClassPayAdjustments(req({ params: { venueId: 'v1', sessionId: 'c1' }, body: sinClave }), res(), jest.fn())
    expect((ajustesClase.guardarAjusteDeClase as jest.Mock).mock.calls[1][0]).toEqual({
      venueId: 'v1',
      classSessionId: 'c1',
      ...sinClave,
      clientKey: undefined,
      actorId: 'u1',
    })
  })
})
