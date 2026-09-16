import { AngelPayEventWorkerJob } from '@/jobs/angelpay-event-worker.job'
import { AngelPayEventClaim } from '@/services/tpv/angelpayEventWorker.service'

const now = new Date('2026-09-13T20:00:00Z')
const row = (id: string) =>
  ({
    id,
    eventId: `angelpay-${id}`,
    payload: {},
    venueId: 'venue',
    attempts: 1,
    claimToken: id,
    leaseUntil: new Date(now.getTime() + 120000),
  }) as AngelPayEventClaim
const setup = () => ({
  now: () => now,
  claim: jest.fn().mockResolvedValue([row('a'), row('b'), row('c')]),
  apply: jest.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce('PROCESSED').mockResolvedValue('PENDING'),
  fail: jest.fn().mockResolvedValue(true),
  cron: { start: jest.fn(), stop: jest.fn() },
})

describe('S4 · ciclo del worker de eventos de AngelPay', () => {
  it('toma un lote acotado, cuenta cada desenlace y un fallo no frena a los demás', async () => {
    const dependencies = setup()
    const job = new AngelPayEventWorkerJob(dependencies)
    expect(await job.runNow()).toEqual({ processed: 1, pending: 1, errors: 0, skipped: 0, failed: 1 })
    expect(dependencies.claim).toHaveBeenCalledWith({ now, limit: 25 })
    expect(dependencies.apply).toHaveBeenCalledTimes(3)
    expect(dependencies.fail).toHaveBeenCalledWith(row('a'), now, expect.any(Error))
  })
  it('no se solapa consigo mismo y cablea start/stop', async () => {
    const dependencies = setup()
    let resolve!: (value: AngelPayEventClaim[]) => void
    dependencies.claim.mockReturnValueOnce(new Promise<AngelPayEventClaim[]>(done => (resolve = done)))
    const job = new AngelPayEventWorkerJob(dependencies)
    job.start()
    const primera = job.runNow()
    expect(await job.runNow()).toEqual({ processed: 0, pending: 0, errors: 0, skipped: 1, failed: 0 })
    resolve([])
    expect(await primera).toEqual({ processed: 0, pending: 0, errors: 0, skipped: 0, failed: 0 })
    job.stop()
    expect(dependencies.cron.start).toHaveBeenCalled()
    expect(dependencies.cron.stop).toHaveBeenCalled()
  })
})
