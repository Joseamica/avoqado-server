import { performance } from 'node:perf_hooks'
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'

const DEFAULT_PAGE_SIZE = 50
const DEFAULT_MAX_SCANNED = 500
const DEFAULT_MAX_RUNTIME_MS = 5_000
const MAX_PAGE_SIZE = 100
const MAX_SCANNED = 1_000
const MAX_RUNTIME_MS = 10_000

export interface CommercialAcquisitionContextCleanupCandidate {
  id: string
}

export interface CommercialAcquisitionContextDeleteResult {
  deleted: boolean
  preservedReferenced: boolean
}

export interface CommercialAcquisitionContextCleanupRepository {
  getDatabaseCutoff(): Promise<Date>
  listCandidates(input: {
    databaseCutoff: Date
    afterId: string | null
    limit: number
  }): Promise<CommercialAcquisitionContextCleanupCandidate[]>
  deleteCandidate(input: { id: string; databaseCutoff: Date }): Promise<CommercialAcquisitionContextDeleteResult>
}

export interface CommercialAcquisitionContextCleanupOptions {
  execute?: boolean
  pageSize?: number
  maxScanned?: number
  maxRuntimeMs?: number
}

export interface CommercialAcquisitionContextCleanupResult {
  scanned: number
  deleted: number
  preservedReferenced: number
  preservedDatabaseRejected: number
  retried: number
  exhausted: boolean
  nextCursor: string | null
}

interface CommercialAcquisitionContextCleanupDependencies {
  repository: CommercialAcquisitionContextCleanupRepository
  monotonicNow?: () => number
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const ownRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    return value as Record<string, unknown>
  }
  const ownValue = (record: Record<string, unknown>, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  }
  const record = error as Record<string, unknown>
  const directCode = ownValue(record, 'code')
  if (directCode !== 'P2010') return typeof directCode === 'string' ? directCode : undefined
  const meta = ownRecord(ownValue(record, 'meta'))
  const cause = ownRecord(ownValue(record, 'cause'))
  const nestedCode = meta ? ownValue(meta, 'code') : undefined
  const nestedSqlState = meta ? ownValue(meta, 'sqlState') : undefined
  const causeCode = cause ? ownValue(cause, 'code') : undefined
  return [nestedCode, nestedSqlState, causeCode].find(value => typeof value === 'string') as string | undefined
}

function intrinsicTime(value: Date): number {
  try {
    return Date.prototype.getTime.call(value)
  } catch {
    return Number.NaN
  }
}

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximum
}

function normalizeOptions(options: CommercialAcquisitionContextCleanupOptions) {
  const normalized = {
    execute: options.execute === true,
    pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    maxScanned: options.maxScanned ?? DEFAULT_MAX_SCANNED,
    maxRuntimeMs: options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
  }
  if (
    !boundedInteger(normalized.pageSize, MAX_PAGE_SIZE) ||
    !boundedInteger(normalized.maxScanned, MAX_SCANNED) ||
    !boundedInteger(normalized.maxRuntimeMs, MAX_RUNTIME_MS)
  ) {
    throw new Error('COMMERCIAL_ACQUISITION_CLEANUP_OPTIONS_INVALID')
  }
  return normalized
}

export function createPrismaCommercialAcquisitionContextCleanupRepository(
  host: PrismaClient,
): CommercialAcquisitionContextCleanupRepository {
  return {
  async getDatabaseCutoff() {
    const rows = await host.$queryRaw<Array<{ cutoff: Date }>>(Prisma.sql`
      SELECT pg_catalog.now() AS "cutoff"
    `)
    if (rows.length !== 1 || !Number.isFinite(intrinsicTime(rows[0].cutoff))) {
      throw new Error('COMMERCIAL_ACQUISITION_CLEANUP_DATABASE_CUTOFF_INVALID')
    }
    return rows[0].cutoff
  },

  async listCandidates({ databaseCutoff, afterId, limit }) {
    return host.$queryRaw<CommercialAcquisitionContextCleanupCandidate[]>(Prisma.sql`
      SELECT acquisition."id"
      FROM "CommercialAcquisitionContext" AS acquisition
      WHERE acquisition."expiresAt" <= (${databaseCutoff}::timestamptz AT TIME ZONE 'UTC') - interval '20 minutes'
        ${afterId === null ? Prisma.empty : Prisma.sql`AND acquisition."id" > ${afterId}`}
      ORDER BY acquisition."id" ASC
      LIMIT ${limit}
    `)
  },

  async deleteCandidate({ id, databaseCutoff }) {
    const rows = await host.$queryRaw<CommercialAcquisitionContextDeleteResult[]>(Prisma.sql`
      WITH candidate AS MATERIALIZED (
        SELECT
          acquisition."id",
          (
            EXISTS (
              SELECT 1
              FROM "CommercialQuote" AS quote
              WHERE quote."acquisitionContextId" = acquisition."id"
            )
            OR EXISTS (
              SELECT 1
              FROM "CommercialQuotePreviewBridge" AS bridge
              WHERE bridge."acquisitionContextId" = acquisition."id"
            )
            OR EXISTS (
              SELECT 1
              FROM "CommercialAcquisitionRedemption" AS redemption
              WHERE redemption."acquisitionContextId" = acquisition."id"
            )
          ) AS "preservedReferenced"
        FROM "CommercialAcquisitionContext" AS acquisition
        WHERE acquisition."id" = ${id}
          AND acquisition."expiresAt" <= (${databaseCutoff}::timestamptz AT TIME ZONE 'UTC') - interval '20 minutes'
          AND acquisition."expiresAt" <= (pg_catalog.now() AT TIME ZONE 'UTC') - interval '20 minutes'
      ), deleted AS (
        DELETE FROM "CommercialAcquisitionContext" AS acquisition
        USING candidate
        WHERE acquisition."id" = candidate."id"
          AND candidate."preservedReferenced" = FALSE
        RETURNING acquisition."id"
      )
      SELECT
        EXISTS (SELECT 1 FROM deleted) AS "deleted",
        COALESCE((SELECT candidate."preservedReferenced" FROM candidate LIMIT 1), FALSE) AS "preservedReferenced"
    `)
    return rows[0] ?? { deleted: false, preservedReferenced: false }
  },
  }
}

export const prismaCommercialAcquisitionContextCleanupRepository =
  createPrismaCommercialAcquisitionContextCleanupRepository(prisma)

export function createCommercialAcquisitionContextCleanupService(
  dependencies: CommercialAcquisitionContextCleanupDependencies = {
    repository: prismaCommercialAcquisitionContextCleanupRepository,
  },
) {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
  return async (options: CommercialAcquisitionContextCleanupOptions = {}): Promise<CommercialAcquisitionContextCleanupResult> => {
    const normalized = normalizeOptions(options)
    const databaseCutoff = await dependencies.repository.getDatabaseCutoff()
    if (!Number.isFinite(intrinsicTime(databaseCutoff))) {
      throw new Error('COMMERCIAL_ACQUISITION_CLEANUP_DATABASE_CUTOFF_INVALID')
    }
    const startedAt = monotonicNow()
    const result: CommercialAcquisitionContextCleanupResult = {
      scanned: 0,
      deleted: 0,
      preservedReferenced: 0,
      preservedDatabaseRejected: 0,
      retried: 0,
      exhausted: false,
      nextCursor: null,
    }

    while (result.scanned < normalized.maxScanned) {
      if (monotonicNow() - startedAt >= normalized.maxRuntimeMs) {
        result.exhausted = true
        break
      }
      const limit = Math.min(normalized.pageSize, normalized.maxScanned - result.scanned)
      const candidates = await dependencies.repository.listCandidates({
        databaseCutoff,
        afterId: result.nextCursor,
        limit,
      })
      if (candidates.length === 0) break

      for (const candidate of candidates.slice(0, limit)) {
        if (monotonicNow() - startedAt >= normalized.maxRuntimeMs) {
          result.exhausted = true
          break
        }
        result.scanned += 1
        result.nextCursor = candidate.id
        if (!normalized.execute) continue

        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const deletion = await dependencies.repository.deleteCandidate({ id: candidate.id, databaseCutoff })
            if (deletion.deleted) result.deleted += 1
            else if (deletion.preservedReferenced) result.preservedReferenced += 1
            break
          } catch (error) {
            const code = databaseErrorCode(error)
            if (code === 'P2003' || code === '23503') {
              result.preservedReferenced += 1
              break
            }
            if (code === '55000') {
              result.preservedDatabaseRejected += 1
              break
            }
            if (code === 'P2034' || code === '40001' || code === '40P01') {
              if (attempt === 0) {
                result.retried += 1
                continue
              }
            }
            throw error
          }
        }
      }

      if (result.exhausted) break
      if (candidates.length < limit) break
      if (result.scanned >= normalized.maxScanned) result.exhausted = true
    }
    return Object.freeze(result)
  }
}

export const cleanupCommercialAcquisitionContexts = createCommercialAcquisitionContextCleanupService()
