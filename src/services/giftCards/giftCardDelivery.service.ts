// src/services/giftCards/giftCardDelivery.service.ts
/**
 * La entrega de tarjetas de regalo por WhatsApp y correo (1b S3; índice Q1–Q4, Q19, Q38, Q43, Q46, Q103, Q105).
 *
 * La hace un trabajo, no una promesa en memoria (Q1): cada minuto (y cuando las apps consultan la cuenta o alguien reenvía, S4)
 * `entregarTarjetas` RECLAMA en la fila las tarjetas que tocan, manda fuera de cualquier transacción y escribe el resultado con
 * CAS sobre el reclamo y la liga (Q38). El reclamo cuenta el intento ANTES de mandar: si el proceso muere a media entrega, el
 * intento ya está contado y el reclamo vence a los 5 minutos; el 4.º atorado pasa a FAILED con `UNCONFIRMED`.
 *
 * 🔴 Ningún log de aquí lleva el `pageToken`, la liga, el código ni el teléfono o correo (el teléfono lo registra
 * `whatsapp.service.ts` como hoy).
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import emailService from '@/services/email.service'
import {
  CODIGOS_DE_PLANTILLA_NO_DISPONIBLE,
  WhatsappCloudApiError,
  sendGiftCardDeliveryWhatsApp,
  whatsappConfigurado,
} from '@/services/whatsapp.service'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { urlDeLaPagina, type CodigoDeFalloDeEntrega } from './giftCardEntrega'
import { anotarFalloTemprano, falloTemprano } from './giftCardFallosTempranos'
import { formatoPesos } from './giftCardLimits'

export const MAX_INTENTOS_DE_ENTREGA = 4
/** Q2: tras el intento 1, 2 y 3. */
export const ESPERA_ENTRE_INTENTOS_MIN = [1, 5, 30] as const
export const RECLAMO_VENCE_MS = 5 * 60_000
export const LOTE_DE_ENTREGA = 50

type CodigoDeAviso = 'WHATSAPP_UNDELIVERED' | 'EMAIL_INVALID_ADDRESS' | 'EMAIL_SEND_FAILED'

/**
 * Q105: los avisos de Resend que marcan la tarjeta (verificados en vivo el 20-oct en resend.com/docs/webhooks/event-types):
 * rebotado y suprimido no llegaron; `email.failed` es un error al mandar. `email.complained` (sí llegó), `delivery_delayed`
 * (temporal) y los de seguimiento no tocan la tarjeta. Sin prototipo: un `type` como `toString` da ausente.
 */
export const FALLO_FINAL_DE_CORREO: Readonly<Record<string, 'EMAIL_INVALID_ADDRESS' | 'EMAIL_SEND_FAILED'>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, 'EMAIL_INVALID_ADDRESS' | 'EMAIL_SEND_FAILED'>, {
    'email.bounced': 'EMAIL_INVALID_ADDRESS',
    'email.suppressed': 'EMAIL_INVALID_ADDRESS',
    'email.failed': 'EMAIL_SEND_FAILED',
  }),
)

export interface EntregaReclamada {
  id: string
  venueId: string
  deliveryChannel: 'WHATSAPP' | 'EMAIL'
  recipientPhone: string | null
  recipientEmail: string | null
  recipientName: string | null
  purchaserName: string | null
  codeLast4: string
  pageToken: string
  initialAmount: Prisma.Decimal
  /** Ya contando ESTE intento (el reclamo lo suma). */
  deliveryAttempts: number
  deliveryOperationKey: string | null
  deliveryClaimedAt: Date
}

export interface ResultadoDeEntrega {
  reclamadas: number
  enviadas: number
  reprogramadas: number
  fallidas: number
  atoradas: number
}

interface Atorada {
  id: string
  venueId: string
  deliveryChannel: 'WHATSAPP' | 'EMAIL'
}

type Desenlace = 'enviadas' | 'reprogramadas' | 'fallidas' | null

const C = Prisma.raw('c')
const G = Prisma.raw('g')

const reclamoVencidoAntesDe = (ahora: Date) => new Date(ahora.getTime() - RECLAMO_VENCE_MS)

/** Lo que el reclamo toma (Q1, Q2): sin reclamo vivo, con turno, sin vencer y con intentos. */
function reclamable(t: Prisma.Sql, ahora: Date): Prisma.Sql {
  return Prisma.sql`${t}."deliveryStatus" = 'PENDING' AND ${t}."status" = 'ACTIVE' AND ${t}."deliveryChannel" IN ('WHATSAPP', 'EMAIL')
    AND (${t}."expiresAt" IS NULL OR ${t}."expiresAt" > ${utcTs(ahora)})
    AND ${t}."deliveryAttempts" < ${MAX_INTENTOS_DE_ENTREGA}
    AND (${t}."deliveryNextAttemptAt" IS NULL OR ${t}."deliveryNextAttemptAt" <= ${utcTs(ahora)})
    AND (${t}."deliveryClaimedAt" IS NULL OR ${t}."deliveryClaimedAt" < ${utcTs(reclamoVencidoAntesDe(ahora))})`
}

/** El 4.º intento cuyo reclamo venció: el proceso murió a media entrega y nadie sabe si el mensaje salió. */
function atorada(t: Prisma.Sql, ahora: Date): Prisma.Sql {
  return Prisma.sql`${t}."deliveryStatus" = 'PENDING' AND ${t}."status" = 'ACTIVE' AND ${t}."deliveryChannel" IN ('WHATSAPP', 'EMAIL')
    AND ${t}."deliveryAttempts" >= ${MAX_INTENTOS_DE_ENTREGA}
    AND (${t}."deliveryClaimedAt" IS NULL OR ${t}."deliveryClaimedAt" < ${utcTs(reclamoVencidoAntesDe(ahora))})`
}

const soloIds = (ids: string[] | undefined): Prisma.Sql => (ids ? Prisma.sql`AND c.id = ANY(${ids})` : Prisma.empty)

/**
 * UN `UPDATE … RETURNING`: la subconsulta toma filas con `FOR UPDATE SKIP LOCKED` y el `WHERE` exterior repite la condición,
 * así que bajo READ COMMITTED una segunda transacción que llega tarde la reevalúa y no gana. Suma el intento y sella el reclamo.
 * `db` sólo lo pasa la prueba de la carrera, para sostener un reclamo sin confirmar (molde de S2); la entrega usa el global.
 */
export async function reclamarEntregas(
  p: { ahora: Date; ids?: string[]; limite?: number },
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
): Promise<EntregaReclamada[]> {
  if (p.ids && p.ids.length === 0) return []
  const limite = Math.max(1, Math.min(LOTE_DE_ENTREGA, p.limite ?? LOTE_DE_ENTREGA))
  return db.$queryRaw<EntregaReclamada[]>`
    UPDATE "GiftCard" AS g
    SET "deliveryClaimedAt" = ${utcTs(p.ahora)}, "deliveryAttempts" = g."deliveryAttempts" + 1, "updatedAt" = ${utcTs(p.ahora)}
    WHERE g.id IN (
      SELECT c.id FROM "GiftCard" AS c
      WHERE ${reclamable(C, p.ahora)} ${soloIds(p.ids)}
      ORDER BY c.id
      LIMIT ${limite}
      FOR UPDATE SKIP LOCKED
    )
      AND ${reclamable(G, p.ahora)}
    RETURNING g.id, g."venueId", g."deliveryChannel"::text AS "deliveryChannel", g."recipientPhone", g."recipientEmail",
      g."recipientName", g."purchaserName", g."codeLast4", g."pageToken", g."initialAmount", g."deliveryAttempts",
      g."deliveryOperationKey", g."deliveryClaimedAt"`
}

/** Lectura pura (la entrada del trabajo, la que va con `retry`): reclamables O atoradas en el 4.º intento. */
export async function hayEntregasPendientes(ahora: Date): Promise<boolean> {
  const [fila] = await prisma.$queryRaw<Array<{ hay: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "GiftCard" AS g WHERE (${reclamable(G, ahora)}) OR (${atorada(G, ahora)})) AS hay`
  return fila?.hay === true
}

/** Las atoradas pasan a FAILED con `UNCONFIRMED`. El reclamo se conserva: si el envío viejo sí termina, su resultado gana. */
async function cerrarAtoradas(ahora: Date, ids: string[] | undefined): Promise<Atorada[]> {
  if (ids && ids.length === 0) return []
  return prisma.$queryRaw<Atorada[]>`
    UPDATE "GiftCard" AS g
    SET "deliveryStatus" = 'FAILED', "deliveryErrorCode" = 'UNCONFIRMED', "deliveryNextAttemptAt" = NULL, "updatedAt" = ${utcTs(ahora)}
    WHERE g.id IN (
      SELECT c.id FROM "GiftCard" AS c
      WHERE ${atorada(C, ahora)} ${soloIds(ids)}
      ORDER BY c.id
      LIMIT ${LOTE_DE_ENTREGA}
      FOR UPDATE SKIP LOCKED
    )
      AND ${atorada(G, ahora)}
    RETURNING g.id, g."venueId", g."deliveryChannel"::text AS "deliveryChannel"`
}

/** Q19: el `logger.error` de cada tarjeta que no se entregó. Sin teléfono, correo, liga ni código. */
function avisarFallo(a: {
  venueId: string
  venueName: string | null
  giftCardId: string
  canal: string
  deliveryErrorCode: CodigoDeFalloDeEntrega | null
  error?: string
}): void {
  logger.error('🎁 [tarjetas de regalo] entrega: la tarjeta no se entregó', a)
}

/** El mensaje de un error, sin la liga ni el destino de la tarjeta (un error de Prisma puede repetir sus argumentos). */
function sinSecretos(error: unknown, e: EntregaReclamada): string {
  const texto = String((error as Error)?.message ?? error)
  return [e.pageToken, e.recipientPhone, e.recipientEmail].reduce<string>((t, s) => (s ? t.split(s).join('…') : t), texto)
}

/**
 * Q4 + Q46: `giftcard:<id>:<llave del reenvío | auto>:<huella de la liga>:<intento>`. Sin la llave del reenvío, un reenvío a
 * mano en 24 h repetiría la del intento 1; sin la huella, el reinicio de Q43 repetiría `…:auto:1` con OTRO contenido y Resend
 * respondería 409, que se toma como definitivo.
 */
export function llaveDeCorreo(e: Pick<EntregaReclamada, 'id' | 'deliveryOperationKey' | 'pageToken' | 'deliveryAttempts'>): string {
  const huellaDeLiga = createHash('sha256').update(e.pageToken).digest('hex').slice(0, 8)
  return `giftcard:${e.id}:${e.deliveryOperationKey ?? 'auto'}:${huellaDeLiga}:${e.deliveryAttempts}`
}

/**
 * Q38 + Q43: el resultado sólo se escribe si la fila sigue con ESTE reclamo y ESTA liga. Si otro la cambió (reenvío a mano,
 * reclamo vencido, cambio de destino), se descarta y la tarjeta sigue PENDING. Si lo único que cambió fue la liga (la reposición
 * del panel no toca la entrega), además se reinicia la entrega: la liga nueva es otra entrega, sin espera y con sus 4 intentos.
 */
async function escribirResultado(e: EntregaReclamada, negocio: string, data: Prisma.GiftCardUpdateManyMutationInput): Promise<boolean> {
  const r = await prisma.giftCard.updateMany({
    where: { id: e.id, deliveryClaimedAt: e.deliveryClaimedAt, pageToken: e.pageToken },
    data,
  })
  if (r.count === 1) return true
  const reinicio = await prisma.giftCard.updateMany({
    where: { id: e.id, deliveryClaimedAt: e.deliveryClaimedAt },
    data: { deliveryClaimedAt: null, deliveryAttempts: 0, deliveryNextAttemptAt: null },
  })
  logger.warn('🎁 [tarjetas de regalo] entrega: la tarjeta cambió mientras se enviaba; ese resultado no se escribe', {
    venueId: e.venueId,
    venueName: negocio,
    giftCardId: e.id,
    canal: e.deliveryChannel,
    ligaNueva: reinicio.count === 1,
  })
  return false
}

async function fallar(e: EntregaReclamada, negocio: string, codigo: CodigoDeFalloDeEntrega): Promise<Desenlace> {
  const escrita = await escribirResultado(e, negocio, {
    deliveryStatus: 'FAILED',
    deliveryErrorCode: codigo,
    deliveryNextAttemptAt: null,
    deliveryClaimedAt: null,
  })
  if (!escrita) return null
  avisarFallo({ venueId: e.venueId, venueName: negocio, giftCardId: e.id, canal: e.deliveryChannel, deliveryErrorCode: codigo })
  return 'fallidas'
}

/** Q2: +1, +5 y +30 min; el 4.º fallo es FAILED. Mientras se reintenta, `deliveryErrorCode` queda null (S-7). */
async function reintentarOFallar(
  e: EntregaReclamada,
  negocio: string,
  codigo: CodigoDeFalloDeEntrega,
  ahora: Date,
  error: unknown,
): Promise<Desenlace> {
  if (e.deliveryAttempts >= MAX_INTENTOS_DE_ENTREGA) return fallar(e, negocio, codigo)
  const espera = ESPERA_ENTRE_INTENTOS_MIN[Math.max(0, e.deliveryAttempts - 1)]
  logger.warn('🎁 [tarjetas de regalo] entrega: no salió; se reintenta', {
    venueId: e.venueId,
    venueName: negocio,
    giftCardId: e.id,
    canal: e.deliveryChannel,
    intento: e.deliveryAttempts,
    enMinutos: espera,
    error: sinSecretos(error, e),
  })
  // El reclamo se suelta: si no, la condición del reclamo (5 min) taparía la espera corta.
  const escrita = await escribirResultado(e, negocio, {
    deliveryNextAttemptAt: new Date(ahora.getTime() + espera * 60_000),
    deliveryErrorCode: null,
    deliveryClaimedAt: null,
  })
  return escrita ? 'reprogramadas' : null
}

/** Q103/Q105: tras escribir SENT con el id, el aviso de fallo que llegó ANTES de esa escritura se aplica aquí. */
async function guardarEnviada(e: EntregaReclamada, negocio: string, messageId: string | null): Promise<Desenlace> {
  const escrita = await escribirResultado(e, negocio, {
    deliveryStatus: 'SENT',
    deliveredAt: new Date(),
    deliveryMessageId: messageId,
    deliveryErrorCode: null,
    deliveryNextAttemptAt: null,
    deliveryClaimedAt: null,
  })
  if (!escrita) return null
  const temprano = messageId ? falloTemprano(messageId) : null
  // Sólo `marcarEntregaFallidaPorMensaje` anota en el mapa, y sólo con estos tres códigos.
  if (messageId && temprano && (await marcarEntregaFallidaPorMensaje(messageId, temprano as CodigoDeAviso))) return 'fallidas'
  return 'enviadas'
}

function plantillaNoDisponible(error: unknown): boolean {
  return (
    error instanceof WhatsappCloudApiError &&
    error.cloudApiErrorCode != null &&
    CODIGOS_DE_PLANTILLA_NO_DISPONIBLE.has(error.cloudApiErrorCode)
  )
}

async function entregarUna(e: EntregaReclamada, negocio: string, ahora: Date): Promise<Desenlace> {
  // Filas de la 1a sin `purchaserName`: «de parte de» el negocio.
  const deParteDe = (e.purchaserName?.trim() || negocio).slice(0, 60)
  const monto = formatoPesos(e.initialAmount)

  if (e.deliveryChannel === 'WHATSAPP') {
    if (!e.recipientPhone) return fallar(e, negocio, 'WHATSAPP_SEND_FAILED')
    if (!whatsappConfigurado()) return fallar(e, negocio, 'TEMPLATE_NOT_AVAILABLE')
    let messageId: string
    try {
      ;({ messageId } = await sendGiftCardDeliveryWhatsApp(e.recipientPhone, {
        negocio,
        monto,
        deParteDe,
        folio: e.codeLast4,
        pageToken: e.pageToken,
      }))
    } catch (error) {
      if (plantillaNoDisponible(error)) return fallar(e, negocio, 'TEMPLATE_NOT_AVAILABLE')
      return reintentarOFallar(e, negocio, 'WHATSAPP_SEND_FAILED', ahora, error)
    }
    // Fuera del try: un fallo al GUARDAR no es un fallo al mandar (no se reprograma un mensaje que ya salió).
    return guardarEnviada(e, negocio, messageId)
  }

  if (!e.recipientEmail) return fallar(e, negocio, 'EMAIL_INVALID_ADDRESS')
  const res = await emailService.sendGiftCardDeliveryEmail(
    e.recipientEmail,
    { negocio, monto, deParteDe, para: e.recipientName?.trim() || null, folio: e.codeLast4, url: urlDeLaPagina(e.pageToken) },
    llaveDeCorreo(e),
  )
  if (res.ok) return guardarEnviada(e, negocio, res.resendId ?? null)
  if (!res.transient) return fallar(e, negocio, 'EMAIL_INVALID_ADDRESS')
  return reintentarOFallar(e, negocio, 'EMAIL_SEND_FAILED', ahora, res.errorCode ?? 'sin respuesta de Resend')
}

async function nombresDeNegocios(venueIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(venueIds)]
  const filas = await prisma.venue.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, take: ids.length })
  return new Map(filas.map(v => [v.id, v.name]))
}

/**
 * Una vuelta: cierra las atoradas, reclama (todas las que tocan o sólo `ids`, a lo más 50) y entrega una por una. Cada tarjeta
 * está aislada: una excepción inesperada deja su `logger.error` (Q19) y su reclamo vence solo a los 5 minutos.
 */
export async function entregarTarjetas(p: { ids?: string[]; ahora?: Date } = {}): Promise<ResultadoDeEntrega> {
  const ahora = p.ahora ?? new Date()
  const atoradas = await cerrarAtoradas(ahora, p.ids)
  const reclamadas = await reclamarEntregas({ ahora, ids: p.ids })
  const r: ResultadoDeEntrega = { reclamadas: reclamadas.length, enviadas: 0, reprogramadas: 0, fallidas: 0, atoradas: atoradas.length }
  if (atoradas.length === 0 && reclamadas.length === 0) return r

  const nombres = await nombresDeNegocios([...atoradas, ...reclamadas].map(x => x.venueId))
  for (const a of atoradas) {
    avisarFallo({
      venueId: a.venueId,
      venueName: nombres.get(a.venueId) ?? null,
      giftCardId: a.id,
      canal: a.deliveryChannel,
      deliveryErrorCode: 'UNCONFIRMED',
    })
  }
  for (const e of reclamadas) {
    const negocio = nombres.get(e.venueId) ?? ''
    try {
      const desenlace = await entregarUna(e, negocio, ahora)
      if (desenlace) r[desenlace] += 1
    } catch (error) {
      avisarFallo({
        venueId: e.venueId,
        venueName: negocio,
        giftCardId: e.id,
        canal: e.deliveryChannel,
        deliveryErrorCode: null,
        error: sinSecretos(error, e),
      })
    }
  }
  return r
}

/**
 * Webhook de Meta o de Resend: el fallo final de ESE mensaje ⇒ FAILED con `codigo` (sólo si la fila sigue SENT con ese
 * `deliveryMessageId`). Q103: ANOTA el aviso ANTES de su CAS, para que el resultado del envío que todavía no se escribe lo vea.
 * Q105: el correo pasa `EMAIL_INVALID_ADDRESS` o `EMAIL_SEND_FAILED`.
 */
export async function marcarEntregaFallidaPorMensaje(messageId: string, codigo: CodigoDeAviso = 'WHATSAPP_UNDELIVERED'): Promise<boolean> {
  anotarFalloTemprano(messageId, codigo)
  const r = await prisma.giftCard.updateMany({
    where: { deliveryMessageId: messageId, deliveryStatus: 'SENT' },
    data: { deliveryStatus: 'FAILED', deliveryErrorCode: codigo },
  })
  if (r.count === 0) return false
  const filas = await prisma.giftCard.findMany({
    where: { deliveryMessageId: messageId, deliveryStatus: 'FAILED' },
    select: { id: true, venueId: true, deliveryChannel: true, venue: { select: { name: true } } },
    take: r.count,
  })
  for (const f of filas) {
    avisarFallo({ venueId: f.venueId, venueName: f.venue.name, giftCardId: f.id, canal: f.deliveryChannel, deliveryErrorCode: codigo })
  }
  return true
}
