import { ModuleScope, OrgRole, Prisma, StaffRole } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import {
  type CatalogActor,
  type MasterCatalogAccess,
  type MasterCatalogAccessReasonCode,
  type MasterCatalogCapability,
  type MasterCatalogModuleConfigV1,
  type MasterCatalogRequiredGate,
} from '../../types/master-catalog'

export const MASTER_CATALOG_FEATURE_CODE = 'MASTER_CATALOG'

type CatalogAccessDb = Prisma.TransactionClient

interface PrincipalResolution {
  allowed: boolean
  orgRole: MasterCatalogAccess['orgRole']
  canRead: boolean
  canMutateContent: boolean
  canConfigureControlPlane: boolean
}

interface ResolveMasterCatalogAccessInput {
  organizationId: string
  principal: CatalogActor
  capability: MasterCatalogCapability
  requiredGate: MasterCatalogRequiredGate
  prisma?: Prisma.TransactionClient
}

function inaccessibleResult(
  organizationId: string,
  reasonCode: MasterCatalogAccessReasonCode,
  overrides: Partial<MasterCatalogAccess> = {},
): MasterCatalogAccess {
  return {
    organizationId,
    orgRole: null,
    entitlementActive: false,
    moduleActive: false,
    config: null,
    reasonCode,
    canRead: false,
    canMutateContent: false,
    canConfigureControlPlane: false,
    ...overrides,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMasterCatalogConfigV1(value: unknown): value is MasterCatalogModuleConfigV1 {
  if (!isPlainObject(value)) return false

  // Exact keys reject silently-ignored rollout flags; an unknown config version
  // must fail closed before any new catalog mutation can run.
  const expectedKeys = ['schemaVersion', 'catalogCoreEnabled', 'identifiersEnabled', 'regionalPricingEnabled', 'governanceMode']
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some(key => !(key in value))) return false

  return (
    value.schemaVersion === 1 &&
    typeof value.catalogCoreEnabled === 'boolean' &&
    typeof value.identifiersEnabled === 'boolean' &&
    typeof value.regionalPricingEnabled === 'boolean' &&
    (value.governanceMode === 'OFF' || value.governanceMode === 'ADVISORY' || value.governanceMode === 'ENFORCED')
  )
}

function resolveEffectiveConfig(
  defaultConfig: unknown,
  organizationOverride: unknown,
): {
  config: MasterCatalogModuleConfigV1 | null
  reasonCode: 'CONFIG_MISSING' | 'CONFIG_INVALID' | null
} {
  if (defaultConfig === null || defaultConfig === undefined) return { config: null, reasonCode: 'CONFIG_MISSING' }
  if (!isPlainObject(defaultConfig)) return { config: null, reasonCode: 'CONFIG_INVALID' }

  // A null override inherits the definition. Any other non-object JSON is a
  // stored-data error, never an excuse to normalize the organization to defaults.
  if (organizationOverride !== null && organizationOverride !== undefined && !isPlainObject(organizationOverride)) {
    return { config: null, reasonCode: 'CONFIG_INVALID' }
  }

  const effective = {
    ...defaultConfig,
    ...(organizationOverride ?? {}),
  }
  return isMasterCatalogConfigV1(effective) ? { config: effective, reasonCode: null } : { config: null, reasonCode: 'CONFIG_INVALID' }
}

function isGateEnabled(config: MasterCatalogModuleConfigV1, requiredGate: MasterCatalogRequiredGate): boolean {
  if (!config.catalogCoreEnabled) return false
  if (requiredGate === 'CORE') return true
  if (requiredGate === 'IDENTIFIERS') return config.identifiersEnabled
  return config.regionalPricingEnabled
}

async function resolvePrincipal(
  db: CatalogAccessDb,
  organizationId: string,
  principal: CatalogActor,
  capability: MasterCatalogCapability,
): Promise<PrincipalResolution> {
  if (principal.type === 'SERVICE') {
    // Service actors are explicit job principals only; they never inherit an
    // interactive content capability or a role from a human session.
    const allowed = capability === 'RUN_SERVICE_JOB' && principal.servicePrincipalId.trim().length > 0
    return {
      allowed,
      orgRole: null,
      canRead: false,
      canMutateContent: allowed,
      canConfigureControlPlane: false,
    }
  }

  if (!principal.staffId.trim()) {
    return { allowed: false, orgRole: null, canRead: false, canMutateContent: false, canConfigureControlPlane: false }
  }

  const staff = await db.staff.findUnique({
    where: { id: principal.staffId },
    select: {
      active: true,
      organizations: {
        where: { organizationId, isActive: true, leftAt: null },
        select: { role: true, isActive: true, leftAt: true },
        take: 1,
      },
      venues: {
        where: { active: true, role: StaffRole.SUPERADMIN },
        select: { id: true, role: true, active: true },
        take: 1,
      },
    },
  })

  if (!staff?.active) {
    return { allowed: false, orgRole: null, canRead: false, canMutateContent: false, canConfigureControlPlane: false }
  }

  if (capability === 'CONFIGURE_CONTROL_PLANE') {
    // Bootstrap revalidates a live platform principal from the database. It
    // deliberately does not grant corporate content access.
    const allowed = !principal.impersonating && staff.venues.some(venue => venue.active && venue.role === StaffRole.SUPERADMIN)
    return {
      allowed,
      orgRole: null,
      canRead: false,
      canMutateContent: false,
      canConfigureControlPlane: allowed,
    }
  }

  if (capability === 'RUN_SERVICE_JOB') {
    return { allowed: false, orgRole: null, canRead: false, canMutateContent: false, canConfigureControlPlane: false }
  }

  const membership = staff.organizations.find(candidate => candidate.isActive && candidate.leftAt === null)
  const orgRole = membership?.role ?? null
  if (!orgRole) {
    return { allowed: false, orgRole: null, canRead: false, canMutateContent: false, canConfigureControlPlane: false }
  }

  const readable = orgRole === OrgRole.OWNER || orgRole === OrgRole.ADMIN || orgRole === OrgRole.VIEWER
  const mutable = orgRole === OrgRole.OWNER || orgRole === OrgRole.ADMIN
  const managesProfiles = orgRole === OrgRole.OWNER
  const allowed =
    capability === 'READ_CONTENT'
      ? readable
      : capability === 'MANAGE_PROFILE'
        ? managesProfiles && !principal.impersonating
        : mutable && !principal.impersonating

  return {
    allowed,
    orgRole,
    canRead: allowed && capability === 'READ_CONTENT',
    canMutateContent: allowed && (capability === 'MUTATE_CONTENT' || capability === 'MANAGE_PROFILE'),
    canConfigureControlPlane: false,
  }
}

export async function resolveMasterCatalogAccess(input: ResolveMasterCatalogAccessInput): Promise<MasterCatalogAccess> {
  const db = (input.prisma ?? prisma) as CatalogAccessDb

  try {
    const principal = await resolvePrincipal(db, input.organizationId, input.principal, input.capability)
    if (!principal.allowed) {
      // Role denial comes before tenant rollout inspection so a denied principal
      // cannot use reason codes to enumerate a customer's commercial state.
      return inaccessibleResult(input.organizationId, 'ROLE_DENIED', { orgRole: principal.orgRole })
    }

    // Both reads always execute for an authorized principal. Control-plane
    // bootstrap must report current rollout state even when the grant is absent.
    const [entitlement, moduleDefinition] = await Promise.all([
      db.organizationEntitlement.findUnique({
        where: {
          organizationId_featureCode: {
            organizationId: input.organizationId,
            featureCode: MASTER_CATALOG_FEATURE_CODE,
          },
        },
        select: { status: true, startsAt: true, endsAt: true },
      }),
      db.module.findUnique({
        where: { code: MASTER_CATALOG_FEATURE_CODE },
        select: {
          active: true,
          scope: true,
          defaultConfig: true,
          organizationModules: {
            where: { organizationId: input.organizationId },
            select: { enabled: true, config: true },
            take: 1,
          },
        },
      }),
    ])

    const now = Date.now()
    const entitlementActive = Boolean(
      entitlement &&
        entitlement.status === 'ACTIVE' &&
        entitlement.startsAt.getTime() <= now &&
        (entitlement.endsAt === null || entitlement.endsAt.getTime() > now),
    )
    const organizationModule = moduleDefinition?.organizationModules[0] ?? null
    // A corrupted scope is unavailable, not a config error: it prevents the
    // organization rollout itself from being a valid MASTER_CATALOG module.
    const moduleDefinitionActive = Boolean(moduleDefinition?.active && moduleDefinition.scope === ModuleScope.ORGANIZATION_ONLY)
    const moduleActive = Boolean(moduleDefinitionActive && organizationModule?.enabled)
    const configResolution = moduleDefinition
      ? resolveEffectiveConfig(moduleDefinition.defaultConfig, organizationModule?.config)
      : { config: null, reasonCode: null }

    let reasonCode: MasterCatalogAccessReasonCode = 'ACCESSIBLE'
    if (!entitlement) reasonCode = 'ENTITLEMENT_MISSING'
    else if (!entitlementActive) reasonCode = 'ENTITLEMENT_INACTIVE'
    else if (!moduleDefinition || !organizationModule) reasonCode = 'MODULE_MISSING'
    else if (!moduleActive) reasonCode = 'MODULE_INACTIVE'
    else if (configResolution.reasonCode) reasonCode = configResolution.reasonCode
    else if (!configResolution.config || !isGateEnabled(configResolution.config, input.requiredGate)) reasonCode = 'GATE_DISABLED'

    const resourcesAccessible = reasonCode === 'ACCESSIBLE'
    return {
      organizationId: input.organizationId,
      orgRole: principal.orgRole,
      entitlementActive,
      moduleActive,
      config: configResolution.config,
      reasonCode,
      canRead: resourcesAccessible && principal.canRead,
      canMutateContent: resourcesAccessible && principal.canMutateContent,
      // A valid SUPERADMIN may repair/bootstrap missing state, but a dependency
      // failure below still removes this capability and maps to 503.
      canConfigureControlPlane: principal.canConfigureControlPlane,
    }
  } catch {
    return inaccessibleResult(input.organizationId, 'DEPENDENCY_UNAVAILABLE')
  }
}

// HTTP adapters use one mapping so database outages never masquerade as a 403,
// while an authorized bootstrap request remains 200 even when state is missing.
export function masterCatalogAccessHttpStatus(access: MasterCatalogAccess): 200 | 403 | 503 {
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') return 503
  if (access.canRead || access.canMutateContent || access.canConfigureControlPlane) return 200
  return 403
}
