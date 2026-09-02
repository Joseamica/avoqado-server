import {
  createCommercialAcquisitionContextCleanupService,
  type CommercialAcquisitionContextCleanupRepository,
} from '@/services/commercial/commercialAcquisitionContextCleanup.service'

const CUTOFF = new Date('2026-08-28T12:00:00.000Z')

function repository(overrides: Partial<CommercialAcquisitionContextCleanupRepository> = {}): CommercialAcquisitionContextCleanupRepository {
  return {
    getDatabaseCutoff: jest.fn().mockResolvedValue(new Date(CUTOFF)),
    listCandidates: jest.fn().mockResolvedValue([]),
    deleteCandidate: jest.fn().mockResolvedValue({ deleted: true, preservedReferenced: false }),
    ...overrides,
  }
}

describe('commercial acquisition context cleanup', () => {
  it('defaults to dry-run, uses the database cutoff and advances from the last scanned candidate', async () => {
    const repo = repository({
      listCandidates: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
        .mockResolvedValueOnce([{ id: 'c' }]),
    })
    const cleanup = createCommercialAcquisitionContextCleanupService({ repository: repo, monotonicNow: () => 0 })

    const result = await cleanup({ pageSize: 2, maxScanned: 10, maxRuntimeMs: 1_000 })

    expect(result).toEqual({
      scanned: 3,
      deleted: 0,
      preservedReferenced: 0,
      preservedDatabaseRejected: 0,
      retried: 0,
      exhausted: false,
      nextCursor: 'c',
    })
    expect(repo.getDatabaseCutoff).toHaveBeenCalledTimes(1)
    expect(repo.listCandidates).toHaveBeenNthCalledWith(1, { databaseCutoff: CUTOFF, afterId: null, limit: 2 })
    expect(repo.listCandidates).toHaveBeenNthCalledWith(2, { databaseCutoff: CUTOFF, afterId: 'b', limit: 2 })
    expect(repo.deleteCandidate).not.toHaveBeenCalled()
    expect(Object.keys(result).sort()).toEqual(
      ['deleted', 'exhausted', 'nextCursor', 'preservedDatabaseRejected', 'preservedReferenced', 'retried', 'scanned'].sort(),
    )
  })

  it('classifies references and database rejection without aborting unrelated candidates', async () => {
    const deleteCandidate = jest
      .fn()
      .mockResolvedValueOnce({ deleted: false, preservedReferenced: true })
      .mockRejectedValueOnce(Object.assign(new Error('foreign key'), { code: 'P2010', meta: { code: '23503' } }))
      .mockRejectedValueOnce(Object.assign(new Error('trigger'), { code: 'P2010', meta: { code: '55000' } }))
      .mockRejectedValueOnce(
        Object.assign(new Error('trigger with nested transient cause'), {
          code: 'P2010',
          meta: { code: '55000' },
          cause: { code: '40001' },
        }),
      )
      .mockResolvedValueOnce({ deleted: true, preservedReferenced: false })
    const repo = repository({
      listCandidates: jest.fn().mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]),
      deleteCandidate,
    })

    const result = await createCommercialAcquisitionContextCleanupService({ repository: repo, monotonicNow: () => 0 })({
      execute: true,
      pageSize: 10,
      maxScanned: 10,
      maxRuntimeMs: 1_000,
    })

    expect(result).toEqual({
      scanned: 5,
      deleted: 1,
      preservedReferenced: 2,
      preservedDatabaseRejected: 2,
      retried: 0,
      exhausted: false,
      nextCursor: 'e',
    })
    expect(deleteCandidate).toHaveBeenCalledTimes(5)
  })

  it.each([
    { label: 'Prisma serialization', error: Object.assign(new Error('serialization'), { code: 'P2034' }) },
    { label: 'raw serialization', error: Object.assign(new Error('serialization'), { code: 'P2010', meta: { code: '40001' } }) },
    { label: 'raw deadlock', error: Object.assign(new Error('deadlock'), { code: 'P2010', meta: { sqlState: '40P01' } }) },
    { label: 'nested cause serialization', error: Object.assign(new Error('serialization'), { code: 'P2010', cause: { code: '40001' } }) },
  ])('retries $label exactly once', async ({ error }) => {
    const deleteCandidate = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ deleted: true, preservedReferenced: false })
    const repo = repository({ listCandidates: jest.fn().mockResolvedValueOnce([{ id: 'a' }]), deleteCandidate })

    const result = await createCommercialAcquisitionContextCleanupService({ repository: repo, monotonicNow: () => 0 })({
      execute: true,
      pageSize: 10,
      maxScanned: 10,
      maxRuntimeMs: 1_000,
    })

    expect(result).toMatchObject({ scanned: 1, deleted: 1, retried: 1 })
    expect(deleteCandidate).toHaveBeenCalledTimes(2)
  })

  it('aborts on unknown failures and on a repeated transient failure', async () => {
    for (const errors of [
      [Object.assign(new Error('network'), { code: 'ECONNRESET' })],
      [
        Object.assign(new Error('deadlock'), { code: 'P2010', meta: { code: '40P01' } }),
        Object.assign(new Error('deadlock again'), { code: 'P2010', meta: { code: '40P01' } }),
      ],
    ]) {
      const deleteCandidate = jest.fn()
      for (const error of errors) deleteCandidate.mockRejectedValueOnce(error)
      const repo = repository({ listCandidates: jest.fn().mockResolvedValueOnce([{ id: 'a' }]), deleteCandidate })
      await expect(
        createCommercialAcquisitionContextCleanupService({ repository: repo, monotonicNow: () => 0 })({
          execute: true,
          pageSize: 10,
          maxScanned: 10,
          maxRuntimeMs: 1_000,
        }),
      ).rejects.toBe(errors.at(-1))
      expect(deleteCandidate).toHaveBeenCalledTimes(errors.length)
    }
  })

  it('stops at row and monotonic runtime budgets with a cursor from the last row actually scanned', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const rowBudgetRepo = repository({ listCandidates: jest.fn().mockResolvedValue(rows) })
    const rowBudget = await createCommercialAcquisitionContextCleanupService({ repository: rowBudgetRepo, monotonicNow: () => 0 })({
      pageSize: 3,
      maxScanned: 2,
      maxRuntimeMs: 1_000,
    })
    expect(rowBudget).toMatchObject({ scanned: 2, exhausted: true, nextCursor: 'b' })

    const times = [0, 0, 5, 11]
    const timeBudgetRepo = repository({ listCandidates: jest.fn().mockResolvedValue(rows) })
    const timeBudget = await createCommercialAcquisitionContextCleanupService({
      repository: timeBudgetRepo,
      monotonicNow: () => times.shift() ?? 11,
    })({ pageSize: 3, maxScanned: 10, maxRuntimeMs: 10 })
    expect(timeBudget).toMatchObject({ scanned: 1, exhausted: true, nextCursor: 'a' })
  })

  it.each([
    { pageSize: 0, maxScanned: 10, maxRuntimeMs: 100 },
    { pageSize: 101, maxScanned: 10, maxRuntimeMs: 100 },
    { pageSize: 10, maxScanned: 0, maxRuntimeMs: 100 },
    { pageSize: 10, maxScanned: 1_001, maxRuntimeMs: 100 },
    { pageSize: 10, maxScanned: 10, maxRuntimeMs: 0 },
    { pageSize: 10, maxScanned: 10, maxRuntimeMs: 10_001 },
  ])('rejects out-of-bounds cleanup options: %j', async options => {
    const repo = repository()
    await expect(createCommercialAcquisitionContextCleanupService({ repository: repo })(options)).rejects.toThrow(
      'COMMERCIAL_ACQUISITION_CLEANUP_OPTIONS_INVALID',
    )
    expect(repo.getDatabaseCutoff).not.toHaveBeenCalled()
  })
})
