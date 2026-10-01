import type { IssueCfdiDeps } from '@/services/fiscal/cfdi.service'

/** In-memory transaction boundary for the existing service unit suites; real locks/CAS have DB coverage. */
export function withIssueTransaction<T extends IssueCfdiDeps>(deps: T): T {
  deps.findOrderInvoices ??= jest.fn().mockResolvedValue([])
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ venueId: 'v1', organizationId: 'org1' }]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    // La versión en conflicto deja rastro (`CFDI_TIMBRE_DUPLICADO`) en la misma frontera transaccional.
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    cfdi: {
      findUnique: jest.fn(({ where }) => deps.findExistingCfdi(where.idempotencyKey)),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(async ({ where, data }) => {
        if (data.status === 'STAMPED') return { count: (await deps.persistCfdi(data, where)) ? 1 : 0 }
        return { count: 1 }
      }),
    },
  }
  deps.runInTransaction = async work => work(tx as any)
  return deps
}
