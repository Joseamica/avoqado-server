/**
 * Fase 1 — entrega de los avisos de aprobación de clientes.
 *
 * Cada 30 segundos: abre los eventos nuevos en una fila por destinatario, reclama las que
 * están listas (lease + SKIP LOCKED) y las entrega.
 *
 * Por qué un job y no `await sendEmail()` donde se decide: el correo se manda DESPUÉS del
 * commit, pero la intención se graba DENTRO de la transacción. Si la decisión se revierte,
 * nadie recibe nada; si el proceso muere después del commit, el aviso sigue en la tabla.
 *
 * ⚠️ Este server corre UNA sola instancia (`.claude/rules/una-sola-instancia.md`), así que
 * el cron no está duplicado. Aun así el reclamo usa lease + SKIP LOCKED: es lo que hace que
 * un segundo proceso —un deploy solapado, un script de mantenimiento— no mande dos veces el
 * mismo correo.
 */
import { CronJob } from 'cron'

import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { scheduleJob } from '../observability/jobContext'
import { sweepOnce } from '../services/reservation/customerApprovalOutbox.service'

const TIMEZONE = 'America/Mexico_City'
const BATCH_SIZE = 50

export class CustomerApprovalOutboxJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // 🔴 `scheduleJob`, no `new CronJob`: abre el contexto de observabilidad, así que cada
    // `logger.*` de esta corrida sale con el nombre del job y su correlationId.
    // Y el callback se pasa TAL CUAL (`() => this.process()`), que es lo que evita perder
    // el `this` — hay un test que falla si alguien lo escribe de la otra forma.
    this.job = scheduleJob(
      'customer-approval-outbox',
      DATABASE_JOB_SCHEDULES.customerApprovalOutbox,
      async () => {
        await this.process()
      },
      null,
      false,
      TIMEZONE,
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Customer Approval Outbox started — every 30 seconds')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Customer Approval Outbox stopped')
    }
  }

  private async process(): Promise<void> {
    // Un tick que tarda más de 30s no puede solaparse con el siguiente: dos barridos a la
    // vez compiten por las mismas filas y sólo generan reintentos inútiles.
    if (this.isRunning) {
      logger.warn('[Customer approval outbox] tick omitido — el anterior sigue corriendo', { job: 'customer-approval-outbox' })
      return
    }
    this.isRunning = true

    try {
      // Sólo la lectura de ENTRADA va envuelta en retry (regla `.claude/rules/cron-jobs.md`):
      // es una lectura pura, segura de repetir. El envío de correos queda FUERA — reintentar
      // ahí mandaría duplicados.
      const hasWork = await retry(
        async () => {
          const now = new Date()
          const pendingEvents = await prisma.customerApprovalOutbox.count({ where: { deliveries: { none: {} } } })
          if (pendingEvents > 0) return true
          const readyDeliveries = await prisma.customerApprovalDelivery.count({
            where: {
              status: { in: ['PENDING', 'FAILED'] },
              nextAttemptAt: { lte: now },
              OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
            },
          })
          return readyDeliveries > 0
        },
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'customer-approval-outbox.findReady' },
      )

      if (!hasWork) return

      const result = await sweepOnce({ limit: BATCH_SIZE })
      if (result.sent || result.failed || result.superseded) {
        logger.info('[Customer approval outbox] barrido', result)
      }
    } catch (err) {
      // Un tick que truena no puede tumbar el proceso: el siguiente vuelve a intentarlo y
      // las filas siguen en la tabla.
      logger.error('Customer Approval Outbox failed', { err })
    } finally {
      this.isRunning = false
    }
  }
}

export const customerApprovalOutboxJob = new CustomerApprovalOutboxJob()
