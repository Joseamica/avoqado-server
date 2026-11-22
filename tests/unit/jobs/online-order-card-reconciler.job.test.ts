// tests/unit/jobs/online-order-card-reconciler.job.test.ts
import { OnlineOrderCardReconcilerJob } from '@/jobs/online-order-card-reconciler.job'
import { DATABASE_JOB_SCHEDULES } from '@/jobs/jobSchedules'
import { scheduleJob } from '@/observability/jobContext'
import { shouldRetryDbConnectionError } from '@/utils/retry'

jest.mock('@/observability/jobContext', () => ({
  __esModule: true,
  scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}))

const NOW = new Date('2026-10-29T18:30:00.000Z')
const EMPTY = { scanned: 0, finished: 0, released: 0, abandoned: 0, stuck: 0, errors: 0 }
const REFUNDS = { scanned: 1, advanced: 1, alerted: 0, errors: 0 }

function harness(
  reconcile = jest.fn().mockResolvedValue({ ...EMPTY, scanned: 2, finished: 1, released: 1 }),
  sweepRefunds = jest.fn().mockResolvedValue(REFUNDS),
  visitEarly = jest.fn().mockResolvedValue(EMPTY),
) {
  const cron = { start: jest.fn(), stop: jest.fn() }
  const retryEntry = jest.fn(async (op: () => Promise<unknown>) => op())
  const job = new OnlineOrderCardReconcilerJob({
    cron: cron as never,
    now: () => NOW,
    reconcile,
    visitEarly,
    sweepRefunds,
    retryEntry: retryEntry as never,
  })
  return { job, cron, reconcile, sweepRefunds, visitEarly, retryEntry }
}

describe('online-order-card-reconciler.job', () => {
  it('usa scheduleJob y envuelve la lectura con retry', async () => {
    new OnlineOrderCardReconcilerJob()
    expect(scheduleJob).toHaveBeenCalledWith(
      'online-order-card-reconciler',
      DATABASE_JOB_SCHEDULES.onlineOrderCardReconciler,
      expect.any(Function),
      null,
      false,
      'America/Mexico_City',
    )

    const h = harness()
    await expect(h.job.checkNow()).resolves.toEqual({ ...EMPTY, scanned: 2, finished: 1, released: 1, refunds: REFUNDS })
    expect(h.reconcile).toHaveBeenCalledWith(NOW, expect.any(Function))
    // T10: las devoluciones se recorren en la misma pasada, con la misma lectura con reintento.
    expect(h.sweepRefunds).toHaveBeenCalledWith(NOW, h.reconcile.mock.calls[0][1])
    // La lectura que recibe el conciliador pasa por el reintento por conexión (y sólo ella).
    const readEntry = h.reconcile.mock.calls[0][1]
    await expect(readEntry(async () => 'filas')).resolves.toBe('filas')
    expect(h.retryEntry).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ shouldRetry: shouldRetryDbConnectionError }))
  })

  it('una pasada que truena no tumba el job y un tick encimado se salta', async () => {
    let release!: (v: unknown) => void
    const reconcile = jest.fn().mockReturnValueOnce(new Promise(r => (release = r)))
    const h = harness(reconcile)
    const first = h.job.checkNow()
    // D661 (A2): el tick encimado no repite la pasada; sólo corre la visita temprana de «Nadie». D661 (Ruling 99): el recorrido de
    // devoluciones tiene su PROPIA bandera: corre aunque la pasada anterior siga.
    await expect(h.job.checkNow()).resolves.toEqual({ ...EMPTY, skipped: true, refunds: REFUNDS })
    expect(h.reconcile).toHaveBeenCalledTimes(1)
    expect(h.sweepRefunds).toHaveBeenCalledTimes(1)
    expect(h.visitEarly).toHaveBeenCalledWith(NOW, h.reconcile.mock.calls[0][1])
    release(EMPTY)
    await first
    reconcile.mockRejectedValueOnce(new Error('la base se cayó'))
    // Los cargos que truenan no frenan las devoluciones…
    await expect(h.job.checkNow()).resolves.toEqual({ ...EMPTY, errors: 1, refunds: REFUNDS })
    // …ni al revés.
    h.sweepRefunds.mockRejectedValueOnce(new Error('Stripe no responde'))
    reconcile.mockResolvedValueOnce(EMPTY)
    // D661 (Task 5): el resultado del recorrido también cuenta los pedidos cerrados «Devuelto» (0 si no corrió).
    await expect(h.job.checkNow()).resolves.toEqual({ ...EMPTY, refunds: { scanned: 0, advanced: 0, alerted: 0, errors: 1, closed: 0 } })
  })

  it('D661 · A2: con la pasada atorada, cada tick encimado visita los borradores de «Nadie» y cuenta lo que hizo; si la visita truena, el job sigue', async () => {
    let release!: (v: unknown) => void
    const h = harness(jest.fn().mockReturnValueOnce(new Promise(r => (release = r))))
    const first = h.job.checkNow()
    h.visitEarly.mockResolvedValueOnce({ ...EMPTY, scanned: 3, finished: 1 })
    await expect(h.job.checkNow()).resolves.toEqual({ ...EMPTY, scanned: 3, finished: 1, skipped: true, refunds: REFUNDS })
    h.visitEarly.mockRejectedValueOnce(new Error('la base se cayó'))
    await expect(h.job.checkNow()).resolves.toEqual({ ...EMPTY, errors: 1, skipped: true, refunds: REFUNDS })
    expect(h.visitEarly).toHaveBeenCalledTimes(2)
    release(EMPTY)
    await first
    // Una pasada normal no la llama aparte: va dentro de la pasada.
    await h.job.checkNow()
    expect(h.visitEarly).toHaveBeenCalledTimes(2)
  })

  it('D661 · Ruling 99: un recorrido de devoluciones colgado sólo se retiene a sí mismo: la pasada del siguiente tick corre completa y a tiempo; el recorrido se salta hasta que el colgado termine', async () => {
    let soltarRecorrido!: (v: unknown) => void
    const sweepRefunds = jest
      .fn()
      .mockReturnValueOnce(new Promise(r => (soltarRecorrido = r)))
      .mockResolvedValue(REFUNDS)
    const h = harness(undefined, sweepRefunds)
    const first = h.job.checkNow() // su pasada termina; su recorrido se queda colgado
    await new Promise(r => setImmediate(r))
    expect(h.reconcile).toHaveBeenCalledTimes(1)
    expect(sweepRefunds).toHaveBeenCalledTimes(1)

    // El siguiente tick: la pasada completa (no la visita sola) y sin esperar al recorrido colgado; el suyo se salta.
    const second = await h.job.checkNow()
    expect(second).toEqual({ ...EMPTY, scanned: 2, finished: 1, released: 1 })
    expect(second.skipped).toBeUndefined()
    expect(h.reconcile).toHaveBeenCalledTimes(2)
    expect(h.visitEarly).not.toHaveBeenCalled()
    expect(sweepRefunds).toHaveBeenCalledTimes(1)

    // Cuando el colgado termina, el recorrido vuelve a correr.
    soltarRecorrido(REFUNDS)
    await first
    await expect(h.job.checkNow()).resolves.toMatchObject({ refunds: REFUNDS })
    expect(sweepRefunds).toHaveBeenCalledTimes(2)
  })

  it('arranca y para el cron', () => {
    const h = harness()
    h.job.start()
    h.job.stop()
    expect(h.cron.start).toHaveBeenCalledTimes(1)
    expect(h.cron.stop).toHaveBeenCalledTimes(1)
  })

  it('corre cada minuto en un segundo que ningún otro job de cada minuto usa', () => {
    const mine = DATABASE_JOB_SCHEDULES.onlineOrderCardReconciler
    expect(mine).toBe('0 * * * * *')
    const seconds = (cron: string): string[] => cron.split(' ')[0].split(',')
    const clashes = Object.entries(DATABASE_JOB_SCHEDULES)
      .filter(([name]) => name !== 'onlineOrderCardReconciler')
      .filter(([, cron]) => cron.split(' ')[1] === '*' || cron.split(' ')[1].startsWith('*/'))
      .filter(([, cron]) => seconds(cron).includes('0'))
    expect(clashes).toEqual([])
  })
})
