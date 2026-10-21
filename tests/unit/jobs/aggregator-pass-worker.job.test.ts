import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { AggregatorPassWorkerJob } from '@/jobs/aggregator-pass-worker.job'
import * as basePlan from '@/services/access/basePlan.service'
import * as sessionSync from '@/services/aggregators/core/sessionSync.service'

const cron = { start: jest.fn(), stop: jest.fn() }

/** Reloj fijo: cada llamada a `now()` devuelve una fecha nueva con el mismo instante. */
const fixed = (iso: string) => () => new Date(iso)

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    pendingEvents: jest.fn().mockResolvedValue([]),
    processEvent: jest.fn().mockResolvedValue(undefined),
    expireVisits: jest.fn().mockResolvedValue(0),
    requeueVisits: jest.fn().mockResolvedValue(0),
    publishHorizon: jest.fn().mockResolvedValue(0),
    claim: jest.fn().mockResolvedValue([]),
    runRow: jest.fn().mockResolvedValue(undefined),
    now: fixed('2030-01-01T00:11:00Z'),
    cron,
    ...overrides,
  } as any
}

describe('AggregatorPassWorkerJob', () => {
  // nuevo
  it('una vuelta: reintenta eventos, vence visitas, re-encola las registradas y procesa la bandeja de salida', async () => {
    const deps = baseDeps({
      pendingEvents: jest.fn().mockResolvedValue(['e1', 'e2']),
      claim: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'o1', claimToken: 't' }])
        .mockResolvedValue([]),
      now: fixed('2030-01-01T00:10:00Z'),
    })
    const job = new AggregatorPassWorkerJob(deps)
    await job.runOnce()
    expect(deps.processEvent).toHaveBeenCalledTimes(2)
    expect(deps.expireVisits).toHaveBeenCalled()
    expect(deps.requeueVisits).toHaveBeenCalled()
    expect(deps.expireVisits.mock.invocationCallOrder[0]).toBeLessThan(deps.requeueVisits.mock.invocationCallOrder[0])
    expect(deps.publishHorizon).toHaveBeenCalled() // minuto múltiplo de 10
    // R15: se reclama de UNA en una, cada fila con su propio lease.
    expect(deps.claim).toHaveBeenCalledWith(1, deps.now())
    expect(deps.runRow).toHaveBeenCalledWith('o1', 't', deps.now())
    expect(deps.claim).toHaveBeenCalledTimes(2) // la segunda no trajo nada: se detiene
  })

  // nuevo
  it('un evento que truena no detiene a los demás', async () => {
    const deps = baseDeps({
      pendingEvents: jest.fn().mockResolvedValue(['e1', 'e2']),
      processEvent: jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(undefined),
    })
    await new AggregatorPassWorkerJob(deps).runOnce()
    expect(deps.processEvent).toHaveBeenCalledTimes(2)
    expect(deps.publishHorizon).not.toHaveBeenCalled()
  })

  // nuevo
  it('el horizonte se publica una sola vez por minuto múltiplo de 10 (no en la segunda vuelta de ese minuto)', async () => {
    const deps = baseDeps({ now: fixed('2030-01-01T00:20:48Z') })
    await new AggregatorPassWorkerJob(deps).runOnce()
    expect(deps.publishHorizon).not.toHaveBeenCalled()
  })

  // nuevo
  it('con filas rápidas manda el presupuesto de tiempo, no un tope chico: drena hasta 500 filas por vuelta', async () => {
    // Revisión final I1: el horizonte encola ~112 SYNC_SESSION por estudio cada 10 min; con 25 por vuelta, una reserva
    // (plazo de 5 min) esperaba minutos. Las filas sin cambios tardan milisegundos: el freno real son los 60 s.
    let n = 0
    const deps = baseDeps({ claim: jest.fn(async () => [{ id: `o${++n}`, claimToken: 't' }]) })
    await new AggregatorPassWorkerJob(deps).runOnce()
    expect(deps.runRow).toHaveBeenCalledTimes(500)
    expect(deps.claim).toHaveBeenCalledTimes(500)
  })

  // nuevo
  it('deja de reclamar filas cuando la vuelta agotó sus 60 s, y cada fila usa su propio `now`', async () => {
    // Cada fila "tarda" 25 s: tras la tercera ya pasaron 75 s y no se reclama una cuarta.
    let t = Date.parse('2030-01-01T00:11:00Z')
    const now = jest.fn(() => new Date(t))
    const deps = baseDeps({
      now,
      claim: jest.fn(async () => [{ id: 'o', claimToken: 't' }]),
      runRow: jest.fn(async () => {
        t += 25_000
      }),
    })
    await new AggregatorPassWorkerJob(deps).runOnce()
    expect(deps.runRow).toHaveBeenCalledTimes(3)
    const rowTimes = deps.runRow.mock.calls.map((c: any[]) => (c[2] as Date).getTime())
    expect(new Set(rowTimes).size).toBe(3)
  })

  // nuevo
  it('una fila de salida que truena no detiene a las demás', async () => {
    const deps = baseDeps({
      claim: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'o1', claimToken: 't1' }])
        .mockResolvedValueOnce([{ id: 'o2', claimToken: 't2' }])
        .mockResolvedValue([]),
      runRow: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined),
    })
    await new AggregatorPassWorkerJob(deps).runOnce()
    expect(deps.runRow).toHaveBeenCalledTimes(2)
    expect(deps.runRow).toHaveBeenLastCalledWith('o2', 't2', expect.any(Date))
  })

  // nuevo
  it('una etapa que truena no impide las demás (eventos y visitas caídos, la bandeja de salida corre igual)', async () => {
    const deps = baseDeps({
      pendingEvents: jest.fn().mockRejectedValue(new Error('P1001')),
      expireVisits: jest.fn().mockRejectedValue(new Error('P1001')),
      claim: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'o1', claimToken: 't' }])
        .mockResolvedValue([]),
    })
    await new AggregatorPassWorkerJob(deps).runOnce()
    expect(deps.runRow).toHaveBeenCalledWith('o1', 't', expect.any(Date))
  })

  // nuevo
  it('no se encima: una vuelta en curso hace que la siguiente no haga nada', async () => {
    let release!: () => void
    const deps = baseDeps({
      pendingEvents: jest.fn(
        () =>
          new Promise<string[]>(resolve => {
            release = () => resolve([])
          }),
      ),
    })
    const job = new AggregatorPassWorkerJob(deps)
    const first = job.runOnce()
    await job.runOnce()
    expect(deps.pendingEvents).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  // nuevo
  it('start/stop delegan en el cron inyectado', () => {
    const job = new AggregatorPassWorkerJob(baseDeps())
    job.start()
    job.stop()
    expect(cron.start).toHaveBeenCalled()
    expect(cron.stop).toHaveBeenCalled()
  })
})

// nuevo — pausa suave (decisión del founder, 3-oct): sin el plan no se publican clases nuevas
describe('horizonte: sin el plan sólo se re-sincroniza lo ya publicado', () => {
  const NOW = new Date('2030-01-01T00:10:00Z')
  const UNTIL = new Date(NOW.getTime() + 14 * 24 * 3600_000)
  const PAUSED_LOG = (n: number) =>
    `[PASES] worker: ${n} conexiones sin plan: no se publican clases nuevas; sólo se actualiza lo ya publicado`
  /** El job con el horizonte REAL (no inyectado), en un minuto múltiplo de 10. */
  const jobWithRealHorizon = () => {
    const deps = baseDeps({ now: () => new Date(NOW) })
    delete deps.publishHorizon
    return new AggregatorPassWorkerJob(deps)
  }
  /** c1/v1 y c2/v2; las clases ligadas del horizonte son s1 y s2, y sólo s2 tiene ocurrencia viva a futuro. */
  const arrange = (entitled: string[]) => {
    prismaMock.aggregatorConnection.findMany.mockResolvedValueOnce([
      { id: 'c1', venueId: 'v1' },
      { id: 'c2', venueId: 'v2' },
    ])
    prismaMock.aggregatorProductLink.findMany.mockResolvedValue([{ productId: 'p1' }])
    prismaMock.classSession.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }])
    prismaMock.aggregatorSessionLink.findMany.mockResolvedValue([{ classSessionId: 's2' }])
    const access = jest.spyOn(basePlan, 'venuesWithFeatureAccess').mockResolvedValue(new Set(entitled))
    const enqueue = jest.spyOn(sessionSync, 'enqueuePassSessionSync').mockResolvedValue(undefined)
    return { access, enqueue }
  }
  afterEach(() => jest.restoreAllMocks())

  it('una con plan y otra sin ⇒ la de plan publica su horizonte; la otra sólo re-sincroniza lo ya publicado', async () => {
    const { access, enqueue } = arrange(['v1'])
    await jobWithRealHorizon().runOnce()
    expect(access).toHaveBeenCalledTimes(1)
    expect(access).toHaveBeenCalledWith(['v1', 'v2'], 'AGGREGATOR_PASSES')
    // Con plan: el horizonte de siempre (productos ligados ⇒ clases).
    expect(prismaMock.aggregatorProductLink.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.aggregatorProductLink.findMany.mock.calls[0][0].where).toMatchObject({ connectionId: 'c1' })
    // Sin plan: sólo las ocurrencias vivas a futuro de ESA conexión, dentro del horizonte y con el mismo tope.
    expect(prismaMock.aggregatorSessionLink.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.aggregatorSessionLink.findMany.mock.calls[0][0]).toMatchObject({
      where: { connectionId: 'c2', live: true, publishedStartsAt: { gt: NOW, lt: UNTIL } },
      take: 500,
    })
    expect(enqueue.mock.calls.map(c => [c[1], c[2]])).toEqual([
      ['v1', 's1'],
      ['v1', 's2'],
      ['v2', 's2'], // la publicada; s1 (sin publicar) no se encola
    ])
    expect(logger.info).toHaveBeenCalledWith(PAUSED_LOG(1))
  })

  it('ninguna con plan y nada publicado ⇒ no se encola nada y queda el aviso en el log', async () => {
    const { enqueue } = arrange([])
    prismaMock.aggregatorSessionLink.findMany.mockResolvedValue([])
    await jobWithRealHorizon().runOnce()
    expect(prismaMock.aggregatorProductLink.findMany).not.toHaveBeenCalled()
    expect(prismaMock.classSession.findMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorSessionLink.findMany).toHaveBeenCalledTimes(2)
    expect(enqueue).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(PAUSED_LOG(2))
  })

  // regresión
  it('todas con plan ⇒ publica como siempre y sin aviso de plan', async () => {
    const { enqueue } = arrange(['v1', 'v2'])
    await jobWithRealHorizon().runOnce()
    expect(prismaMock.aggregatorSessionLink.findMany).not.toHaveBeenCalled()
    expect(enqueue.mock.calls.map(c => [c[1], c[2]])).toEqual([
      ['v1', 's1'],
      ['v1', 's2'],
      ['v2', 's1'],
      ['v2', 's2'],
    ])
    expect((logger.info as jest.Mock).mock.calls.flat().join(' ')).not.toContain('sin plan')
  })
})
