/**
 * «Mandar correo» desde la ficha (spec 2026-10-30 §5.6, fase 2): uno a uno, desde el Gmail del vendedor, para que quede en
 * SUS «Enviados» y la respuesta le llegue a él. Y la reconciliación de lo que no sabemos si salió.
 *
 * 🔴 El dinero de aquí es la confianza del prospecto: un correo de más (el doble clic, un reintento a ciegas) o uno a quien
 * se dio de baja no se deshace. Por eso:
 *  - un clic = un `clientRequestId` único: el segundo clic devuelve el mismo registro y no manda otro;
 *  - la reserva va bajo el candado de la conexión (`FOR UPDATE`), y de ESA lectura salen la cuenta y el token: si el
 *    vendedor cambia de cuenta al mismo tiempo, el envío queda del lado A (y el cambio lo marca) o del lado B;
 *  - la baja se revisa otra vez bajo el candado, justo antes de reservar;
 *  - el evento de la ficha nace CON la reserva: un envío incierto se ve («no sabemos si salió») y nadie lo repite;
 *  - lo incierto NUNCA se reenvía ni se certifica como «no salió»: se busca por su Message-ID en «Enviados».
 */
import { Prisma } from '@prisma/client'
import MailComposer from 'nodemailer/lib/mail-composer'
import logger from '../../../config/logger'
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../../errors/AppError'
import prisma from '../../../utils/prismaClient'
import { logAction } from '../../dashboard/activity-log.service'
import type { BloqueCampana } from '../../marketing/campaignBlocks'
import { normalizeEmail } from '../../marketing/emailSuppression.service'
import { scopeWhere, type CrmAccess } from '../access.service'
import { addEvent } from '../timeline.service'
import {
  anotarError,
  clienteGmail,
  conexionesActivas,
  ERROR_CUENTA_REEMPLAZADA,
  esInvalidGrant,
  gmailConfigurado,
  marcarRevocada,
  mensajeDe,
  NO_CONFIGURADO,
  RECONECTA,
  statusHttp,
} from './gmailOAuth.service'
import { isBlocked } from './optOut.service'
import { armarCorreo, assertSinVariablesDesconocidas, nombreDelActor } from './templates.service'
import { MOTIVO_FUERA_DE_LA_LISTA, puedeMandarFueraDeProduccion } from './testAllowlist'

/** Gmail no contestó (timeout, red, 5xx): se busca en la siguiente vuelta. */
export const ERROR_SIN_RESPUESTA = 'Gmail no contestó'
/** 24 h buscándolo sin encontrarlo: DESCONOCIDO para siempre («revisa tus Enviados»). Nunca «no salió». */
export const ERROR_NO_ENCONTRADO = 'no se encontró en Enviados'
const FINALES = [ERROR_CUENTA_REEMPLAZADA, ERROR_NO_ENCONTRADO]

const TIMEOUT_MS = 30_000
const MIN = 60_000
const PENDIENTES_POR_CONEXION = 20

export interface MandarCorreoInput {
  accountId: string
  contactId: string
  subject: string
  blocks: BloqueCampana[]
  /** El clic: lo genera el diálogo al abrirse, así un doble clic manda una vez. */
  clientRequestId: string
}

type Respuesta = { status: 'ENVIADO' | 'DESCONOCIDO' }

const PREVIO_SELECT = { status: true, staffId: true, accountId: true, error: true } satisfies Prisma.CrmEmailMessageSelect
type Previo = Prisma.CrmEmailMessageGetPayload<{ select: typeof PREVIO_SELECT }>

interface FilaConexion {
  googleEmail: string
  refreshTokenCiphertext: Uint8Array
  status: string
  version: number
}

const noSeManda = (motivo: string) => new ValidationError(`No se manda: ${motivo}`, 'CRM_CORREO_BLOQUEADO', { motivo })
const reconecta = () => new ConflictError(RECONECTA, 'CRM_GMAIL_RECONECTA')

/** Lo que ya pasó con ese clic. Nunca devuelve lo de otra persona ni de otra cuenta. */
function respuestaDe(previo: Previo, actor: CrmAccess, accountId: string): Respuesta {
  if (previo.staffId !== actor.staffId || previo.accountId !== accountId) {
    throw new ConflictError('Ese envío ya existe', 'CRM_CORREO_DUPLICADO')
  }
  if (previo.status === 'ENVIADO') return { status: 'ENVIADO' }
  if (previo.status === 'FALLIDO') throw new ValidationError(`No salió: ${previo.error ?? 'Gmail no lo aceptó'}`, 'CRM_GMAIL_RECHAZADO')
  // ENVIANDO (el primer clic sigue en camino) o DESCONOCIDO: no sabemos todavía, y no se manda otro.
  return { status: 'DESCONOCIDO' }
}

const extracto = (texto: string) => texto.replace(/\s+/g, ' ').trim().slice(0, 200)

/** Sólo cambia una fila que sigue ENVIANDO: nunca pisa la «cuenta reemplazada» ni lo que encontró la reconciliación. */
async function cerrarIncierto(id: string, status: 'FALLIDO' | 'DESCONOCIDO', error: string): Promise<void> {
  try {
    await prisma.crmEmailMessage.updateMany({ where: { id, status: 'ENVIANDO' }, data: { status, error } })
  } catch (falla) {
    // Si la base tampoco contesta, la fila queda ENVIANDO y la reconciliación la encuentra a los 10 min.
    logger.error('[CRM] Could not record the Gmail send outcome', { messageId: id, status, error: mensajeDe(falla) })
  }
}

/**
 * Manda UN correo a un contacto de una cuenta, desde el Gmail del vendedor. `ENVIADO` = Gmail lo aceptó; `DESCONOCIDO` =
 * no sabemos (Gmail no contestó, o contestó y no se pudo guardar): la ficha lo dice y la reconciliación lo busca.
 *
 * Errores: 404 cuenta o contacto fuera del alcance; 422 sin correo, dado de baja (`No se manda: <motivo>`), fuera de la
 * lista de prueba o rechazado por Gmail; 409 sin Gmail conectado o «Reconecta tu Gmail»; 503 la app no está configurada.
 */
export async function mandarCorreo(actor: CrmAccess, input: MandarCorreoInput): Promise<Respuesta> {
  const { accountId, contactId, subject, blocks, clientRequestId } = input
  if (!gmailConfigurado()) throw new ServiceUnavailableError(NO_CONFIGURADO, 'CRM_GMAIL_NO_CONFIGURADO')
  assertSinVariablesDesconocidas(subject, blocks)

  // El mismo clic otra vez: su respuesta, nunca otro correo.
  const previo = await prisma.crmEmailMessage.findUnique({ where: { clientRequestId }, select: PREVIO_SELECT })
  if (previo) return respuestaDe(previo, actor, accountId)

  // 1. La cuenta en el alcance de quien manda (si no, 404 como si no existiera) y el contacto con correo.
  const account = await prisma.crmAccount.findFirst({
    where: { AND: [{ id: accountId }, scopeWhere(actor, 'ver')] },
    select: { name: true, contacts: { where: { id: contactId }, take: 1, select: { id: true, name: true, email: true } } },
  })
  if (!account) throw new NotFoundError('Ese negocio no existe', 'CRM_CUENTA_NOT_FOUND')
  const contact = account.contacts[0]
  if (!contact) throw new NotFoundError('Ese contacto no existe', 'CRM_CONTACTO_NOT_FOUND')
  const toEmail = contact.email?.trim() ? normalizeEmail(contact.email) : null
  if (!toEmail) throw new ValidationError('Ese contacto no tiene correo', 'CRM_CONTACTO_SIN_CORREO')

  const conexion = await prisma.crmGmailConnection.findUnique({ where: { staffId: actor.staffId }, select: { status: true } })
  if (!conexion) throw new ConflictError('Conecta tu Gmail en «Mi Gmail» para mandar correo', 'CRM_GMAIL_NO_CONECTADO')
  if (conexion.status !== 'ACTIVA') throw reconecta()

  const bloqueo = await isBlocked(toEmail)
  if (bloqueo) throw noSeManda(bloqueo)
  // 🔴 Fuera de producción sólo a la lista de prueba: la base local trae correos de gente real.
  if (!puedeMandarFueraDeProduccion(toEmail)) throw noSeManda(MOTIVO_FUERA_DE_LA_LISTA)

  const vendedor = await nombreDelActor(actor.staffId)
  // Sin pie: es un correo de persona a persona, no una campaña.
  const correo = armarCorreo(subject, blocks, { nombre: contact.name, negocio: account.name, vendedor })

  // 2. La reserva, bajo el candado de la conexión.
  let reserva: { previo: Previo } | { fila: FilaConexion; id: string; rfcMessageId: string }
  try {
    reserva = await prisma.$transaction(async tx => {
      const [fila] = await tx.$queryRaw<FilaConexion[]>`
        SELECT "googleEmail", "refreshTokenCiphertext", "status", "version"
        FROM "CrmGmailConnection" WHERE "staffId" = ${actor.staffId} FOR UPDATE`
      if (!fila || fila.status !== 'ACTIVA') throw reconecta()

      // Dos clics a la vez: el segundo esperó el candado y aquí ya ve la fila del primero.
      const yaEsta = await tx.crmEmailMessage.findUnique({ where: { clientRequestId }, select: PREVIO_SELECT })
      if (yaEsta) return { previo: yaEsta }

      // 🔴 Otra vez, justo antes de reservar (Codex plan r5 H19): una baja que llegó mientras el vendedor escribía.
      const bloqueoAhora = await isBlocked(toEmail, tx)
      if (bloqueoAhora) throw noSeManda(bloqueoAhora)

      const { id } = await tx.crmEmailMessage.create({
        data: {
          accountId,
          contactId,
          staffId: actor.staffId,
          direction: 'SALIDA',
          fromEmail: fila.googleEmail,
          toEmail,
          clientRequestId,
          subject: correo.subject,
          snippet: extracto(correo.text),
          status: 'ENVIANDO',
        },
        select: { id: true },
      })
      const rfcMessageId = `<crm.${id}@avoqado.io>`
      await tx.crmEmailMessage.update({ where: { id }, data: { rfcMessageId } })
      // El evento nace con la reserva (Codex plan r2 H5), sólo con ids: lo demás se lee del mensaje al pintar la ficha.
      await addEvent(tx, {
        accountId,
        kind: 'EMAIL_SENT',
        actorStaffId: actor.staffId,
        data: { messageId: id, contactId },
        sourceKey: `email:${id}`,
      })
      return { fila, id, rfcMessageId }
    })
  } catch (error) {
    // El mismo `clientRequestId` lo reservó otra persona (otro candado): su fila, nunca otro correo.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existente = await prisma.crmEmailMessage.findUnique({ where: { clientRequestId }, select: PREVIO_SELECT })
      if (existente) return respuestaDe(existente, actor, accountId)
    }
    throw error
  }
  if ('previo' in reserva) return respuestaDe(reserva.previo, actor, accountId)
  const { fila, id, rfcMessageId } = reserva

  // 3. El MIME: del vendedor, a la persona, con nuestro Message-ID (con él se reconoce en el hilo y en «Enviados»).
  const raw = (
    await new MailComposer({
      from: { name: vendedor ?? '', address: fila.googleEmail },
      to: { name: contact.name, address: toEmail },
      subject: correo.subject,
      html: correo.html,
      text: correo.text,
      messageId: rfcMessageId,
    })
      .compile()
      .build()
  ).toString('base64url')

  // 4. A Gmail. Nunca se reintenta solo: lo incierto queda DESCONOCIDO y lo busca la reconciliación.
  let enviado: { id?: string | null; threadId?: string | null }
  try {
    const gmail = clienteGmail(fila.refreshTokenCiphertext)
    enviado = (await gmail.users.messages.send({ userId: 'me', requestBody: { raw } }, { timeout: TIMEOUT_MS })).data
  } catch (error) {
    return resolverFalla(error, { id, staffId: actor.staffId, version: fila.version })
  }
  if (!enviado?.id) {
    await cerrarIncierto(id, 'DESCONOCIDO', ERROR_SIN_RESPUESTA)
    return { status: 'DESCONOCIDO' }
  }

  // 5. Gmail lo aceptó. Si guardarlo falla, la respuesta es DESCONOCIDO y la fila queda para la reconciliación.
  try {
    await prisma.crmEmailMessage.updateMany({
      // También si mientras tanto lo marcaron DESCONOCIDO: lo que contestó Gmail es la prueba de que salió.
      where: { id, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
      data: { status: 'ENVIADO', gmailMessageId: enviado.id, gmailThreadId: enviado.threadId ?? null, sentAt: new Date(), error: null },
    })
  } catch (error) {
    logger.error('[CRM] Gmail accepted the email but it could not be saved', { messageId: id, error: mensajeDe(error) })
    return { status: 'DESCONOCIDO' }
  }
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_EMAIL_SENT',
    entity: 'CrmEmailMessage',
    entityId: id,
    data: { accountId, contactId },
  })
  return { status: 'ENVIADO' }
}

async function resolverFalla(error: unknown, envio: { id: string; staffId: string; version: number }): Promise<Respuesta> {
  // Las credenciales ya no sirven: el token no se pudo renovar, así que el correo NO salió.
  if (esInvalidGrant(error)) {
    await cerrarIncierto(envio.id, 'FALLIDO', RECONECTA)
    await marcarRevocada(envio.staffId, envio.version, new Date())
    throw reconecta()
  }
  const status = statusHttp(error)
  // Un 4xx es Gmail diciendo que NO lo aceptó (validación, permisos, límite): no salió, con su motivo.
  if (status !== undefined && status >= 400 && status < 500) {
    const e = error as { response?: { data?: { error?: { message?: unknown } } } }
    const motivo = String(e.response?.data?.error?.message ?? mensajeDe(error)).slice(0, 200)
    await cerrarIncierto(envio.id, 'FALLIDO', motivo)
    throw new ValidationError(`Gmail no aceptó el correo: ${motivo}`, 'CRM_GMAIL_RECHAZADO')
  }
  // Sin respuesta (timeout, red) o un 5xx: Gmail pudo haberlo mandado. No sabemos.
  logger.warn('[CRM] Gmail did not answer the send', { messageId: envio.id, status, error: mensajeDe(error) })
  await cerrarIncierto(envio.id, 'DESCONOCIDO', ERROR_SIN_RESPUESTA)
  return { status: 'DESCONOCIDO' }
}

// ── Reconciliar lo que no sabemos si salió ────────────────────────────────────────────────────────────────────────────

/**
 * Lo llama el trabajo de respuestas cada 5 min. Revisa los DESCONOCIDO y los ENVIANDO de hace más de 10 min (un proceso que
 * murió entre mandar y guardar no pasó por ningún `catch`; Codex plan r1 #6), sólo de su buzón ACTUAL (Codex plan r3 H6):
 * los de una cuenta reemplazada ya quedaron «cuenta reemplazada» al reconectar.
 *
 * Busca cada uno por su Message-ID en «Enviados»: encontrado → ENVIADO (su evento ya existe). No encontrado → sigue
 * DESCONOCIDO, y a las 24 h para siempre («revisa tus Enviados»): el vendedor pudo borrarlo, así que NUNCA se certifica
 * «no salió». Nunca reenvía.
 */
export async function reconciliarDesconocidos(ahora: Date = new Date()): Promise<void> {
  if (!gmailConfigurado()) return
  const conexiones = await conexionesActivas('crm-gmail.reconciliar.conexiones')

  for (const conexion of conexiones) {
    try {
      const pendientes = await prisma.crmEmailMessage.findMany({
        where: {
          staffId: conexion.staffId,
          direction: 'SALIDA',
          fromEmail: conexion.googleEmail,
          rfcMessageId: { not: null },
          OR: [
            { status: 'ENVIANDO', createdAt: { lt: new Date(ahora.getTime() - 10 * MIN) } },
            // `notIn` deja fuera los NULL en SQL: por eso el `error: null` aparte.
            { status: 'DESCONOCIDO', OR: [{ error: null }, { error: { notIn: FINALES } }] },
          ],
        },
        select: { id: true, rfcMessageId: true, status: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        // ponytail: 20 por conexión y vuelta; a las 24 h cada pendiente sale de la fila, así que no se acumulan.
        take: PENDIENTES_POR_CONEXION,
      })
      if (!pendientes.length) continue

      const gmail = clienteGmail(conexion.refreshTokenCiphertext)
      for (const pendiente of pendientes) {
        const rfc = pendiente.rfcMessageId!.replace(/^<|>$/g, '')
        const { data } = await gmail.users.messages.list({ userId: 'me', q: `in:sent rfc822msgid:${rfc}`, maxResults: 1 })
        const hallado = data.messages?.[0]
        if (hallado?.id) {
          await prisma.crmEmailMessage.updateMany({
            where: { id: pendiente.id, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
            data: {
              status: 'ENVIADO',
              gmailMessageId: hallado.id,
              gmailThreadId: hallado.threadId ?? null,
              sentAt: pendiente.createdAt,
              error: null,
            },
          })
        } else if (pendiente.createdAt.getTime() <= ahora.getTime() - 24 * 60 * MIN) {
          await prisma.crmEmailMessage.updateMany({
            where: { id: pendiente.id, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
            data: { status: 'DESCONOCIDO', error: ERROR_NO_ENCONTRADO },
          })
        } else if (pendiente.status === 'ENVIANDO') {
          // Un proceso que murió a media petición: la ficha ya dice «no sabemos si salió», y se sigue buscando.
          await prisma.crmEmailMessage.updateMany({
            where: { id: pendiente.id, status: 'ENVIANDO' },
            data: { status: 'DESCONOCIDO', error: ERROR_SIN_RESPUESTA },
          })
        }
      }
    } catch (error) {
      // El error de una conexión no detiene a las demás.
      if (esInvalidGrant(error)) {
        await marcarRevocada(conexion.staffId, conexion.version, ahora)
      } else {
        logger.error('[CRM] Could not reconcile the uncertain Gmail sends of a seller', {
          staffId: conexion.staffId,
          error: mensajeDe(error),
        })
        await anotarError(conexion.staffId, conexion.version, error)
      }
    }
  }
}
