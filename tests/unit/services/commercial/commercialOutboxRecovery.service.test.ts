import * as recoveryModule from '@/services/commercial/commercialOutboxRecovery.service'

describe('commercial outbox inspected recovery', () => {
  const actor = {
    staffId: 'staff-recovery',
    reason: 'Reintentar después de desplegar soporte compatible',
    permissions: ['commercial:publish'],
  }
  it('exposes an injectable recovery service factory', () => {
    expect((recoveryModule as Record<string, unknown>).createCommercialOutboxRecoveryService).toEqual(expect.any(Function))
  })

  it('exposes safe inspection and requeue operations from the factory', () => {
    const service = recoveryModule.createCommercialOutboxRecoveryService()

    expect(service).toMatchObject({
      listFailed: expect.any(Function),
      getFailed: expect.any(Function),
      requeueFailed: expect.any(Function),
    })
  })

  it('projects failed rows without payload or raw error text and normalizes legacy errors', async () => {
    const raw = {
      id: 'outbox-failed-1',
      eventType: 'PUBLICATION_ACTIVATED',
      publicationId: 'catalog-1',
      previousPublicationId: null,
      status: 'FAILED',
      attempts: 8,
      lastError: 'postgres password=do-not-return',
      nextAttemptAt: new Date('2026-08-27T12:00:00.000Z'),
      claimedAt: null,
      claimExpiresAt: null,
      createdAt: new Date('2026-08-27T11:00:00.000Z'),
      updatedAt: new Date('2026-08-27T12:00:00.000Z'),
      payload: { secret: 'must-not-leak' },
    }
    const listFailedRows = jest.fn().mockResolvedValue([raw])
    const createService = recoveryModule.createCommercialOutboxRecoveryService as unknown as (dependencies: unknown) => {
      listFailed(input?: unknown): Promise<unknown>
    }
    const service = createService({ listFailedRows, now: () => new Date('2026-08-27T12:00:00.000Z') })

    const result = await service.listFailed()

    expect(result).toEqual({
      items: [
        {
          id: raw.id,
          eventType: raw.eventType,
          publicationId: raw.publicationId,
          previousPublicationId: null,
          status: 'FAILED',
          attempts: 8,
          lastErrorCode: 'COMMERCIAL_OUTBOX_LEGACY_ERROR',
          nextAttemptAt: raw.nextAttemptAt,
          leaseActive: false,
          claimedAt: null,
          claimExpiresAt: null,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        },
      ],
      nextCursor: null,
    })
    expect(JSON.stringify(result)).not.toContain('do-not-return')
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(listFailedRows).toHaveBeenCalledWith({ cursor: null, limit: 51 })
  })

  it('gets one failed row through the same safe projection and preserves a known stable code', async () => {
    const raw = {
      id: 'outbox-failed-known',
      eventType: 'PUBLICATION_CREATED',
      publicationId: 'catalog-2',
      previousPublicationId: null,
      status: 'FAILED',
      attempts: 3,
      lastError: 'COMMERCIAL_OUTBOX_SCHEMA_FUTURE',
      nextAttemptAt: new Date('2026-08-27T12:00:00.000Z'),
      claimedAt: null,
      claimExpiresAt: null,
      createdAt: new Date('2026-08-27T11:00:00.000Z'),
      updatedAt: new Date('2026-08-27T12:00:00.000Z'),
      payload: { bearer: 'hidden' },
    }
    const getFailedRow = jest.fn().mockResolvedValue(raw)
    const createService = recoveryModule.createCommercialOutboxRecoveryService as unknown as (dependencies: unknown) => {
      getFailed(id: string): Promise<unknown>
    }
    const service = createService({
      listFailedRows: jest.fn(),
      getFailedRow,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    })

    const result = await service.getFailed(raw.id)

    expect(result).toMatchObject({ id: raw.id, lastErrorCode: 'COMMERCIAL_OUTBOX_SCHEMA_FUTURE' })
    expect(result).not.toHaveProperty('payload')
    expect(result).not.toHaveProperty('lastError')
    expect(JSON.stringify(result)).not.toContain('hidden')
    expect(getFailedRow).toHaveBeenCalledWith(raw.id)
  })

  it('projects lease activity against the operation clock instead of the host clock', async () => {
    const raw = {
      id: 'outbox-failed-clock',
      eventType: 'PUBLICATION_CREATED',
      publicationId: 'catalog-clock',
      previousPublicationId: null,
      status: 'FAILED',
      attempts: 8,
      lastError: 'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
      nextAttemptAt: new Date('2099-01-01T00:00:00.000Z'),
      claimedAt: new Date('2099-01-01T00:00:00.000Z'),
      claimExpiresAt: new Date('2099-01-01T00:01:00.000Z'),
      createdAt: new Date('2099-01-01T00:00:00.000Z'),
      updatedAt: new Date('2099-01-01T00:00:00.000Z'),
    }
    const service = recoveryModule.createCommercialOutboxRecoveryService({
      ...recoveryModule.prismaCommercialOutboxRecoveryDependencies,
      getFailedRow: jest.fn().mockResolvedValue(raw),
      now: () => new Date('2100-01-01T00:00:00.000Z'),
    })

    await expect(service.getFailed(raw.id)).resolves.toMatchObject({ leaseActive: false })
  })

  it('requeues the inspected row only after current authority verification and audits safe coordinates', async () => {
    const locked = {
      id: 'outbox-recoverable',
      eventType: 'PUBLICATION_ACTIVATED',
      publicationId: 'catalog-2',
      previousPublicationId: 'catalog-1',
      status: 'FAILED',
      attempts: 8,
      lastError: 'driver text that must stay private',
      nextAttemptAt: new Date('2026-08-27T11:00:00.000Z'),
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
      updatedAt: new Date('2026-08-27T11:00:00.000Z'),
      payloadVersion: 1,
      payload: { hidden: 'authority verifies this internally' },
      dedupeKey: 'commercial:activation:2:catalog-2',
    }
    const lockFailedRow = jest.fn().mockResolvedValue(locked)
    const verifyCurrentAuthority = jest.fn()
    const requeue = jest.fn().mockResolvedValue(true)
    const writeAudit = jest.fn()
    const tx = { lockFailedRow, verifyCurrentAuthority, requeue, writeAudit }
    const runInTransaction = jest.fn(operation => operation(tx))
    const createService = recoveryModule.createCommercialOutboxRecoveryService as unknown as (dependencies: unknown) => {
      requeueFailed(id: string, input: unknown, actor: unknown): Promise<unknown>
    }
    const service = createService({
      listFailedRows: jest.fn(),
      getFailedRow: jest.fn(),
      runInTransaction,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    })

    await expect(
      service.requeueFailed(
        locked.id,
        {
          observedAttempts: 8,
          observedLastErrorCode: 'COMMERCIAL_OUTBOX_LEGACY_ERROR',
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).resolves.toEqual({
      id: locked.id,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date('2026-08-27T12:00:00.000Z'),
    })
    expect(verifyCurrentAuthority).toHaveBeenCalledWith(locked)
    expect(requeue).toHaveBeenCalledWith(locked, new Date('2026-08-27T12:00:00.000Z'))
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COMMERCIAL_OUTBOX_FAILURE_REQUEUED',
        before: { attempts: 8, lastErrorCode: 'COMMERCIAL_OUTBOX_LEGACY_ERROR' },
      }),
    )
    expect(JSON.stringify(writeAudit.mock.calls)).not.toContain('driver text')
    expect(verifyCurrentAuthority.mock.invocationCallOrder[0]).toBeLessThan(requeue.mock.invocationCallOrder[0])
    expect(requeue.mock.invocationCallOrder[0]).toBeLessThan(writeAudit.mock.invocationCallOrder[0])
  })

  it.each([
    {
      name: 'stale attempt count',
      mutate: (row: any) => ({ ...row, attempts: 9 }),
      authorityFails: false,
      casSucceeds: true,
    },
    {
      name: 'stale normalized error code',
      mutate: (row: any) => ({ ...row, lastError: 'COMMERCIAL_OUTBOX_SCHEMA_FUTURE' }),
      authorityFails: false,
      casSucceeds: true,
    },
    {
      name: 'active lease',
      mutate: (row: any) => ({ ...row, claimExpiresAt: new Date('2026-08-27T12:01:00.000Z') }),
      authorityFails: false,
      casSucceeds: true,
    },
    {
      name: 'invalid current authority',
      mutate: (row: any) => row,
      authorityFails: true,
      casSucceeds: true,
    },
    {
      name: 'lost recovery CAS',
      mutate: (row: any) => row,
      authorityFails: false,
      casSucceeds: false,
    },
  ])('rejects $name without an audit or an unsafe requeue', async ({ mutate, authorityFails, casSucceeds }) => {
    const locked = mutate({
      id: 'outbox-stale',
      eventType: 'PUBLICATION_CREATED',
      publicationId: 'catalog-1',
      previousPublicationId: null,
      status: 'FAILED',
      attempts: 8,
      lastError: 'legacy private text',
      nextAttemptAt: new Date('2026-08-27T11:00:00.000Z'),
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
      updatedAt: new Date('2026-08-27T11:00:00.000Z'),
      payloadVersion: 1,
      payload: {},
      dedupeKey: 'commercial:publication:catalog-1:created',
    })
    const verifyCurrentAuthority = authorityFails
      ? jest.fn().mockRejectedValue(new Error('COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE'))
      : jest.fn()
    const requeue = jest.fn().mockResolvedValue(casSucceeds)
    const writeAudit = jest.fn()
    const tx = {
      lockFailedRow: jest.fn().mockResolvedValue(locked),
      verifyCurrentAuthority,
      requeue,
      writeAudit,
    }
    const createService = recoveryModule.createCommercialOutboxRecoveryService as unknown as (dependencies: unknown) => {
      requeueFailed(id: string, input: unknown, actor: unknown): Promise<unknown>
    }
    const service = createService({
      listFailedRows: jest.fn(),
      getFailedRow: jest.fn(),
      runInTransaction: (operation: (transaction: typeof tx) => unknown) => operation(tx),
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    })

    await expect(
      service.requeueFailed(
        locked.id,
        {
          observedAttempts: 8,
          observedLastErrorCode: 'COMMERCIAL_OUTBOX_LEGACY_ERROR',
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_OUTBOX_RECOVERY_CONFLICT' })
    expect(writeAudit).not.toHaveBeenCalled()
    if (!casSucceeds || authorityFails) expect(JSON.stringify(writeAudit.mock.calls)).not.toContain('private')
    if (locked.attempts !== 8 || locked.lastError === 'COMMERCIAL_OUTBOX_SCHEMA_FUTURE' || locked.claimExpiresAt) {
      expect(verifyCurrentAuthority).not.toHaveBeenCalled()
      expect(requeue).not.toHaveBeenCalled()
    }
  })

  it('rethrows infrastructure failures instead of disguising them as a recovery conflict', async () => {
    const infrastructureFailure = new Error('database connection lost')
    const locked = {
      id: 'outbox-infrastructure',
      eventType: 'PUBLICATION_CREATED',
      publicationId: 'catalog-infrastructure',
      previousPublicationId: null,
      status: 'FAILED',
      attempts: 8,
      lastError: 'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
      nextAttemptAt: new Date('2026-08-27T11:00:00.000Z'),
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
      updatedAt: new Date('2026-08-27T11:00:00.000Z'),
      payloadVersion: 1,
      payload: {},
      dedupeKey: 'commercial:publication:catalog-infrastructure:created',
    }
    const requeue = jest.fn()
    const writeAudit = jest.fn()
    const service = recoveryModule.createCommercialOutboxRecoveryService({
      listFailedRows: jest.fn(),
      getFailedRow: jest.fn(),
      runInTransaction: operation =>
        operation({
          lockFailedRow: jest.fn().mockResolvedValue(locked),
          verifyCurrentAuthority: jest.fn().mockRejectedValue(infrastructureFailure),
          requeue,
          writeAudit,
        }),
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    })

    await expect(
      service.requeueFailed(
        locked.id,
        {
          observedAttempts: 8,
          observedLastErrorCode: 'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toBe(infrastructureFailure)
    expect(requeue).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })
})
