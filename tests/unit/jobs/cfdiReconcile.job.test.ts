import { Prisma } from '@prisma/client'
import prisma from '../../../src/utils/prismaClient'
import { CfdiReconcileJob, PRESUPUESTO_REPARACION_MS, PRESUPUESTO_TIMBRES_ATORADOS_MS } from '../../../src/jobs/cfdiReconcile.job'
import { completarArchivos, repararArchivosCompartido, repararArchivosDe } from '../../../src/services/fiscal/finalizadorCfdi'
import { reconcileStuckCfdi } from '../../../src/services/fiscal/cfdiReconcile.service'
jest.mock('../../../src/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))
jest.mock('../../../src/services/fiscal/cfdi.service', () => ({ tocaRevisarCancelaciones: () => false }))
jest.mock('../../../src/services/fiscal/cfdiReconcile.service', () => ({ reconcileStuckCfdi: jest.fn() }))
// C2 · T5: el barrido delega cada fila en la reparación (la misma que usa la espera de una nota); la selección es la real. OF-2 (T7 N4,
// cambio A PROPÓSITO): la COMPARTIDA (`repararArchivosCompartido`), no `repararArchivosDe` directo.
jest.mock('../../../src/services/fiscal/finalizadorCfdi', () => ({
  completarArchivos: jest.fn(),
  repararArchivosDe: jest.fn(),
  repararArchivosCompartido: jest.fn(),
  dondeFaltanArchivos: jest.requireActual('../../../src/services/fiscal/finalizadorCfdi').dondeFaltanArchivos,
  conLimiteDeTiempo: jest.requireActual('../../../src/services/fiscal/finalizadorCfdi').conLimiteDeTiempo,
}))
jest.mock('../../../src/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: () => ({ name: 'fake' }) }))
// C3 · T2 (Codex C3-23): la pasada que repone el `CFDI_EXTRACCION_EMITIDA` perdido llama al ÚNICO escritor del evento; aquí, un doble.
jest.mock('../../../src/services/fiscal/cfdiExtraccion.service', () => ({ registrarExtraccionEmitida: jest.fn() }))
import { registrarExtraccionEmitida } from '../../../src/services/fiscal/cfdiExtraccion.service'
describe('barrido de archivos CFDI', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // C3 · T2 (M2 del pre-flight): la pasada de eventos de extracción lee con `$queryRaw`; sin filas por omisión.
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])
  })
  it('corre sin STAMPING; selección acotada, orden estable y fallo aislado', async () => {
    const rows = ['a', 'b'].map(id => ({
      id,
      idempotencyKey: id,
      uuid: id,
      facturapiId: id,
      attempts: 1,
      venue: { slug: 'demo' },
      fiscalEmisor: {},
    }))
    ;(prisma.cfdi.findMany as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce(rows)
    ;(repararArchivosCompartido as jest.Mock).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('OK')
    const before = Date.now()
    await new CfdiReconcileJob().runNow()
    expect(prisma.cfdi.findMany).toHaveBeenCalledTimes(2)
    const query = (prisma.cfdi.findMany as jest.Mock).mock.calls[1][0]
    expect(query).toMatchObject({
      where: {
        status: 'STAMPED',
        // C2 · T5: también las filas sin `xmlConceptos`.
        // C2 · T5 ronda 1 (M6): también las que quedaron sin PDF.
        // OF-1 (M4), cambio A PROPÓSITO: «sin `xmlConceptos`» ya cubre a las de sin desglose o sin URL del XML.
        OR: [{ xmlConceptos: { equals: Prisma.DbNull } }, { pdfUrl: null }],
      },
      take: 20,
      orderBy: [{ stampedAt: 'asc' }, { id: 'asc' }],
    })
    expect(query.where.stampedAt.lt.getTime()).toBeGreaterThanOrEqual(before - 10 * 60_000)
    expect(query.where.stampedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 10 * 60_000)
    expect(repararArchivosCompartido).toHaveBeenCalledTimes(2)
    expect(repararArchivosCompartido).toHaveBeenLastCalledWith('b', { sandbox: true, esperaMs: expect.any(Number) })
    expect(completarArchivos).not.toHaveBeenCalled() // los parámetros los arma la reparación, con la fila fresca
  })
  it('selecciona también STAMP_FAILED inciertas con versión y sellos intactos', async () => {
    ;(prisma.cfdi.findMany as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await new CfdiReconcileJob().runNow()
    expect((prisma.cfdi.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({
      where: {
        OR: [{ status: 'STAMPING' }, { status: 'STAMP_FAILED', protocoloIva: 1, falloDefinitivo: false, enviadoAt: { not: null } }],
      },
      select: { attempts: true, protocoloIva: true, falloDefinitivo: true, enviadoAt: true },
    })
    expect(reconcileStuckCfdi).not.toHaveBeenCalled()
  })
  it('avanza ambas páginas después de fallos y vuelve al inicio al agotarlas', async () => {
    const date = new Date(Date.now() - 20 * 60_000)
    const row = (id: string) => ({
      id,
      updatedAt: date,
      stampedAt: date,
      idempotencyKey: id,
      uuid: id,
      facturapiId: id,
      attempts: 1,
      venue: { slug: 'demo' },
      fiscalEmisor: {},
    })
    ;(prisma.cfdi.findMany as jest.Mock)
      .mockResolvedValueOnce([row('a')])
      .mockResolvedValueOnce([row('a')])
      .mockResolvedValueOnce([row('b')])
      .mockResolvedValueOnce([row('b')])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row('a')])
      .mockResolvedValueOnce([row('a')])
    ;(reconcileStuckCfdi as jest.Mock).mockRejectedValueOnce(new Error('PAC offline')).mockResolvedValue({ outcome: 'INCONCLUSIVE' })
    ;(repararArchivosCompartido as jest.Mock).mockResolvedValue('FALLO')
    const job = new CfdiReconcileJob()
    for (let i = 0; i < 4; i++) await job.runNow()
    const queries = (prisma.cfdi.findMany as jest.Mock).mock.calls.map(([query]) => query)
    expect(queries[2].where.AND).toEqual([{ OR: [{ updatedAt: { gt: date } }, { updatedAt: date, id: { gt: 'a' } }] }])
    expect(queries[3].where.AND).toEqual([{ OR: [{ stampedAt: { gt: date } }, { stampedAt: date, id: { gt: 'a' } }] }])
    expect(queries[6].where.AND).toBeUndefined()
    expect(queries[7].where.AND).toBeUndefined()
    expect((repararArchivosCompartido as jest.Mock).mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a'])
  })

  // C2 · T5 ronda 1 (I1): una reparación colgada (el PAC o el almacenamiento no contestan) no cuelga la pasada. La pasada deja de tomar
  // filas al agotar su presupuesto, libera `isRunning` y la siguiente corre completa (STAMPING atorados y reparación incluidos). El
  // cursor queda en la última fila INTENTADA: la que se colgó no se reintenta en la pasada siguiente, la que no se alcanzó sí.
  it('🔴 I1: una reparación que nunca contesta ⇒ la pasada se corta por presupuesto y la siguiente sí corre', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z') })
    try {
      const date = new Date('2026-10-09T10:00:00Z')
      const fila = (id: string) => ({ id, stampedAt: date })
      ;(prisma.cfdi.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // pasada 1: STAMPING atorados
        .mockResolvedValueOnce([fila('a'), fila('b')]) // pasada 1: archivos
        .mockResolvedValueOnce([]) // pasada 2: STAMPING atorados
        .mockResolvedValueOnce([]) // pasada 2: archivos
      ;(repararArchivosCompartido as jest.Mock).mockImplementation(() => new Promise(() => {}))
      const job = new CfdiReconcileJob()
      let terminada = false
      void job.runNow().then(() => (terminada = true))
      await jest.advanceTimersByTimeAsync(PRESUPUESTO_REPARACION_MS - 1)
      expect(terminada).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      expect(terminada).toBe(true)
      expect((repararArchivosCompartido as jest.Mock).mock.calls.map(([id]) => id)).toEqual(['a'])
      await job.runNow()
      expect(prisma.cfdi.findMany).toHaveBeenCalledTimes(4) // la pasada 2 no salió con «tick skipped»
      const queries = (prisma.cfdi.findMany as jest.Mock).mock.calls.map(([query]) => query)
      expect(queries[3].where.AND).toEqual([{ OR: [{ stampedAt: { gt: date } }, { stampedAt: date, id: { gt: 'a' } }] }])
    } finally {
      jest.useRealTimers()
    }
  })
  // OF-1 (T5 N6): `reconcileStuckCfdi` consulta al PAC con el SDK, sin tiempo límite. Una consulta colgada ya no detiene la pasada: los
  // atorados tienen su presupuesto, la reparación de archivos corre igual, y el cursor queda en la última fila INTENTADA.
  it('🔴 OF-1: un timbre atorado cuya consulta nunca contesta ⇒ la pasada corta los atorados por presupuesto, repara archivos y la siguiente corre', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z') })
    try {
      const date = new Date('2026-10-09T10:00:00Z')
      const atorada = (id: string) => ({ id, updatedAt: date, status: 'STAMPING' })
      ;(prisma.cfdi.findMany as jest.Mock)
        .mockResolvedValueOnce([atorada('a'), atorada('b')]) // pasada 1: STAMPING atorados
        .mockResolvedValueOnce([]) // pasada 1: archivos
        .mockResolvedValueOnce([]) // pasada 2: STAMPING atorados
        .mockResolvedValueOnce([]) // pasada 2: archivos
      ;(reconcileStuckCfdi as jest.Mock).mockImplementation(() => new Promise(() => {}))
      const job = new CfdiReconcileJob()
      let terminada = false
      void job.runNow().then(() => (terminada = true))
      await jest.advanceTimersByTimeAsync(PRESUPUESTO_TIMBRES_ATORADOS_MS - 1)
      expect(terminada).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      expect(terminada).toBe(true)
      expect((reconcileStuckCfdi as jest.Mock).mock.calls.map(([p]) => p.cfdi.id)).toEqual(['a'])
      expect(prisma.cfdi.findMany).toHaveBeenCalledTimes(2) // la reparación de archivos corrió en la misma pasada
      await job.runNow()
      expect(prisma.cfdi.findMany).toHaveBeenCalledTimes(4) // la pasada 2 no salió con «tick skipped»
      const queries = (prisma.cfdi.findMany as jest.Mock).mock.calls.map(([query]) => query)
      expect(queries[2].where.AND).toEqual([{ OR: [{ updatedAt: { gt: date } }, { updatedAt: date, id: { gt: 'a' } }] }])
    } finally {
      jest.useRealTimers()
      ;(reconcileStuckCfdi as jest.Mock).mockReset()
    }
  })

  // C2 · OF-2 (T7 N4, `task-7-rereview-1.md`): el barrido usaba `repararArchivosDe` directo, sin la memoria ni el vuelo compartidos: lo que el
  // PAC ya no entrega (`XML_NO_DISPONIBLE`, no se persiste) se volvía a bajar en cada vuelta del cursor, y una vista y el barrido podían bajar
  // la misma factura a la vez. Ahora usa la MISMA reparación compartida que las vistas (una en vuelo por factura; lo permanente se recuerda).
  it('🔴 T7 N4: cada fila va por la reparación COMPARTIDA, esperando a lo más lo que queda del presupuesto', async () => {
    const date = new Date(Date.now() - 20 * 60_000)
    ;(prisma.cfdi.findMany as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'a', stampedAt: date },
      { id: 'b', stampedAt: date },
    ])
    ;(repararArchivosCompartido as jest.Mock).mockResolvedValue('XML_NO_DISPONIBLE')
    await new CfdiReconcileJob().runNow()
    expect(repararArchivosDe).not.toHaveBeenCalled()
    expect((repararArchivosCompartido as jest.Mock).mock.calls.map(([id, o]) => [id, o.sandbox])).toEqual([
      ['a', true],
      ['b', true],
    ])
    for (const [, o] of (repararArchivosCompartido as jest.Mock).mock.calls) {
      expect(o.esperaMs).toBeGreaterThan(0)
      expect(o.esperaMs).toBeLessThanOrEqual(PRESUPUESTO_REPARACION_MS)
      expect(o).not.toHaveProperty('insistir') // el barrido respeta lo recordado
    }
  })

  // C3 · T2 (Codex C3-23, v7/v8): si el proceso cae entre el timbre de una extracción y su evento y nadie vuelve a llamar, la fila no entra en
  // ninguna otra selección del job. Esta pasada la encuentra (timbrada o ya CANCELADA, con su `uuid`, hace más de 10 min, sin evento) y lo
  // escribe sin actor; acotada a 50, con cursor por id, y una fila que falla no detiene a las demás.
  it('🔴 C3-23: la pasada de eventos de extracción — selección acotada y cortada a 10 min, cursor por id, sin actor y fallo aislado', async () => {
    const filas = Array.from({ length: 50 }, (_, i) => ({ id: `e${String(i).padStart(2, '0')}` }))
    ;(prisma.cfdi.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce(filas).mockResolvedValueOnce([])
    ;(prisma.cfdi.findUniqueOrThrow as jest.Mock).mockImplementation(async ({ where }: any) => ({ id: where.id, completa: true }))
    ;(registrarExtraccionEmitida as jest.Mock).mockRejectedValueOnce(new Error('una que falla'))
    const before = Date.now()
    const job = new CfdiReconcileJob()
    await job.runNow()
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    const [sql, ...valores] = (prisma.$queryRaw as jest.Mock).mock.calls[0]
    const texto = (sql as string[]).join('?')
    expect(texto).toMatch(/c\.status IN \('STAMPED', 'CANCELLED'\)/)
    expect(texto).toMatch(/c\.uuid IS NOT NULL/)
    expect(texto).toMatch(/starts_with\(c\."idempotencyKey", \?\)/)
    expect(texto).toMatch(
      /NOT EXISTS \(SELECT 1 FROM "ActivityLog" a WHERE a\.action = 'CFDI_EXTRACCION_EMITIDA' AND a\."entityId" = c\.id\)/,
    )
    expect(texto).toMatch(/ORDER BY c\.id\s+LIMIT \?/)
    // C3 · T4 (pendiente 1 de la T2): el corte mira también `updatedAt`: el job no le gana al usuario que acaba de recuperar o finalizar.
    expect(texto).toMatch(/GREATEST\(c\."stampedAt", c\."updatedAt"\) < \?/)
    // El corte viaja como `utcTs(cutoff)` (un fragmento con la fecha y `AT TIME ZONE 'UTC'`), nunca como un `Date` suelto.
    const fragmento = valores.find((v: any) => v?.strings?.join('?').includes("AT TIME ZONE 'UTC'")) as any
    const corte = fragmento?.values?.[0] as Date
    expect(corte.getTime()).toBeLessThanOrEqual(Date.now() - 10 * 60_000)
    expect(corte.getTime()).toBeGreaterThanOrEqual(before - 10 * 60_000)
    expect(valores).toContain('cfdi-extraccion-')
    expect(valores).toContain(50)
    expect((registrarExtraccionEmitida as jest.Mock).mock.calls.map(([c, actor]) => [c.id, actor])).toEqual(filas.map(f => [f.id, null]))
    expect((registrarExtraccionEmitida as jest.Mock).mock.calls[0][0]).toMatchObject({ completa: true }) // la fila entera, releída
    await job.runNow() // la página estaba llena: la siguiente pasada sigue después de la última
    expect((prisma.$queryRaw as jest.Mock).mock.calls[1]).toContain('e49')
  })
})
