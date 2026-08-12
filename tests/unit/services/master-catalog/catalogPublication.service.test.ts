import { createCatalogPublicationService } from '@/services/master-catalog/catalogPublication.service'

const context = { organizationId: 'org-1', actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false } }

describe('catalogPublication.service', () => {
  it.each([
    ['CATALOG_FIELDS_PUBLISH', 'previewFields'],
    ['CATALOG_PRODUCT_ACTIVATION', 'previewActivation'],
    ['CATALOG_FIELDS_REVERSION', 'previewReversion'],
  ] as const)('routes %s to its static preview implementation', async (operation, expected) => {
    const dependencies = {
      previewFields: jest.fn().mockResolvedValue({ operation }),
      previewActivation: jest.fn().mockResolvedValue({ operation }),
      previewReversion: jest.fn().mockResolvedValue({ operation }),
      confirm: jest.fn(),
      recover: jest.fn(),
    }
    const service = createCatalogPublicationService(dependencies as never)
    const input = { operation, idempotencyKey: 'key-1', targets: [] }

    await expect(service.preview(context, input as never)).resolves.toEqual({ operation })
    expect(dependencies[expected]).toHaveBeenCalledWith(context, input)
    expect(Object.values(dependencies).filter(value => jest.isMockFunction(value) && value.mock.calls.length > 0)).toHaveLength(1)
  })

  it('shares generic confirm and recovery without a second state machine', async () => {
    const dependencies = {
      previewFields: jest.fn(),
      previewActivation: jest.fn(),
      previewReversion: jest.fn(),
      confirm: jest.fn().mockResolvedValue({ state: 'APPLIED' }),
      recover: jest.fn().mockResolvedValue({ state: 'PREVIEWED' }),
    }
    const service = createCatalogPublicationService(dependencies as never)
    const confirmInput = { confirm: true as const, publicationBatchId: 'batch-1', previewToken: 'token', idempotencyKey: 'key' }
    const recoveryInput = { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey: 'key' }

    await service.confirm(context, confirmInput)
    await service.getByIdempotencyKey(context, recoveryInput as never)
    expect(dependencies.confirm).toHaveBeenCalledWith(context, confirmInput)
    expect(dependencies.recover).toHaveBeenCalledWith(context, recoveryInput)
  })

  it.each([
    [null, 'CATALOG_PUBLICATION_INPUT_INVALID'],
    [[], 'CATALOG_PUBLICATION_INPUT_INVALID'],
    [{ operation: 'UNKNOWN' }, 'CATALOG_PUBLICATION_OPERATION_UNSUPPORTED'],
  ])('rejects malformed or unknown preview routing before any dependency: %p', async (input, code) => {
    const dependencies = {
      previewFields: jest.fn(),
      previewActivation: jest.fn(),
      previewReversion: jest.fn(),
      confirm: jest.fn(),
      recover: jest.fn(),
    }
    const service = createCatalogPublicationService(dependencies as never)

    await expect(service.preview(context, input as never)).rejects.toMatchObject({ statusCode: 422, code })
    expect(Object.values(dependencies).every(dependency => dependency.mock.calls.length === 0)).toBe(true)
  })
})
