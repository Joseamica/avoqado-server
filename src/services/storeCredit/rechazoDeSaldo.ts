// src/services/storeCredit/rechazoDeSaldo.ts
/**
 * El contrato con las apps (S10, I2, «opción b» del controlador): con destino saldo a favor, el Reembolso del POS (`issuePosRefund`) y
 * el Cambio (`createExchange`) rechazan SIEMPRE con un 4xx de prefijo `STORE_CREDIT_`, y ninguno escribió nada: la app borra lo pendiente
 * por el prefijo, sin una lista de códigos. Los rechazos de siempre de esas rutas que no lo traen («No se puede devolver $X»,
 * `EXCHANGE_CHAIN_GIFT_CARD_PENDING`, `REFUND_AUTHORITY_UNAVAILABLE`, la llave mal formada…) salen como `STORE_CREDIT_REJECTED`: el mismo
 * status y el mismo mensaje, y su código en `details.originalCode` (con sus datos, si traía).
 *
 * No se tocan:
 *  - `IDEMPOTENCY_KEY_REUSED`: la llave es de OTRA operación; lo pendiente no se borra (puede que sí se haya escrito con ella);
 *  - `ACTOR_MISMATCH` (el Cambio): se revisa ANTES de reconocer la llave, así que sale aunque un envío anterior con esa misma llave sí
 *    haya escrito (otra sesión reenvía lo pendiente). Envuelto, la app borraría lo pendiente de un Cambio que existe;
 *  - los 5xx: transitorios, se reintentan;
 *  - 401, 403, 408 y 429: sesión, permiso, tiempo y límite tienen su propio trato en las apps (vienen del middleware, de antes del
 *    servicio, y aunque los lance el servicio no se disfrazan);
 *  - lo que no es `AppError` (un error crudo sale como 500).
 * Sólo se aplica a lo lanzado ANTES del commit: estos servicios no lanzan 4xx después de escribir (lo de después es de mejor esfuerzo), y
 * todo lo que puede cambiar entre el envío y el reenvío se mira DESPUÉS de reconocer la llave, bajo su candado (I1).
 */
import AppError from '@/errors/AppError'

const NO_SE_DISFRAZAN = new Set([401, 403, 408, 429])
/** Los códigos que pueden salir aunque la operación con esa llave ya se haya escrito: nunca se dicen «definitivos, nada escrito». */
const CODIGOS_QUE_NO_SE_DISFRAZAN = new Set(['IDEMPOTENCY_KEY_REUSED', 'ACTOR_MISMATCH'])

export function comoRechazoDeSaldo(error: unknown): unknown {
  if (!(error instanceof AppError) || error.statusCode < 400 || error.statusCode >= 500) return error
  if (NO_SE_DISFRAZAN.has(error.statusCode) || CODIGOS_QUE_NO_SE_DISFRAZAN.has(error.code ?? '') || error.code?.startsWith('STORE_CREDIT_'))
    return error
  const datos =
    error.details && typeof error.details === 'object' && !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : error.details === undefined
        ? {}
        : { originalDetails: error.details }
  return new AppError(error.message, error.statusCode, true, 'STORE_CREDIT_REJECTED', { ...datos, originalCode: error.code ?? null })
}
