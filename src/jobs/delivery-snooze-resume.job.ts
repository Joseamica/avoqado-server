// jobs/delivery-snooze-resume.job.ts

import { CronJob } from 'cron'

import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { reanudarSnoozesVencidos } from '../services/delivery-channels/core/deliveryChannelLink.service'

/**
 * Reactiva los canales de reparto cuya pausa temporal ya venció.
 *
 * 🔴 POR QUÉ EXISTE: es lo único que hace que el botón "me saturé" del POS sea seguro.
 * Sin este job, la pausa que pide quien está cocinando sería un apagador sin reloj, y el
 * modo de fallo está documentado en la comunidad de Square bajo el título literal "POS
 * ordering - pause stuck": alguien pausa a media cena, nadie se acuerda de reactivar, y el
 * negocio amanece apagado en el marketplace. Toast lo evita ofreciendo sólo duraciones
 * fijas; ese es el patrón que copiamos, y este job es la mitad que lo cumple.
 *
 * CADENCIA — cada minuto, y aquí sí es el número correcto, no una elección perezosa: la
 * pausa más corta que se puede pedir es de 20 minutos, así que un tick cada 5 la estiraría
 * hasta 25 (un 25% de más). El botón dice "20 minutos" y tiene que ser verdad. El costo es
 * una query por minuto sobre un índice, contra pedidos perdidos de un negocio real.
 *
 * NO lleva `retry(...)`: la regla de `cron-jobs.md` lo pide para jobs de baja frecuencia,
 * donde una P1001 en la estampida del minuto :00 mata la única pasada de la hora. Aquí
 * corre cada minuto y arranca al segundo :35 (fuera de la estampida), así que un fallo se
 * reintenta solo 60 segundos después — y el reloj sigue puesto en la base, así que ningún
 * canal se pierde: `reanudarSnoozesVencidos` deja a propósito el `snoozedUntil` intacto
 * cuando la reanudación falla.
 */
export class DeliverySnoozeResumeJob {
  private job: CronJob | null = null

  /** Cada minuto al segundo :35 — NUNCA :00, regla anti-estampida (.claude/rules/cron-jobs.md). */
  private readonly CRON_PATTERN = '35 * * * * *'

  start(): void {
    if (this.job) return
    this.job = scheduleJob('deliverySnoozeResume', this.CRON_PATTERN, async () => {
      await this.runOnce()
    })
    logger.info('⏰ Delivery snooze resume job started — cada minuto')
  }

  stop(): void {
    this.job?.stop()
    this.job = null
  }

  async runOnce(): Promise<{ reanudados: number; fallidos: number }> {
    try {
      const r = await reanudarSnoozesVencidos()
      // Sólo se loguea cuando pasó algo: un job por minuto que reporta "0 y 0" ahoga el
      // log y entierra las líneas que sí importan.
      if (r.reanudados > 0 || r.fallidos > 0) {
        logger.info('⏰ [DeliverySnoozeResume] pausas vencidas procesadas', r)
      }
      return r
    } catch (error) {
      // Un fallo del job NUNCA tumba el proceso. El reloj sigue en la base y el siguiente
      // tick lo vuelve a intentar.
      logger.error('🚨 [DeliverySnoozeResume] la pasada falló entera', {
        error: error instanceof Error ? error.message : String(error),
      })
      return { reanudados: 0, fallidos: 0 }
    }
  }
}

export const deliverySnoozeResumeJob = new DeliverySnoozeResumeJob()
