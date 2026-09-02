import { Prisma } from '@prisma/client'
import { z } from 'zod'

import { commercialDraftActorSchema } from '@/schemas/commercial.schema'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import type { CommercialDraftActor } from '@/types/commercial'
import type { CommercialOfferBenefitDraftInputV3, CommercialOfferDraftViewV3 } from '@/types/commercialOfferV3'
import prisma from '@/utils/prismaClient'

import { loadCommercialOfferDraftGraphV3 } from './commercialOfferDraftGraph.service'

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)
const timestamp = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)))
const common = {
  benefitCode: code.refine(value => value !== 'SAAS_PRICE'),
  priority: z.number().int().min(-10_000).max(10_000),
}
const hardwareCommon = {
  ...common,
  hardwareCatalogKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  quantityLimit: z.number().int().min(1).max(1_000),
  benefitStartsAt: timestamp,
  benefitEndsAt: timestamp,
}
const benefitSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...hardwareCommon,
      kind: z.literal('HARDWARE_PERCENT_OFF'),
      percentBasisPoints: z.number().int().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      ...hardwareCommon,
      kind: z.literal('HARDWARE_FIXED_PRICE'),
      unitAmountMinor: z.string().regex(/^(0|[1-9][0-9]{0,11})$/),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('PAYMENTS_RATE_SCHEDULE'),
      paymentsRateScheduleVersionId: z
        .string()
        .regex(/^payments-rate-schedule-version-[A-Za-z0-9][A-Za-z0-9._:-]{0,95}-v[1-9][0-9]{0,8}$/),
    })
    .strict(),
])
const benefitsSchema = z.array(benefitSchema).max(100)

interface CommercialOfferDraftAudit {
  action: 'COMMERCIAL_OFFER_DRAFT_PROMOTED' | 'COMMERCIAL_OFFER_DRAFT_REPLACED'
  entityId: string
  actor: CommercialDraftActor
  before: { revision: number; offerSchemaVersion: 2 | 3 }
  after: { revision: number; offerSchemaVersion: 3 }
}

export interface CommercialOfferDraftTransaction {
  promoteIfRevision(
    id: string,
    benefits: CommercialOfferBenefitDraftInputV3[],
    expectedRevision: number,
    actorStaffId: string,
  ): Promise<CommercialOfferDraftViewV3 | null>
  replaceIfRevision(
    id: string,
    benefits: CommercialOfferBenefitDraftInputV3[],
    expectedRevision: number,
    actorStaffId: string,
  ): Promise<CommercialOfferDraftViewV3 | null>
  exists(id: string): Promise<boolean>
  writeAudit(input: CommercialOfferDraftAudit): Promise<void>
}

export interface CommercialOfferDraftDependencies {
  getGraph(id: string): Promise<CommercialOfferDraftViewV3 | null>
  runInTransaction<T>(operation: (tx: CommercialOfferDraftTransaction) => Promise<T>): Promise<T>
}

function draftInvalid(details?: unknown): ConflictError {
  return new ConflictError('El borrador de oferta v3 contiene campos inválidos.', 'COMMERCIAL_OFFER_DRAFT_INVALID', details)
}

function parseActor(actor: CommercialDraftActor): CommercialDraftActor {
  const parsed = commercialDraftActorSchema.safeParse(actor)
  if (!parsed.success) throw draftInvalid({ issues: parsed.error.issues })
  return parsed.data
}

function validateBenefitSemantics(benefits: CommercialOfferBenefitDraftInputV3[]): void {
  const codes = benefits.map(benefit => benefit.benefitCode)
  if (new Set(codes).size !== codes.length) throw draftInvalid()
  const hardware = benefits.filter(
    (
      benefit,
    ): benefit is Extract<CommercialOfferBenefitDraftInputV3, { kind: 'HARDWARE_PERCENT_OFF' | 'HARDWARE_FIXED_PRICE' }> =>
      benefit.kind === 'HARDWARE_PERCENT_OFF' || benefit.kind === 'HARDWARE_FIXED_PRICE',
  )
  for (const benefit of hardware) {
    if (Date.parse(benefit.benefitStartsAt) >= Date.parse(benefit.benefitEndsAt)) throw draftInvalid()
  }
  const bySku = new Map<string, typeof hardware>()
  for (const benefit of hardware) {
    const values = bySku.get(benefit.hardwareCatalogKey) ?? []
    values.push(benefit)
    bySku.set(benefit.hardwareCatalogKey, values)
  }
  for (const values of bySku.values()) {
    const ordered = [...values].sort((left, right) => Date.parse(left.benefitStartsAt) - Date.parse(right.benefitStartsAt))
    for (let index = 1; index < ordered.length; index += 1) {
      if (Date.parse(ordered[index].benefitStartsAt) < Date.parse(ordered[index - 1].benefitEndsAt)) throw draftInvalid()
    }
  }
}

export function parseCommercialOfferDraftBenefitsV3(input: unknown): CommercialOfferBenefitDraftInputV3[] {
  const parsed = benefitsSchema.safeParse(input)
  if (!parsed.success) throw draftInvalid({ issues: parsed.error.issues })
  const benefits = [...parsed.data].sort((left, right) =>
    left.benefitCode < right.benefitCode ? -1 : left.benefitCode > right.benefitCode ? 1 : 0,
  ) as CommercialOfferBenefitDraftInputV3[]
  validateBenefitSemantics(benefits)
  return benefits
}

function revision(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw draftInvalid()
  return value
}

export function createCommercialOfferDraftService(dependencies: CommercialOfferDraftDependencies) {
  return {
    getDraft(id: string): Promise<CommercialOfferDraftViewV3 | null> {
      return dependencies.getGraph(id)
    },
    async promoteDraft(
      id: string,
      benefitInput: unknown,
      expectedRevisionInput: number,
      actorInput: CommercialDraftActor,
    ): Promise<CommercialOfferDraftViewV3> {
      const benefits = parseCommercialOfferDraftBenefitsV3(benefitInput)
      const expectedRevision = revision(expectedRevisionInput)
      const actor = parseActor(actorInput)
      return dependencies.runInTransaction(async tx => {
        const promoted = await tx.promoteIfRevision(id, benefits, expectedRevision, actor.staffId)
        if (!promoted) {
          if (!(await tx.exists(id))) throw new NotFoundError('Borrador de campaña no encontrado.')
          throw new ConflictError('La revisión o versión del borrador cambió.', 'COMMERCIAL_OFFER_DRAFT_CONFLICT')
        }
        await tx.writeAudit({
          action: 'COMMERCIAL_OFFER_DRAFT_PROMOTED',
          entityId: id,
          actor,
          before: { revision: expectedRevision, offerSchemaVersion: 2 },
          after: { revision: promoted.revision, offerSchemaVersion: 3 },
        })
        return promoted
      })
    },
    async replaceBenefits(
      id: string,
      benefitInput: unknown,
      expectedRevisionInput: number,
      actorInput: CommercialDraftActor,
    ): Promise<CommercialOfferDraftViewV3> {
      const benefits = parseCommercialOfferDraftBenefitsV3(benefitInput)
      const expectedRevision = revision(expectedRevisionInput)
      const actor = parseActor(actorInput)
      return dependencies.runInTransaction(async tx => {
        const replaced = await tx.replaceIfRevision(id, benefits, expectedRevision, actor.staffId)
        if (!replaced) {
          if (!(await tx.exists(id))) throw new NotFoundError('Borrador de oferta no encontrado.')
          throw new ConflictError('La revisión del borrador de oferta cambió.', 'COMMERCIAL_OFFER_DRAFT_CONFLICT')
        }
        await tx.writeAudit({
          action: 'COMMERCIAL_OFFER_DRAFT_REPLACED',
          entityId: id,
          actor,
          before: { revision: expectedRevision, offerSchemaVersion: 3 },
          after: { revision: replaced.revision, offerSchemaVersion: 3 },
        })
        return replaced
      })
    },
  }
}

async function createBenefits(
  tx: Prisma.TransactionClient,
  campaignDraftId: string,
  benefits: CommercialOfferBenefitDraftInputV3[],
): Promise<void> {
  for (const benefit of benefits) {
    if (benefit.kind === 'HARDWARE_PERCENT_OFF') {
      await tx.commercialOfferBenefitDraft.create({
        data: {
          campaignDraftId,
          offerSchemaVersion: 3,
          benefitCode: benefit.benefitCode,
          kind: benefit.kind,
          priority: benefit.priority,
          hardwareCatalogKey: benefit.hardwareCatalogKey,
          percentBasisPoints: benefit.percentBasisPoints,
          quantityLimit: benefit.quantityLimit,
          benefitStartsAt: new Date(benefit.benefitStartsAt),
          benefitEndsAt: new Date(benefit.benefitEndsAt),
        },
      })
      continue
    }
    if (benefit.kind === 'HARDWARE_FIXED_PRICE') {
      await tx.commercialOfferBenefitDraft.create({
        data: {
          campaignDraftId,
          offerSchemaVersion: 3,
          benefitCode: benefit.benefitCode,
          kind: benefit.kind,
          priority: benefit.priority,
          hardwareCatalogKey: benefit.hardwareCatalogKey,
          unitAmountMinor: BigInt(benefit.unitAmountMinor),
          quantityLimit: benefit.quantityLimit,
          benefitStartsAt: new Date(benefit.benefitStartsAt),
          benefitEndsAt: new Date(benefit.benefitEndsAt),
        },
      })
      continue
    }
    await tx.commercialOfferBenefitDraft.create({
      data: {
        campaignDraftId,
        offerSchemaVersion: 3,
        benefitCode: benefit.benefitCode,
        kind: benefit.kind,
        priority: benefit.priority,
        paymentsRateScheduleVersionId: benefit.paymentsRateScheduleVersionId,
      },
    })
  }
}

function prismaAdapter(tx: Prisma.TransactionClient): CommercialOfferDraftTransaction {
  return {
    async promoteIfRevision(id, benefits, expectedRevision, actorStaffId) {
      const changed = await tx.commercialCampaignDraft.updateMany({
        where: { id, revision: expectedRevision, status: 'ACTIVE', offerSchemaVersion: 2 },
        data: { offerSchemaVersion: 3, revision: { increment: 1 }, updatedById: actorStaffId },
      })
      if (changed.count !== 1) return null
      await createBenefits(tx, id, benefits)
      return loadCommercialOfferDraftGraphV3(tx, id, { consistency: 'FOR_UPDATE' })
    },
    async replaceIfRevision(id, benefits, expectedRevision, actorStaffId) {
      const changed = await tx.commercialCampaignDraft.updateMany({
        where: { id, revision: expectedRevision, status: 'ACTIVE', offerSchemaVersion: 3 },
        data: { revision: { increment: 1 }, updatedById: actorStaffId },
      })
      if (changed.count !== 1) return null
      await tx.commercialOfferBenefitDraft.deleteMany({ where: { campaignDraftId: id } })
      await createBenefits(tx, id, benefits)
      return loadCommercialOfferDraftGraphV3(tx, id, { consistency: 'FOR_UPDATE' })
    },
    async exists(id) {
      return Boolean(await tx.commercialCampaignDraft.findUnique({ where: { id }, select: { id: true } }))
    },
    async writeAudit(input) {
      await tx.activityLog.create({
        data: {
          staffId: input.actor.staffId,
          actorType: null,
          action: input.action,
          entity: 'CommercialCampaignDraft',
          entityId: input.entityId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
          data: { reason: input.actor.reason, before: input.before, after: input.after },
        },
      })
    },
  }
}

export const commercialOfferDraftService = createCommercialOfferDraftService({
  getGraph: id =>
    prisma.$transaction(tx => loadCommercialOfferDraftGraphV3(tx, id, { consistency: 'SNAPSHOT' }), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 30_000,
    }),
  runInTransaction: operation =>
    prisma.$transaction(tx => operation(prismaAdapter(tx)), {
      maxWait: 5_000,
      timeout: 30_000,
    }),
})
