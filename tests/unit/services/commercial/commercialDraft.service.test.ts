import { ConflictError } from '@/errors/AppError'
import { createCommercialDraftService } from '@/services/commercial/commercialDraft.service'
import type { CommercialDraftInput } from '@/types/commercial'

const input: CommercialDraftInput = {
  name: 'Catálogo México',
  description: 'Borrador mínimo',
  products: [],
  pricebooks: [],
  prices: [],
  bundles: [],
  bundleItems: [],
  featureBindings: [],
}

const actor = {
  staffId: 'staff_1',
  reason: 'Actualizar oferta aprobada',
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
}

describe('commercialDraftService optimistic concurrency', () => {
  it('creates the draft and audit row in the same transaction', async () => {
    const created = { id: 'draft_1', revision: 1, ...input }
    const tx = {
      createGraph: jest.fn().mockResolvedValue(created),
      replaceGraphIfRevision: jest.fn(),
      writeAudit: jest.fn().mockResolvedValue(undefined),
    }
    const service = createCommercialDraftService({
      getGraph: jest.fn(),
      runInTransaction: operation => operation(tx),
    })

    await expect(service.createCommercialDraft(input, actor)).resolves.toEqual(created)
    expect(tx.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'COMMERCIAL_DRAFT_CREATED', entityId: 'draft_1', actor }))
  })

  it('rejects a stale revision and does not create a misleading audit row', async () => {
    const tx = {
      createGraph: jest.fn(),
      replaceGraphIfRevision: jest.fn().mockResolvedValue(null),
      writeAudit: jest.fn(),
    }
    const service = createCommercialDraftService({
      getGraph: jest.fn(),
      runInTransaction: operation => operation(tx),
    })

    await expect(service.replaceCommercialDraft('draft_1', input, 4, actor)).rejects.toMatchObject<Partial<ConflictError>>({
      statusCode: 409,
      code: 'COMMERCIAL_DRAFT_CONFLICT',
    })
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('audits the before/after revisions after a successful conditional replace', async () => {
    const replaced = { id: 'draft_1', revision: 5, ...input }
    const tx = {
      createGraph: jest.fn(),
      replaceGraphIfRevision: jest.fn().mockResolvedValue(replaced),
      writeAudit: jest.fn().mockResolvedValue(undefined),
    }
    const service = createCommercialDraftService({
      getGraph: jest.fn(),
      runInTransaction: operation => operation(tx),
    })

    await expect(service.replaceCommercialDraft('draft_1', input, 4, actor)).resolves.toEqual(replaced)
    expect(tx.replaceGraphIfRevision).toHaveBeenCalledWith('draft_1', input, 4, actor.staffId)
    expect(tx.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COMMERCIAL_DRAFT_REPLACED',
        entityId: 'draft_1',
        before: { revision: 4 },
        after: { revision: 5 },
      }),
    )
  })
})
