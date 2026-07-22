import { Prisma, PrismaClient } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'
import { withSerializableRetry } from '@/utils/serializableRetry'

const tableName = `serializable_retry_${process.pid}_${Date.now()}`
const contender = new PrismaClient()
const inspector = new PrismaClient()

async function waitForSignalOrFailure(signal: Promise<void>, operation: Promise<unknown>, label: string): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      signal,
      operation.then(() => {
        throw new Error(`${label} completed before signaling readiness`)
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

describe('serializableRetry PostgreSQL contention', () => {
  beforeAll(async () => {
    await inspector.$executeRawUnsafe(`CREATE TABLE "${tableName}" (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`)
    await inspector.$executeRawUnsafe(`INSERT INTO "${tableName}" (id, value) VALUES (1, 0)`)
  })

  afterAll(async () => {
    try {
      await inspector.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tableName}"`)
    } finally {
      await Promise.allSettled([contender.$disconnect(), inspector.$disconnect()])
    }
  })

  it('reruns a serializable closure after a concurrent committed update', async () => {
    let attempts = 0
    let signalFirstRead!: () => void
    const firstRead = new Promise<void>(resolve => {
      signalFirstRead = resolve
    })
    let permitFirstWrite!: () => void
    const firstWritePermit = new Promise<void>(resolve => {
      permitFirstWrite = resolve
    })

    const retriedIncrement = withSerializableRetry(
      async tx => {
        attempts += 1
        await tx.$queryRawUnsafe<Array<{ value: number }>>(`SELECT value FROM "${tableName}" WHERE id = 1`)

        if (attempts === 1) {
          signalFirstRead()
          await firstWritePermit
        }

        await tx.$executeRawUnsafe(`UPDATE "${tableName}" SET value = value + 1 WHERE id = 1`)
      },
      { maxRetries: 3, baseDelayMs: 1 },
    )

    try {
      await waitForSignalOrFailure(firstRead, retriedIncrement, 'first serializable read')
      await contender.$transaction(
        async tx => {
          await tx.$queryRawUnsafe<Array<{ value: number }>>(`SELECT value FROM "${tableName}" WHERE id = 1`)
          await tx.$executeRawUnsafe(`UPDATE "${tableName}" SET value = value + 1 WHERE id = 1`)
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
    } finally {
      permitFirstWrite()
    }

    await retriedIncrement
    const [row] = await inspector.$queryRawUnsafe<Array<{ value: number }>>(`SELECT value FROM "${tableName}" WHERE id = 1`)

    expect(attempts).toBe(2)
    expect(row.value).toBe(2)
  })

  it('maps repeated PostgreSQL lock timeouts to HTTP 409', async () => {
    const advisoryLockKey = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
    let signalLockHeld!: () => void
    const lockHeld = new Promise<void>(resolve => {
      signalLockHeld = resolve
    })
    let releaseLock!: () => void
    const lockRelease = new Promise<void>(resolve => {
      releaseLock = resolve
    })

    const holder = contender.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${advisoryLockKey})::text AS lock_result`
        signalLockHeld()
        await lockRelease
      },
      { timeout: 5_000 },
    )

    let attempts = 0
    let captured: unknown
    try {
      await waitForSignalOrFailure(lockHeld, holder, 'advisory lock holder')
      captured = await withSerializableRetry(
        async tx => {
          attempts += 1
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '50ms'")
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${advisoryLockKey})::text AS lock_result`
        },
        { maxRetries: 2, baseDelayMs: 1, timeoutMs: 2_000 },
      ).catch(error => error)
    } finally {
      releaseLock()
      await holder
    }

    expect(captured).toBeInstanceOf(ConflictError)
    expect(captured).toMatchObject({ statusCode: 409, code: undefined })
    expect((captured as Error).message).not.toMatch(/P2028|P2010|55P03|40001/)
    expect(attempts).toBe(2)
  })
})
