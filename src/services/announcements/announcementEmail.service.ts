import { Prisma, PlatformAnnouncementDeliveryStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { env } from '../../config/env'
import emailService from '../email.service'
import { CUPO_EN_PAUSA, campanasPausadasPorCupo, esErrorDeCupo, reinicioDelCupoDiario } from '../email/resendQuota'
import { cabecerasDeBaja } from '../crm/email/footer'
import { puedeMandarFueraDeProduccion } from '../crm/email/testAllowlist'
import { conNegocio } from '../demo/candadoDemo'
import { signUnsubscribeToken } from '../../utils/unsubscribeToken'
import { utcTs } from '../../utils/sqlDates'
import { isAnnouncementEmailOn } from './announcementEmailPreference.service'
import { renderAnnouncementEmail } from './announcementEmailTemplate'

/**
 * Correo de los anuncios de plataforma: una fila por (anuncio, persona) en `platform_announcement_emails`.
 *
 * - Lo encola el job, nunca `publishAnnouncement` (codex r1 #2): si el proceso muere entre publicar y encolar, el job lo retoma.
 * - 🔴 A lo más UN correo por persona y anuncio (codex r3 #1): el transporte no distingue «Resend lo rechazó» de «se perdió la
 *   respuesta», así que justo antes de llamar a Resend la fila guarda `sendStartedAt`. Sólo un rechazo SEGURO de que no salió
 *   (cupo, pausa del cupo, límite de velocidad) la devuelve a la cola; cualquier otro resultado la deja FAILED, y una fila que
 *   aparece con `sendStartedAt` sin SENT (el proceso murió a media llamada) queda FAILED «INCIERTO». A cambio, un error raro deja
 *   a alguien sin correo; el anuncio igual le llega en la app.
 * - Tope propio por día UTC (`ANNOUNCEMENT_EMAIL_DAILY_CAP`), reservado ANTES de la red bajo un candado advisory: dos
 *   trabajadores nunca se pasan del tope (codex r1 #3, r2 #3, r3 #2).
 */

const LIMITE_RECLAMO = 50
const LEASE_MS = 5 * 60 * 1000
const MAX_INTENTOS = 5
const REINTENTO_MS = 2 * 60 * 1000
const VELOCIDAD_MS = 60 * 1000
const PAUSA_ENTRE_ENVIOS_MS = 500 // Resend: 2 por segundo
const VENTANA_MS = 24 * 60 * 60 * 1000
const ANUNCIOS_POR_VUELTA = 20
const PERSONAS_POR_ANUNCIO = 500
const CANDADO_DEL_TOPE = 'announcement-email-cap'
const INCIERTO = 'INCIERTO: el proceso se detuvo a media llamada a Resend; no se sabe si salió y no se reintenta'

const Estado = PlatformAnnouncementDeliveryStatus

/** El día de Resend (UTC), `YYYY-MM-DD`. */
const diaUTC = (fecha: Date) => fecha.toISOString().slice(0, 10)

/** Una URL http(s) absoluta, o null. La plantilla deja `href=""` con cualquier otra cosa: aquí se frena antes. */
function urlHttp(valor: string | undefined): string | null {
  if (!valor) return null
  try {
    const u = new URL(valor)
    return u.protocol === 'http:' || u.protocol === 'https:' ? valor.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

// ===========================
// Encolar
// ===========================

/**
 * El correo SIGUE a las entregas del buzón durante 24 h contadas desde `deliveredAt` (codex r5 #1: una publicación recuperada
 * tarde abre su ventana al recuperarse). La selección avanza sola (codex r5 #2): sólo salen los anuncios que todavía tienen
 * entregas SIN fila de correo, así uno ya encolado completo deja su lugar al siguiente. Destinatarios = las entregas (el público
 * histórico, codex r3 #4), no la audiencia de hoy. Idempotente: el `@@unique([announcementId, staffId])` y `skipDuplicates`.
 */
export async function enqueuePendingAnnouncementEmails(now: Date): Promise<number> {
  const desde = new Date(now.getTime() - VENTANA_MS)
  const sinCorreo = (d: Prisma.Sql) => Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "platform_announcement_emails" e WHERE e."announcementId" = ${d}."announcementId" AND e."staffId" = ${d}."staffId"
  )`
  const anuncios = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT a.id
    FROM "platform_announcements" AS a
    WHERE a.status = 'PUBLISHED'
      AND a."sendEmail" = true
      AND a."deliveredAt" > ${utcTs(desde)}
      AND EXISTS (
        SELECT 1 FROM "platform_announcement_deliveries" AS d
        WHERE d."announcementId" = a.id AND ${sinCorreo(Prisma.sql`d`)}
      )
    ORDER BY a."deliveredAt" ASC, a.id ASC
    LIMIT ${ANUNCIOS_POR_VUELTA}
  `)

  let encolados = 0
  for (const { id } of anuncios) {
    // Una fila por persona; su negocio es el de su primera entrega (el token de baja lo lleva).
    const personas = await prisma.$queryRaw<{ staffId: string; venueId: string }[]>(Prisma.sql`
      SELECT DISTINCT ON (d."staffId") d."staffId", d."venueId"
      FROM "platform_announcement_deliveries" AS d
      WHERE d."announcementId" = ${id} AND ${sinCorreo(Prisma.sql`d`)}
      ORDER BY d."staffId", d."createdAt" ASC, d.id ASC
      LIMIT ${PERSONAS_POR_ANUNCIO}
    `)
    if (personas.length === 0) continue
    // Sin `id`: Prisma pone `@default(cuid())`, cuid v1.
    const r = await prisma.platformAnnouncementEmail.createMany({
      data: personas.map(p => ({ announcementId: id, staffId: p.staffId, venueId: p.venueId })),
      skipDuplicates: true,
    })
    encolados += r.count
  }
  return encolados
}

// ===========================
// Reclamar
// ===========================

/**
 * Reclama filas listas con `FOR UPDATE SKIP LOCKED` y lease de 5 min, como `claimDeliveries`: `attempts` se cuenta AL RECLAMAR,
 * así una fila que tumba el proceso antes de llegar a Resend no se reintenta para siempre. Con la pausa del cupo de Resend
 * activa no reclama nada.
 *
 * Antes retira lo que ya no tiene salida: una fila con `sendStartedAt` sin SENT y el lease vencido (el proceso murió a media
 * llamada) queda FAILED «INCIERTO», sin volver a mandarse; una que agotó sus intentos antes de la red, FAILED. Nunca se reclama
 * una fila con `sendStartedAt`.
 */
export async function claimAnnouncementEmails(input: { limit?: number; now: Date }): Promise<string[]> {
  const now = input.now
  if (campanasPausadasPorCupo(now)) return []

  await prisma.platformAnnouncementEmail.updateMany({
    where: { status: Estado.PENDING, sendStartedAt: { not: null }, leaseUntil: { lte: now } },
    data: { status: Estado.FAILED, leaseUntil: null, lastError: INCIERTO },
  })
  await prisma.platformAnnouncementEmail.updateMany({
    where: { status: Estado.PENDING, sendStartedAt: null, attempts: { gte: MAX_INTENTOS }, leaseUntil: { lte: now } },
    data: { status: Estado.FAILED, leaseUntil: null, lastError: `Agotó los ${MAX_INTENTOS} intentos sin llegar a Resend` },
  })

  const limit = Math.max(1, Math.min(LIMITE_RECLAMO, input.limit ?? LIMITE_RECLAMO))
  const leaseUntil = new Date(now.getTime() + LEASE_MS)
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH candidates AS (
      SELECT e.id
      FROM "platform_announcement_emails" AS e
      WHERE e.status = 'PENDING'
        AND e."sendStartedAt" IS NULL
        AND e.attempts < ${MAX_INTENTOS}
        AND e."nextAttemptAt" <= ${utcTs(now)}
        AND (e."leaseUntil" IS NULL OR e."leaseUntil" <= ${utcTs(now)})
      ORDER BY e."nextAttemptAt" ASC, e.id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "platform_announcement_emails" AS e
    SET "leaseUntil" = ${utcTs(leaseUntil)}, attempts = e.attempts + 1, "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE e.id = candidates.id
    RETURNING e.id
  `)
  return rows.map(r => r.id)
}

// ===========================
// Mandar
// ===========================

type Fila = {
  id: string
  announcementId: string
  staffId: string
  venueId: string
  attempts: number
  leaseUntil: Date | null
  sendStartedAt: Date | null
  capDay: string | null
}

/**
 * Reserva el lugar del día y marca `sendStartedAt` en UNA escritura con CAS, bajo el candado del tope. El día se lee con el reloj
 * DESPUÉS de tomar el candado (codex r6 #2): una tanda que cruza la medianoche cuenta lo de después en el día nuevo. Una reserva
 * de otro día no vale: se cuenta de nuevo contra hoy.
 */
async function reservar(d: Fila, cas: Prisma.PlatformAnnouncementEmailWhereInput, reloj: () => Date) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CANDADO_DEL_TOPE}, 0))::text`
    const t = reloj()
    const dia = diaUTC(t)
    if (d.capDay !== dia) {
      const usados = await tx.platformAnnouncementEmail.count({ where: { capDay: dia } })
      if (usados >= env.ANNOUNCEMENT_EMAIL_DAILY_CAP) return { r: 'lleno' as const, t }
    }
    const w = await tx.platformAnnouncementEmail.updateMany({ where: cas, data: { capDay: dia, sendStartedAt: t } })
    return { r: w.count > 0 ? ('ok' as const) : ('perdida' as const), t, dia }
  })
}

/**
 * Manda las filas reclamadas, una por una con 500 ms entre envíos. Cada escritura lleva CAS `(id, attempts, leaseUntil)`: si
 * otro trabajador se quedó la fila, no se toca. `reloj` (inyectable para las pruebas de medianoche) decide el día del tope en el
 * momento de cada reserva; `opts.now` sólo fecha lo que no depende del día.
 */
export async function sendClaimedAnnouncementEmails(
  ids: string[],
  opts: { now: Date; reloj?: () => Date; pausaMs?: number },
): Promise<{ sent: number; skipped: number; failed: number }> {
  const res = { sent: 0, skipped: 0, failed: 0 }
  if (ids.length === 0) return res
  const reloj = opts.reloj ?? (() => new Date())
  const pausaMs = opts.pausaMs ?? PAUSA_ENTRE_ENVIOS_MS

  const filas = await prisma.platformAnnouncementEmail.findMany({
    where: { id: { in: ids }, status: Estado.PENDING },
    take: ids.length,
    include: {
      announcement: { select: { title: true, body: true, imageUrl: true, contentBlocks: true, actionLabel: true, actionUrl: true } },
      staff: { select: { email: true } },
    },
  })

  let mandados = 0
  for (const d of filas) {
    const cas = { id: d.id, attempts: d.attempts, leaseUntil: d.leaseUntil }
    const escribir = async (data: Prisma.PlatformAnnouncementEmailUpdateManyMutationInput) =>
      (await prisma.platformAnnouncementEmail.updateMany({ where: cas, data })).count > 0
    /** Vuelve a la cola sin gastar el intento: nunca llegó a Resend, o Resend lo rechazó seguro. */
    const devolver = (nextAttemptAt: Date, lastError: string | null) =>
      escribir({
        status: Estado.PENDING,
        attempts: d.attempts - 1,
        sendStartedAt: null,
        capDay: null,
        leaseUntil: null,
        nextAttemptAt,
        lastError,
      })

    if (d.sendStartedAt) {
      if (await escribir({ status: Estado.FAILED, leaseUntil: null, lastError: INCIERTO })) res.failed++
      continue
    }

    // ── Antes de la red: cualquier error aquí es seguro de reintentar ──
    let correo: { to: string; subject: string; html: string; text: string; unsubscribeUrl: string }
    try {
      const to = d.staff.email
      const motivo = !to
        ? 'SIN_CORREO'
        : !(await isAnnouncementEmailOn(d.staffId))
          ? 'BAJA'
          : !puedeMandarFueraDeProduccion(to)
            ? 'FUERA_DE_LA_LISTA'
            : null
      if (motivo || !to) {
        if (await escribir({ status: Estado.SENT, skippedReason: motivo, leaseUntil: null, lastError: null })) res.skipped++
        continue
      }
      const base = urlHttp(env.BASE_URL)
      if (!base) throw new Error('Falta BASE_URL http(s) del servidor: la liga de baja saldría rota')
      const panel = urlHttp(env.FRONTEND_URL)
      if (!panel) throw new Error('Falta FRONTEND_URL http(s) del DASHBOARD: la liga «Ver» saldría rota')
      const token = signUnsubscribeToken({ staffId: d.staffId, venueId: d.venueId, category: 'ANNOUNCEMENTS' })
      const unsubscribeUrl = `${base}/api/v1/public/unsubscribe?token=${token}`
      correo = { to, unsubscribeUrl, ...renderAnnouncementEmail({ ...d.announcement, openUrl: panel, unsubscribeUrl }) }
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error)
      const agotado = d.attempts >= MAX_INTENTOS
      const escrito = await escribir(
        agotado
          ? { status: Estado.FAILED, leaseUntil: null, lastError: mensaje }
          : {
              status: Estado.PENDING,
              leaseUntil: null,
              nextAttemptAt: new Date(opts.now.getTime() + REINTENTO_MS * d.attempts),
              lastError: mensaje,
            },
      )
      if (escrito) res.failed++
      logger.warn('[Anuncios] No se pudo preparar un correo de anuncio', { emailId: d.id, error: mensaje })
      continue
    }

    // ── El tope del día, reservado ANTES de la red ──
    let reservado = false
    for (let vuelta = 0; vuelta < 3 && !reservado; vuelta++) {
      const r = await reservar(d, { ...cas, status: Estado.PENDING, sendStartedAt: null }, reloj)
      if (r.r === 'perdida') break
      if (r.r === 'lleno') {
        await devolver(reinicioDelCupoDiario(r.t), null)
        break
      }
      d.capDay = r.dia
      // codex r7: si la medianoche cayó entre reservar y mandar, esa reserva es del día viejo. Se suelta y se reserva otra vez.
      // ponytail: un correo que ya está en el aire a medianoche cuenta en el día en que salió de aquí; el tope de 40 deja 60 de
      // margen sobre los 100 de Resend. Si el tope se acerca a 100, medir el día con la cabecera `Date` de Resend.
      if (diaUTC(reloj()) === r.dia) {
        reservado = true
        break
      }
      if (!(await escribir({ capDay: null, sendStartedAt: null }))) break
      d.capDay = null
    }
    if (!reservado) continue

    // ── La llamada a Resend: a lo más una vez ──
    if (mandados++ > 0 && pausaMs > 0) await new Promise(resolve => setTimeout(resolve, pausaMs))
    let resultado: { ok: boolean; errorCode?: string }
    try {
      resultado = await conNegocio(d.venueId, () =>
        emailService.sendEmailWithResult({
          to: correo.to,
          subject: correo.subject,
          html: correo.html,
          text: correo.text,
          headers: cabecerasDeBaja(correo.unsubscribeUrl),
          // Segunda red: si de todos modos se repitiera, Resend no lo manda dos veces.
          idempotencyKey: `announcement-email:${d.announcementId}:${d.staffId}`,
          antesDeMandar: () => (campanasPausadasPorCupo() ? CUPO_EN_PAUSA : null),
        }),
      )
    } catch (error) {
      resultado = { ok: false, errorCode: error instanceof Error ? error.message : 'Sin respuesta de Resend' }
    }

    if (resultado.ok) {
      if (await escribir({ status: Estado.SENT, sentAt: reloj(), leaseUntil: null, lastError: null })) res.sent++
    } else if (esErrorDeCupo(resultado.errorCode) || resultado.errorCode === CUPO_EN_PAUSA) {
      await devolver(reinicioDelCupoDiario(reloj()), resultado.errorCode ?? null)
    } else if (resultado.errorCode === 'rate_limit_exceeded') {
      await devolver(new Date(reloj().getTime() + VELOCIDAD_MS), resultado.errorCode)
    } else {
      // Error genérico, application_error, excepción o timeout: pudo haber salido. Nunca se reintenta.
      if (await escribir({ status: Estado.FAILED, leaseUntil: null, lastError: resultado.errorCode ?? 'Error de envío' })) res.failed++
      logger.warn('[Anuncios] Correo de anuncio FAILED sin reintento', { emailId: d.id, error: resultado.errorCode })
    }
  }
  return res
}
