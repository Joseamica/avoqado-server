/**
 * Cobro simple · S1 (founder, 22-nov-2026, «A todo automático»): manda lo que contesta el procesador. Aprobado o rechazado se
 * escriben al momento; SÓLO si no llega ninguna respuesta la solicitud entra a «sin respuesta» y espera a lo más 10 s el aviso del
 * banco. Si no llega, `cerrarSinRespuesta` (terminal-payment.service) la cierra «no cobrada» con la forma que todas las apps de la
 * calle ya pintan como «puedes volver a cobrar». Nadie declara ni pone PIN; la terminal no se aparta por la duda.
 *
 * Aquí viven las constantes y la ENTRADA (un CAS puro sobre la fila). Lo que necesita al servicio (el cancel a la terminal, el
 * temporizador, el cierre) vive en `terminal-payment.service.ts`. Diseño: `docs/audit/2026-11-22-cobro-simple/diseno.md` §3.
 */
import { Prisma } from '@prisma/client'
import { utcTs, utcTsOrNull } from '../../utils/sqlDates'

/** Lo que espera el SERVIDOR el aviso del banco tras quedarse sin respuesta. */
export const SIN_RESPUESTA_MS = 10_000
/** Una TPV vieja que contesta «sigo cobrando» tras el cancel del POS se tolera esto desde el cancel; luego, «sin respuesta». */
export const TOPE_SIGO_TRAS_CANCEL_MS = 30_000
/** Una solicitud SENT con acuse de hace más que esto, sin final, se le pregunta a la terminal (el patrón del 22-nov). */
export const SIN_FINAL_TRAS_ACUSE_MS = 60_000
/** El tope de una llamada al SDK: un «sigo cobrando» (ACTIVE) no se tolera más allá de esto desde el acuse. */
export const TOPE_DE_UNA_LLAMADA_AL_SDK_MS = 150_000
/**
 * Codex S1 r3 (R3-10): una solicitud PENDING entregada por el protocolo CON acuse que lleva esto sin acusar desde su último envío
 * entra a «sin respuesta» desde el vigía (un reinicio entre guardarla y su acuse la dejaba esperando los 5 min). El acuse se espera 5 s;
 * una entrega LEGACY (TPV sin acuse) se queda PENDING toda su vida a propósito y nunca entra por aquí.
 */
export const SIN_ACUSE_TRAS_ENVIO_MS = 30_000
/** «Aprobado, por registrar»: si a los 5 min el aviso aprobado sigue sin `Payment`, 🚨 a operaciones (una vez por fila). */
export const APROBADO_SIN_REGISTRO_MS = 5 * 60_000
/**
 * Tope de los intentos ligados que leen los cierres de S1 (`cerrarSinRespuesta`, `reconcileBankDeclined`) para tomar sus candados.
 * Una solicitud real tiene uno o unos cuantos (un intento por toque en la terminal). ponytail: lo que pase de 100 no se lee (ni se
 * candadea ni cuenta para los vetos por llave; los vetos por `requestId` del CAS sí lo cubren); paginar si algún día es alcanzable.
 */
export const TOPE_DE_INTENTOS_POR_SOLICITUD = 100

/** Por qué quedó sin respuesta. Viaja en `resultJson.noChargeCause` y, al cerrar, en el campo opcional `noChargeCause`. */
export type CausaSinRespuesta = 'NO_RESPONSE' | 'ACK_TIMEOUT' | 'TERMINAL_GONE'

/** Los 10 s, acortables SÓLO fuera de producción (pruebas que esperan el temporizador real). Mismo patrón que `longPollMs`. */
export function sinRespuestaMs(): number {
  const override = Number(process.env.TERMINAL_PAYMENT_SIN_RESPUESTA_MS)
  return Number.isFinite(override) && override >= 50 && process.env.NODE_ENV !== 'production' ? override : SIN_RESPUESTA_MS
}

/**
 * ENTRADA a «sin respuesta», un solo UPDATE condicional: una fila EN VUELO (o UNKNOWN todavía sin reloj) pasa a UNKNOWN con
 * `noResponseAt` sellado UNA vez (un segundo hecho no alarga los 10 s) y la causa en el sobre. La ranura de la terminal se suelta
 * en el mismo UPDATE (UNKNOWN ya no está en el índice parcial). El sobre se FUNDE (`||`): una afirmación de cobro que ya estuviera
 * guardada (`claimedSuccess`) se conserva y el cierre la respeta. `failureCode` sólo se escribe al salir de vuelo (diagnóstico:
 * `ACK_TIMEOUT`, `SOCKET_NOT_FOUND`…); una UNKNOWN conserva el suyo. Devuelve si entró.
 */
export async function entrarSinRespuesta(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  input: {
    requestId: string
    venueId: string
    causa: CausaSinRespuesta
    failureCode?: string | null
    /** Lo que la terminal contestó, si contestó (`terminalResult`), o el texto del servidor. Se funde con el sobre. */
    sobre?: Record<string, unknown>
    /**
     * El reloj del SERVIDOR (no el `NOW()` de la base): el cierre compara con el mismo reloj, así un desfase entre la app y la base
     * no adelanta ni atrasa los 10 s. Las pruebas lo usan para simular el paso del tiempo.
     */
    ahora?: Date
    /**
     * Respeta un «sigo cobrando» (ACTIVE) que la terminal contestó al cancel del POS mientras su cancel sea posterior a esta hora
     * (el tope de 30 s). Lo usan el vigía y la revisión del cancel; una terminal que se fue (`TERMINAL_GONE`) no lo respeta.
     */
    respetarActiveHasta?: Date
    /**
     * Sólo desde ese estado: `SENT` en el barrido de las acusadas sin final (R2-7: un cancel del POS en medio no entra por ahí) y
     * `PENDING` en el acuse perdido de una reentrega o en el barrido de las que nunca acusaron (R3-10).
     */
    soloDesde?: 'SENT' | 'PENDING'
    /** Codex S1 r3 (R3-9): sólo si `probeActiveAt` sigue siendo éste (un ACTIVE sellado después de la lectura gana). */
    probeActiveAtLeido?: Date | null
  },
): Promise<boolean> {
  const sobre = {
    requestId: input.requestId,
    status: 'timeout',
    errorMessage: 'Confirmando con el banco…',
    ...(input.sobre ?? {}),
    noChargeCause: input.causa,
  }
  const n = await db.$executeRaw`
    UPDATE "TerminalPaymentRequest"
    SET "status" = 'UNKNOWN'::"TerminalPaymentRequestStatus",
        "noResponseAt" = COALESCE("noResponseAt", ${utcTs(input.ahora ?? new Date())}),
        "failureCode" = CASE WHEN "status" = 'UNKNOWN'::"TerminalPaymentRequestStatus" THEN "failureCode" ELSE ${input.failureCode ?? null} END,
        "resultJson" = COALESCE("resultJson", '{}'::jsonb) || ${JSON.stringify(sobre)}::jsonb,
        "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "requestId" = ${input.requestId} AND "venueId" = ${input.venueId}
      AND ${
        input.soloDesde
          ? Prisma.sql`"status" = ${input.soloDesde}::"TerminalPaymentRequestStatus"`
          : Prisma.sql`("status" IN ('PENDING', 'SENT', 'CANCEL_REQUESTED') OR ("status" = 'UNKNOWN' AND "noResponseAt" IS NULL))`
      }
      ${input.probeActiveAtLeido !== undefined ? Prisma.sql`AND "probeActiveAt" IS NOT DISTINCT FROM ${utcTsOrNull(input.probeActiveAtLeido)}` : Prisma.empty}
      ${
        input.respetarActiveHasta
          ? Prisma.sql`AND NOT ("status" = 'CANCEL_REQUESTED' AND "cancelDisposition" IS NOT DISTINCT FROM 'ACTIVE'
              AND COALESCE("cancelRequestedAt", "updatedAt") > ${utcTs(input.respetarActiveHasta)})`
          : Prisma.empty
      }`
  return n > 0
}
