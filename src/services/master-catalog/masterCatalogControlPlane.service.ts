import { ModuleScope, Prisma } from '@prisma/client'
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError'
import type { CatalogActor, MasterCatalogModuleConfigV1 } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
import { transitionCatalogGovernanceToEnforced } from './catalogGovernance.service'
import { MASTER_CATALOG_FEATURE_CODE, resolveMasterCatalogAccess } from './masterCatalogAccess.service'

type Dependencies = {
  db: any
  writeCatalogAudit: typeof writeCatalogAudit
  transitionCatalogGovernanceToEnforced: typeof transitionCatalogGovernanceToEnforced
  resolveMasterCatalogAccess: typeof resolveMasterCatalogAccess
}

const defaults: Dependencies = { db: prisma, writeCatalogAudit, transitionCatalogGovernanceToEnforced, resolveMasterCatalogAccess }

const DAY_MS = 86_400_000

function compareVersions(left: string, right: string): number | null {
  const valid = /^\d+(?:\.\d+)*$/
  if (!valid.test(left) || !valid.test(right)) return left === right ? 0 : null
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function actorSummary(batch: any) {
  if (!batch) return null
  if (batch.actorType === 'SERVICE') return { type: 'SERVICE' as const, servicePrincipalId: batch.servicePrincipalId }
  return batch.staff
    ? { type: 'HUMAN' as const, staffId: batch.staffId, staff: batch.staff }
    : { type: 'HUMAN' as const, staffId: batch.staffId, staff: null }
}

function readinessForVenue(venue: any, observations: any[]) {
  const required = venue.catalogVenueClientRequirements.filter((requirement: any) => requirement.mode === 'REQUIRED')
  const missingFamilies: string[] = []
  const staleFamilies: string[] = []
  const incompatibleFamilies: string[] = []
  const now = Date.now()

  const latestObservations = required.flatMap((requirement: any) => {
    const observation = observations.find(candidate => candidate.family === requirement.family)
    if (!observation) {
      missingFamilies.push(requirement.family)
      return []
    }
    const stale = observation.lastSeenAt.getTime() < now - requirement.maxObservationAgeDays * DAY_MS
    const comparison = requirement.minimumVersion ? compareVersions(observation.appVersion, requirement.minimumVersion) : 0
    const compatible = comparison !== null && comparison >= 0
    if (stale) staleFamilies.push(requirement.family)
    if (!compatible) incompatibleFamilies.push(requirement.family)
    return [{ ...observation, stale, compatible }]
  })

  const activeOverrides = venue.catalogClientReadinessOverrides.filter(
    (override: any) => override.status === 'ACTIVE' && !override.revokedAt && override.expiresAt.getTime() > now,
  )
  const failingFamilies = new Set([...missingFamilies, ...staleFamilies, ...incompatibleFamilies])
  const ready = failingFamilies.size === 0
  const fullyOverridden =
    !ready &&
    [...failingFamilies].every(family => activeOverrides.some((override: any) => override.family === null || override.family === family))
  const state = required.length === 0 ? 'NOT_CONFIGURED' : ready ? 'READY' : fullyOverridden ? 'OVERRIDDEN' : 'NOT_READY'

  return {
    state,
    requiredFamilies: required.map((requirement: any) => requirement.family),
    missingFamilies,
    staleFamilies,
    incompatibleFamilies,
    requirements: venue.catalogVenueClientRequirements,
    latestObservations,
    activeOverrides,
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('Solicitud de control no válida')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !keys.includes(key))) throw new ValidationError('Solicitud de control no válida')
  return input
}

function date(value: unknown, nullable = false): Date | null {
  if (value === null && nullable) return null
  if (typeof value !== 'string') throw new ValidationError('Fecha de control no válida')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ValidationError('Fecha de control no válida')
  return parsed
}

function config(value: unknown): MasterCatalogModuleConfigV1 {
  const input = object(value, ['schemaVersion', 'catalogCoreEnabled', 'identifiersEnabled', 'regionalPricingEnabled', 'governanceMode'])
  if (
    Object.keys(input).length !== 5 ||
    input.schemaVersion !== 1 ||
    typeof input.catalogCoreEnabled !== 'boolean' ||
    typeof input.identifiersEnabled !== 'boolean' ||
    typeof input.regionalPricingEnabled !== 'boolean' ||
    !['OFF', 'ADVISORY', 'ENFORCED'].includes(String(input.governanceMode))
  )
    throw new ValidationError('Configuración de catálogo no válida')
  return input as unknown as MasterCatalogModuleConfigV1
}

export function createMasterCatalogControlPlaneService(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides }

  async function assertActiveSuperadmin(tx: any, actor: CatalogActor) {
    if (actor.type !== 'HUMAN' || actor.impersonating) throw new ForbiddenError('Control de catálogo reservado a SUPERADMIN')
    const authority = await tx.staffVenue.findFirst({
      where: { staffId: actor.staffId, role: 'SUPERADMIN', active: true, staff: { active: true } },
      select: { id: true },
    })
    if (!authority) throw new ForbiddenError('Control de catálogo reservado a SUPERADMIN')
  }

  async function assertOrganization(tx: any, organizationId: string) {
    const organization = await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true } })
    if (!organization) throw new NotFoundError('Organización no encontrada')
  }

  async function assertControl(tx: any, organizationId: string, actor: CatalogActor) {
    await assertActiveSuperadmin(tx, actor)
    await assertOrganization(tx, organizationId)
    const access = await dependencies.resolveMasterCatalogAccess({
      organizationId,
      principal: actor,
      capability: 'CONFIGURE_CONTROL_PLANE',
      requiredGate: 'CORE',
      prisma: tx,
    })
    if (!access.canConfigureControlPlane) throw new ForbiddenError('Control de catálogo reservado a SUPERADMIN')
  }

  return {
    async listOrganizations(actor: CatalogActor, input: { cursor?: string; pageSize?: number } = {}) {
      const pageSize = input.pageSize ?? 25
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ValidationError('pageSize no válido')
      return dependencies.db.$transaction(async (tx: any) => {
        await assertActiveSuperadmin(tx, actor)
        const rows = await tx.organization.findMany({
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: { id: true, name: true, slug: true, _count: { select: { venues: true } } },
          orderBy: { id: 'asc' },
          take: pageSize + 1,
        })
        return { items: rows.slice(0, pageSize), nextCursor: rows.length > pageSize ? rows[pageSize - 1].id : null }
      })
    },

    async getOrganization(organizationId: string, actor: CatalogActor) {
      return dependencies.db.$transaction(async (tx: any) => {
        await assertActiveSuperadmin(tx, actor)
        const organization = await tx.organization.findUnique({
          where: { id: organizationId },
          select: {
            id: true,
            name: true,
            slug: true,
            organizationEntitlements: {
              where: { featureCode: MASTER_CATALOG_FEATURE_CODE },
              take: 1,
              select: {
                id: true,
                status: true,
                source: true,
                startsAt: true,
                endsAt: true,
                reason: true,
                grantedById: true,
                createdAt: true,
                updatedAt: true,
                grantedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
              },
            },
            organizationModules: {
              where: { module: { code: MASTER_CATALOG_FEATURE_CODE } },
              take: 1,
              select: {
                id: true,
                enabled: true,
                enabledBy: true,
                enabledAt: true,
                createdAt: true,
                updatedAt: true,
                module: { select: { active: true, scope: true } },
              },
            },
            venues: {
              orderBy: { name: 'asc' },
              select: {
                id: true,
                name: true,
                currency: true,
                timezone: true,
                catalogGovernanceEnforcedAt: true,
                catalogVenueRollouts: {
                  take: 1,
                  select: {
                    registryState: true,
                    aliasPublicationState: true,
                    governanceState: true,
                    identifierRevision: true,
                    createdAt: true,
                    updatedAt: true,
                    updatedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                  },
                },
                catalogVenueClientRequirements: {
                  orderBy: { family: 'asc' },
                  select: { family: true, mode: true, minimumVersion: true, maxObservationAgeDays: true },
                },
                catalogClientReadinessOverrides: {
                  orderBy: { createdAt: 'desc' },
                  select: {
                    id: true,
                    family: true,
                    status: true,
                    reason: true,
                    expiresAt: true,
                    revokedAt: true,
                    revocationReason: true,
                    createdAt: true,
                    updatedAt: true,
                  },
                },
              },
            },
          },
        })
        if (!organization) throw new NotFoundError('Organización no encontrada')
        const [access, observations, failedLines] = await Promise.all([
          dependencies.resolveMasterCatalogAccess({
            organizationId,
            principal: actor,
            capability: 'CONFIGURE_CONTROL_PLANE',
            requiredGate: 'CORE',
            prisma: tx,
          }),
          tx.catalogClientObservation.findMany({
            where: { organizationId },
            orderBy: [{ venueId: 'asc' }, { family: 'asc' }, { lastSeenAt: 'desc' }, { id: 'desc' }],
            distinct: ['venueId', 'family'],
            select: { venueId: true, family: true, deviceId: true, appVersion: true, lastSeenAt: true, source: true },
          }),
          tx.catalogPublicationLine.findMany({
            where: { organizationId, batch: { state: 'FAILED' } },
            orderBy: [{ batch: { updatedAt: 'desc' } }, { id: 'desc' }],
            distinct: ['venueId'],
            select: {
              venueId: true,
              batch: {
                select: {
                  failureCode: true,
                  failureMessage: true,
                  updatedAt: true,
                  actorType: true,
                  staffId: true,
                  servicePrincipalId: true,
                  staff: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
              },
            },
          }),
        ])
        const failuresByVenue = new Map(failedLines.map((line: any) => [line.venueId, line.batch]))
        return {
          organization: { id: organization.id, name: organization.name, slug: organization.slug },
          entitlement: organization.organizationEntitlements[0] ?? null,
          module: organization.organizationModules[0]
            ? {
                ...organization.organizationModules[0],
                definitionActive: organization.organizationModules[0].module.active,
                scope: organization.organizationModules[0].module.scope,
                module: undefined,
              }
            : null,
          access,
          venues: organization.venues.map((venue: any) => {
            const rollout = venue.catalogVenueRollouts[0]
            const failure = failuresByVenue.get(venue.id) as any
            return {
              id: venue.id,
              name: venue.name,
              currency: venue.currency,
              timezone: venue.timezone,
              catalogGovernanceEnforcedAt: venue.catalogGovernanceEnforcedAt,
              rollout: rollout
                ? { ...rollout, identifierRevision: rollout.identifierRevision.toString() }
                : {
                    registryState: 'NOT_STARTED',
                    aliasPublicationState: 'DISABLED',
                    governanceState: 'NOT_STARTED',
                    identifierRevision: '0',
                    createdAt: null,
                    updatedAt: null,
                    updatedBy: null,
                  },
              readiness: readinessForVenue(
                venue,
                observations.filter((observation: any) => observation.venueId === venue.id),
              ),
              lastFailure: failure
                ? {
                    code: failure.failureCode,
                    message: failure.failureMessage,
                    occurredAt: failure.updatedAt,
                    actor: actorSummary(failure),
                  }
                : null,
            }
          }),
        }
      })
    },

    async updateEntitlement(organizationId: string, actor: CatalogActor, raw: unknown) {
      const input = object(raw, ['status', 'source', 'reason', 'startsAt', 'endsAt'])
      if (!['ACTIVE', 'REVOKED'].includes(String(input.status)) || !['CONTRACT', 'CUSTOM'].includes(String(input.source)))
        throw new ValidationError('Entitlement no válido')
      if (typeof input.reason !== 'string' || !input.reason.trim() || Buffer.byteLength(input.reason) > 2000)
        throw new ValidationError('reason no válido')
      const startsAt = date(input.startsAt)
      const endsAt = date(input.endsAt, true)
      if (endsAt && endsAt.getTime() <= startsAt!.getTime()) throw new ValidationError('endsAt debe ser posterior a startsAt')
      return dependencies.db.$transaction(async (tx: any) => {
        await assertControl(tx, organizationId, actor)
        const before = await tx.organizationEntitlement.findUnique({
          where: { organizationId_featureCode: { organizationId, featureCode: MASTER_CATALOG_FEATURE_CODE } },
        })
        const result = await tx.organizationEntitlement.upsert({
          where: { organizationId_featureCode: { organizationId, featureCode: MASTER_CATALOG_FEATURE_CODE } },
          create: {
            organizationId,
            featureCode: MASTER_CATALOG_FEATURE_CODE,
            status: input.status,
            source: input.source,
            reason: input.reason,
            startsAt,
            endsAt,
            grantedById: actor.type === 'HUMAN' ? actor.staffId : '',
          },
          update: { status: input.status, source: input.source, reason: input.reason, startsAt, endsAt },
        })
        await dependencies.writeCatalogAudit(tx, {
          organizationId,
          actor,
          action: 'CATALOG_ENTITLEMENT_UPDATED',
          entity: 'OrganizationEntitlement',
          entityId: result.id,
          after: {
            status: String(input.status),
            source: String(input.source),
            startsAt: startsAt!.toISOString(),
            endsAt: endsAt?.toISOString() ?? null,
          },
          reason: input.reason as string,
        })
        return { before, after: result }
      })
    },

    async updateModule(organizationId: string, actor: CatalogActor, raw: unknown) {
      const input = object(raw, ['enabled'])
      if (typeof input.enabled !== 'boolean') throw new ValidationError('enabled es requerido')
      return dependencies.db.$transaction(async (tx: any) => {
        await assertControl(tx, organizationId, actor)
        const module = await tx.module.findUnique({
          where: { code: MASTER_CATALOG_FEATURE_CODE },
          select: { id: true, scope: true, active: true },
        })
        if (!module || !module.active || module.scope !== ModuleScope.ORGANIZATION_ONLY)
          throw new NotFoundError('Módulo MASTER_CATALOG no disponible')
        const before = await tx.organizationModule.findUnique({
          where: { organizationId_moduleId: { organizationId, moduleId: module.id } },
        })
        const result = await tx.organizationModule.upsert({
          where: { organizationId_moduleId: { organizationId, moduleId: module.id } },
          create: { organizationId, moduleId: module.id, enabled: input.enabled, enabledBy: actor.type === 'HUMAN' ? actor.staffId : '' },
          update: { enabled: input.enabled },
        })
        await dependencies.writeCatalogAudit(tx, {
          organizationId,
          actor,
          action: 'CATALOG_MODULE_UPDATED',
          entity: 'OrganizationModule',
          entityId: result.id,
          after: { enabled: input.enabled as boolean },
        })
        return { before, after: result }
      })
    },

    async updateConfig(organizationId: string, actor: CatalogActor, raw: unknown) {
      const input = object(raw, ['config'])
      const nextConfig = config(input.config)
      return dependencies.db.$transaction(async (tx: any) => {
        await assertControl(tx, organizationId, actor)
        const module = await tx.module.findUnique({
          where: { code: MASTER_CATALOG_FEATURE_CODE },
          select: { id: true, scope: true, active: true },
        })
        if (!module || !module.active || module.scope !== ModuleScope.ORGANIZATION_ONLY)
          throw new NotFoundError('Módulo MASTER_CATALOG no disponible')
        const assignment = await tx.organizationModule.findUnique({
          where: { organizationId_moduleId: { organizationId, moduleId: module.id } },
          select: { config: true },
        })
        const result = await tx.organizationModule.updateMany({
          where: { organizationId, moduleId: module.id },
          data: { config: nextConfig as unknown as Prisma.InputJsonObject },
        })
        if (result.count !== 1) throw new NotFoundError('Asignación de módulo no encontrada')
        await dependencies.writeCatalogAudit(tx, {
          organizationId,
          actor,
          action: 'CATALOG_CONFIG_UPDATED',
          entity: 'OrganizationModule',
          after: nextConfig as unknown as Prisma.InputJsonObject,
        })
        return { before: assignment?.config ?? null, after: nextConfig }
      })
    },

    async updateGovernance(organizationId: string, venueId: string, actor: CatalogActor, raw: unknown) {
      const input = object(raw, ['governanceState'])
      if (input.governanceState !== 'ENFORCED') throw new ValidationError('Sólo se permite la transición ENFORCED')
      return dependencies.db.$transaction(async (tx: any) => {
        await assertControl(tx, organizationId, actor)
        const venue = await tx.venue.findFirst({
          where: { id: venueId, organizationId },
          select: { id: true, catalogGovernanceEnforcedAt: true },
        })
        if (!venue) throw new NotFoundError('Sucursal no encontrada')
        const rollout = await tx.catalogVenueRollout.findUnique({
          where: { organizationId_venueId: { organizationId, venueId } },
          select: { governanceState: true, updatedAt: true },
        })
        const after = await dependencies.transitionCatalogGovernanceToEnforced(tx, { organizationId, venueId, actor })
        return {
          before: {
            governanceState: rollout?.governanceState ?? 'NOT_STARTED',
            catalogGovernanceEnforcedAt: venue.catalogGovernanceEnforcedAt,
          },
          after,
        }
      })
    },
  }
}

export const masterCatalogControlPlaneService = createMasterCatalogControlPlaneService()
