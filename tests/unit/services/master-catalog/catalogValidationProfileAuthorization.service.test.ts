import prisma from '@/utils/prismaClient'
import { resolveMasterCatalogAccess } from '@/services/master-catalog/masterCatalogAccess.service'
import { writeCatalogAudit } from '@/services/master-catalog/catalogAudit.service'
import { confirmCatalogValidationProfile, previewCatalogValidationProfile } from '@/services/master-catalog/catalogValidation.service'
import type { CatalogCommandContext } from '@/types/master-catalog'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    catalogValidationProfile: { findMany: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    catalogIdempotencyRecord: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  },
}))
jest.mock('@/services/master-catalog/masterCatalogAccess.service', () => ({ resolveMasterCatalogAccess: jest.fn() }))
jest.mock('@/services/master-catalog/catalogAudit.service', () => ({ writeCatalogAudit: jest.fn() }))

const ownerContext: CatalogCommandContext = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
  orgRole: 'OWNER',
}

const accessible = {
  canMutateContent: true,
  canConfigureControlPlane: true,
  reasonCode: 'ACCESSIBLE',
}

function previewInput(idempotencyKey: string) {
  return { idempotencyKey, name: 'Authorized profile', requiredFields: [] }
}

describe('validation-profile authorization revalidation', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => callback(prisma))
    ;(prisma.catalogValidationProfile.findMany as jest.Mock).mockResolvedValue([])
    ;(prisma.catalogIdempotencyRecord.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
      id: 'profile-batch-1',
      ...data,
    }))
    ;(resolveMasterCatalogAccess as jest.Mock).mockResolvedValue(accessible)
  })

  it.each([
    ['SERVICE actor', { organizationId: 'org-1', actor: { type: 'SERVICE', servicePrincipalId: 'service-1' } } as CatalogCommandContext],
    [
      'impersonating HUMAN',
      {
        organizationId: 'org-1',
        actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: true },
        orgRole: 'OWNER',
      } as CatalogCommandContext,
    ],
  ])('rejects %s before access lookup or idempotency reservation', async (_label, context) => {
    await expect(previewCatalogValidationProfile(context, previewInput('denied-actor'))).rejects.toMatchObject({ statusCode: 403 })

    expect(resolveMasterCatalogAccess).not.toHaveBeenCalled()
    expect(prisma.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('rejects a HUMAN without live MANAGE_PROFILE mutation access', async () => {
    ;(resolveMasterCatalogAccess as jest.Mock).mockResolvedValue({ ...accessible, canMutateContent: false, reasonCode: 'ROLE_DENIED' })

    await expect(previewCatalogValidationProfile(ownerContext, previewInput('role-denied'))).rejects.toMatchObject({ statusCode: 403 })
    expect(prisma.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('maps access dependency failure to retryable 503', async () => {
    ;(resolveMasterCatalogAccess as jest.Mock).mockResolvedValue({
      ...accessible,
      canMutateContent: false,
      reasonCode: 'DEPENDENCY_UNAVAILABLE',
    })

    await expect(previewCatalogValidationProfile(ownerContext, previewInput('dependency-down'))).rejects.toMatchObject({
      statusCode: 503,
      code: 'CATALOG_ACCESS_UNAVAILABLE',
    })
    expect(prisma.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('fails confirm before advisory/profile/audit when access was revoked after preview', async () => {
    ;(resolveMasterCatalogAccess as jest.Mock)
      .mockResolvedValueOnce(accessible)
      .mockResolvedValueOnce({ ...accessible, canMutateContent: false, reasonCode: 'ROLE_DENIED' })
    const preview = await previewCatalogValidationProfile(ownerContext, previewInput('revoked-before-confirm'))

    await expect(
      confirmCatalogValidationProfile(ownerContext, {
        profileBatchId: preview.profileBatchId,
        idempotencyKey: 'revoked-before-confirm',
        previewToken: preview.previewToken,
        confirm: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403 })

    // WHY: Preview never grants durable authority; confirm revalidates live
    // OWNER/CORE before reading the bearer record or acquiring any write lock.
    expect(prisma.catalogIdempotencyRecord.findFirst).not.toHaveBeenCalled()
    expect(prisma.$executeRaw).not.toHaveBeenCalled()
    expect(prisma.catalogValidationProfile.create).not.toHaveBeenCalled()
    expect(writeCatalogAudit).not.toHaveBeenCalled()
  })

  it('rejects a different HUMAN than the actor persisted by preview', async () => {
    const preview = await previewCatalogValidationProfile(ownerContext, previewInput('actor-mismatch'))
    const persisted = (prisma.catalogIdempotencyRecord.create as jest.Mock).mock.calls[0][0].data
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({
      ...persisted,
      id: preview.profileBatchId,
      actorType: 'HUMAN',
      staffId: 'staff-owner',
    })
    const otherActor: CatalogCommandContext = {
      ...ownerContext,
      actor: { type: 'HUMAN', staffId: 'staff-other', impersonating: false },
    }

    await expect(
      confirmCatalogValidationProfile(otherActor, {
        profileBatchId: preview.profileBatchId,
        idempotencyKey: 'actor-mismatch',
        previewToken: preview.previewToken,
        confirm: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403 })

    expect(prisma.$executeRaw).not.toHaveBeenCalled()
    expect(prisma.catalogValidationProfile.create).not.toHaveBeenCalled()
  })
})
