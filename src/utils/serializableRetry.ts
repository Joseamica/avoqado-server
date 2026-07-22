import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const RETRY_SQLSTATES = new Set(['40001', '55P03'])

export interface SerializableRetryOptions {
  timeoutMs?: number
  /** Total transaction attempts, including the initial attempt. */
  maxRetries?: number
  baseDelayMs?: number
}

function nestedCode(error: Record<string, unknown>): string | undefined {
  const meta = error.meta && typeof error.meta === 'object' ? (error.meta as Record<string, unknown>) : undefined
  const cause = error.cause && typeof error.cause === 'object' ? (error.cause as Record<string, unknown>) : undefined
  return [meta?.code, meta?.sqlState, cause?.code].find(value => typeof value === 'string') as string | undefined
}

export function isRetryableDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const value = error as Record<string, unknown>
  if (value.code === 'P2034') return true
  if (typeof value.code === 'string' && RETRY_SQLSTATES.has(value.code)) return true

  return value.code === 'P2010' && RETRY_SQLSTATES.has(nestedCode(value) ?? '')
}

function validateOptions(timeoutMs: number, maxRetries: number, baseDelayMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be greater than zero')
  if (!Number.isInteger(maxRetries) || maxRetries < 1) throw new RangeError('maxRetries must be a positive integer')
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new RangeError('baseDelayMs must be zero or greater')
}

export async function withSerializableRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableRetryOptions = {},
): Promise<T> {
  const { timeoutMs = 10_000, maxRetries = 5, baseDelayMs = 50 } = options
  validateOptions(timeoutMs, maxRetries, baseDelayMs)

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: timeoutMs,
      })
    } catch (error) {
      if (!isRetryableDbError(error)) throw error
      if (attempt === maxRetries) {
        throw new ConflictError('Conflicto de concurrencia persistente, por favor intente de nuevo')
      }

      logger.warn('Serialization/lock conflict; retrying transaction', { attempt, maxRetries })
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)))
    }
  }

  throw new ConflictError('Conflicto de concurrencia persistente, por favor intente de nuevo')
}
