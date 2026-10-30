/**
 * El trabajo de cada minuto de la entrega de tarjetas (1b S3): se registra con su nombre y su segundo libre, no corre dos vueltas a
 * la vez, y su única lectura de entrada (¿hay algo que hacer?) va con el reintento de conexión; la vuelta, que manda, no.
 */
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import { scheduleJob } from '@/observability/jobContext'
import { GiftCardDeliveryJob, giftCardDeliveryJob } from '@/jobs/giftCardDelivery.job'
import { DATABASE_JOB_SCHEDULES } from '@/jobs/jobSchedules'
import { shouldRetryDbConnectionError } from '@/utils/retry'

const AHORA = new Date('2026-10-21T15:00:24Z')
const noopCron = { start: jest.fn(), stop: jest.fn() }
const VUELTA = { reclamadas: 2, enviadas: 1, reprogramadas: 1, fallidas: 0, atoradas: 0 }

function job(over: Partial<ConstructorParameters<typeof GiftCardDeliveryJob>[0]> = {}) {
  return new GiftCardDeliveryJob({
    cron: noopCron,
    now: () => AHORA,
    retryEntry: jest.fn((fn: () => Promise<unknown>) => fn()) as never,
    hayPendientes: jest.fn().mockResolvedValue(true),
    entregar: jest.fn().mockResolvedValue(VUELTA),
    ...over,
  })
}

describe('GiftCardDeliveryJob', () => {
  it("se registra como 'gift-card-delivery' en '24 * * * * *' con zona America/Mexico_City", () => {
    expect(giftCardDeliveryJob).toBeInstanceOf(GiftCardDeliveryJob)
    expect(DATABASE_JOB_SCHEDULES.giftCardDelivery).toBe('24 * * * * *')
    new GiftCardDeliveryJob() // sin `cron` de prueba: se registra como en producción (el beforeEach global borra el registro del import)
    expect(scheduleJob).toHaveBeenCalledWith('gift-card-delivery', '24 * * * * *', expect.any(Function), null, false, 'America/Mexico_City')
  })

  it('con pendientes corre la vuelta con el mismo reloj y devuelve su resultado', async () => {
    const entregar = jest.fn().mockResolvedValue(VUELTA)
    const r = await job({ entregar }).runNow()

    expect(entregar).toHaveBeenCalledWith({ ahora: AHORA })
    expect(r).toEqual({ ...VUELTA, skipped: false })
  })

  it('runNow con otra vuelta en curso ⇒ skipped: true', async () => {
    let soltar!: (v: typeof VUELTA) => void
    const entregar = jest.fn(() => new Promise<typeof VUELTA>(resolve => (soltar = resolve)))
    const j = job({ entregar })

    const primera = j.runNow()
    await new Promise(resolve => setImmediate(resolve))
    const segunda = await j.runNow()
    soltar(VUELTA)

    expect(segunda.skipped).toBe(true)
    expect((await primera).skipped).toBe(false)
    expect(entregar).toHaveBeenCalledTimes(1)
  })

  it('la entrada (hayEntregasPendientes) va con retry y shouldRetryDbConnectionError; la vuelta no', async () => {
    const retryEntry = jest.fn((fn: () => Promise<unknown>, _opciones?: unknown) => fn())
    const hayPendientes = jest.fn().mockResolvedValue(true)
    await job({ retryEntry: retryEntry as never, hayPendientes }).runNow()

    expect(retryEntry).toHaveBeenCalledTimes(1)
    expect(retryEntry.mock.calls[0][1]).toEqual(expect.objectContaining({ shouldRetry: shouldRetryDbConnectionError }))
    expect(hayPendientes).toHaveBeenCalledWith(AHORA)
  })

  it('sin pendientes ⇒ entregarTarjetas no se llama', async () => {
    const entregar = jest.fn()
    const r = await job({ hayPendientes: jest.fn().mockResolvedValue(false), entregar }).runNow()

    expect(entregar).not.toHaveBeenCalled()
    expect(r).toEqual({ reclamadas: 0, enviadas: 0, reprogramadas: 0, fallidas: 0, atoradas: 0, skipped: false })
  })
})
