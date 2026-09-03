import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError, NotFoundError, ValidationError } from '@/errors/AppError'
import { commercialDraftActorSchema, commercialDraftInputSchema, commercialExpectedRevisionSchema } from '@/schemas/commercial.schema'
import type { CommercialDraftActor, CommercialDraftInput, CommercialDraftView } from '@/types/commercial'

type CommercialDraftTransaction = {
  createGraph(input: CommercialDraftInput, actorStaffId: string, sourceKey?: string): Promise<CommercialDraftView>
  replaceGraphIfRevision(
    id: string,
    input: CommercialDraftInput,
    expectedRevision: number,
    actorStaffId: string,
  ): Promise<CommercialDraftView | null>
  writeAudit(input: CommercialDraftAudit): Promise<void>
}

interface CommercialDraftAudit {
  action: 'COMMERCIAL_DRAFT_CREATED' | 'COMMERCIAL_DRAFT_REPLACED'
  entityId: string
  actor: CommercialDraftActor
  before?: { revision: number }
  after: { revision: number }
}

export interface CommercialDraftServiceDependencies {
  getGraph(id: string): Promise<CommercialDraftView | null>
  runInTransaction<T>(
    operation: (transaction: CommercialDraftTransaction) => Promise<T>,
    options?: { timeoutMilliseconds: number },
  ): Promise<T>
}

function parseInput(input: CommercialDraftInput): CommercialDraftInput {
  const parsed = commercialDraftInputSchema.safeParse(input)
  if (!parsed.success)
    throw new ValidationError(`El borrador comercial no es válido: ${parsed.error.issues[0]?.message ?? 'revisa los campos'}`)
  return parsed.data
}

function parseActor(actor: CommercialDraftActor): CommercialDraftActor {
  const parsed = commercialDraftActorSchema.safeParse(actor)
  if (!parsed.success) throw new ValidationError('Se requiere un actor humano y un motivo para modificar el catálogo.')
  return parsed.data
}

export async function getCommercialDraftGraphFromTx(tx: Prisma.TransactionClient, id: string): Promise<CommercialDraftView | null> {
  const row = await tx.commercialDraft.findUnique({
    where: { id },
    include: {
      products: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] },
      pricebooks: { orderBy: { code: 'asc' } },
      prices: { orderBy: { code: 'asc' }, include: { pricebook: true, product: true, bundle: true } },
      bundles: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] },
      bundleItems: { orderBy: [{ sortOrder: 'asc' }, { product: { code: 'asc' } }], include: { bundle: true, product: true } },
      featureBindings: { orderBy: { capabilityCode: 'asc' }, include: { product: true } },
    },
  })
  if (!row) return null
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    name: row.name,
    description: row.description,
    revision: row.revision,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    products: row.products.map(product => ({
      code: product.code,
      slug: product.slug,
      kind: product.kind,
      salesMode: product.salesMode,
      name: product.name,
      description: product.description,
      active: product.active,
      sortOrder: product.sortOrder,
      ...(product.limits ? { limits: product.limits as { users: 'UNLIMITED'; devices: 'UNLIMITED' } } : {}),
    })),
    pricebooks: row.pricebooks.map(pricebook => ({ code: pricebook.code, name: pricebook.name, active: pricebook.active })),
    prices: row.prices.map(price => ({
      code: price.code,
      pricebookCode: price.pricebook.code,
      ...(price.product ? { productCode: price.product.code } : {}),
      ...(price.bundle ? { bundleCode: price.bundle.code } : {}),
      billingUnit: price.billingUnit,
      amount: price.amount.toFixed(2),
      taxBehavior: price.taxBehavior,
      active: price.active,
    })),
    bundles: row.bundles.map(bundle => ({
      code: bundle.code,
      slug: bundle.slug,
      name: bundle.name,
      description: bundle.description,
      active: bundle.active,
      sortOrder: bundle.sortOrder,
    })),
    bundleItems: row.bundleItems.map(item => ({
      bundleCode: item.bundle.code,
      productCode: item.product.code,
      quantity: item.quantity,
      sortOrder: item.sortOrder,
    })),
    featureBindings: row.featureBindings.map(binding => ({
      productCode: binding.product.code,
      capabilityCode: binding.capabilityCode,
      capabilityKind: binding.capabilityKind,
    })),
  }
}

async function createChildren(tx: Prisma.TransactionClient, draftId: string, input: CommercialDraftInput): Promise<void> {
  const products = new Map<string, string>()
  for (const product of input.products) {
    const row = await tx.commercialProductDraft.create({
      data: { draftId, ...product, limits: product.limits ?? Prisma.JsonNull },
      select: { id: true, code: true },
    })
    products.set(row.code, row.id)
  }
  const pricebooks = new Map<string, string>()
  for (const pricebook of input.pricebooks) {
    const row = await tx.commercialPricebookDraft.create({ data: { draftId, ...pricebook }, select: { id: true, code: true } })
    pricebooks.set(row.code, row.id)
  }
  const bundles = new Map<string, string>()
  for (const bundle of input.bundles) {
    const row = await tx.commercialBundleDraft.create({ data: { draftId, ...bundle }, select: { id: true, code: true } })
    bundles.set(row.code, row.id)
  }
  for (const price of input.prices) {
    await tx.commercialPriceDraft.create({
      data: {
        draftId,
        code: price.code,
        pricebookId: pricebooks.get(price.pricebookCode)!,
        productId: price.productCode ? products.get(price.productCode)! : null,
        bundleId: price.bundleCode ? bundles.get(price.bundleCode)! : null,
        billingUnit: price.billingUnit,
        amount: new Prisma.Decimal(price.amount),
        currency: 'MXN',
        taxBehavior: price.taxBehavior,
        taxRateBasisPoints: price.taxBehavior === 'EXCLUSIVE' ? 1600 : 0,
        active: price.active,
      },
    })
  }
  for (const item of input.bundleItems) {
    await tx.commercialBundleItemDraft.create({
      data: {
        draftId,
        bundleId: bundles.get(item.bundleCode)!,
        productId: products.get(item.productCode)!,
        quantity: item.quantity,
        sortOrder: item.sortOrder,
      },
    })
  }
  for (const binding of input.featureBindings) {
    await tx.commercialFeatureBindingDraft.create({
      data: {
        draftId,
        productId: products.get(binding.productCode)!,
        capabilityCode: binding.capabilityCode,
        capabilityKind: binding.capabilityKind,
      },
    })
  }
}

function prismaTransactionAdapter(tx: Prisma.TransactionClient): CommercialDraftTransaction {
  return {
    async createGraph(input, actorStaffId, sourceKey) {
      const draft = await tx.commercialDraft.create({
        data: {
          sourceKey,
          name: input.name,
          description: input.description,
          createdById: actorStaffId,
          updatedById: actorStaffId,
        },
        select: { id: true },
      })
      await createChildren(tx, draft.id, input)
      return (await getCommercialDraftGraphFromTx(tx, draft.id))!
    },
    async replaceGraphIfRevision(id, input, expectedRevision, actorStaffId) {
      const changed = await tx.commercialDraft.updateMany({
        where: { id, revision: expectedRevision, status: 'ACTIVE' },
        data: {
          name: input.name,
          description: input.description,
          updatedById: actorStaffId,
          revision: { increment: 1 },
        },
      })
      if (changed.count !== 1) return null
      await tx.commercialFeatureBindingDraft.deleteMany({ where: { draftId: id } })
      await tx.commercialBundleItemDraft.deleteMany({ where: { draftId: id } })
      await tx.commercialPriceDraft.deleteMany({ where: { draftId: id } })
      await tx.commercialBundleDraft.deleteMany({ where: { draftId: id } })
      await tx.commercialPricebookDraft.deleteMany({ where: { draftId: id } })
      await tx.commercialProductDraft.deleteMany({ where: { draftId: id } })
      await createChildren(tx, id, input)
      return getCommercialDraftGraphFromTx(tx, id)
    },
    async writeAudit(audit) {
      await tx.activityLog.create({
        data: {
          staffId: audit.actor.staffId,
          // Platform-wide commercial changes have no truthful tenant
          // organizationId. The legacy-compatible actor shape therefore uses
          // staffId only; classified durable actors are tenant-scoped by DB.
          actorType: null,
          action: audit.action,
          entity: 'CommercialDraft',
          entityId: audit.entityId,
          ipAddress: audit.actor.ipAddress,
          userAgent: audit.actor.userAgent,
          data: {
            reason: audit.actor.reason,
            ...(audit.before ? { before: audit.before } : {}),
            after: audit.after,
          },
        },
      })
    },
  }
}

const defaultDependencies: CommercialDraftServiceDependencies = {
  getGraph: id => getCommercialDraftGraphFromTx(prisma, id),
  runInTransaction: (operation, options) =>
    prisma.$transaction(tx => operation(prismaTransactionAdapter(tx)), {
      ...(options ? { timeout: options.timeoutMilliseconds } : {}),
    }),
}

export function createCommercialDraftService(dependencies: CommercialDraftServiceDependencies) {
  return {
    async getCommercialDraft(id: string): Promise<CommercialDraftView | null> {
      return dependencies.getGraph(id)
    },
    async createCommercialDraft(
      input: CommercialDraftInput,
      actor: CommercialDraftActor,
      options: { sourceKey?: string; transactionTimeoutMilliseconds?: number } = {},
    ): Promise<CommercialDraftView> {
      const validatedInput = parseInput(input)
      const validatedActor = parseActor(actor)
      return dependencies.runInTransaction(
        async tx => {
          const draft = await tx.createGraph(validatedInput, validatedActor.staffId, options.sourceKey)
          await tx.writeAudit({
            action: 'COMMERCIAL_DRAFT_CREATED',
            entityId: draft.id,
            actor: validatedActor,
            after: { revision: draft.revision },
          })
          return draft
        },
        options.transactionTimeoutMilliseconds === undefined
          ? undefined
          : { timeoutMilliseconds: options.transactionTimeoutMilliseconds },
      )
    },
    async replaceCommercialDraft(
      id: string,
      input: CommercialDraftInput,
      expectedRevision: number,
      actor: CommercialDraftActor,
    ): Promise<CommercialDraftView> {
      const validatedInput = parseInput(input)
      const validatedActor = parseActor(actor)
      const revision = commercialExpectedRevisionSchema.safeParse(expectedRevision)
      if (!revision.success) throw new ValidationError('La revisión esperada debe ser un entero positivo.')
      return dependencies.runInTransaction(async tx => {
        const draft = await tx.replaceGraphIfRevision(id, validatedInput, revision.data, validatedActor.staffId)
        if (!draft) {
          throw new ConflictError(
            'El borrador cambió mientras lo editabas. Actualiza la vista antes de volver a guardar.',
            'COMMERCIAL_DRAFT_CONFLICT',
          )
        }
        await tx.writeAudit({
          action: 'COMMERCIAL_DRAFT_REPLACED',
          entityId: draft.id,
          actor: validatedActor,
          before: { revision: revision.data },
          after: { revision: draft.revision },
        })
        return draft
      })
    },
  }
}

const commercialDraftService = createCommercialDraftService(defaultDependencies)

export const getCommercialDraft = commercialDraftService.getCommercialDraft
export const createCommercialDraft = commercialDraftService.createCommercialDraft
export const replaceCommercialDraft = commercialDraftService.replaceCommercialDraft

export async function requireCommercialDraft(id: string): Promise<CommercialDraftView> {
  const draft = await getCommercialDraft(id)
  if (!draft) throw new NotFoundError('Borrador comercial no encontrado.')
  return draft
}
