/**
 * 🔴 Los relojes de delivery tienen que ARRANCAR, no sólo anunciarlo.
 *
 * `scheduleJob` crea el `CronJob` APAGADO (`start = false`, como `new CronJob`). Desde el 20-ago el job del menú (menú,
 * agotados y horario de la tienda) y el que reabre la pausa del POS al vencer decían «started» en el log y nunca
 * llamaban `.start()`: en producción jamás corrieron. Se notó el 12-nov con el primer canal real (Rappi de Testarudo):
 * el canal ACTIVO y su menú nunca subió, sin una sola línea de error.
 */
import { DeliveryMenuSyncJob } from '@/jobs/delivery-menu-sync.job'
import { DeliverySnoozeResumeJob } from '@/jobs/delivery-snooze-resume.job'

describe.each([
  ['menú, agotados y horario (delivery-menu-sync)', () => new DeliveryMenuSyncJob()],
  ['reabrir la pausa del POS al vencer (delivery-snooze-resume)', () => new DeliverySnoozeResumeJob()],
])('el reloj de %s', (_nombre, crear) => {
  it('🔴 después de start() el reloj está corriendo; stop() lo apaga', () => {
    const job = crear()
    job.start()
    try {
      expect((job as unknown as { job: { isActive: boolean } }).job.isActive).toBe(true)
    } finally {
      job.stop()
    }
    expect((job as unknown as { job: unknown }).job).toBeNull()
  })
})
