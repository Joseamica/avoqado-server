// src/jobs/attendance-late-alert.job.ts

import { CronJob } from 'cron'
import { NotificationChannel, NotificationPriority, NotificationType, StaffRole } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { sendNotification } from '../services/dashboard/notification.service'
import { quienVaTarde } from '../services/dashboard/attendanceLiveAlert'

/**
 * Aviso EN VIVO de retardo.
 *
 * El reporte de asistencia ya calcula los retardos, pero sólo los ves si ENTRAS a la pantalla —
 * normalmente por la tarde, cuando ya no se puede hacer nada. Esto avisa a las 9:20, cuando
 * todavía se le puede hablar a alguien o mover a otra persona a cubrir.
 *
 * 🔴 Quién va tarde lo decide `quienVaTarde`, COMPARTIDO con la herramienta `who_is_late_now` del
 * MCP. Si cada uno recolectara por su cuenta acabarían divergiendo — es el defecto que ya apareció
 * entre el reporte y las comisiones con los turnos nocturnos. Aquí sólo vive lo que el MCP no
 * necesita: el interruptor, la deduplicación y a quién se le manda.
 *
 * 🔴 Dos interruptores, no uno: el checador prendido Y el aviso prendido
 * (`attendanceEnabled` + `attendanceLateAlertEnabled`, este último APAGADO de fábrica). Manda
 * correos: un negocio no puede empezar a recibirlos por una actualización que no pidió.
 *
 * ⚠️ LÍMITE DECLARADO: el dedup consulta-luego-escribe, POR DESTINATARIO, y no es atómico. Dos
 * corridas simultáneas del mismo tick podrían mandar un correo repetido a la misma persona. Se
 * acepta: el daño es una repetición, no una pérdida — y perder era el defecto real (P1 #2), que
 * venía de deduplicar sin mirar el destinatario. Hoy los crons corren en UNA sola instancia
 * (`.claude/rules/una-sola-instancia.md`), así que la ventana es estrecha; `runNow()` la abre si
 * alguien lo dispara a mano mientras el cron corre.
 */
export class AttendanceLateAlertJob {
  private job: CronJob | null = null

  constructor() {
    // Cada 10 minutos, en minuto desfasado para no encimarse con los ~40 jobs de la hora en punto.
    this.job = scheduleJob(
      'attendance-late-alert',
      '4,14,24,34,44,54 * * * *',
      async () => {
        await this.run()
      },
      null,
      false,
      'America/Mexico_City',
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Attendance Late Alert Job started — cada 10 minutos')
    }
  }

  stop(): void {
    if (this.job) this.job.stop()
  }

  /** Visible para pruebas y para disparo manual. */
  async runNow(): Promise<{ avisados: number; venues: number }> {
    return this.run()
  }

  private async run(): Promise<{ avisados: number; venues: number }> {
    const ahora = new Date()
    let avisados = 0

    // 🔴 La consulta de ENTRADA va con reintento (regla `cron-jobs.md`): a la hora en punto se
    // alinean ~40 jobs, la ráfaga de conexiones excede el `connect_timeout` de Prisma y el tick
    // muere con P1001. Es una LECTURA pura, así que reintentarla es seguro. Los envíos de correo
    // quedan FUERA del retry a propósito: reintentar un envío lo duplica.
    const venues = await retry(
      () =>
        prisma.venue.findMany({
          // Dos condiciones, no una: el checador prendido Y el aviso prendido.
          where: { settings: { attendanceEnabled: true, attendanceLateAlertEnabled: true } },
          select: { id: true, name: true },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'attendance-late-alert.venues' },
    )

    for (const venue of venues) {
      try {
        const { tarde } = await quienVaTarde(venue.id, ahora)
        if (tarde.length === 0) continue

        const destinatarios = await this.quienDebeEnterarse(venue.id)
        if (destinatarios.length === 0) continue

        for (const persona of tarde) {
          const llave = `${persona.staffVenueId}:${persona.scheduleDate}`
          // 🔴 El dedup es POR DESTINATARIO (P1 #2 de Codex). Buscando "cualquier notificación de
          // esta persona" bastaba con que al OWNER le llegara la suya para que un corte del proceso
          // dejara a ADMIN y MANAGER sin aviso PARA SIEMPRE: la corrida siguiente encontraba la del
          // OWNER y saltaba a los tres. El daño posible no era "un correo repetido" como decía este
          // comentario, sino la pérdida silenciosa y permanente de un aviso legítimo.
          const yaAvisados = await prisma.notification.findMany({
            where: { venueId: venue.id, type: NotificationType.ATTENDANCE_LATE, entityType: 'AttendanceLateAlert', entityId: llave },
            select: { recipientId: true },
          })
          const pendientes = destinatarios.filter(id => !yaAvisados.some(n => n.recipientId === id))
          if (pendientes.length === 0) continue

          for (const recipientId of pendientes) {
            await sendNotification({
              recipientId,
              venueId: venue.id,
              type: NotificationType.ATTENDANCE_LATE,
              title: `${persona.nombre} no ha checado`,
              message: `Su entrada era a las ${persona.esperada} y lleva ${persona.minutosTarde} minutos de retraso.`,
              actionLabel: 'Ver asistencia',
              entityType: 'AttendanceLateAlert',
              entityId: llave,
              priority: NotificationPriority.NORMAL,
              // 🔴 Correo ADEMÁS del aviso en el dashboard: es lo que hace que el dueño se entere
              // cuando no está en el local, que es justo cuando esto sirve. Igual que Square.
              // La preferencia de cada persona (`NotificationPreference`) puede recortarlo.
              channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
              metadata: { staffVenueId: persona.staffVenueId, scheduleDate: persona.scheduleDate, minutosTarde: persona.minutosTarde },
            })
          }
          avisados++
        }
      } catch (e) {
        // Un venue que truena no puede impedir los avisos de los demás.
        logger.error(`[attendance-late-alert] falló el venue ${venue.name}: ${(e as Error).message}`)
      }
    }

    if (avisados > 0) logger.info(`[attendance-late-alert] ${avisados} aviso(s) de retardo en ${venues.length} venue(s)`)
    return { avisados, venues: venues.length }
  }

  /**
   * Quién ve un retardo: OWNER, ADMIN y MANAGER — los mismos que tienen `attendance:read`.
   * 🔴 Nunca roles de piso: un mesero no puede recibir el retardo de sus compañeros.
   */
  private async quienDebeEnterarse(venueId: string): Promise<string[]> {
    const filas = await prisma.staffVenue.findMany({
      where: { venueId, active: true, role: { in: [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER] } },
      select: { staffId: true },
    })
    return filas.map(f => f.staffId)
  }
}

export const attendanceLateAlertJob = new AttendanceLateAlertJob()
