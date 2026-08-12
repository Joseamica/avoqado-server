import { Prisma } from '@prisma/client'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const H1_CONSTRAINT_MARKERS = [
  'ActivityLog_actorStaffId',
  'OrganizationEntitlement_grantedById',
  'CatalogBrand_',
  'CatalogManufacturer_',
  'CatalogFamily_',
  'CatalogItem_',
  'CatalogProductTypeMapping_',
  'CatalogIdentifier_',
  'CatalogValidationProfile_',
  'CatalogItemPrice_',
  'CatalogVenueRollout_',
  'CatalogVenueClientRequirement_',
  'CatalogClientReadinessOverride_',
  'CatalogVenueBinding_',
  'CatalogVenueOverride_',
  'CatalogIdempotencyRecord_staffId',
  'CatalogImportBatch_staffId',
  'CatalogBindingBatch_staffId',
  'CatalogPublicationBatch_staffId',
] as const

export function isH1ProvenanceConstraint(error: unknown): boolean {
  const value = error as { code?: string; message?: string; meta?: unknown; constraint?: string; detail?: string }
  if (!['P2003', 'P2004', 'P2010', '23503', '23514'].includes(value.code ?? '')) return false
  const signature = `${value.constraint ?? ''} ${value.detail ?? ''} ${value.message ?? ''} ${JSON.stringify(value.meta ?? {})}`
  return H1_CONSTRAINT_MARKERS.some(marker => signature.includes(marker))
}

export async function deleteOrRetainStaffWithH1ProvenanceTx(
  tx: Prisma.TransactionClient,
  staffId: string,
  afterStaffLock?: (staffId: string) => Promise<void>,
) {
  // WHY: Classification and mutation share a row lock so an H1 writer
  // cannot add immutable Staff provenance between the decision and delete.
  const locked = await tx.$queryRaw<Array<{ id: string; email: string }>>(Prisma.sql`
    SELECT id, email FROM "Staff" WHERE id = ${staffId} FOR UPDATE
  `)
  const staff = locked[0]
  if (!staff) throw new NotFoundError('Usuario no encontrado')
  await afterStaffLock?.(staffId)
  const provenance = await tx.$queryRaw<Array<{ hasProvenance: boolean }>>(Prisma.sql`
    SELECT TRUE AS "hasProvenance"
    WHERE EXISTS (SELECT 1 FROM "ActivityLog" WHERE "actorStaffId" = ${staffId} AND "organizationId" IS NOT NULL)
       OR EXISTS (SELECT 1 FROM "OrganizationEntitlement" WHERE "grantedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogBrand" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogManufacturer" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogFamily" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogItem" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogProductTypeMapping" WHERE "createdById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogIdentifier" WHERE "createdById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogValidationProfile" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogItemPrice" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogVenueRollout" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogVenueClientRequirement" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogClientReadinessOverride" WHERE "createdById" = ${staffId} OR "revokedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogVenueBinding" WHERE "createdById" = ${staffId} OR "updatedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogVenueOverride" WHERE "requestedById" = ${staffId} OR "decidedById" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogIdempotencyRecord" WHERE "staffId" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogImportBatch" WHERE "staffId" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogBindingBatch" WHERE "staffId" = ${staffId})
       OR EXISTS (SELECT 1 FROM "CatalogPublicationBatch" WHERE "staffId" = ${staffId})
    LIMIT 1
  `)
  // These authorities use plain String actor identifiers rather than
  // cascading Staff relations. Revoke them before either terminal branch
  // so a hard-deleted actor cannot keep refreshing or finish OAuth.
  const revokedAt = new Date()
  await tx.mcpAuthCode.deleteMany({ where: { staffId } })
  await tx.mcpRefreshToken.updateMany({ where: { staffId, revokedAt: null }, data: { revokedAt } })
  await tx.oAuthState.deleteMany({ where: { userId: staffId } })
  await tx.googleOAuthSession.deleteMany({ where: { OR: [{ authUserId: staffId }, { staffId }] } })
  if (!provenance.length) {
    await tx.staff.delete({ where: { id: staffId } })
    return { staff, retainedForAudit: false }
  }
  await tx.staffOrganization.updateMany({ where: { staffId, isActive: true }, data: { isActive: false, leftAt: revokedAt } })
  await tx.staffVenue.updateMany({
    where: { staffId, active: true },
    data: { active: false, endDate: revokedAt, pin: null, posStaffId: null, permissions: Prisma.JsonNull },
  })
  await tx.staffPasskey.deleteMany({ where: { staffId } })
  await tx.deviceToken.deleteMany({ where: { staffId } })
  await tx.googleCalendarConnection.deleteMany({ where: { staffId } })
  await tx.staff.update({
    where: { id: staffId },
    data: {
      active: false,
      email: `deleted+${staffId}@redacted.avoqado.invalid`,
      password: null,
      googleId: null,
      firstName: 'Usuario',
      lastName: 'eliminado',
      phone: null,
      employeeCode: null,
      photoUrl: null,
      emailVerified: false,
      emailVerificationCode: null,
      emailVerificationExpires: null,
      resetToken: null,
      resetTokenExpiry: null,
      resetTokenUsedAt: null,
      posRawData: Prisma.JsonNull,
    },
  })
  return { staff, retainedForAudit: true }
}

export function createStaffDeletionService(
  overrides: {
    prisma?: typeof prisma
    afterStaffLock?: (staffId: string) => Promise<void>
  } = {},
) {
  const dependencies = { prisma: overrides.prisma ?? prisma, afterStaffLock: overrides.afterStaffLock }
  return async (staffId: string) => {
    try {
      return await dependencies.prisma.$transaction(tx => deleteOrRetainStaffWithH1ProvenanceTx(tx, staffId, dependencies.afterStaffLock))
    } catch (error) {
      if (isH1ProvenanceConstraint(error)) {
        throw new ConflictError('El usuario conserva provenance inmutable de catálogo', 'STAFF_HAS_H1_PROVENANCE')
      }
      throw error
    }
  }
}

export const deleteOrRetainStaffWithH1Provenance = createStaffDeletionService()
