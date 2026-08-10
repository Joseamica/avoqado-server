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
          select: { id: true, name: true, slug: true, venues: { select: { id: true, name: true, catalogGovernanceEnforcedAt: true } } },
        })
        if (!organization) throw new NotFoundError('Organización no encontrada')
        const access = await dependencies.resolveMasterCatalogAccess({
          organizationId,
          principal: actor,
          capability: 'CONFIGURE_CONTROL_PLANE',
          requiredGate: 'CORE',
          prisma: tx,
        })
        return { organization, access }
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
        return result
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
        return result
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
        return nextConfig
      })
    },

    async updateGovernance(organizationId: string, venueId: string, actor: CatalogActor, raw: unknown) {
      const input = object(raw, ['governanceState'])
      if (input.governanceState !== 'ENFORCED') throw new ValidationError('Sólo se permite la transición ENFORCED')
      return dependencies.db.$transaction(async (tx: any) => {
        await assertControl(tx, organizationId, actor)
        const venue = await tx.venue.findFirst({ where: { id: venueId, organizationId }, select: { id: true } })
        if (!venue) throw new NotFoundError('Sucursal no encontrada')
        return dependencies.transitionCatalogGovernanceToEnforced(tx, { organizationId, venueId, actor })
      })
    },
  }
}

export const masterCatalogControlPlaneService = createMasterCatalogControlPlaneService()
