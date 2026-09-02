import { Prisma } from '@prisma/client'

import { ConflictError } from '@/errors/AppError'

export const COMMERCIAL_WRITER_LOCK_DOMAIN = 'avoqado:commercial:catalog-offer-publication:v1'
export const COMMERCIAL_WRITER_ADVISORY_LOCK_KEY = -2896351599520032041n
export const COMMERCIAL_WRITER_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  // The eligibility fingerprint must observe commits that happened while this writer waited for
  // the advisory lock. Pinning READ COMMITTED prevents a role/database/pooler default such as
  // REPEATABLE READ from taking the transaction snapshot before the lock is acquired.
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
})

export interface CommercialWriterTransactionClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>
}

export interface CommercialWriterTransactionHost<Tx extends CommercialWriterTransactionClient> {
  $transaction<T>(
    operation: (tx: Tx) => Promise<T>,
    options: { maxWait: number; timeout: number; isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>
}

export interface CommercialWriterTransactionRunnerDependencies<Tx extends CommercialWriterTransactionClient> {
  host: CommercialWriterTransactionHost<Tx>
  sleep?: (milliseconds: number) => Promise<void>
  random?: () => number
}

export interface CommercialWriterTransactionRunner<Tx extends CommercialWriterTransactionClient> {
  run<T>(operation: (tx: Tx) => Promise<T>): Promise<T>
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const value = error as { code?: unknown; meta?: unknown }
  if (value.code === '55P03') return '55P03'
  if (value.code !== 'P2010' || typeof value.meta !== 'object' || value.meta === null) return null
  return (value.meta as { code?: unknown }).code === '55P03' ? '55P03' : null
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function jitterMilliseconds(random: () => number): number {
  const sampled = random()
  const bounded = Number.isFinite(sampled) ? Math.min(1, Math.max(0, sampled)) : 0.5
  return 50 + Math.floor(bounded * 100)
}

function lockTimeout(): ConflictError {
  return new ConflictError(
    'Otra operación comercial está terminando. Vuelve a intentar.',
    'COMMERCIAL_WRITER_LOCK_TIMEOUT',
    { retryable: true, attempts: 2 },
  )
}

export function createCommercialWriterTransactionRunner<Tx extends CommercialWriterTransactionClient>(
  dependencies: CommercialWriterTransactionRunnerDependencies<Tx>,
): CommercialWriterTransactionRunner<Tx> {
  const sleep = dependencies.sleep ?? defaultSleep
  const random = dependencies.random ?? Math.random
  return {
    async run<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await dependencies.host.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2000ms'")
            await tx.$queryRawUnsafe(
              'SELECT pg_advisory_xact_lock($1::bigint)::text AS lock_result',
              COMMERCIAL_WRITER_ADVISORY_LOCK_KEY.toString(),
            )
            return operation(tx)
          }, COMMERCIAL_WRITER_TRANSACTION_OPTIONS)
        } catch (error) {
          if (postgresCode(error) !== '55P03') throw error
          if (attempt === 2) throw lockTimeout()
          await sleep(jitterMilliseconds(random))
        }
      }
      throw lockTimeout()
    },
  }
}
