// src/services/giftCards/giftCardPayKey.ts
/**
 * La llave de un cobro con saldo (1b, Q91 y Q94). La usan `pay-gift-card` (S2) y `pay-new-order` (S2b) con la MISMA llave de
 * candado: una llave de Payment es única por negocio entre las dos rutas.
 *  - Q91: un solo envío por llave a la vez. El candado de la llave es LO PRIMERO de la transacción; con él puesto se vuelve a
 *    buscar el cobro de la llave y se lee la hora de la base. Un reintento espera al primer envío y recibe su cobro, o los dos
 *    se rechazan igual.
 *  - Q91: un rechazo definitivo queda sellado 10 min para esa llave: otro envío en ese lapso recibe el MISMO rechazo, aunque
 *    el saldo haya cambiado.
 *  - Q94: lo que NO se sella (se reintenta con la misma llave) es la tabla del contrato del índice, tal cual.
 *
 * ponytail: el sello es un Map en memoria de UNA instancia (sin Redis, `.claude/rules/una-sola-instancia.md`); con varias
 * instancias, una tabla (venueId, llave, respuesta, venceEn) leída y escrita bajo el mismo candado.
 */
import type { Prisma } from '@prisma/client'
import AppError from '@/errors/AppError'

export const SELLO_DE_RECHAZO_MS = 10 * 60_000

/**
 * Q94: la tabla «Rechazos que se reintentan con la misma llave (Q94)» del contrato del índice, tal cual (sus filas con
 * `code`; las demás —sin respuesta, 5xx, 429— las cubre la regla de `sellarSiEsDefinitivo`). Cambiar esta lista es cambiar
 * esa tabla y las dos apps.
 */
export const CODIGOS_REINTENTABLES: readonly string[] = ['ORDER_PAYMENT_CONFLICT', 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE']

const sellos = new Map<string, { error: AppError; venceEn: number }>()
const claveDe = (venueId: string, llave: string) => `${venueId}:${llave}`

export interface LlaveTomada {
  cobroPrevioId: string | null
  /** La hora de la base leída YA con el candado de la llave (`clock_timestamp()`, no `now()`). */
  ahora: Date
}

/**
 * LO PRIMERO dentro de la `$transaction`: (1) el candado de la llave —un segundo envío espera aquí a que el primero confirme o
 * se deshaga (≤ 15 s, `ORDER_LOCK_WAIT_BUDGET`); orden de candados: llave → Order → sobre → turno—; (2) el cobro de la llave;
 * (3) sin cobro y con sello vigente, el MISMO error sellado; (4) la hora de la base. `clock_timestamp()` y no `now()`: `now()`
 * es la hora en que EMPEZÓ la transacción, antes de esperar el candado. Se compara en JS, nunca contra una columna en SQL.
 */
export async function tomarLlaveDeCobro(tx: Prisma.TransactionClient, venueId: string, llave: string): Promise<LlaveTomada> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'giftpay:' + venueId + ':' + llave}))`
  const previo = await tx.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey: llave } },
    select: { id: true },
  })
  if (!previo) {
    const sellado = rechazoSellado(venueId, llave)
    if (sellado) throw sellado
  }
  const [reloj] = await tx.$queryRaw<Array<{ ms: bigint }>>`SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`
  return { cobroPrevioId: previo?.id ?? null, ahora: new Date(Number(reloj.ms)) }
}

/**
 * En el `catch` del cuerpo de la transacción, ANTES de relanzar (el candado sigue puesto). Sella SÓLO un `AppError` 4xx distinto
 * de 429, con `code` y fuera de `CODIGOS_REINTENTABLES` (lista blanca de reintentables, no lista de excepciones). Guarda el MISMO
 * objeto de error (el manejador global responde igual: `code`, `message` y detalles). Ya sellada, no alarga el plazo.
 */
export function sellarSiEsDefinitivo(venueId: string, llave: string, err: unknown, ahoraMs: number = Date.now()): void {
  if (!(err instanceof AppError) || typeof err.code !== 'string' || !err.code) return
  if (err.statusCode < 400 || err.statusCode >= 500 || err.statusCode === 429) return
  if (CODIGOS_REINTENTABLES.includes(err.code)) return
  if (rechazoSellado(venueId, llave, ahoraMs)) return
  for (const [clave, sello] of sellos) if (sello.venceEn <= ahoraMs) sellos.delete(clave)
  sellos.set(claveDe(venueId, llave), { error: err, venceEn: ahoraMs + SELLO_DE_RECHAZO_MS })
}

/** El error sellado de la llave, o `null` (borra el vencido al leerlo). */
export function rechazoSellado(venueId: string, llave: string, ahoraMs: number = Date.now()): Error | null {
  const clave = claveDe(venueId, llave)
  const sello = sellos.get(clave)
  if (!sello) return null
  if (sello.venceEn <= ahoraMs) {
    sellos.delete(clave)
    return null
  }
  return sello.error
}

/** Sólo para pruebas. */
export function reiniciarSellosParaPruebas(): void {
  sellos.clear()
}

/** Sólo para pruebas: cuántas llaves hay selladas (vigentes o no purgadas). */
export function tamanoDeSellosParaPruebas(): number {
  return sellos.size
}
