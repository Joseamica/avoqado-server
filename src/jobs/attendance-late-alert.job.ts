// src/jobs/attendance-late-alert.job.ts

import { CronJob } from 'cron'
import { NotificationChannel, NotificationPriority, NotificationType, StaffRole } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { getNotificationPreferences, sendNotification } from '../services/dashboard/notification.service'
import { sendNotificationEmail } from '../services/resend.service'
import { type PersonaTarde, quienVaTarde } from '../services/dashboard/attendanceLiveAlert'

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

        // Lo que le toca a cada destinatario en ESTA pasada, para poder mandarle UN correo
        // con la lista en vez de uno por nombre.
        const nuevosPorDestinatario = new Map<string, PersonaTarde[]>()

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
            // 🔴 En la CAMPANA va uno por persona: cada nombre es una acción pendiente, y marcar
            // "ya le hablé a Ana" no puede borrar a Carlos. El correo se manda aparte, agrupado.
            await sendNotification({
              recipientId,
              venueId: venue.id,
              type: NotificationType.ATTENDANCE_LATE,
              title: `${persona.nombre} no ha checado`,
              message: `Entraba a las ${persona.esperada}. Van ${persona.minutosTarde} minutos de retraso y no ha checado.`,
              actionLabel: 'Ver asistencia',
              entityType: 'AttendanceLateAlert',
              entityId: llave,
              priority: NotificationPriority.NORMAL,
              channels: [NotificationChannel.IN_APP],
              metadata: { staffVenueId: persona.staffVenueId, scheduleDate: persona.scheduleDate, minutosTarde: persona.minutosTarde },
            })
            nuevosPorDestinatario.set(recipientId, [...(nuevosPorDestinatario.get(recipientId) ?? []), persona])
          }
          avisados++
        }

        await this.mandarResumenPorCorreo(venue.id, nuevosPorDestinatario)
      } catch (e) {
        // Un venue que truena no puede impedir los avisos de los demás.
        logger.error(`[attendance-late-alert] falló el venue ${venue.name}: ${(e as Error).message}`)
      }
    }

    if (avisados > 0) logger.info(`[attendance-late-alert] ${avisados} aviso(s) de retardo en ${venues.length} venue(s)`)
    return { avisados, venues: venues.length }
  }

  /**
   * 🔴 UN correo por persona-que-lo-recibe y por pasada, con la LISTA — no uno por nombre.
   *
   * Decisión del founder (29-ago). El dato que la sostiene: los turnos empiezan a horas distintas
   * ("abre 8:00 / inter 9:00 / cierre 11:00"), así que en un día normal los retardos caen en
   * pasadas distintas y agrupar no cambia nada — sólo hay uno. Donde SÍ cambia es el día malo
   * (festivo sin marcar, cierre imprevisto): 12 personas × 3 jefes eran 36 correos de golpe, la
   * forma más rápida de que alguien apague la función para siempre. Agrupado son 3.
   *
   * 🔴 No hay referente que copiar: Square NO manda este aviso al gerente — sólo al propio
   * empleado, y sus dueños llevan años pidiéndolo en el foro (buscado en vivo, 29-ago).
   *
   * Se respeta la preferencia de cada quien: si alguien apagó el correo para este tipo, no le
   * llega — igual que haría `sendNotification`. Un fallo al mandar NO tumba el job: la campana
   * ya quedó puesta, que es el registro que importa.
   */
  private async mandarResumenPorCorreo(venueId: string, porDestinatario: Map<string, PersonaTarde[]>): Promise<void> {
    for (const [recipientId, personas] of porDestinatario) {
      if (personas.length === 0) continue
      try {
        const pref = await getNotificationPreferences(recipientId, venueId, NotificationType.ATTENDANCE_LATE)
        if (!pref.enabled) continue
        // `channels` null = sin preferencia explícita: se manda, que es el default de esta alerta.
        if (pref.channels && pref.channels.length > 0 && !pref.channels.includes(NotificationChannel.EMAIL)) continue

        const staff = await prisma.staff.findUnique({ where: { id: recipientId }, select: { email: true } })
        if (!staff?.email) continue

        const titulo = personas.length === 1 ? `${personas[0].nombre} no ha checado` : `${personas.length} personas no han checado`
        // 🔴 "lleva 40 min" se leía como "lleva 40 min AQUÍ" (lo señaló el founder, 29-ago).
        // Se nombra lo que son esos minutos: retraso.
        const cuerpo = personas.map(p => `${p.nombre} — entraba a las ${p.esperada} · ${p.minutosTarde} min de retraso`).join('\n')

        await sendNotificationEmail(staff.email, titulo, titulo, cuerpo, undefined, 'Ver asistencia')
      } catch (e) {
        logger.error(`[attendance-late-alert] no se pudo mandar el resumen a ${recipientId}: ${(e as Error).message}`)
      }
    }
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
