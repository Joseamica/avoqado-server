// src/jobs/attendance-late-alert.job.ts

import { CronJob } from 'cron'
import { DateTime } from 'luxon'
import { NotificationChannel, NotificationPriority, NotificationType, StaffRole } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { sendNotification } from '../services/dashboard/notification.service'
import { resolveExpectedDay } from '../services/dashboard/workSchedule.service'
import { evaluarAvisoEnVivo } from '../services/dashboard/attendanceLiveAlert'

/**
 * Aviso EN VIVO de retardo.
 *
 * El reporte de asistencia ya calcula los retardos, pero sólo los ves si ENTRAS a la pantalla —
 * normalmente por la tarde, cuando ya no se puede hacer nada. Esto avisa a las 9:20, cuando
 * todavía se le puede hablar a alguien o mover a otra persona a cubrir.
 *
 * Corre cada 10 minutos. La decisión de "¿ya hay que avisar?" vive en `attendanceLiveAlert.ts`,
 * que es puro y está probado; aquí sólo se recolecta el contexto y se manda.
 *
 * 🔴 Sólo en venues con el checador PRENDIDO (`VenueSettings.attendanceEnabled`). Un negocio que
 * no lo usa no puede recibir correos de retardo.
 *
 * 🔴 Sin cuadrante NO se juzga — misma regla que el reporte y las comisiones.
 *
 * ⚠️ LÍMITE DECLARADO: el "una vez por persona por día" se resuelve consultando si ya existe la
 * notificación antes de mandarla. NO es atómico: dos corridas simultáneas podrían mandar dos
 * correos. Se acepta a propósito — el daño es un correo repetido, no un número equivocado, y
 * cerrarlo pide un índice único y su migración. Si llega a molestar, ése es el arreglo.
 */
export class AttendanceLateAlertJob {
  private job: CronJob | null = null

  constructor() {
    // Cada 10 minutos, en el minuto 4 para no encimarse con los cortes en punto.
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
  async runNow(): Promise<{ avisados: number; revisados: number }> {
    return this.run()
  }

  private async run(): Promise<{ avisados: number; revisados: number }> {
    const ahora = new Date()
    let avisados = 0
    let revisados = 0

    // 🔴 La consulta de ENTRADA va con reintento (regla `cron-jobs.md`): a la hora en punto se
    // alinean ~40 jobs, la ráfaga de conexiones excede el `connect_timeout` de Prisma y el tick
    // muere con P1001. Es una LECTURA pura, así que reintentarla es seguro. Los envíos de correo
    // quedan FUERA del retry a propósito: reintentar un envío lo duplica.
    const venues = await retry(
      () =>
        prisma.venue.findMany({
          where: { settings: { attendanceEnabled: true } },
          select: {
            id: true,
            name: true,
            timezone: true,
            settings: { select: { attendanceGraceMinutes: true, rotatingShiftsEnabled: true } },
          },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'attendance-late-alert.venues' },
    )

    for (const venue of venues) {
      try {
        const zona = venue.timezone || 'America/Mexico_City'
        const graceMinutes = venue.settings?.attendanceGraceMinutes ?? 10
        // El día del NEGOCIO, no el del servidor. A las 00:30 en México el server en UTC ya
        // está en el día siguiente, y el turno nocturno se juzgaría contra el cuadrante equivocado.
        const hoy = DateTime.fromJSDate(ahora).setZone(zona)
        // Se revisan HOY y AYER: un turno nocturno de ayer sigue vivo a las 2 de la mañana.
        const dias = [hoy.toISODate(), hoy.minus({ days: 1 }).toISODate()].filter(Boolean) as string[]

        const personas = await prisma.staffVenue.findMany({
          where: {
            venueId: venue.id,
            active: true,
            OR: [{ endDate: null }, { endDate: { gte: hoy.startOf('day').toJSDate() } }],
          },
          select: {
            id: true,
            staffId: true,
            staff: { select: { firstName: true, lastName: true } },
            workSchedule: { select: { weekly: true } },
            // 🔴 `workScheduleExceptions`, NO `scheduleExceptions`: ese último es la
            // disponibilidad para CITAS y reservas, otro modelo y otra cosa.
            workScheduleExceptions: {
              where: { startDate: { lte: dias[0] }, endDate: { gte: dias[1] } },
              orderBy: [{ startDate: 'asc' as const }, { createdAt: 'asc' as const }],
              select: { startDate: true, endDate: true, kind: true, startTime: true, endTime: true, type: true },
            },
            workShiftAssignments: venue.settings?.rotatingShiftsEnabled
              ? { where: { date: { in: dias }, status: 'PUBLISHED' }, select: { date: true, startTime: true, endTime: true, status: true } }
              : (false as const),
          },
        })

        for (const persona of personas) {
          for (const dia of dias) {
            revisados++
            const asignacion = (persona as any).workShiftAssignments?.find((a: any) => a.date === dia) ?? null
            const esperado = resolveExpectedDay(persona.workSchedule?.weekly as any, persona.workScheduleExceptions as any, dia, asignacion as any)

            const inicioDia = DateTime.fromISO(dia, { zone: zona }).startOf('day').toJSDate()
            const finVentana = DateTime.fromISO(dia, { zone: zona }).plus({ days: 2 }).toJSDate()
            const checada = await prisma.timeEntry.findFirst({
              where: { staffId: persona.staffId, venueId: venue.id, clockInTime: { gte: inicioDia, lt: finVentana } },
              orderBy: { clockInTime: 'asc' },
              select: { clockInTime: true },
            })

            const veredicto = evaluarAvisoEnVivo({
              expectedStart: esperado.start,
              expectedEnd: esperado.end,
              timezone: zona,
              graceMinutes,
              clockInTime: checada?.clockInTime ?? null,
              scheduleDate: dia,
              isDayOff: esperado.isDayOff,
              now: ahora,
            })
            if (veredicto.aviso !== 'RETARDO') continue

            const llave = `${persona.id}:${dia}`
            const yaAvisado = await prisma.notification.findFirst({
              where: { venueId: venue.id, type: NotificationType.ATTENDANCE_LATE, entityType: 'AttendanceLateAlert', entityId: llave },
              select: { id: true },
            })
            if (yaAvisado) continue

            const nombre = `${persona.staff.firstName ?? ''} ${persona.staff.lastName ?? ''}`.trim() || 'Alguien del equipo'
            const destinatarios = await this.quienDebeEnterarse(venue.id)
            for (const recipientId of destinatarios) {
              await sendNotification({
                recipientId,
                venueId: venue.id,
                type: NotificationType.ATTENDANCE_LATE,
                title: `${nombre} no ha checado`,
                message: `Su entrada era a las ${esperado.start} y lleva ${veredicto.minutosTarde} minutos de retraso.`,
                actionLabel: 'Ver asistencia',
                entityType: 'AttendanceLateAlert',
                entityId: llave,
                priority: NotificationPriority.NORMAL,
                // 🔴 Correo ADEMÁS del aviso en el dashboard: es lo que hace que el dueño se
                // entere cuando no está en el local, que es justo cuando esto sirve. Igual que
                // Square. La preferencia de cada persona puede recortarlo.
                channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
                metadata: { staffVenueId: persona.id, scheduleDate: dia, minutosTarde: veredicto.minutosTarde },
              })
            }
            if (destinatarios.length > 0) avisados++
          }
        }
      } catch (e) {
        // Un venue que truena no puede impedir los avisos de los demás.
        logger.error(`[attendance-late-alert] falló el venue ${venue.name}: ${(e as Error).message}`)
      }
    }

    if (avisados > 0) logger.info(`[attendance-late-alert] ${avisados} aviso(s) de retardo · ${revisados} día-persona revisados`)
    return { avisados, revisados }
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
