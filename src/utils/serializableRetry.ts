import { Prisma, PrismaClient } from '@prisma/client'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const RETRY_SQLSTATES = new Set(['40001', '55P03'])

export interface SerializableRetryOptions {
  timeoutMs?: number
  /** Optional interactive-transaction admission wait; omitted preserves Prisma's default. */
  maxWaitMs?: number
  /** Total transaction attempts, including the initial attempt. */
  maxRetries?: number
  baseDelayMs?: number
  /** Repite también un bloqueo mutuo (40P01) con este mismo lazo (S5b, R63); `fn` recibe entonces `TxConReintento`. */
  reintentarInterbloqueo?: boolean
  /** Nombre de la transacción en el `warn` de cada reintento. */
  etiqueta?: string
}

/**
 * El único `tx` con el que se escriben (o bloquean) las tablas de beneficios (`Discount`, `CouponCode`, `CouponRedemption`,
 * `StampReward`, `StampCard`, `StampEvent`, `Customer`, `LoyaltyTransaction`, `GiftCard`): sólo lo entrega `withDeadlockRetry` (o
 * `withSerializableRetry` con `reintentarInterbloqueo`), así que una escritura que no se repite al trabarse no compila (S5b, R65).
 * 🔴 Paso 1 de la fase 0: nace como alias SIN la marca para que cada paso compile; el paso 8 la prende con un `unique symbol`
 * (`Prisma.TransactionClient & { readonly [conReintento]: true }`) y el compilador lista lo que faltó.
 */
export type TxConReintento = Prisma.TransactionClient

/** Intentos por bloqueo mutuo de `withDeadlockRetry`. Las pruebas de los cruces lo bajan a 1 para ver el rojo. */
export const REINTENTO_POR_INTERBLOQUEO = { intentos: 4 }

/** Si una prueba lo pone, manda sobre `maxRetries` de `withSerializableRetry` (rojo de X11). En producción es `null`. */
export const REINTENTO_SERIALIZABLE = { intentos: null as number | null }

export interface OpcionesDeInterbloqueo {
  /** Nombre de la transacción (el de la función que la abre) en el `warn` de cada reintento. */
  etiqueta: string
  timeout?: number
  maxWait?: number
  isolationLevel?: Prisma.TransactionIsolationLevel
  /** Sólo para quien abre en un cliente inyectado (`liveDemoCleanup`, `staffDeletion`); por omisión, el global. */
  cliente?: PrismaClient
}

function nestedCode(error: Record<string, unknown>): string | undefined {
  const meta = error.meta && typeof error.meta === 'object' ? (error.meta as Record<string, unknown>) : undefined
  const cause = error.cause && typeof error.cause === 'object' ? (error.cause as Record<string, unknown>) : undefined
  return [meta?.code, meta?.sqlState, cause?.code].find(value => typeof value === 'string') as string | undefined
}

/**
 * Fallo de serialización: P2034 de Prisma, o el 40001 de Postgres directo o envuelto en P2010 (consulta cruda: un `FOR SHARE`
 * en SERIALIZABLE sobre una fila que otro cambió después de la foto). Sin 55P03 ni 40P01: ésos los ven las funciones de al lado.
 */
export function isSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as Record<string, unknown>
  return value.code === 'P2034' || value.code === '40001' || (value.code === 'P2010' && nestedCode(value) === '40001')
}

export function isRetryableDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const value = error as Record<string, unknown>
  if (value.code === 'P2034') return true
  if (typeof value.code === 'string' && RETRY_SQLSTATES.has(value.code)) return true

  return value.code === 'P2010' && RETRY_SQLSTATES.has(nestedCode(value) ?? '')
}

/**
 * Bloqueo mutuo (40P01): directo, envuelto en P2010 o —en una consulta de MODELO— como `PrismaClientUnknownRequestError` con el
 * SQLSTATE sólo en el mensaje (Prisma 6.19.3 sólo traduce 40001; la misma forma que el 55P03 de `isModelLockTimeoutError`).
 * Quien lo reintente lo decide él; aquí no se reintenta. El catálogo NO lo reintenta (R10, T4-R1): no usa esta función.
 */
export function isDeadlockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as Record<string, unknown>
  if (value.code === '40P01') return true
  if (value.code === 'P2010' && nestedCode(value) === '40P01') return true
  return error instanceof Prisma.PrismaClientUnknownRequestError && error.message.includes('PostgresError { code: "40P01"')
}

/**
 * `lock_timeout` vencido (55P03) en una consulta de MODELO. Prisma 6.19 no le da código: llega como
 * `PrismaClientUnknownRequestError` sin `code` ni `meta`, y el SQLSTATE sólo viaja en el `QueryError(PostgresError { code:
 * "55P03", … })` del mensaje (medido el 2026-09-28 con el INSERT de JournalLine y el upsert de AccountingPeriodLock). En una
 * consulta cruda (P2010) o como código directo ya lo reconoce `isRetryableDbError`. Quien lo reintente lo decide él.
 */
export function isModelLockTimeoutError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientUnknownRequestError && error.message.includes('PostgresError { code: "55P03"')
}

function validateOptions(timeoutMs: number, maxRetries: number, baseDelayMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be greater than zero')
  if (!Number.isInteger(maxRetries) || maxRetries < 1) throw new RangeError('maxRetries must be a positive integer')
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new RangeError('baseDelayMs must be zero or greater')
}

const esperar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * El 409 de siempre (mismo mensaje, sin código) con `cause` = el último error de la base, no enumerable como el de
 * `new Error(msg, { cause })`: lo lee la prueba de X11 y nunca sale en la respuesta HTTP (`globalErrorHandler` arma el cuerpo
 * con `message`, `code` y `details`).
 */
function conflictoPersistente(causa: unknown): ConflictError {
  const conflicto = new ConflictError('Conflicto de concurrencia persistente, por favor intente de nuevo')
  Object.defineProperty(conflicto, 'cause', { value: causa, enumerable: false, writable: true, configurable: true })
  return conflicto
}

export async function withSerializableRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: SerializableRetryOptions & { reintentarInterbloqueo?: false },
): Promise<T>
export async function withSerializableRetry<T>(
  fn: (tx: TxConReintento) => Promise<T>,
  options: SerializableRetryOptions & { reintentarInterbloqueo: true },
): Promise<T>
export async function withSerializableRetry<T>(fn: (tx: TxConReintento) => Promise<T>, options: SerializableRetryOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, maxWaitMs, baseDelayMs = 50, reintentarInterbloqueo = false, etiqueta } = options
  const maxRetries = REINTENTO_SERIALIZABLE.intentos ?? options.maxRetries ?? 5
  validateOptions(timeoutMs, maxRetries, baseDelayMs)
  if (maxWaitMs !== undefined && (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0))
    throw new RangeError('maxWaitMs must be greater than zero')

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await prisma.$transaction(tx => fn(tx as TxConReintento), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: timeoutMs,
        ...(maxWaitMs === undefined ? {} : { maxWait: maxWaitMs }),
      })
    } catch (error) {
      if (!isRetryableDbError(error) && !(reintentarInterbloqueo && isDeadlockError(error))) throw error
      if (attempt === maxRetries) throw conflictoPersistente(error)

      logger.warn('Serialization/lock conflict; retrying transaction', { attempt, maxRetries, ...(etiqueta ? { etiqueta } : {}) })
      await esperar(baseDelayMs * 2 ** (attempt - 1))
    }
  }

  throw new ConflictError('Conflicto de concurrencia persistente, por favor intente de nuevo')
}

/**
 * Red por traba (S5b, R63–R65): abre la transacción y, si Postgres la eligió como víctima de un bloqueo mutuo (40P01, en
 * cualquiera de las formas de `isDeadlockError`), la repite COMPLETA: todo lo suyo ya se deshizo y la otra transacción siguió.
 * Nada más se repite (un error de negocio, 40001 o 55P03 salen al primer intento, por identidad). Al agotarse, el MISMO error de
 * hoy, sin traducir. Por eso el cuerpo no tiene efectos fuera de la base: lo que se publica después sale de su retorno.
 * Va donde se ABRE la transacción, nunca dentro de una función que ya recibe `tx`.
 */
export async function withDeadlockRetry<T>(fn: (tx: TxConReintento) => Promise<T>, opciones: OpcionesDeInterbloqueo): Promise<T> {
  const { etiqueta, cliente, timeout, maxWait, isolationLevel } = opciones
  const transaccion = Object.fromEntries(Object.entries({ timeout, maxWait, isolationLevel }).filter(([, v]) => v !== undefined))
  const db = cliente ?? prisma
  for (let intento = 1; ; intento += 1) {
    try {
      // Sin opciones, la misma llamada de hoy (sólo el cuerpo): así no cambian los dobles de quien se envuelve.
      return Object.keys(transaccion).length
        ? await db.$transaction(tx => fn(tx as TxConReintento), transaccion)
        : await db.$transaction(tx => fn(tx as TxConReintento))
    } catch (error) {
      if (!isDeadlockError(error) || intento >= REINTENTO_POR_INTERBLOQUEO.intentos) throw error
      logger.warn('interbloqueo (40P01): se reintenta la transacción', { etiqueta, intento })
      await esperar(25 + Math.random() * 100 * intento)
    }
  }
}
