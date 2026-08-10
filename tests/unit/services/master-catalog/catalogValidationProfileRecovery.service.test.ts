import { recoverCatalogValidationProfileResultV1 } from '@/services/master-catalog/catalogValidationProfileRecovery.service'

function appliedRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-batch-1',
    resourceType: 'CatalogValidationProfile',
    resourceId: 'profile-1',
    result: {
      profileBatchId: 'profile-batch-1',
      profileId: 'profile-1',
      profileVersion: 1,
      rulesSchemaVersion: 1,
      active: true,
    },
    ...overrides,
  }
}

describe('recoverCatalogValidationProfileResultV1', () => {
  it('returns a persisted result only when it is bound to its state-machine record', () => {
    expect(recoverCatalogValidationProfileResultV1(appliedRecord() as any)).toEqual(appliedRecord().result)
  })

  it.each([
    ['batch mismatch', { result: { ...appliedRecord().result, profileBatchId: 'another-batch' } }],
    ['profile mismatch', { result: { ...appliedRecord().result, profileId: 'another-profile' } }],
    ['wrong resource type', { resourceType: 'CatalogItem' }],
    ['blank matching batch ids', { id: ' ', result: { ...appliedRecord().result, profileBatchId: ' ' } }],
    ['null resource id', { resourceId: null }],
    ['blank resource id', { resourceId: ' ' }],
    ['blank result id', { result: { ...appliedRecord().result, profileId: ' ' } }],
    ['zero version', { result: { ...appliedRecord().result, profileVersion: 0 } }],
    ['PostgreSQL Int overflow', { result: { ...appliedRecord().result, profileVersion: 2_147_483_648 } }],
    ['wrong schema', { result: { ...appliedRecord().result, rulesSchemaVersion: 2 } }],
    ['inactive result', { result: { ...appliedRecord().result, active: false } }],
  ])('rejects %s as an untrusted APPLIED result', (_label, overrides) => {
    // WHY: Idempotent recovery must not return a well-shaped JSON blob that was
    // copied from another batch/profile or detached from resource provenance.
    expect(recoverCatalogValidationProfileResultV1(appliedRecord(overrides) as any)).toBeNull()
  })
})
