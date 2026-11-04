/**
 * Las respuestas a la línea de tiempo (spec 2026-10-30 §5.6, fase 2): cada 5 min, por cada vendedor con su Gmail ACTIVO,
 * se leen los hilos de los correos que mandó desde su buzón ACTUAL y se guarda lo que contestaron.
 *
 * 🔴 Los errores son por hilo y por conexión: un hilo borrado (404) se retira y se sigue con el siguiente; el token revocado
 * de un vendedor (`invalid_grant`) lo deja REVOCADA —sólo si sigue en la versión que se usó— y no atora a los demás.
 *
 * Si el vendedor conecta otra cuenta, los hilos de la anterior ya no se leen (Codex plan r2 H6): la ficha los sigue
 * mostrando como están, y «Mi Gmail» dice «Las respuestas a correos de tu cuenta anterior ya no se registran».
 */
// ponytail: lee hilo por hilo; con muchos vendedores, pasar a users.history.list desde un historyId guardado.
import { Prisma } from '@prisma/client'
import type { gmail_v1 } from 'googleapis'
import logger from '../../../config/logger'
import { utcTs } from '../../../utils/sqlDates'
import prisma from '../../../utils/prismaClient'
import { normalizeEmail } from '../../marketing/emailSuppression.service'
import { touchNoEarlierTx } from '../accounts.service'
import { addEvent } from '../timeline.service'
import {
  anotarError,
  clienteGmail,
  conexionesActivas,
  esInvalidGrant,
  gmailConfigurado,
  marcarRevocada,
  mensajeDe,
  statusHttp,
  type ConexionActiva,
} from './gmailOAuth.service'

const MIN = 60_000
const TIMEOUT_MS = 30_000
const METADATA = ['From', 'To', 'Subject', 'Message-ID']

/** Un `invalid_grant` corta la conexión entera: todos sus hilos fallarían igual. */
class CredencialesRevocadas extends Error {}

/**
 * Hasta 50 hilos distintos (el `LIMIT 50`) de sus SALIDA ENVIADO, del buzón actual. Sin fecha de corte (Codex plan r2 H7): una respuesta
 * del día 31 también entra; el ritmo baja con la edad — con envío de los últimos 30 días, cada 5 min; más viejo, cada
 * 24 h —, primero los nunca revisados y luego los que llevan más tiempo sin revisar.
 */
async function hilosPorRevisar(conexion: ConexionActiva, ahora: Date): Promise<string[]> {
  const hace = (ms: number) => utcTs(new Date(ahora.getTime() - ms))
  // ponytail: el GROUP BY vuelve a agregar TODO lo ENVIADO del vendedor cada 5 min (filtrado por índice, salida tope 50);
  // con decenas de miles de envíos por vendedor, pasar a users.history.list desde un historyId guardado.
  const filas = await prisma.$queryRaw<Array<{ threadId: string }>>(Prisma.sql`
    SELECT t."threadId" FROM (
      SELECT "gmailThreadId" AS "threadId",
             MAX(COALESCE("sentAt", "createdAt")) AS "ultimoEnvio",
             CASE WHEN bool_or("lastCheckedAt" IS NULL) THEN NULL ELSE MIN("lastCheckedAt") END AS "revisado"
      FROM "CrmEmailMessage"
      WHERE "staffId" = ${conexion.staffId}
        AND "direction" = 'SALIDA'
        AND "status" = 'ENVIADO'
        AND "fromEmail" = ${conexion.googleEmail}
        AND "gmailThreadId" IS NOT NULL
      GROUP BY "gmailThreadId"
    ) t
    WHERE t."revisado" IS NULL
       OR (t."ultimoEnvio" >= ${hace(30 * 24 * 60 * MIN)} AND t."revisado" < ${hace(5 * MIN)})
       OR (t."ultimoEnvio" < ${hace(30 * 24 * 60 * MIN)} AND t."revisado" < ${hace(24 * 60 * MIN)})
    ORDER BY t."revisado" ASC NULLS FIRST, t."threadId" ASC
    LIMIT 50
  `)
  return filas.map(fila => fila.threadId)
}

const encabezado = (mensaje: gmail_v1.Schema$Message, nombre: string) =>
  mensaje.payload?.headers?.find(h => h.name?.toLowerCase() === nombre.toLowerCase())?.value ?? ''

/** La dirección de un `From`: lo de entre `<>` si lo hay, en minúsculas. */
const direccionDe = (from: string) => normalizeEmail(from.match(/<([^>]+)>/)?.[1] ?? from)

/** Gmail entrega el `snippet` con el HTML escapado («&lt;rafa@…&gt;»): se guarda como texto. `&amp;` va al final. */
const desescapar = (snippet: string) =>
  snippet
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

/** Lo que NO es una respuesta: lo que mandó el propio vendedor (por su dirección, o porque Gmail lo marca enviado) y sus borradores. */
const esPropio = (mensaje: gmail_v1.Schema$Message, googleEmail: string) =>
  direccionDe(encabezado(mensaje, 'From')) === googleEmail || (mensaje.labelIds ?? []).some(label => label === 'SENT' || label === 'DRAFT')

/** Guarda las respuestas nuevas de un hilo y sus eventos, sólo si el hilo sigue teniendo alguna SALIDA. */
async function guardarRespuestas(
  conexion: ConexionActiva,
  threadId: string,
  mensajes: gmail_v1.Schema$Message[],
  ahora: Date,
): Promise<void> {
  const respuestas = mensajes.filter(m => m.id && !esPropio(m, conexion.googleEmail))
  if (!respuestas.length) return

  await prisma.$transaction(async tx => {
    // Un 404 de otra vuelta pudo haberlo retirado: entonces no hay a qué cuenta colgarle la respuesta.
    const salida = await tx.crmEmailMessage.findFirst({
      where: { staffId: conexion.staffId, direction: 'SALIDA', gmailThreadId: threadId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { accountId: true, contactId: true },
    })
    if (!salida) return

    // `gmailMessageId` es único: una respuesta leída dos veces no se vuelve a guardar, y sólo las nuevas traen evento.
    const nuevas = await tx.crmEmailMessage.createManyAndReturn({
      data: respuestas.map(m => ({
        accountId: salida.accountId,
        contactId: salida.contactId,
        staffId: conexion.staffId,
        direction: 'ENTRADA',
        fromEmail: direccionDe(encabezado(m, 'From')),
        toEmail: conexion.googleEmail,
        gmailMessageId: m.id!,
        gmailThreadId: threadId,
        subject: encabezado(m, 'Subject') || '(sin asunto)',
        snippet: m.snippet == null ? null : desescapar(m.snippet),
        status: 'RECIBIDO',
        sentAt: m.internalDate ? new Date(Number(m.internalDate)) : null,
      })),
      skipDuplicates: true,
      select: { id: true, gmailMessageId: true, sentAt: true },
    })
    for (const nueva of nuevas) {
      // Sólo ids: el extracto se lee del mensaje al pintar la ficha.
      await addEvent(tx, {
        accountId: salida.accountId,
        kind: 'EMAIL_RECEIVED',
        actorStaffId: null,
        data: { messageId: nueva.id },
        sourceKey: `gmail:${nueva.gmailMessageId}`,
      })
    }
    // Una respuesta es un toque (como la entrada de la landing): «Estancado» cuenta desde la más nueva. Nunca hacia atrás:
    // una respuesta vieja que apenas se leyó no le quita a la cuenta un toque más reciente.
    if (nuevas.length) {
      const masNueva = Math.max(...nuevas.map(nueva => nueva.sentAt?.getTime() ?? ahora.getTime()))
      await touchNoEarlierTx(tx, salida.accountId, new Date(masNueva))
    }
  })
}

const marcarRevisado = (conexion: ConexionActiva, threadId: string, data: Prisma.CrmEmailMessageUpdateManyMutationInput) =>
  prisma.crmEmailMessage.updateMany({ where: { staffId: conexion.staffId, direction: 'SALIDA', gmailThreadId: threadId }, data })

async function sincronizarConexion(conexion: ConexionActiva, ahora: Date): Promise<void> {
  const hilos = await hilosPorRevisar(conexion, ahora)
  if (!hilos.length) return
  const gmail = clienteGmail(conexion.refreshTokenCiphertext)

  for (const threadId of hilos) {
    try {
      const { data } = await gmail.users.threads.get(
        { userId: 'me', id: threadId, format: 'metadata', metadataHeaders: METADATA },
        { timeout: TIMEOUT_MS },
      )
      await guardarRespuestas(conexion, threadId, data.messages ?? [], ahora)
      await marcarRevisado(conexion, threadId, { lastCheckedAt: ahora })
    } catch (error) {
      if (esInvalidGrant(error)) throw new CredencialesRevocadas()
      if (statusHttp(error) === 404) {
        // El vendedor borró el hilo: se retira (sus SALIDA se quedan en la ficha, sin hilo que leer).
        await marcarRevisado(conexion, threadId, { gmailThreadId: null, lastCheckedAt: ahora })
        continue
      }
      logger.warn('[CRM] Could not read a Gmail thread', { staffId: conexion.staffId, threadId, error: mensajeDe(error) })
      // También cuando falla, el hilo pasa al final de la fila (Codex plan r3 H12): uno roto no tapa a los demás.
      await marcarRevisado(conexion, threadId, { lastCheckedAt: ahora })
    }
  }
}

/** Una vuelta del trabajo de respuestas. Nunca truena por una conexión: se registra y sigue con la siguiente. */
export async function sincronizarRespuestas(ahora: Date = new Date()): Promise<void> {
  if (!gmailConfigurado()) return
  const conexiones = await conexionesActivas('crm-gmail.respuestas.conexiones')

  for (const conexion of conexiones) {
    try {
      await sincronizarConexion(conexion, ahora)
    } catch (error) {
      if (error instanceof CredencialesRevocadas || esInvalidGrant(error)) {
        await marcarRevocada(conexion.staffId, conexion.version, ahora)
        continue
      }
      logger.error('[CRM] Could not sync the Gmail replies of a seller', { staffId: conexion.staffId, error: mensajeDe(error) })
      await anotarError(conexion.staffId, conexion.version, error)
    }
  }
}
