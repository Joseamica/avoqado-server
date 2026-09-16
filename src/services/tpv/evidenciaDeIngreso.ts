/**
 * Codex R12-1 / R13-1 / R14-1 (checkpoint 1 del webhook): la PRIMERA EVIDENCIA DURABLE del intento y la tarifa que el receptor
 * del webhook capturó en ese instante.
 *
 * La tarifa de un cobro se congela sobre la PRIMERA evidencia bancaria aceptada del cargo. Cuando esa evidencia es un webhook
 * `approved`, el receptor la captura AL INGRESO y la persiste DENTRO del evento (`_avoqado.tarifaCongeladaAlIngreso`). TODO origen
 * que después CREE el Payment del cargo —el registrador del webhook (con SU evento o con uno posterior), S4 (la recuperación tras
 * una caída) y el REST de la terminal que llega con la misma llave— consume la captura de ESA primera evidencia, nunca captura
 * «ahora» y nunca la captura de un evento posterior del mismo intento (Codex R14-1: E1 al 2.5 % cuyo registrador murió, edición al
 * 8 %, E2 con otro `eventId` creaba el Payment con SU captura ⇒ $8.50 en vez de $3).
 *
 * «Primera» es un orden DURABLE: `(createdAt, id)` de los eventos aprobados del intento en este venue, con el aprobado elegido
 * EN SQL antes de cualquier límite (R14-1: diez rechazos seguidos de un aprobado ya no lo esconden) y con la clasificación
 * bancaria compartida (`estadoBancarioSql`, R14-3). El ingreso de cada evento del intento y la decisión durable del Payment
 * comparten el candado del intento (`candadoDeIntento`), y bajo ese candado el ingreso fecha cada evento estrictamente después
 * del anterior del mismo intento: quien llega segundo ve lo que el primero dejó commiteado, y el orden no depende del reloj de
 * inicio de una transacción que esperó.
 *
 * Pertenencia (se conserva, no se relaja): el evento tiene que ser del MISMO intento (`attemptId` canónico), del MISMO venue,
 * `send_transaction` aprobado, y recibido por la MISMA afiliación a la que se atribuye el cobro. Un evento del intento recibido por
 * OTRA afiliación no acredita la tarifa de ésta ni autoriza capturar la de hoy: la incertidumbre se conserva (captura fallida con
 * motivo, costo pendiente y visible). Nunca se confía en una captura enviada por el cliente: sólo la persistida.
 * Codex R15-1: si la espera del candado vence al ingresar (55P03) el evento se persiste igual —perder la evidencia del banco sería
 * peor— pero MARCADO (`_avoqado.ingresoSinCandado`) y sin orden durable; mientras exista una marca así en el intento, NINGUNA
 * evidencia del intento acredita la tarifa (`ORDEN_NO_ACREDITADO`): el cobro se registra con captura fallida y motivo público, y su
 * costo queda pendiente hasta una acreditación explícita. La recuperación bajo el candado (`ordenarIngresosSinCandado`, en el servicio
 * del webhook) le da un orden de RECUPERACIÓN y sella `ordenadoEn`, pero la marca se CONSERVA: un orden de recuperación no demuestra
 * la prioridad histórica.
 * Módulo sin efectos propios: una consulta acotada (`LIMIT 1` sobre los aprobados), sin escritura.
 */
import { Prisma } from '@prisma/client'
import type { TarifaCongelada } from '../payments/transactionCost.service'
import { estadoBancarioSql } from './estadoBancario'

export type TarifaCapturadaAlIngreso = { slot: TarifaCongelada['slot']; pricing: TarifaCongelada | null }

/** Codex R12-1: la captura al ingreso, tal como quedó persistida en el evento (`_avoqado.tarifaCongeladaAlIngreso`), o null si no la hay. */
export function tarifaCapturadaAlIngresoDe(payload: unknown): TarifaCapturadaAlIngreso | null {
  const avoqado = (payload as { _avoqado?: { tarifaCongeladaAlIngreso?: unknown } } | null)?._avoqado
  const t = avoqado?.tarifaCongeladaAlIngreso
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null
  const r = t as { slot?: unknown; pricing?: unknown }
  const slot = r.slot === 'PRIMARY' || r.slot === 'SECONDARY' || r.slot === 'TERTIARY' ? r.slot : null
  const pricing = r.pricing && typeof r.pricing === 'object' && !Array.isArray(r.pricing) ? (r.pricing as TarifaCongelada) : null
  return pricing ? { slot, pricing } : null
}

export type EvidenciaDeIngreso =
  /** Evento pertinente CON captura persistida: el origen que crea el Payment la consume tal cual. */
  | { tipo: 'CON_CAPTURA'; eventLogId: string; captura: TarifaCapturadaAlIngreso }
  /** Evento pertinente SIN captura (anterior a la regla): se conserva la incertidumbre — nunca VALIDO desde la configuración de hoy. */
  | { tipo: 'SIN_CAPTURA'; eventLogId: string }
  /** Evento del intento recibido por OTRA afiliación (o sin afiliación receptora): no acredita esta tarifa ni autoriza capturar «ahora». */
  | { tipo: 'OTRA_AFILIACION'; eventLogId: string; receivedByMerchantAccountId: string | null }
  /**
   * Codex R15-1: algún evento del intento entró por el FALLBACK del ingreso (la espera del candado venció, 55P03) y quedó marcado
   * `_avoqado.ingresoSinCandado`: su posición histórica no es demostrable — aunque después reciba un orden de recuperación — y por
   * tanto NINGUNA evidencia del intento acredita la tarifa: incertidumbre conservada, nunca la tarifa de hoy.
   */
  | { tipo: 'ORDEN_NO_ACREDITADO' }

export const MOTIVO_SIN_CAPTURA_AL_INGRESO = 'SIN_CAPTURA_AL_INGRESO'
export const MOTIVO_EVIDENCIA_DE_OTRA_AFILIACION = 'EVIDENCIA_DE_INGRESO_DE_OTRA_AFILIACION'
/** Codex R14-1: el registrador del webhook no encontró NINGÚN aprobado del intento (ni el suyo): incertidumbre, nunca la tarifa de hoy. */
export const MOTIVO_EVIDENCIA_DE_INGRESO_NO_VISIBLE = 'EVIDENCIA_DE_INGRESO_NO_VISIBLE'
/** Codex R15-1: un ingreso del intento entró sin candado (55P03): el orden histórico de la evidencia no está acreditado. */
export const MOTIVO_EVIDENCIA_DE_INGRESO_SIN_ORDEN = 'EVIDENCIA_DE_INGRESO_SIN_ORDEN'

/** Marca durable (dentro de `_avoqado`) de un evento que entró por el fallback del ingreso; `ordenadoEn` la sella la recuperación. */
export const MARCA_INGRESO_SIN_CANDADO = 'ingresoSinCandado'

const afiliacionReceptora = (payload: unknown): string | null => {
  const recibidoPor = (payload as { _avoqado?: { receivedByMerchantAccountId?: unknown } } | null)?._avoqado?.receivedByMerchantAccountId
  return typeof recibidoPor === 'string' && recibidoPor ? recibidoPor : null
}

/**
 * La PRIMERA evidencia durable APROBADA del intento en este venue (orden durable `(createdAt, id)`; el aprobado se elige en SQL,
 * antes del límite), clasificada por pertenencia y captura. `null` = no hay evento aprobado del intento: quien crea el Payment
 * es la primera evidencia y —si es el REST— captura al cobrar. Se consulta con el cliente de la transacción que ya tiene el
 * candado del intento: así la lectura y la decisión durable del Payment son una sola fotografía frente al ingreso.
 */
export async function evidenciaDurableDelIngreso(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  venueId: string,
  merchantAccountId: string,
  llaveDelIntento: string,
): Promise<EvidenciaDeIngreso | null> {
  // Codex R15-1: UNA sola sentencia decide las dos cosas —¿hay algún ingreso del intento sin orden acreditado? y ¿cuál es el
  // primer aprobado?— sobre la misma fotografía: entre dos consultas podría publicarse otro fallback fuera del candado.
  const [fila] = await db.$queryRaw<{ sinOrden: boolean; primeraId: string | null; primeraPayload: unknown }[]>`
    WITH intento AS (
      SELECT e."id", e."payload", e."createdAt"
      FROM "ProviderEventLog" e
      WHERE e."provider" = 'PAYMENT_PROCESSOR'
        AND e."attemptId" = ${llaveDelIntento}
        AND e."venueId" = ${venueId}
        AND e."type" = 'send_transaction'
    ),
    primera AS (
      SELECT "id", "payload" FROM intento
      WHERE ${estadoBancarioSql(Prisma.sql`"payload"->'payload'->'status'`)} = 'APROBADO'
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
    )
    SELECT
      EXISTS (
        SELECT 1 FROM intento WHERE jsonb_typeof("payload"->'_avoqado'->${Prisma.raw(`'${MARCA_INGRESO_SIN_CANDADO}'`)}) = 'object'
      ) AS "sinOrden",
      (SELECT "id" FROM primera) AS "primeraId",
      (SELECT "payload" FROM primera) AS "primeraPayload"`
  if (fila?.sinOrden) return { tipo: 'ORDEN_NO_ACREDITADO' }
  if (!fila?.primeraId) return null
  const primera = { id: fila.primeraId, payload: fila.primeraPayload }
  const recibidoPor = afiliacionReceptora(primera.payload)
  if (recibidoPor !== merchantAccountId)
    return { tipo: 'OTRA_AFILIACION', eventLogId: primera.id, receivedByMerchantAccountId: recibidoPor }
  const captura = tarifaCapturadaAlIngresoDe(primera.payload)
  return captura ? { tipo: 'CON_CAPTURA', eventLogId: primera.id, captura } : { tipo: 'SIN_CAPTURA', eventLogId: primera.id }
}
