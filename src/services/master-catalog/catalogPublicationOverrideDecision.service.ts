import type { Prisma } from '@prisma/client'
import { ConflictError, ForbiddenError, ValidationError } from '../../errors/AppError'
import type { CatalogActor, CatalogManagedFieldV1 } from '../../types/master-catalog'
import { canonicalJsonV1 } from './catalogHash.service'
import type { CatalogPublicationJson, CatalogPublicationProjection } from './catalogPublication.types'

export type CatalogPublicationDecisionInput =
  | { field: CatalogManagedFieldV1; decision: 'PUBLISH_CORPORATE' }
  | { field: CatalogManagedFieldV1; decision: 'APPROVE_LOCAL_OVERRIDE'; overrideId: string }

export interface CatalogPublicationResolvedDecision {
  field: CatalogManagedFieldV1
  decision: 'PUBLISH_CORPORATE' | 'APPROVE_LOCAL_OVERRIDE'
  before: CatalogPublicationJson
  proposed: CatalogPublicationJson
  after: CatalogPublicationJson
  overrideId: string | null
  reason: string | null
}

interface OverrideRow {
  id: string
  organizationId: string
  venueId: string
  bindingId: string
  field: string
  localValue: unknown
  status: string
  requestedById: string | null
  decidedById: string | null
  reason: string | null
}

interface OverrideDecisionDependencies {
  now: () => Date
}

function requirePublisher(actor: CatalogActor): asserts actor is Extract<CatalogActor, { type: 'HUMAN' }> {
  // WHY: Content decisions are live corporate authority; SERVICE and
  // impersonated sessions cannot inherit maker/checker permission.
  if (actor.type !== 'HUMAN' || actor.impersonating || !actor.staffId.trim()) {
    throw new ForbiddenError('La decisión de publicación requiere OWNER/ADMIN humano no suplantado')
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJsonV1(left) === canonicalJsonV1(right)
  } catch {
    return false
  }
}

function assertExactDecisionSet(
  projection: Pick<CatalogPublicationProjection, 'fieldMask'>,
  decisions: readonly CatalogPublicationDecisionInput[],
): void {
  const expected = [...projection.fieldMask]
  const actual = decisions.map(decision => decision.field)
  const unique = new Set(actual)
  if (
    actual.length !== expected.length ||
    unique.size !== actual.length ||
    expected.some(field => !unique.has(field)) ||
    actual.some(field => !expected.includes(field))
  ) {
    throw new ConflictError('Cada campo de la publicación requiere una decisión exacta.', 'CATALOG_PUBLICATION_DECISIONS_INCOMPLETE')
  }
}

function overrideConflict(message: string): never {
  throw new ConflictError(message, 'CATALOG_OVERRIDE_CONFLICT')
}

export function createCatalogPublicationOverrideDecisionService(dependencies: OverrideDecisionDependencies = { now: () => new Date() }) {
  return {
    async resolve(
      tx: Prisma.TransactionClient,
      input: {
        organizationId: string
        venueId: string
        bindingId: string
        actor: CatalogActor
        projection: Pick<CatalogPublicationProjection, 'fieldMask' | 'fields'>
        decisions: CatalogPublicationDecisionInput[]
      },
    ): Promise<CatalogPublicationResolvedDecision[]> {
      requirePublisher(input.actor)
      assertExactDecisionSet(input.projection, input.decisions)
      const requestedOverrideIds = input.decisions
        .filter(
          (decision): decision is Extract<CatalogPublicationDecisionInput, { decision: 'APPROVE_LOCAL_OVERRIDE' }> =>
            decision.decision === 'APPROVE_LOCAL_OVERRIDE',
        )
        .map(decision => decision.overrideId)

      const overrides =
        requestedOverrideIds.length === 0
          ? []
          : ((await tx.catalogVenueOverride.findMany({
              where: {
                organizationId: input.organizationId,
                venueId: input.venueId,
                bindingId: input.bindingId,
                field: { in: input.projection.fieldMask },
                status: { in: ['REQUESTED', 'APPROVED'] },
              },
              select: {
                id: true,
                organizationId: true,
                venueId: true,
                bindingId: true,
                field: true,
                localValue: true,
                status: true,
                requestedById: true,
                decidedById: true,
                reason: true,
              },
              orderBy: { id: 'asc' },
            })) as OverrideRow[])

      const decisionByField = new Map(input.decisions.map(decision => [decision.field, decision]))
      const resolved: CatalogPublicationResolvedDecision[] = []
      for (const fieldProjection of input.projection.fields) {
        const decision = decisionByField.get(fieldProjection.field) as CatalogPublicationDecisionInput
        if (decision.decision === 'PUBLISH_CORPORATE') {
          // WHY: Corporate publication never carries an override FK and uses
          // exactly the reviewed proposal, even in mixed preserve/publish lines.
          resolved.push({
            field: fieldProjection.field,
            decision: decision.decision,
            before: fieldProjection.before,
            proposed: fieldProjection.proposed,
            after: fieldProjection.proposed,
            overrideId: null,
            reason: null,
          })
          continue
        }

        const selected = overrides.find(override => override.id === decision.overrideId && override.field === fieldProjection.field)
        if (!selected || !valuesEqual(selected.localValue, fieldProjection.before)) {
          overrideConflict('La excepción ya no coincide con el valor local vigente.')
        }
        if (selected.status === 'REQUESTED' && selected.requestedById === input.actor.staffId) {
          overrideConflict('El solicitante no puede aprobar su propia excepción.')
        }
        if (selected.status !== 'APPROVED' && selected.status !== 'REQUESTED') {
          overrideConflict('La excepción no está vigente para esta publicación.')
        }

        if (selected.status === 'REQUESTED') {
          const currentApproved = overrides.find(
            override => override.field === selected.field && override.status === 'APPROVED' && override.id !== selected.id,
          )
          if (currentApproved) {
            // WHY: The Task 2 deferred FK lets the approved predecessor point
            // at its exact replacement before the replacement's approval CAS.
            const superseded = await tx.catalogVenueOverride.updateMany({
              where: {
                id: currentApproved.id,
                organizationId: input.organizationId,
                bindingId: input.bindingId,
                field: selected.field,
                status: 'APPROVED',
              },
              data: { status: 'SUPERSEDED', supersededByOverrideId: selected.id, supersededAt: dependencies.now() },
            })
            if (superseded.count !== 1) overrideConflict('La excepción aprobada cambió durante la publicación.')
          }
          const approved = await tx.catalogVenueOverride.updateMany({
            where: {
              id: selected.id,
              organizationId: input.organizationId,
              bindingId: input.bindingId,
              field: selected.field,
              status: 'REQUESTED',
              requestedById: { not: input.actor.staffId },
            },
            data: { status: 'APPROVED', decidedById: input.actor.staffId, decidedAt: dependencies.now() },
          })
          if (approved.count !== 1) overrideConflict('La solicitud cambió durante la publicación.')
        }

        resolved.push({
          field: fieldProjection.field,
          decision: 'APPROVE_LOCAL_OVERRIDE',
          before: fieldProjection.before,
          proposed: fieldProjection.proposed,
          after: fieldProjection.before,
          overrideId: selected.id,
          reason: selected.reason ?? null,
        })
      }
      return resolved
    },

    async reject(
      tx: Prisma.TransactionClient,
      input: {
        organizationId: string
        venueId: string
        bindingId: string
        overrideId: string
        actor: CatalogActor
        reason: string
      },
    ): Promise<void> {
      requirePublisher(input.actor)
      if (!input.reason.trim()) throw new ValidationError('El motivo de rechazo es requerido')
      const rows = (await tx.catalogVenueOverride.findMany({
        where: {
          id: input.overrideId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          bindingId: input.bindingId,
          status: 'REQUESTED',
        },
        select: { id: true, requestedById: true },
        take: 1,
      })) as Array<{ id: string; requestedById: string | null }>
      const row = rows[0]
      if (!row) overrideConflict('La solicitud de excepción ya no está vigente.')
      if (row.requestedById === input.actor.staffId) {
        throw new ForbiddenError('El solicitante no puede rechazar su propia excepción.', 'CATALOG_OVERRIDE_MAKER_CHECKER_REQUIRED')
      }
      const rejected = await tx.catalogVenueOverride.updateMany({
        where: {
          id: row.id,
          organizationId: input.organizationId,
          bindingId: input.bindingId,
          status: 'REQUESTED',
          requestedById: { not: input.actor.staffId },
        },
        data: { status: 'REJECTED', decidedById: input.actor.staffId, decidedAt: dependencies.now() },
      })
      if (rejected.count !== 1) overrideConflict('La solicitud cambió durante la decisión.')
    },
  }
}
