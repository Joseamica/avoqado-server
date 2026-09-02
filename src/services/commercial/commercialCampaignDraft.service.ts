import { Prisma } from '@prisma/client'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { commercialDraftActorSchema } from '@/schemas/commercial.schema'
import { commercialCampaignDraftInputSchema } from '@/schemas/commercialQuote.schema'
import type { CommercialDraftActor } from '@/types/commercial'
import type { CommercialCampaignDraftInput, CommercialCampaignDraftView, CommercialCampaignRuleV2 } from '@/types/commercialQuote'
import prisma from '@/utils/prismaClient'
import { loadCommercialCampaignDraftGraph, normalizeCommercialCampaignDraftInputV2 } from './commercialCampaignDraftGraph.service'
import { assertCommercialMoneyLimitV2, parseCommercialMoneyV2 } from './commercialMoneyV2.service'

interface CampaignDraftAudit {
  action: 'COMMERCIAL_CAMPAIGN_DRAFT_CREATED' | 'COMMERCIAL_CAMPAIGN_DRAFT_REPLACED'
  entityId: string
  actor: CommercialDraftActor
  before?: { revision: number }
  after: { revision: number }
}

interface CampaignDraftTransaction {
  createGraph(input: CommercialCampaignDraftInput, actorStaffId: string): Promise<CommercialCampaignDraftView>
  replaceGraphIfRevision(
    id: string,
    input: CommercialCampaignDraftInput,
    expectedRevision: number,
    actorStaffId: string,
  ): Promise<CommercialCampaignDraftView | null>
  exists(id: string): Promise<boolean>
  writeAudit(input: CampaignDraftAudit): Promise<void>
}

export interface CommercialCampaignDraftDependencies {
  getGraph(id: string): Promise<CommercialCampaignDraftView | null>
  runInTransaction<T>(operation: (tx: CampaignDraftTransaction) => Promise<T>): Promise<T>
}

function parseInput(input: unknown): CommercialCampaignDraftInput {
  const parsed = commercialCampaignDraftInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new ConflictError('El borrador de campaña contiene campos inválidos.', 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID', {
      issues: parsed.error.issues,
    })
  }
  return normalizeCommercialCampaignDraftInputV2(parsed.data)
}

function parseActor(actor: CommercialDraftActor): CommercialDraftActor {
  const parsed = commercialDraftActorSchema.safeParse(actor)
  if (!parsed.success) throw new ConflictError('Se requiere un actor humano y un motivo.', 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID')
  return parsed.data
}

async function createRules(tx: Prisma.TransactionClient, draftId: string, rules: CommercialCampaignRuleV2[]): Promise<void> {
  for (const rule of rules) {
    const amountMinor = 'amount' in rule ? assertCommercialMoneyLimitV2('UNIT_AMOUNT', parseCommercialMoneyV2(rule.amount)) : null
    await tx.commercialCampaignRuleDraft.create({
      data: {
        campaignDraftId: draftId,
        code: rule.code,
        type: rule.type,
        priority: rule.priority,
        target: rule.target as Prisma.InputJsonValue,
        amountMinor,
        percentBasisPoints: 'percentBasisPoints' in rule ? rule.percentBasisPoints : null,
        cycles: rule.cycles,
      },
    })
  }
}

function prismaAdapter(tx: Prisma.TransactionClient): CampaignDraftTransaction {
  return {
    async createGraph(input, actorStaffId) {
      const draft = await tx.commercialCampaignDraft.create({
        data: {
          code: input.code,
          name: input.name,
          description: input.description,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          offerSchemaVersion: 2,
          allowedRuleCodeGroups: Prisma.DbNull,
          stackingGroups: input.stackingGroups as unknown as Prisma.InputJsonValue,
          createdById: actorStaffId,
          updatedById: actorStaffId,
        },
        select: { id: true },
      })
      await createRules(tx, draft.id, input.rules)
      return (await loadCommercialCampaignDraftGraph(tx, draft.id, { consistency: 'FOR_UPDATE' }))!
    },
    async replaceGraphIfRevision(id, input, expectedRevision, actorStaffId) {
      const changed = await tx.commercialCampaignDraft.updateMany({
        where: { id, revision: expectedRevision, status: 'ACTIVE', offerSchemaVersion: 2 },
        data: {
          code: input.code,
          name: input.name,
          description: input.description,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          allowedRuleCodeGroups: Prisma.DbNull,
          stackingGroups: input.stackingGroups as unknown as Prisma.InputJsonValue,
          updatedById: actorStaffId,
          revision: { increment: 1 },
        },
      })
      if (changed.count !== 1) return null
      await tx.commercialCampaignRuleDraft.deleteMany({ where: { campaignDraftId: id } })
      await createRules(tx, id, input.rules)
      return loadCommercialCampaignDraftGraph(tx, id, { consistency: 'FOR_UPDATE' })
    },
    async exists(id) {
      return Boolean(await tx.commercialCampaignDraft.findUnique({ where: { id }, select: { id: true } }))
    },
    async writeAudit(input) {
      await tx.activityLog.create({
        data: {
          staffId: input.actor.staffId,
          // Global control-plane mutation: there is no truthful tenant id, so
          // the ActivityLog tenant guard requires the legacy staff principal.
          actorType: null,
          action: input.action,
          entity: 'CommercialCampaignDraft',
          entityId: input.entityId,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
          data: {
            reason: input.actor.reason,
            ...(input.before ? { before: input.before } : {}),
            after: input.after,
          },
        },
      })
    },
  }
}

export function createCommercialCampaignDraftService(dependencies: CommercialCampaignDraftDependencies) {
  return {
    getDraft(id: string): Promise<CommercialCampaignDraftView | null> {
      return dependencies.getGraph(id)
    },
    async createDraft(input: unknown, actorInput: CommercialDraftActor): Promise<CommercialCampaignDraftView> {
      const parsed = parseInput(input)
      const actor = parseActor(actorInput)
      return dependencies.runInTransaction(async tx => {
        const created = await tx.createGraph(parsed, actor.staffId)
        await tx.writeAudit({
          action: 'COMMERCIAL_CAMPAIGN_DRAFT_CREATED',
          entityId: created.id,
          actor,
          after: { revision: created.revision },
        })
        return created
      })
    },
    async replaceDraft(
      id: string,
      input: unknown,
      expectedRevision: number,
      actorInput: CommercialDraftActor,
    ): Promise<CommercialCampaignDraftView> {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new ConflictError('La revisión del borrador no es válida.', 'COMMERCIAL_CAMPAIGN_DRAFT_CONFLICT')
      }
      const parsed = parseInput(input)
      const actor = parseActor(actorInput)
      return dependencies.runInTransaction(async tx => {
        const replaced = await tx.replaceGraphIfRevision(id, parsed, expectedRevision, actor.staffId)
        if (!replaced) {
          if (!(await tx.exists(id))) throw new NotFoundError('Borrador de campaña no encontrado.')
          throw new ConflictError('La revisión del borrador de campaña cambió.', 'COMMERCIAL_CAMPAIGN_DRAFT_CONFLICT')
        }
        await tx.writeAudit({
          action: 'COMMERCIAL_CAMPAIGN_DRAFT_REPLACED',
          entityId: id,
          actor,
          before: { revision: expectedRevision },
          after: { revision: replaced.revision },
        })
        return replaced
      })
    },
  }
}

export const commercialCampaignDraftService = createCommercialCampaignDraftService({
  getGraph: id =>
    prisma.$transaction(tx => loadCommercialCampaignDraftGraph(tx, id, { consistency: 'SNAPSHOT' }), {
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
