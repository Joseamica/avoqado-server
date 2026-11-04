import { pedirExporte, estadoExporte, descargarExporte, reintentarExporte } from '@/controllers/dashboard/exports.dashboard.controller'

jest.mock('@/services/exports/exportRun.service', () => ({ exportRunService: { pedir: jest.fn() } }))
jest.mock('@/jobs/export-runner.job', () => ({ exportRunnerJob: { despertar: jest.fn() } }))
jest.mock('@/services/privateStorage.service', () => ({ signPrivateAttachmentUrl: jest.fn(async () => 'https://firmada') }))
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminDeLaSesion: jest.fn(async () => false) }))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))
jest.mock('@/services/dashboard/salesSummaryPlanRange', () => ({
  ...jest.requireActual('@/services/dashboard/salesSummaryPlanRange'),
  rangoBloqueadoPorPlan: jest.fn(async () => false),
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  resolveRequestVenueId: (req: any) => req.params.venueId,
  resolveUserRoleForVenue: jest.fn(async () => ({ role: 'CASHIER', source: 'token' })),
}))

import prisma from '@/utils/prismaClient' // el prismaMock global (tests/__helpers__/setup.ts), con exportRun desde la tarea 1
import { exportRunService } from '@/services/exports/exportRun.service'
import { exportRunnerJob } from '@/jobs/export-runner.job'
import { signPrivateAttachmentUrl } from '@/services/privateStorage.service'
import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { cobros } from '@/services/exports/exportadores/cobros.exportador'
import { EXPORT_LIMITS } from '@/services/exports/exportPolicy'

function res() {
  const r: any = { statusCode: 200 }
  r.status = jest.fn((c: number) => {
    r.statusCode = c
    return r
  })
  r.json = jest.fn((b: any) => {
    r.body = b
    return r
  })
  r.setHeader = jest.fn()
  r.send = jest.fn()
  return r
}
const filtros = { startDate: '2026-10-01T06:00:00.000Z', endDate: '2026-11-01T05:59:59.999Z' }
const req = (o: any = {}) =>
  ({
    params: { venueId: 'v1', kind: 'ventas-detalladas', runId: 'run1', ...o.params },
    body: o.body ?? { format: 'xlsx', columns: ['paymentId'], filters: filtros },
    query: o.query ?? {},
    authContext: { userId: 's1', venueId: 'v1', role: 'CASHIER' },
  }) as any
const runFallido = {
  id: 'run1',
  venueId: 'v1',
  kind: 'cobros',
  status: 'FAILED',
  format: 'XLSX',
  columns: ['paymentId', 'amount'],
  params: { methods: ['CASH'], startDate: filtros.startDate },
  expiresAt: new Date(Date.now() + 3600_000),
}
const listo = {
  id: 'run1',
  venueId: 'v1',
  kind: 'ventas-detalladas',
  params: filtros,
  status: 'READY',
  filePath: 'private/x/v.csv',
  fileName: 'v.csv',
  expiresAt: new Date(Date.now() + 3600_000),
}

describe('exports.dashboard.controller', () => {
  beforeEach(() => jest.clearAllMocks())

  it('grande ⇒ 202 con runId y despierta al cocinero', async () => {
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({ tipo: 'encolado', runId: 'run1', formato: 'xlsx', reutilizado: false })
    const r = res()
    await pedirExporte(req(), r, jest.fn())
    expect(r.statusCode).toBe(202)
    expect(r.body.data).toEqual({ runId: 'run1', status: 'QUEUED', format: 'xlsx' })
    expect(exportRunnerJob.despertar).toHaveBeenCalled()
  })
  it('xlsx que no cabe ⇒ 202 avisando changedToFormat csv', async () => {
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({
      tipo: 'encolado',
      runId: 'run2',
      formato: 'csv',
      cambioAFormato: 'csv',
      reutilizado: false,
    })
    const r = res()
    await pedirExporte(req(), r, jest.fn())
    expect(r.body.data).toEqual({ runId: 'run2', status: 'QUEUED', format: 'csv', changedToFormat: 'csv' })
  })
  it('rechazo ⇒ 413 con el número', async () => {
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({ tipo: 'rechazo', filas: 250_000, maximo: 200_000 })
    const r = res()
    await pedirExporte(req(), r, jest.fn())
    expect(r.statusCode).toBe(413)
    expect(r.body.message).toMatch(/250,000/)
  })
  it('demasiados vivos ⇒ 429', async () => {
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({ tipo: 'demasiadosVivos' })
    const r = res()
    await pedirExporte(req(), r, jest.fn())
    expect(r.statusCode).toBe(429)
  })
  it('kind desconocido ⇒ 404', async () => {
    const next = jest.fn()
    await pedirExporte(req({ params: { kind: 'nope' } }), res(), next)
    expect(next.mock.calls[0][0]?.statusCode).toBe(404)
  })
  it('columnas: sólo las conocidas, en su orden y sin repetir, llegan a `pedir` (la huella no se ensucia)', async () => {
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({ tipo: 'encolado', runId: 'run4', formato: 'csv', reutilizado: false })
    const r = res()
    await pedirExporte(
      req({ body: { format: 'csv', columns: ['paymentId', 'basura', 'paymentId', 'x'.repeat(50)], filters: filtros } }),
      r,
      jest.fn(),
    )
    expect(r.statusCode).toBe(202)
    expect((exportRunService.pedir as jest.Mock).mock.calls[0][0].columnas).toEqual(['paymentId'])
  })
  it('formato pdf ⇒ 400', async () => {
    const next = jest.fn()
    await pedirExporte(req({ body: { format: 'pdf', columns: ['paymentId'], filters: filtros } }), res(), next)
    expect(next.mock.calls[0][0]?.statusCode).toBe(400)
  })
  it.each([
    ['ventas-detalladas', { startDate: 'no-es-fecha', endDate: filtros.endDate }],
    ['ventas-detalladas', { startDate: filtros.startDate, endDate: '2026-13-45' }],
    ['cobros', { startDate: 'ayer' }],
  ])('🔴 %s con una fecha inválida ⇒ 400 al pedir, no un pedido que truena en segundo plano', async (kind, filters) => {
    const next = jest.fn()
    await pedirExporte(req({ params: { kind }, body: { format: 'csv', columns: ['paymentId'], filters } }), res(), next)
    expect(next.mock.calls[0][0]?.statusCode).toBe(400)
    expect(exportRunService.pedir).not.toHaveBeenCalled()
  })
  it('sin TRANSACTION_EXPORT ⇒ 403 con el contrato de feature-gate de hoy y sin pedido', async () => {
    const { venueHasFeatureAccess } = jest.requireMock('@/services/access/basePlan.service')
    venueHasFeatureAccess.mockResolvedValueOnce(false)
    const r = res()
    await pedirExporte(req(), r, jest.fn())
    expect(r.statusCode).toBe(403)
    expect(r.body).toMatchObject({ featureCode: 'TRANSACTION_EXPORT', subscriptionRequired: true })
    expect(exportRunService.pedir).not.toHaveBeenCalled()
  })
  it('cobros: sin función de plan, pasa los filtros validados al servicio', async () => {
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({ tipo: 'encolado', runId: 'run3', formato: 'csv', reutilizado: false })
    const r = res()
    await pedirExporte(
      req({
        params: { kind: 'cobros' },
        body: { format: 'csv', columns: ['paymentId'], filters: { methods: 'CASH,CREDIT_CARD', search: ' 42 ' } },
      }),
      r,
      jest.fn(),
    )
    expect(r.statusCode).toBe(202)
    expect((exportRunService.pedir as jest.Mock).mock.calls[0][0]).toMatchObject({
      kind: 'cobros',
      formato: 'csv',
      filtros: { methods: ['CASH', 'CREDIT_CARD'], search: '42' },
    })
  })
  it('carril directo: arma aquí por páginas de TAMANO_PAGINA (nunca más grandes) y manda el archivo', async () => {
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({ tipo: 'directo', formato: 'csv', filas: 2 })
    const fila = (id: string) => ({ id, createdAt: new Date('2026-10-02T00:00:00.000Z') })
    const llena = Array.from({ length: EXPORT_LIMITS.TAMANO_PAGINA }, (_, i) => fila(`p${i}`))
    const pagina = jest
      .spyOn(cobros, 'pagina')
      .mockResolvedValueOnce(llena as any)
      .mockResolvedValueOnce([fila('ultimo')] as any)
    try {
      const r = res()
      await pedirExporte(req({ params: { kind: 'cobros' }, body: { format: 'csv', columns: ['paymentId'], filters: {} } }), r, jest.fn())
      expect(pagina).toHaveBeenCalledTimes(2)
      for (const llamada of pagina.mock.calls) expect(llamada[4]).toBe(EXPORT_LIMITS.TAMANO_PAGINA)
      expect(pagina.mock.calls[1][3]).toEqual({ createdAt: '2026-10-02T00:00:00.000Z', id: `p${EXPORT_LIMITS.TAMANO_PAGINA - 1}` })
      expect(r.send).toHaveBeenCalled()
      expect(exportRunnerJob.despertar).not.toHaveBeenCalled()
    } finally {
      pagina.mockRestore()
    }
  })
  it('un CASHIER sólo ve SUS pedidos (filtro por requestedById), con el rol resuelto para el negocio', async () => {
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue(null)
    const next = jest.fn()
    await estadoExporte(req(), res(), next)
    expect(next.mock.calls[0][0]?.statusCode).toBe(404)
    expect((prisma.exportRun.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({
      id: 'run1',
      venueId: 'v1',
      requestedById: 's1',
    })
    expect(resolveUserRoleForVenue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 's1', targetVenueId: 'v1', tokenVenueId: 'v1', tokenRole: 'CASHIER' }),
    )
  })
  it('un OWNER ve los de su negocio sin filtro por persona', async () => {
    ;(resolveUserRoleForVenue as jest.Mock).mockResolvedValueOnce({ role: 'OWNER', source: 'staffVenue' })
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue({
      id: 'run1',
      kind: 'cobros',
      status: 'RUNNING',
      processedRows: 500,
      totalRows: 4224,
      format: 'XLSX',
      cambioACsv: false,
      esperandoCobros: true,
    })
    const r = res()
    await estadoExporte(req(), r, jest.fn())
    expect((prisma.exportRun.findFirst as jest.Mock).mock.calls[0][0].where.requestedById).toEqual({ not: null })
    expect(r.body.data).toMatchObject({ status: 'RUNNING', processedRows: 500, totalRows: 4224, format: 'xlsx', waitingForPayments: true })
  })
  it('estado de un READY ya vencido ⇒ EXPIRED, aunque la limpieza no haya pasado (Codex r1 #8)', async () => {
    ;(resolveUserRoleForVenue as jest.Mock).mockResolvedValueOnce({ role: 'OWNER', source: 'staffVenue' })
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue({
      id: 'run1',
      kind: 'cobros',
      status: 'READY',
      processedRows: 10,
      totalRows: 10,
      format: 'CSV',
      cambioACsv: false,
      esperandoCobros: false,
      expiresAt: new Date(Date.now() - 1),
    })
    const r = res()
    await estadoExporte(req(), r, jest.fn())
    expect(r.body.data.status).toBe('EXPIRED')
  })
  it('🔴 tras borrar a quien pidió (SetNull), ni un OWNER descarga: la búsqueda exige dueño (Codex r2 R2)', async () => {
    ;(resolveUserRoleForVenue as jest.Mock).mockResolvedValueOnce({ role: 'OWNER', source: 'staffVenue' })
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue(null) // Postgres no la encuentra: requestedById es null
    const next = jest.fn()
    await descargarExporte(req(), res(), next)
    expect((prisma.exportRun.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({
      id: 'run1',
      venueId: 'v1',
      requestedById: { not: null },
    })
    expect(next.mock.calls[0][0]?.statusCode).toBe(404)
    expect(signPrivateAttachmentUrl).not.toHaveBeenCalled()
  })
  it('descarga READY vigente ⇒ liga firmada de 10 min (attachment) y su nombre', async () => {
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue({ ...listo, filePath: 'private/x/ventas.xlsx', fileName: 'ventas.xlsx' })
    const r = res()
    await descargarExporte(req(), r, jest.fn())
    expect(r.body.data).toEqual({ url: 'https://firmada', fileName: 'ventas.xlsx' })
    expect(signPrivateAttachmentUrl).toHaveBeenCalledWith('private/x/ventas.xlsx', listo.expiresAt)
  })
  it('🔴 el pedido vence MIENTRAS `autorizar` espera ⇒ 410 y sin firmar (Codex r5 B2)', async () => {
    const corto = { ...listo, filePath: 'private/x/ventas.xlsx', expiresAt: new Date(Date.now() + 50) }
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue(corto)
    const { venueHasFeatureAccess } = jest.requireMock('@/services/access/basePlan.service')
    venueHasFeatureAccess.mockImplementationOnce(() => new Promise(ok => setTimeout(() => ok(true), 100)))
    const r = res()
    await descargarExporte(req(), r, jest.fn())
    expect(r.statusCode).toBe(410)
    expect(signPrivateAttachmentUrl).not.toHaveBeenCalled()
  })
  it('🔴 descarga de un negocio que perdió TRANSACTION_EXPORT ⇒ 403 con el cuerpo del GET y sin firmar (Codex r1 #5)', async () => {
    const { venueHasFeatureAccess } = jest.requireMock('@/services/access/basePlan.service')
    venueHasFeatureAccess.mockResolvedValueOnce(false)
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue(listo)
    const r = res()
    await descargarExporte(req(), r, jest.fn())
    expect(r.statusCode).toBe(403)
    expect(r.body).toMatchObject({ featureCode: 'TRANSACTION_EXPORT', subscriptionRequired: true })
    expect(signPrivateAttachmentUrl).not.toHaveBeenCalled()
  })
  it('🔴 descarga de un negocio que bajó a Gratis (rango fuera de «hoy») ⇒ 403 PLAN_LIMIT_RANGE', async () => {
    const { rangoBloqueadoPorPlan } = jest.requireMock('@/services/dashboard/salesSummaryPlanRange')
    rangoBloqueadoPorPlan.mockResolvedValueOnce(true)
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue(listo)
    const r = res()
    await descargarExporte(req(), r, jest.fn())
    expect(r.statusCode).toBe(403)
    expect(r.body).toMatchObject({ code: 'PLAN_LIMIT_RANGE' })
    expect(signPrivateAttachmentUrl).not.toHaveBeenCalled()
  })
  it('descarga EXPIRED o READY ya vencido ⇒ 410', async () => {
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 'run1',
      status: 'EXPIRED',
      filePath: null,
      expiresAt: new Date(Date.now() - 1),
    })
    const a = res()
    await descargarExporte(req(), a, jest.fn())
    expect(a.statusCode).toBe(410)
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 'run1',
      status: 'READY',
      filePath: 'private/x',
      fileName: 'x.csv',
      expiresAt: new Date(Date.now() - 1),
    })
    const b = res()
    await descargarExporte(req(), b, jest.fn())
    expect(b.statusCode).toBe(410)
    expect(signPrivateAttachmentUrl).not.toHaveBeenCalled()
  })
  it('reintentar FAILED ⇒ 202 con los filtros, columnas y formato guardados, siempre en segundo plano', async () => {
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue(runFallido)
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({ tipo: 'encolado', runId: 'run9', formato: 'xlsx', reutilizado: false })
    const r = res()
    await reintentarExporte(req({ body: {} }), r, jest.fn())
    expect(r.statusCode).toBe(202)
    expect(r.body.data).toMatchObject({ runId: 'run9' })
    expect((exportRunService.pedir as jest.Mock).mock.calls[0][0]).toMatchObject({
      kind: 'cobros',
      formato: 'xlsx',
      columnas: ['paymentId', 'amount'],
      filtros: { methods: ['CASH'], startDate: filtros.startDate },
      forzarSegundoPlano: true,
    })
  })
  it('reintentar un READY ya vencido ⇒ 202 (Codex r1 #8)', async () => {
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue({ ...runFallido, status: 'READY', expiresAt: new Date(Date.now() - 1) })
    ;(exportRunService.pedir as jest.Mock).mockResolvedValue({ tipo: 'encolado', runId: 'run10', formato: 'xlsx', reutilizado: false })
    const r = res()
    await reintentarExporte(req({ body: {} }), r, jest.fn())
    expect(r.statusCode).toBe(202)
  })
  it('reintentar algo vigente que no falló ⇒ 409', async () => {
    ;(prisma.exportRun.findFirst as jest.Mock).mockResolvedValue({
      ...runFallido,
      status: 'READY',
      expiresAt: new Date(Date.now() + 3600_000),
    })
    const r = res()
    await reintentarExporte(req({ body: {} }), r, jest.fn())
    expect(r.statusCode).toBe(409)
    expect(exportRunService.pedir).not.toHaveBeenCalled()
  })
})
