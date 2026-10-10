// C2 · Tarea 2 (Codex C2-7): el job guarda el cursor que le devuelve el barrido de cancelaciones y lo pasa en la pasada siguiente
// (igual que `artifactCursor`). Sin esto, con más de 50 cancelaciones en trámite la 51 nunca se revisaba: el barrido tomaba siempre
// las 50 primeras.
import prisma from '../../../src/utils/prismaClient'
import { CfdiReconcileJob, PRESUPUESTO_REPARACION_MS, PRESUPUESTO_WEBHOOKS_MS } from '../../../src/jobs/cfdiReconcile.job'
import { asegurarWebhooksFaltantes } from '../../../src/services/fiscal/facturapiWebhook.service'
import { repararArchivosCompartido } from '../../../src/services/fiscal/finalizadorCfdi'

const mockSync = jest.fn()
const mockDonde = jest.fn((cutoff: Date, cursor: unknown) => ({ cutoff, cursor }))
const mockCierres = jest.fn((desde: Date, cursor: unknown) => ({ desde, cursor }))
const mockExterna = jest.fn()
jest.mock('../../../src/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))
jest.mock('../../../src/services/fiscal/cfdi.service', () => ({
  tocaRevisarCancelaciones: () => true,
  CANCEL_SYNC_MAX_PER_TICK: 50,
  syncPendingCancellations: (...a: any[]) => mockSync(...a),
  dondeBuscarCancelacionesPendientes: (cutoff: Date, cursor: unknown) => mockDonde(cutoff, cursor),
  dondeBuscarCierresRecientes: (desde: Date, cursor: unknown) => mockCierres(desde, cursor),
  refreshPendingCancellation: jest.fn(),
  sincronizarCancelacionExterna: (...a: any[]) => mockExterna(...a),
}))
jest.mock('../../../src/services/fiscal/cfdiReconcile.service', () => ({ reconcileStuckCfdi: jest.fn() }))
jest.mock('../../../src/services/fiscal/finalizadorCfdi', () => ({
  repararArchivosCompartido: jest.fn(), // OF-2 (T7 N4): el barrido usa la reparación compartida
  dondeFaltanArchivos: jest.requireActual('../../../src/services/fiscal/finalizadorCfdi').dondeFaltanArchivos,
  conLimiteDeTiempo: jest.requireActual('../../../src/services/fiscal/finalizadorCfdi').conLimiteDeTiempo,
}))
jest.mock('../../../src/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: () => ({ name: 'fake' }) }))
jest.mock('../../../src/services/fiscal/facturapiWebhook.service', () => ({
  asegurarWebhooksFaltantes: jest.fn(async () => ({ revisados: 0 })),
  defaultAsegurarFaltantesDeps: jest.fn(() => ({})),
}))

describe('C2-7 · el job lleva el cursor del barrido de cancelaciones', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.cfdi.findMany as jest.Mock).mockResolvedValue([])
  })

  it('🔴 la pasada 1 empieza sin cursor; la 2 recibe el que devolvió la 1; al vaciarse, vuelve al principio', async () => {
    const c1 = { requestedAt: new Date('2026-10-01T00:49:00Z'), id: 'c49' }
    mockSync
      .mockResolvedValueOnce({ revisadas: 50, resueltas: 0, siguenEnTramite: 50, errores: 0, cursor: c1 })
      .mockResolvedValueOnce({ revisadas: 1, resueltas: 0, siguenEnTramite: 1, errores: 0, cursor: null })
      .mockResolvedValueOnce({ revisadas: 0, resueltas: 0, siguenEnTramite: 0, errores: 0, cursor: null })
    const job = new CfdiReconcileJob()
    await job.runNow()
    await job.runNow()
    await job.runNow()
    expect(mockSync.mock.calls.map(c => c[0].cursor)).toEqual([null, c1, null])
  })

  it('la búsqueda del job usa el MISMO filtro con cursor que el servicio (orden y tope de hoy)', async () => {
    const c1 = { requestedAt: new Date('2026-10-01T00:49:00Z'), id: 'c49' }
    mockSync.mockImplementationOnce(async (_params: any, deps: any) => {
      await deps.findPending(new Date('2026-10-05T00:00:00Z'), c1)
      return { revisadas: 0, resueltas: 0, siguenEnTramite: 0, errores: 0, cursor: null }
    })
    await new CfdiReconcileJob().runNow()
    expect(mockDonde).toHaveBeenCalledWith(new Date('2026-10-05T00:00:00Z'), c1)
    expect((prisma.cfdi.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({
      where: { cutoff: new Date('2026-10-05T00:00:00Z'), cursor: c1 },
      orderBy: [{ cancelRequestedAt: 'asc' }, { id: 'asc' }],
      take: 50,
    })
  })

  // C2 ronda 2 (N1): el job también lleva el cursor de la fase de cierres recientes y re-consulta con la vía externa/tardía.
  it('🔴 N1: la fase de cierres recientes usa su filtro, su cursor y la vía externa (sólo consulta)', async () => {
    const c1 = { updatedAt: new Date('2026-10-04T10:00:00Z'), id: 'r9' }
    mockSync
      .mockImplementationOnce(async (_params: any, deps: any) => {
        await deps.findRecentlyClosed(new Date('2026-10-04T00:00:00Z'), null)
        await deps.recheckClosed({ id: 'r1' })
        return { revisadas: 0, resueltas: 0, siguenEnTramite: 0, errores: 0, cursor: null, cierresRevisados: 50, cursorCerradas: c1 }
      })
      .mockResolvedValueOnce({
        revisadas: 0,
        resueltas: 0,
        siguenEnTramite: 0,
        errores: 0,
        cursor: null,
        cierresRevisados: 0,
        cursorCerradas: null,
      })
    const job = new CfdiReconcileJob()
    await job.runNow()
    await job.runNow()
    expect(mockCierres).toHaveBeenCalledWith(new Date('2026-10-04T00:00:00Z'), null)
    expect((prisma.cfdi.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({
      where: { desde: new Date('2026-10-04T00:00:00Z'), cursor: null },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 50,
    })
    expect(mockExterna).toHaveBeenCalledWith({ id: 'r1' }, expect.objectContaining({ sandbox: expect.any(Boolean) }))
    expect(mockSync.mock.calls.map(c => c[0].cursorCerradas)).toEqual([null, c1])
  })

  // C2 · T5 ronda 1 (M1): los dos barridos leen hasta 50 + 50 filas completas cada hora; `xmlConceptos` de una global pesa ~1 MiB y
  // ninguno lo usa, así que no lo traen. Nada más se quita (siguen con `include: { fiscalEmisor: true }`).
  it('🔴 M1: los barridos de cancelación no traen `xmlConceptos` (y conservan su `include`)', async () => {
    mockSync.mockImplementationOnce(async (_params: any, deps: any) => {
      await deps.findPending(new Date('2026-10-05T00:00:00Z'), null)
      await deps.findRecentlyClosed(new Date('2026-10-04T00:00:00Z'), null)
      return { revisadas: 0, resueltas: 0, siguenEnTramite: 0, errores: 0, cursor: null }
    })
    await new CfdiReconcileJob().runNow()
    const [pendientes, cerradas] = (prisma.cfdi.findMany as jest.Mock).mock.calls.map(([q]) => q)
    for (const q of [pendientes, cerradas]) {
      expect(q.omit).toEqual({ xmlConceptos: true })
      expect(q.include).toEqual({ fiscalEmisor: true })
    }
  })

  // C2 · T5 ronda 1 (I1): con una reparación de archivos colgada, la pasada siguiente SÍ revisa cancelaciones (la red de seguridad de
  // los «en duda» de la T2); antes `isRunning` se quedaba en `true` y cada tick salía con «tick skipped».
  it('🔴 I1: una reparación colgada no detiene el barrido de cancelaciones de la pasada siguiente', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z') })
    try {
      mockSync.mockResolvedValue({ revisadas: 0, resueltas: 0, siguenEnTramite: 0, errores: 0, cursor: null })
      ;(prisma.cfdi.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // pasada 1: STAMPING atorados
        .mockResolvedValueOnce([{ id: 'a', stampedAt: new Date('2026-10-09T10:00:00Z') }]) // pasada 1: archivos
      ;(repararArchivosCompartido as jest.Mock).mockImplementation(() => new Promise(() => {}))
      const job = new CfdiReconcileJob()
      let terminada = false
      void job.runNow().then(() => (terminada = true))
      await jest.advanceTimersByTimeAsync(PRESUPUESTO_REPARACION_MS)
      expect(terminada).toBe(true)
      await job.runNow()
      expect(mockSync).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
      mockSync.mockReset()
    }
  })
  // OF-1: el alta de webhooks faltantes va por el SDK de Facturapi, sin tiempo límite; una colgada ya no detiene la pasada.
  it('🔴 OF-1: un alta de webhooks que nunca contesta ⇒ la pasada sigue al agotar su presupuesto (atorados y archivos corren)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z') })
    try {
      mockSync.mockResolvedValue({ revisadas: 0, resueltas: 0, siguenEnTramite: 0, errores: 0, cursor: null })
      ;(asegurarWebhooksFaltantes as jest.Mock).mockImplementationOnce(() => new Promise(() => {}))
      const job = new CfdiReconcileJob()
      let terminada = false
      void job.runNow().then(() => (terminada = true))
      await jest.advanceTimersByTimeAsync(PRESUPUESTO_WEBHOOKS_MS - 1)
      expect(terminada).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      expect(terminada).toBe(true)
      expect(prisma.cfdi.findMany).toHaveBeenCalledTimes(2) // STAMPING atorados y archivos
    } finally {
      jest.useRealTimers()
      mockSync.mockReset()
    }
  })
})
