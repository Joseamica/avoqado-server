import type { PrismaClient } from '@prisma/client'

type AcquireCatalogMutationLock = typeof import('@/services/master-catalog/catalogMutationLock.service').acquireCatalogMutationLock

export interface CatalogBindingWriterHarness {
  writerOne: PrismaClient
  writerTwo: PrismaClient
  runBehindMutationLock<T, U>(startConfirms: () => [Promise<T>, Promise<U>]): Promise<[T, U]>
  disconnect(): Promise<void>
}

export function assertDisposableH1Database(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const isDisposable = (candidate: URL): boolean =>
    ['localhost', '127.0.0.1'].includes(candidate.hostname) && candidate.pathname === '/avoqado_h1a_test_20260808'

  // WHY: This guard runs before any runtime Prisma import. A poisoned shell
  // therefore cannot make prepared integration cleanup target dev or remote data.
  if (!isDisposable(effective) || !isDisposable(declared) || declared.toString() !== effective.toString()) {
    throw new Error('Task 8 integration requires the exact disposable local H1 database')
  }
}

function applicationDatabaseUrl(applicationName: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  url.searchParams.set('application_name', applicationName)
  return url.toString()
}

export async function createCatalogBindingWriterHarness(input: {
  organizationId: string
  fixtureKey: string
  acquireCatalogMutationLock: AcquireCatalogMutationLock
}): Promise<CatalogBindingWriterHarness> {
  assertDisposableH1Database()
  const { PrismaClient: PrismaClientConstructor } = await import('@prisma/client')
  const applicationNames = {
    writerOne: `h1a-binding-writer-a-${input.fixtureKey}`,
    writerTwo: `h1a-binding-writer-b-${input.fixtureKey}`,
    blocker: `h1a-binding-blocker-${input.fixtureKey}`,
    observer: `h1a-binding-observer-${input.fixtureKey}`,
  }
  const writerOne = new PrismaClientConstructor({
    datasources: { db: { url: applicationDatabaseUrl(applicationNames.writerOne) } },
  })
  const writerTwo = new PrismaClientConstructor({
    datasources: { db: { url: applicationDatabaseUrl(applicationNames.writerTwo) } },
  })
  const blocker = new PrismaClientConstructor({
    datasources: { db: { url: applicationDatabaseUrl(applicationNames.blocker) } },
  })
  const observer = new PrismaClientConstructor({
    datasources: { db: { url: applicationDatabaseUrl(applicationNames.observer) } },
  })

  async function waitForBothAdvisoryWaiters(): Promise<void> {
    const deadline = Date.now() + 4_000
    let lastObserved: Array<{ applicationName: string; pid: number }> = []

    // WHY: Seeing both named writer pools in PostgreSQL's advisory-lock wait
    // state proves overlap at the production serialization seam.
    while (Date.now() < deadline) {
      lastObserved = await observer.$queryRaw<Array<{ applicationName: string; pid: number }>>`
        SELECT application_name AS "applicationName", pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name IN (${applicationNames.writerOne}, ${applicationNames.writerTwo})
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE '%pg_advisory_xact_lock%'
      `
      if (new Set(lastObserved.map(row => row.applicationName)).size === 2) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for both binding writers; observed ${JSON.stringify(lastObserved)}`)
  }

  async function runBehindMutationLock<T, U>(startConfirms: () => [Promise<T>, Promise<U>]): Promise<[T, U]> {
    let signalLockHeld!: () => void
    let releaseLock!: () => void
    const lockHeld = new Promise<void>(resolve => (signalLockHeld = resolve))
    const release = new Promise<void>(resolve => (releaseLock = resolve))
    const blockerTransaction = blocker.$transaction(
      async tx => {
        await input.acquireCatalogMutationLock(tx, input.organizationId)
        signalLockHeld()
        await release
      },
      { timeout: 10_000 },
    )
    await lockHeld
    const confirms = startConfirms()

    try {
      await waitForBothAdvisoryWaiters()
    } catch (error) {
      releaseLock()
      await blockerTransaction
      await Promise.allSettled(confirms)
      throw error
    }
    releaseLock()
    await blockerTransaction
    return Promise.all(confirms)
  }

  return {
    writerOne,
    writerTwo,
    runBehindMutationLock,
    disconnect: async () => {
      await Promise.all([writerOne.$disconnect(), writerTwo.$disconnect(), blocker.$disconnect(), observer.$disconnect()])
    },
  }
}
