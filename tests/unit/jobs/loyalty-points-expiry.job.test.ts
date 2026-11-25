/**
 * D27 (Codex r6 #2): una vuelta que tarda más de una hora no se encima con la siguiente, pero tampoco la pierde: al terminar, corre otra
 * vez en seguida (una sola, aunque se hayan saltado varios disparos).
 */
import { LoyaltyPointsExpiryJob } from '../../../src/jobs/loyalty-points-expiry.job'

const vacio = { negocios: 0, customersAffected: 0, pointsExpired: 0, fallidos: 0 }

describe('LoyaltyPointsExpiryJob', () => {
  it('si llega un disparo mientras corre una vuelta, corre UNA vuelta más al terminar', async () => {
    let soltar: () => void = () => {}
    const correr = jest
      .fn()
      .mockImplementationOnce(() => new Promise(resolve => (soltar = () => resolve(vacio))))
      .mockResolvedValue(vacio)
    const job = new LoyaltyPointsExpiryJob({ cron: { start: jest.fn(), stop: jest.fn() }, correr })

    const primera = job.runNow()
    await expect(job.runNow()).resolves.toBeNull() // disparo durante la vuelta: no se encima
    await expect(job.runNow()).resolves.toBeNull() // otro más: sigue siendo UNA pendiente
    soltar()
    await primera
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    expect(correr).toHaveBeenCalledTimes(2)
  })

  it('sin disparos de más, corre una sola vez', async () => {
    const correr = jest.fn().mockResolvedValue(vacio)
    const job = new LoyaltyPointsExpiryJob({ cron: { start: jest.fn(), stop: jest.fn() }, correr })
    await job.runNow()
    await new Promise(resolve => setImmediate(resolve))
    expect(correr).toHaveBeenCalledTimes(1)
  })
})
