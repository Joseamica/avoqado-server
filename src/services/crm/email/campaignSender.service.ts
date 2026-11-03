/**
 * El remitente de las campañas masivas del CRM (spec 2026-10-30 §5.6, fase 2): vacía la cola de `CrmCampaignDelivery` por
 * Resend, un correo a la vez.
 *
 * 🔴 Tres reglas gobiernan todo el archivo:
 *  1. Una fila es de quien la reclamó: lease de 5 min + `FOR UPDATE SKIP LOCKED`, y TODA escritura de resultado es un CAS
 *     sobre `{ id, status, attempts, leaseUntil }`. Si el CAS no aplica, el resultado se descarta (nunca se pisa a otro).
 *  2. Un correo que Resend aceptó no se manda otra vez a ciegas. Si aceptó y no se pudo guardar, queda DESCONOCIDO. Un
 *     reintento (lease vencido, o un transitorio que pudo ser una respuesta perdida) va con la MISMA llave de idempotencia,
 *     que Resend recuerda 24 h; por eso nada se reintenta pasadas 23 h del primer intento: queda DESCONOCIDO. FALLIDO sólo con
 *     certeza de que no salió; lo que pudo salir (agotar los intentos, la llave usada con otro contenido) es DESCONOCIDO.
 *  3. Lo que puede cambiar entre encolar y mandar se revisa AL BORDE: la campaña cancelada, la baja/rebote/queja, la persona
 *     eliminada del CRM (D7) y la lista de prueba fuera de producción.
 *
 * El tope diario (calentamiento del subdominio) cuenta `sendAttemptAt`, que se escribe al reclamar ANTES de tocar la red y
 * nadie mueve: el lugar queda apartado aunque la respuesta se pierda, un rebote no lo devuelve y un reintento no lo cuenta dos
 * veces. Sólo frena los PRIMEROS intentos.
 */
import { Prisma } from '@prisma/client'
import { env } from '../../../config/env'
import logger from '../../../config/logger'
import { venueStartOfDay } from '../../../utils/datetime'
import { platformUnsubscribeUrl } from '../../../utils/platformUnsubscribeToken'
import prisma from '../../../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../../../utils/retry'
import { utcTs } from '../../../utils/sqlDates'
import emailService from '../../email.service'
import { correoEliminadoDesde, MOTIVO_PERSONA_ELIMINADA } from '../erase.service'
import type { BloqueCampana } from '../../marketing/campaignBlocks'
import { cabecerasDeBaja, pieDeCampana, type MotivoDeEnvio } from './footer'
import { isBlocked } from './optOut.service'
import { armarCorreo } from './templates.service'
import { MOTIVO_FUERA_DE_LA_LISTA, puedeMandarFueraDeProduccion } from './testAllowlist'
import type { Vars } from './templateVars'

export type ResultadoEnvio = 'ENVIADO' | 'REINTENTO' | 'FALLIDO' | 'OMITIDO' | 'DESCONOCIDO'

/** 5 min: mandar un correo (esperar a Resend) es lento; un lease más corto dejaría a otro reclamar la fila a media llamada. */
export const LEASE_MS = 5 * 60 * 1000
/**
 * 1 m, 5 m, 30 m, 2 h y 6 h: la espera tras cada transitorio. Cinco esperas = seis intentos; el sexto que falla queda DESCONOCIDO
 * (Ruling 11): seis fallos no prueban que ninguno llegó a Resend, y la fila no guarda qué pasó en cada intento.
 */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]
const MAX_INTENTOS = BACKOFF_MS.length + 1
/** Resend recuerda la llave de idempotencia 24 h: con una hora de margen, nada se reintenta pasadas 23 h del primer intento. */
const VENTANA_DE_REINTENTO_MS = 23 * 3_600_000
const TOPE_REINTENTOS = 50
const TOPE_NUEVAS = 50
/** Cuántas viejas pasan a DESCONOCIDO por vuelta (sólo pega si el trabajo estuvo detenido; las demás, en la siguiente). */
const LOTE_DE_VIEJAS = 500
/** Resend acepta 2 llamadas por segundo por cuenta (mismo margen que el marketing de superadmin): 100 correos ≈ 50 s. */
const PAUSA_ENTRE_ENVIOS_MS = 500
/** «Hoy» del tope diario: el día de Ciudad de México. */
const ZONA = 'America/Mexico_City'
const NO_SABEMOS_SI_SALIO = 'No sabemos si salió: pasaron más de 23 horas desde el primer intento'
const ACEPTADO_SIN_GUARDAR = 'Resend lo aceptó, pero no se pudo guardar el resultado: no se vuelve a mandar'
/**
 * Resend ya tiene una petición con esta llave y otro contenido (p. ej. un deploy cambió el pie entre intentos): ése pudo salir. La
 * llave en vuelo (`concurrent_idempotent_requests`) es otra cosa: se reintenta y Resend contesta lo que pasó con la primera.
 */
const LLAVE_YA_USADA = 'invalid_idempotent_request'
/**
 * Lo que se frena en un reintento (intento 2 en adelante): un intento anterior pudo haber llegado a Resend (respuesta perdida, o un
 * proceso que murió a media llamada), así que no es «omitida». La usan el borde del remitente y cancelar la campaña.
 */
export const PUDO_SALIR_EN_UN_INTENTO_ANTERIOR = 'No sabemos si salió: un intento anterior pudo llegar a Resend'
const LLAVE_EN_VUELO = 'concurrent_idempotent_requests'

/**
 * Reclama lo que toca mandar, de campañas ENVIANDO, y lo deja ENVIANDO con su lease (`attempts + 1`, `sendAttemptAt` sólo
 * la primera vez). Antes, lo que ya no cabe en la ventana de 23 h pasa a DESCONOCIDO sin tocar Resend.
 *
 *  - Reintentos (REINTENTO vencidos y ENVIANDO con el lease vencido): hasta 50, sin tope diario: ya apartaron su lugar.
 *  - Primeros intentos (PENDIENTE): hasta `topeNuevas`, los más viejos primero.
 *
 * 🔴 El `LIMIT` va DENTRO de cada escaneo que bloquea: así un segundo remitente salta lo bloqueado y sigue juntando filas, en
 * vez de bloquear la cola entera (la lección de `marketing/campaignScheduler.service.ts`).
 */
export async function reclamarLote(topeNuevas: number, ahora: Date): Promise<string[]> {
  if (!Number.isInteger(topeNuevas) || topeNuevas < 0) throw new Error('topeNuevas debe ser un entero mayor o igual a 0.')
  const corte = new Date(ahora.getTime() - VENTANA_DE_REINTENTO_MS)
  const lease = new Date(ahora.getTime() + LEASE_MS)

  // Fuera de la ventana: ya no se sabe si salió, y Resend ya olvidó la llave. Sin mirar la campaña: también una que quedó
  // trabada en una campaña cancelada termina aquí, en vez de quedarse ENVIANDO para siempre.
  await prisma.$executeRaw(Prisma.sql`
    WITH viejas AS (
      SELECT d."id"
      FROM "CrmCampaignDelivery" d
      WHERE d."sendAttemptAt" <= ${utcTs(corte)}
        AND (d."status" = 'REINTENTO' OR (d."status" = 'ENVIANDO' AND (d."leaseUntil" IS NULL OR d."leaseUntil" <= ${utcTs(ahora)})))
      ORDER BY d."id"
      LIMIT ${LOTE_DE_VIEJAS}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "CrmCampaignDelivery" d
    SET "status" = 'DESCONOCIDO', "leaseUntil" = NULL, "nextAttemptAt" = NULL, "lastError" = ${NO_SABEMOS_SI_SALIO}
    FROM viejas
    WHERE d."id" = viejas."id"`)

  const filas = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH reintentos AS (
      SELECT d."id"
      FROM "CrmCampaignDelivery" d
      JOIN "CrmCampaign" c ON c."id" = d."campaignId"
      WHERE c."status" = 'ENVIANDO'
        AND (d."sendAttemptAt" IS NULL OR d."sendAttemptAt" > ${utcTs(corte)})
        AND (
          (d."status" = 'REINTENTO' AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= ${utcTs(ahora)}))
          OR (d."status" = 'ENVIANDO' AND (d."leaseUntil" IS NULL OR d."leaseUntil" <= ${utcTs(ahora)}))
        )
      ORDER BY d."nextAttemptAt" ASC NULLS FIRST, d."id"
      LIMIT ${TOPE_REINTENTOS}
      FOR UPDATE OF d SKIP LOCKED
    ),
    nuevas AS (
      SELECT d."id"
      FROM "CrmCampaignDelivery" d
      JOIN "CrmCampaign" c ON c."id" = d."campaignId"
      WHERE c."status" = 'ENVIANDO' AND d."status" = 'PENDIENTE'
      ORDER BY d."createdAt", d."id"
      LIMIT ${topeNuevas}
      FOR UPDATE OF d SKIP LOCKED
    ),
    elegidas AS (
      SELECT "id" FROM reintentos
      UNION ALL
      SELECT "id" FROM nuevas
    )
    UPDATE "CrmCampaignDelivery" d
    SET "status" = 'ENVIANDO',
      "leaseUntil" = ${utcTs(lease)},
      "attempts" = d."attempts" + 1,
      -- 🔴 Se escribe UNA vez, antes de la red, y nadie la mueve: aparta el lugar del día y marca la ventana de 23 h.
      "sendAttemptAt" = COALESCE(d."sendAttemptAt", ${utcTs(ahora)})
    FROM elegidas
    WHERE d."id" = elegidas."id"
    RETURNING d."id"`)
  return filas.map(f => f.id)
}

/**
 * Manda (o descarta) UNA delivery ya reclamada. No lanza por un resultado esperado: todo termina en uno de los cinco
 * valores. `ahora` sólo lo fijan las pruebas.
 */
export async function enviarDelivery(id: string, ahora: Date = new Date()): Promise<ResultadoEnvio> {
  const d = await prisma.crmCampaignDelivery.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      reason: true,
      reasonVenueName: true,
      vars: true,
      status: true,
      attempts: true,
      leaseUntil: true,
      accountId: true,
      campaign: { select: { status: true, enqueuedAt: true, subject: true, blocks: true } },
    },
  })
  // Si la fila ya no es nuestra (otro la reclamó al vencer el lease, o alguien la movió), no se toca ni se manda.
  if (!d || d.status !== 'ENVIANDO' || !d.leaseUntil || d.leaseUntil <= ahora) {
    logger.warn('[CRM] A campaign delivery is no longer ours to send; left as is', { deliveryId: id, status: d?.status })
    return 'DESCONOCIDO'
  }

  const cas = { id: d.id, status: 'ENVIANDO', attempts: d.attempts, leaseUntil: d.leaseUntil }
  /** El resultado, sólo si la fila sigue siendo nuestra; si no, se descarta y se dice DESCONOCIDO. */
  const escribir = async (resultado: ResultadoEnvio, data: Prisma.CrmCampaignDeliveryUpdateManyMutationInput) => {
    try {
      const { count } = await prisma.crmCampaignDelivery.updateMany({ where: cas, data: { leaseUntil: null, ...data } })
      if (count) return resultado
      logger.warn('[CRM] Lost a campaign delivery before saving its result', { deliveryId: id, resultado })
    } catch (error) {
      logger.error('[CRM] Could not save a campaign delivery result', {
        deliveryId: id,
        resultado,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return 'DESCONOCIDO' as const
  }
  // En el primer intento, lo que se frena al borde no salió: OMITIDO. En un reintento pudo haber salido antes: DESCONOCIDO con el motivo.
  const omitir = (skipReason: string) =>
    d.attempts > 1
      ? escribir('DESCONOCIDO', { status: 'DESCONOCIDO', skipReason, lastError: PUDO_SALIR_EN_UN_INTENTO_ANTERIOR, nextAttemptAt: null })
      : escribir('OMITIDO', { status: 'OMITIDO', skipReason, nextAttemptAt: null })
  // `attempts` ya viene con el intento de ahora (el reclamo lo sube), así que la primera espera es BACKOFF_MS[0].
  /** Pudo haber salido: «no sabemos si salió», sin otro intento (nunca FALLIDO, que la pantalla pinta «No salieron»). */
  const desconocido = (lastError: string) => escribir('DESCONOCIDO', { status: 'DESCONOCIDO', lastError, nextAttemptAt: null })
  // Un rechazo en un REINTENTO no borra la duda del intento anterior (respuesta perdida y luego, p. ej., la credencial revocada:
  // Resend rechaza antes de mirar la llave). Igual que `omitir`: sólo el primer intento puede decir «no salió».
  const fallar = (lastError: string) =>
    d.attempts > 1
      ? desconocido(`${PUDO_SALIR_EN_UN_INTENTO_ANTERIOR} (${lastError})`)
      : escribir('FALLIDO', { status: 'FALLIDO', lastError, nextAttemptAt: null })
  const reintentar = (lastError: string) =>
    d.attempts >= MAX_INTENTOS
      ? desconocido(`No sabemos si salió: se agotaron los ${MAX_INTENTOS} intentos (${lastError})`)
      : escribir('REINTENTO', {
          status: 'REINTENTO',
          lastError,
          nextAttemptAt: new Date(ahora.getTime() + BACKOFF_MS[d.attempts - 1]),
        })

  // ── Al borde ──
  if (d.campaign.status !== 'ENVIANDO') {
    return omitir(d.campaign.status === 'CANCELADA' ? 'campaña cancelada' : `campaña ${d.campaign.status.toLowerCase()}`)
  }
  let bloqueo: string | false
  try {
    bloqueo = (await isBlocked(d.email)) || ((await fueEliminada(d)) && MOTIVO_PERSONA_ELIMINADA)
  } catch (error) {
    // Nunca se toma un error de la base por «no está bloqueado»: no se manda y se reintenta después.
    logger.error('[CRM] Could not check the opt-outs before a campaign send', {
      deliveryId: id,
      error: error instanceof Error ? error.message : String(error),
    })
    return reintentar('No se pudo revisar las bajas')
  }
  if (bloqueo) return omitir(bloqueo)
  if (!puedeMandarFueraDeProduccion(d.email)) return omitir(MOTIVO_FUERA_DE_LA_LISTA)

  // ── El correo ──
  const urlDeBaja = platformUnsubscribeUrl(d.email)
  const correo = armarCorreo(
    d.campaign.subject,
    d.campaign.blocks as unknown as BloqueCampana[],
    d.vars as Vars,
    pieDeCampana(d.reason as MotivoDeEnvio, d.reasonVenueName, urlDeBaja),
  )
  let resultado: Awaited<ReturnType<typeof emailService.sendEmailWithResult>>
  try {
    resultado = await emailService.sendEmailWithResult({
      to: d.email,
      subject: correo.subject,
      html: correo.html,
      text: correo.text,
      from: env.CRM_CAMPAIGN_FROM,
      replyTo: env.CRM_CAMPAIGN_REPLY_TO,
      headers: cabecerasDeBaja(urlDeBaja),
      // 🔴 La llave es el id: un reintento de ESTA delivery es el mismo correo para Resend. El tag es para encontrarla desde
      // el aviso de Resend aunque su `resendId` no se haya guardado.
      idempotencyKey: d.id,
      tags: [{ name: 'crmDeliveryId', value: d.id }],
    })
  } catch {
    // Sin respuesta: pudo salir o no. La misma llave lo vuelve seguro de reintentar.
    resultado = { ok: false, transient: true, errorCode: 'Sin respuesta de Resend' }
  }

  if (resultado.ok) {
    const aceptado = { resendId: resultado.resendId ?? null, sentAt: ahora, nextAttemptAt: null }
    if ((await escribir('ENVIADO', { status: 'ENVIADO', lastError: null, ...aceptado })) === 'ENVIADO') return 'ENVIADO'
    // 🔴 Salió y no quedó guardado: DESCONOCIDO, nunca otro intento. Si tampoco esto se puede escribir, la fila sigue
    // ENVIANDO y, al vencer el lease, el reintento lleva la misma llave (Resend no lo manda dos veces).
    await escribir('DESCONOCIDO', { status: 'DESCONOCIDO', lastError: ACEPTADO_SIN_GUARDAR, ...aceptado })
    return 'DESCONOCIDO'
  }
  if (resultado.transient || resultado.errorCode === LLAVE_EN_VUELO) return reintentar(resultado.errorCode ?? 'Error transitorio de envío')
  if (resultado.errorCode === LLAVE_YA_USADA) {
    return desconocido('No sabemos si salió: Resend ya tenía un envío con esta llave y otro contenido')
  }
  // Cualquier otro rechazo es seguro: con la misma llave y el mismo contenido, Resend devolvería el envío que hubiera aceptado antes.
  return fallar(resultado.errorCode ?? 'Error de envío')
}

/**
 * ¿La persona se eliminó del CRM (D7) después de que se leyó su público? Su cuenta ya no existe (sólo «Eliminar» borra una
 * cuenta), o su correo está en la lápida desde que se encoló, con la misma llave que usa la eliminación. «Eliminar» ya deja
 * OMITIDO lo que encuentra en la cola; esto cierra el hueco de un encolado que leyó el consentimiento antes de que la
 * eliminación terminara y metió sus filas después. Si la base falla, lanza (quien llama reintenta, nunca manda a ciegas).
 */
async function fueEliminada(d: { email: string; accountId: string | null; campaign: { enqueuedAt: Date | null } }): Promise<boolean> {
  if (d.accountId && !(await prisma.crmAccount.findUnique({ where: { id: d.accountId }, select: { id: true } }))) return true
  return correoEliminadoDesde(d.email, d.campaign.enqueuedAt)
}

/** La campaña ENVIANDO que ya no tiene nada por mandar (ni PENDIENTE, ni REINTENTO, ni ENVIANDO) queda ENVIADA. */
export async function cerrarCampanasTerminadas(): Promise<number> {
  const { count } = await prisma.crmCampaign.updateMany({
    where: { status: 'ENVIANDO', deliveries: { none: { status: { in: ['PENDIENTE', 'REINTENTO', 'ENVIANDO'] } } } },
    data: { status: 'ENVIADA', finishedAt: new Date() },
  })
  return count
}

const esperar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Una vuelta del trabajo: tope del día → reclamar → mandar uno por uno → cerrar las campañas terminadas. Con
 * `MARKETING_KILL_SWITCH` prendido no hace nada (ni una consulta) y devuelve null.
 *
 * ponytail: el conteo del día y el reclamo no van juntos bajo candado; con UNA instancia (y el `isRunning` del trabajo) no
 * se enciman. Con dos, el tope podría pasarse por un lote: un candado advisory por vuelta.
 */
export async function correrEnvioDeCampanas(opts: { ahora?: Date; pausaMs?: number } = {}): Promise<Record<ResultadoEnvio, number> | null> {
  if (env.MARKETING_KILL_SWITCH === 'true') return null
  const ahora = opts.ahora ?? new Date()
  const pausaMs = opts.pausaMs ?? PAUSA_ENTRE_ENVIOS_MS

  // La lectura de entrada, con reintento de conexión (`.claude/rules/cron-jobs.md`): un COUNT, seguro de repetir. Usa el
  // índice de `sendAttemptAt`, con cualquier estado.
  const intentadasHoy = await retry(
    () => prisma.crmCampaignDelivery.count({ where: { sendAttemptAt: { gte: venueStartOfDay(ZONA, ahora) } } }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'crm-campaign-sender.count' },
  )
  const topeNuevas = Math.max(0, Math.min(TOPE_NUEVAS, env.CRM_CAMPAIGN_DAILY_CAP - intentadasHoy))
  const ids = await reclamarLote(topeNuevas, ahora)

  const resumen: Record<ResultadoEnvio, number> = { ENVIADO: 0, REINTENTO: 0, FALLIDO: 0, OMITIDO: 0, DESCONOCIDO: 0 }
  for (const [i, id] of ids.entries()) {
    if (i > 0 && pausaMs > 0) await esperar(pausaMs)
    try {
      resumen[await enviarDelivery(id, opts.ahora)] += 1
    } catch (error) {
      // Sólo truena si falla la relectura inicial (antes de tocar Resend): la fila espera su lease y se reintenta.
      logger.error('[CRM] A campaign delivery failed before sending; the rest of the batch goes on', {
        deliveryId: id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const terminadas = await cerrarCampanasTerminadas()
  if (ids.length || terminadas) logger.info('[CRM] Campaign sender tick', { reclamadas: ids.length, terminadas, ...resumen })
  return resumen
}
