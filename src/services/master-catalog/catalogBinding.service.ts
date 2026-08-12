import { Prisma } from '@prisma/client'
import { randomBytes, randomUUID } from 'node:crypto'
import { ForbiddenError, ServiceUnavailableError } from '../../errors/AppError'
import type {
  CatalogBindingConfirmInput,
  CatalogBindingPreview,
  CatalogBindingPreviewInput,
  CatalogBindingResult,
  CatalogCommandContext,
} from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
import { confirmCatalogBindingsWithDependencies, type CatalogBindingConfirmationDependencies } from './catalogBindingConfirmation.service'
import { previewCatalogBindingsWithDependencies } from './catalogBindingPreview.service'
import { acquireCatalogMutationLock } from './catalogMutationLock.service'
import { evaluatePreparedDishBinding } from './catalogRecipeCost.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'

interface CatalogBindingServiceDependencies extends CatalogBindingConfirmationDependencies {
  randomToken(): string
}

export interface CatalogBindingService {
  preview(context: CatalogCommandContext, input: CatalogBindingPreviewInput): Promise<CatalogBindingPreview>
  confirm(context: CatalogCommandContext, input: CatalogBindingConfirmInput): Promise<CatalogBindingResult>
}

export function createCatalogBindingService(dependencies: CatalogBindingServiceDependencies): CatalogBindingService {
  return {
    preview: (context, input) =>
      previewCatalogBindingsWithDependencies(
        {
          prisma: dependencies.prisma,
          assertLiveAccessTx: dependencies.assertLiveAccessTx,
          now: dependencies.now,
          randomToken: dependencies.randomToken,
        },
        context,
        input,
      ),
    confirm: (context, input) => confirmCatalogBindingsWithDependencies(dependencies, context, input),
  }
}

async function assertBindingLiveAccessTx(tx: Prisma.TransactionClient, context: CatalogCommandContext): Promise<void> {
  const access = await resolveMasterCatalogAccess({
    organizationId: context.organizationId,
    principal: context.actor,
    capability: 'MUTATE_CONTENT',
    requiredGate: 'CORE',
    prisma: tx,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') throw new ServiceUnavailableError('No fue posible revalidar Catalog Core')
  if (!access.canMutateContent) throw new ForbiddenError('Acceso de binding denegado')
}

const defaultService = createCatalogBindingService({
  prisma,
  assertLiveAccessTx: assertBindingLiveAccessTx,
  acquireMutationLockTx: acquireCatalogMutationLock,
  writeCatalogAudit,
  evaluatePreparedDishBinding,
  now: () => new Date(),
  randomToken: () => randomBytes(32).toString('base64url'),
  randomAttemptId: () => randomUUID(),
})

export const previewCatalogBindings = (context: CatalogCommandContext, input: CatalogBindingPreviewInput) =>
  defaultService.preview(context, input)
export const confirmCatalogBindings = (context: CatalogCommandContext, input: CatalogBindingConfirmInput) =>
  defaultService.confirm(context, input)
