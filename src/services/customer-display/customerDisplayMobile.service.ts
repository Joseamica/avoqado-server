// src/services/customer-display/customerDisplayMobile.service.ts
import { TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { NotFoundError, ServiceUnavailableError } from '@/errors/AppError'
import { canonicalJson } from './canonicalHash'
import { acuseLegible } from './customerDisplayAckView'
import { getEffectiveDesign } from './customerDisplayDesign.service'
import type { FichaEfectiva } from './customerDisplayDesign.effective'
import { STORAGE_ORIGINS } from './storageOrigins'

/**
 * Lo que la TABLET pide de su pantalla del cliente (spec §5.7.1, §5.7.2): su ficha y su ack. Binding EXACTO
 * `{ venueId, deviceUid: X-Device-ID, type: POS_ANDROID }`, sin respaldo a otra terminal. 🔴 La terminal se resuelve SIEMPRE
 * acotada al negocio antes de pedir `'refresh'` (que invalida su caché): un id de otro negocio nunca llega a la caché.
 */

/** El MISMO 404 que ya da el poll: la app lo lee como «este aparato no es de aquí; usa la fábrica». */
function dispositivoNoEncontrado(): NotFoundError {
  return new NotFoundError('Dispositivo POS Android no encontrado.', 'DEVICE_NOT_FOUND')
}

const bindingDe = (venueId: string, deviceUid: string) => ({ venueId, deviceUid, type: TerminalType.POS_ANDROID })

export async function getMobileCustomerDisplay(
  venueId: string,
  deviceUid: string,
): Promise<{ terminalId: string; ficha: FichaEfectiva; imageOrigins: string[] }> {
  const aparato = await prisma.terminal.findFirst({ where: bindingDe(venueId, deviceUid), select: { id: true } })
  if (!aparato) throw dispositivoNoEncontrado()
  // Fresca y escrita a través de la caché: la huella que la tablet guarda es la que verá en su siguiente poll.
  const { ficha } = await getEffectiveDesign(venueId, aparato.id, { cache: 'refresh' })
  return { terminalId: aparato.id, ficha, imageOrigins: [...STORAGE_ORIGINS] }
}

export const CLIENT_CLOCK_TOLERANCE_MS = 5 * 60_000

/** Una hora de la tablet más de 5 min POR DELANTE de la llegada se sustituye por la del servidor y se marca. */
export function acotarHoraDelCliente(declarada: string | null, recibida: Date): { valor: string | null; adelantada: boolean } {
  if (declarada === null) return { valor: null, adelantada: false }
  const t = Date.parse(declarada)
  if (!Number.isFinite(t) || t - recibida.getTime() > CLIENT_CLOCK_TOLERANCE_MS) return { valor: recibida.toISOString(), adelantada: true }
  return { valor: new Date(t).toISOString(), adelantada: false }
}

export interface AckInput {
  installationId: string
  fingerprint: string
  seq: number
  storedAt: string
  shownAt: string | null
  surface: 'presentation' | 'activity' | 'kiosk' | 'window' | null
  imagesReady: number
  imagesPending: number
  imagesFailed: number
  unsupportedSchema: boolean
}

export interface AckGuardado {
  fingerprint: string
  seq: number
  /** Hora del SERVIDOR: la única que el dashboard muestra (spec §6.1). */
  receivedAt: string
  storedAt: string | null
  shownAt: string | null
  clientClockSkew: boolean
  surface: AckInput['surface']
  imagesReady: number
  imagesPending: number
  imagesFailed: number
  unsupportedSchema: boolean
}

/** Lo que se guarda: las horas en ISO-8601 con `Z` (F1 descarta todo acuse cuyo `receivedAt` no lo sea). */
export function armarAcuse(body: AckInput, recibido: Date): AckGuardado {
  const guardada = acotarHoraDelCliente(body.storedAt, recibido)
  const mostrada = acotarHoraDelCliente(body.shownAt, recibido)
  return {
    fingerprint: body.fingerprint,
    seq: body.seq,
    receivedAt: recibido.toISOString(),
    storedAt: guardada.valor,
    shownAt: mostrada.valor,
    clientClockSkew: guardada.adelantada || mostrada.adelantada,
    surface: body.surface,
    imagesReady: body.imagesReady,
    imagesPending: body.imagesPending,
    imagesFailed: body.imagesFailed,
    unsupportedSchema: body.unsupportedSchema,
  }
}

export type AckResult =
  | { accepted: true; current?: boolean; currentFingerprint?: string }
  | { accepted: false; reason: 'STALE_SEQ' | 'OTHER_INSTALLATION' }

/**
 * Un acuse guardado con el que se puede comparar: el que F1 y el MCP leen como acuse (`acuseLegible`) y con un `seq` entero
 * seguro. Lo demás —basura, el `now()::text` de una QA, un `seq` de 2^53 que ningún `seq` válido supera— no bloquea a nadie:
 * se reemplaza (Codex r1 #3).
 */
function acuseComparable(raw: unknown): AckGuardado | null {
  if (!acuseLegible(raw)) return null
  const seq = (raw as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? (raw as unknown as AckGuardado) : null
}

/**
 * ¿Es un REENVÍO del acuse guardado? Lo es si, recibido a la hora del original, se guardaría EXACTAMENTE lo mismo: todo el
 * contenido normalizado —horas acotadas incluidas—, no sólo `seq` y huella (Codex r1 #3).
 */
function esReenvio(previo: AckGuardado, body: AckInput): boolean {
  return canonicalJson(armarAcuse(body, new Date(previo.receivedAt))) === canonicalJson(previo)
}

/** R10: cuántas veces se relee si otro escribió entre la lectura y la escritura. */
export const ACK_CAS_MAX_INTENTOS = 3

/**
 * El ack de la tablet: un REPORTE del cliente, no una prueba física (spec §5.7.1). `accepted` = «guardé lo que dices
 * mostrar», no «es lo vigente»; `current` se decide con la ficha recalculada SIN caché.
 *
 * Sin bitácora a propósito: es un reporte de aparato de alta frecuencia, como el latido (Global Constraints del plan).
 */
export async function acknowledgeCustomerDisplay(
  venueId: string,
  deviceUid: string,
  body: AckInput,
  ahora: Date = new Date(),
): Promise<AckResult> {
  let terminalId: string | null = null
  let guardado = false
  for (let intento = 0; intento < ACK_CAS_MAX_INTENTOS && !guardado; intento++) {
    // El acuse como TEXTO: el CAS compara exactamente lo que hay, aunque sea basura o un número que JavaScript redondea.
    const [fila] = await prisma.$queryRaw<Array<{ id: string; instalacion: string | null; ack: string | null }>>`
      SELECT id, "customerDisplayInstallationId" AS instalacion, "customerDisplayAck"::text AS ack
        FROM "Terminal"
       WHERE "venueId" = ${venueId} AND "deviceUid" = ${deviceUid} AND "type" = 'POS_ANDROID'
       LIMIT 1`
    if (!fila) throw dispositivoNoEncontrado()
    terminalId = fila.id
    // 🔴 Sólo la instalación registrada: un ack viejo de otra no vuelve a ocupar lo que el reporte de la nueva limpió.
    if (fila.instalacion !== body.installationId) return { accepted: false, reason: 'OTHER_INSTALLATION' }
    const previo = acuseComparable(fila.ack === null ? null : JSON.parse(fila.ack))
    if (previo && esReenvio(previo, body)) {
      guardado = true // la respuesta anterior se perdió: se acepta y no se escribe nada
      break
    }
    if (previo && previo.seq >= body.seq) return { accepted: false, reason: 'STALE_SEQ' }
    // 🔴 UNA escritura condicionada (spec §5.7.2): binding exacto + la instalación registrada + el acuse que se leyó, tal
    // cual (también si era NULL o ilegible). Sin fechas atadas: las horas viajan dentro del JSON.
    const escritas = await prisma.$executeRaw`
      UPDATE "Terminal"
         SET "customerDisplayAck" = ${JSON.stringify(armarAcuse(body, ahora))}::jsonb
       WHERE id = ${fila.id}
         AND "venueId" = ${venueId}
         AND "deviceUid" = ${deviceUid}
         AND "type" = 'POS_ANDROID'
         AND "customerDisplayInstallationId" = ${body.installationId}
         AND "customerDisplayAck"::text IS NOT DISTINCT FROM ${fila.ack}::text`
    guardado = escritas === 1 // 0: alguien escribió en medio (otro acuse, un reporte, una mudanza): se relee
  }
  if (!guardado || terminalId === null) {
    // 🔴 Codex r2 N1: perder los tres CAS NO prueba `STALE_SEQ` (pudieron ganar acuses MÁS VIEJOS). Reintentable: la app conserva
    // el ack y lo vuelve a mandar con espera (spec §8: «5xx → lo conserva y reintenta»).
    throw new ServiceUnavailableError('Otros acuses de este aparato se están guardando; vuelve a intentarlo.', 'CUSTOMER_DISPLAY_ACK_BUSY')
  }

  try {
    const { ficha } = await getEffectiveDesign(venueId, terminalId, { cache: 'refresh' })
    return ficha.fingerprint === body.fingerprint
      ? { accepted: true, current: true }
      : { accepted: true, current: false, currentFingerprint: ficha.fingerprint }
  } catch (error) {
    // DD5: el ack SÍ quedó guardado; decir `current: false` sería mentir.
    logger.warn('[pantalla-del-cliente] ack guardado, pero no se pudo recalcular la ficha vigente', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { accepted: true }
  }
}
