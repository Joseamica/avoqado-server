import { Prisma } from '@prisma/client'
import AppError, { ConflictError, ForbiddenError, ServiceUnavailableError, ValidationError } from '../../errors/AppError'
import type { CatalogActor, MasterCatalogModuleConfigV1 } from '../../types/master-catalog'
import { writeCatalogAudit } from './catalogAudit.service'
import { acquireCatalogGovernanceVenueFence, type CatalogGovernanceVenueFence } from './catalogGovernanceFence.service'
import { MASTER_CATALOG_FEATURE_CODE, resolveMasterCatalogAccess } from './masterCatalogAccess.service'
import { MASTER_ADMIN_PRINCIPAL_ID } from '../../lib/authPrincipals'

type GovernanceTransaction = Prisma.TransactionClient

export interface LegacyCatalogGovernanceInput {
  organizationId: string
  venueId: string
  operation: 'CREATE' | 'ACTIVATE'
  willBeVendable: boolean
  actor: CatalogActor
}

export interface EnforceCatalogGovernanceInput {
  organizationId: string
  venueId: string
  actor: CatalogActor
  enforcedAt?: Date
}

export interface LegacyCatalogGovernanceForVenueInput {
  venueId: string
  operation: 'CREATE' | 'ACTIVATE'
  willBeVendable: boolean
  actor: CatalogActor
}

export interface LegacyCatalogProductUpdateInput {
  organizationId: string
  venueId: string
  productId: string
  requestedActive: boolean
  actor: CatalogActor
}

export type LegacyCatalogGovernanceComputedInput = Omit<LegacyCatalogGovernanceInput, 'willBeVendable'>

export interface LegacyServiceProductCreationAuditInput {
  organizationId: string
  venueId: string
  productId: string
  actor: Extract<CatalogActor, { type: 'SERVICE' }>
}

interface CatalogGovernanceDependencies {
  acquireFence: (tx: GovernanceTransaction, input: { venueId: string; organizationId: string }) => Promise<CatalogGovernanceVenueFence>
  writeCatalogAudit: typeof writeCatalogAudit
  assertControlPlaneAccess: (tx: GovernanceTransaction, organizationId: string, actor: CatalogActor) => Promise<void>
  lockProduct: (
    tx: GovernanceTransaction,
    input: Pick<LegacyCatalogProductUpdateInput, 'organizationId' | 'venueId' | 'productId'>,
  ) => Promise<{ id: string; active: boolean } | null>
  now: () => Date
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseGovernanceConfig(defaultConfig: unknown, overrideConfig: unknown): MasterCatalogModuleConfigV1 | null {
  // WHY: Once the cutoff exists, malformed stored policy fails closed. Module
  // enablement and entitlement are deliberately absent from the truth table.
  if (!isPlainObject(defaultConfig)) return null
  if (overrideConfig != null && !isPlainObject(overrideConfig)) return null
  const value = { ...defaultConfig, ...(overrideConfig ?? {}) }
  const keys = ['schemaVersion', 'catalogCoreEnabled', 'identifiersEnabled', 'regionalPricingEnabled', 'governanceMode']
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) return null
  if (
    value.schemaVersion !== 1 ||
    typeof value.catalogCoreEnabled !== 'boolean' ||
    typeof value.identifiersEnabled !== 'boolean' ||
    typeof value.regionalPricingEnabled !== 'boolean' ||
    !['OFF', 'ADVISORY', 'ENFORCED'].includes(String(value.governanceMode))
  ) {
    return null
  }
  return value as unknown as MasterCatalogModuleConfigV1
}

function requireActor(actor: CatalogActor): void {
  // WHY: Human writers retain Staff provenance while stable SERVICE principals
  // never fabricate a Staff FK at a shared Product boundary.
  const identity = actor.type === 'HUMAN' ? actor.staffId : actor.servicePrincipalId
  if (!identity.trim()) throw new ValidationError('El actor del catálogo es requerido')
}

export function resolveLegacyCatalogActor(staffId: string, impersonating: boolean): CatalogActor {
  // WHY: Break-glass master tokens use a stable synthetic subject and have no
  // Staff row. Classifying that exact identity as SERVICE prevents FK writes
  // while preserving immutable provenance through the catalog audit.
  if (staffId === MASTER_ADMIN_PRINCIPAL_ID) {
    return { type: 'SERVICE', servicePrincipalId: MASTER_ADMIN_PRINCIPAL_ID }
  }
  return { type: 'HUMAN', staffId, impersonating }
}

async function defaultAssertControlPlaneAccess(tx: GovernanceTransaction, organizationId: string, actor: CatalogActor): Promise<void> {
  const access = await resolveMasterCatalogAccess({
    organizationId,
    principal: actor,
    capability: 'CONFIGURE_CONTROL_PLANE',
    requiredGate: 'CORE',
    prisma: tx,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') {
    throw new ServiceUnavailableError(
      'No fue posible validar el control del Catálogo maestro.',
      'CATALOG_GOVERNANCE_DEPENDENCY_UNAVAILABLE',
    )
  }
  if (!access.canConfigureControlPlane) throw new ForbiddenError('No puedes configurar el gobierno del catálogo')
}

const defaults: CatalogGovernanceDependencies = {
  acquireFence: acquireCatalogGovernanceVenueFence,
  writeCatalogAudit,
  assertControlPlaneAccess: defaultAssertControlPlaneAccess,
  lockProduct: async (tx, input) => {
    const rows = await tx.$queryRaw<Array<{ id: string; active: boolean }>>(Prisma.sql`
      SELECT product.id, product.active
      FROM "Product" AS product
      JOIN "Venue" AS venue ON venue.id = product."venueId"
      WHERE product.id = ${input.productId}
        AND product."venueId" = ${input.venueId}
        AND product."deletedAt" IS NULL
        AND venue."organizationId" = ${input.organizationId}
      FOR NO KEY UPDATE OF product
    `)
    return rows[0] ?? null
  },
  now: () => new Date(),
}

export function createCatalogGovernanceService(overrides: Partial<CatalogGovernanceDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides }

  async function assertLegacyAgainstFence(
    tx: GovernanceTransaction,
    input: LegacyCatalogGovernanceInput,
    venue: CatalogGovernanceVenueFence,
  ): Promise<void> {
    // WHY: NULL is the byte-compatible NEVER_ENABLED path; it performs no
    // entitlement, module, rollout, CatalogItem, binding or profile read.
    if (venue.catalogGovernanceEnforcedAt === null || !input.willBeVendable) return

    let moduleDefinition: {
      defaultConfig: unknown
      organizationModules: Array<{ config: unknown }>
    } | null
    let rollout: { governanceState: string } | null
    try {
      ;[moduleDefinition, rollout] = await Promise.all([
        tx.module.findUnique({
          where: { code: MASTER_CATALOG_FEATURE_CODE },
          select: {
            defaultConfig: true,
            organizationModules: {
              where: { organizationId: input.organizationId },
              select: { config: true },
              take: 1,
            },
          },
        }),
        tx.catalogVenueRollout.findUnique({
          where: { organizationId_venueId: { organizationId: input.organizationId, venueId: input.venueId } },
          select: { governanceState: true },
        }),
      ])
    } catch {
      throw new ServiceUnavailableError(
        'No fue posible validar el gobierno del Catálogo maestro.',
        'CATALOG_GOVERNANCE_DEPENDENCY_UNAVAILABLE',
      )
    }

    const config = moduleDefinition
      ? parseGovernanceConfig(moduleDefinition.defaultConfig, moduleDefinition.organizationModules[0]?.config)
      : null
    if (!config || !rollout) {
      throw new ServiceUnavailableError(
        'No fue posible validar el gobierno del Catálogo maestro.',
        'CATALOG_GOVERNANCE_DEPENDENCY_UNAVAILABLE',
      )
    }

    // WHY: Only the two explicit ENFORCED states block legacy vendable writes;
    // commercial grants, paid tier, demo and module enabled flags add no gate.
    if (config.governanceMode === 'ENFORCED' && rollout.governanceState === 'ENFORCED') {
      throw new AppError('Este producto debe crearse o activarse desde el Catálogo maestro.', 422, true, 'CATALOG_GOVERNANCE_REQUIRED', {
        action: 'OPEN_MASTER_CATALOG',
      })
    }
  }

  return {
    async assertLegacy(tx: GovernanceTransaction, input: LegacyCatalogGovernanceInput): Promise<void> {
      requireActor(input.actor)
      const venue = await dependencies.acquireFence(tx, input)
      return assertLegacyAgainstFence(tx, input, venue)
    },

    async assertLegacyProductUpdate(
      tx: GovernanceTransaction,
      input: LegacyCatalogProductUpdateInput,
    ): Promise<{ id: string; active: boolean }> {
      requireActor(input.actor)
      // WHY: The Venue chronology fence precedes the Product row lock, matching
      // ENFORCED transition order and making the activation decision current.
      const venue = await dependencies.acquireFence(tx, input)
      const product = await dependencies.lockProduct(tx, {
        organizationId: input.organizationId,
        venueId: input.venueId,
        productId: input.productId,
      })
      if (!product) throw new AppError('Producto no encontrado', 404)
      await assertLegacyAgainstFence(
        tx,
        {
          ...input,
          operation: 'ACTIVATE',
          willBeVendable: input.requestedActive && !product.active,
        },
        venue,
      )
      return product
    },

    async assertLegacyComputed(
      tx: GovernanceTransaction,
      input: LegacyCatalogGovernanceComputedInput,
      inspectAfterFence: () => Promise<boolean>,
    ): Promise<void> {
      requireActor(input.actor)
      const venue = await dependencies.acquireFence(tx, input)
      const willBeVendable = await inspectAfterFence()
      return assertLegacyAgainstFence(tx, { ...input, willBeVendable }, venue)
    },

    async writeLegacyServiceProductCreationAudit(tx: GovernanceTransaction, input: LegacyServiceProductCreationAuditInput): Promise<void> {
      requireActor(input.actor)
      // WHY: SERVICE writers cannot populate a Staff FK, so the immutable
      // ActivityLog is their queryable creation provenance and shares rollback.
      await dependencies.writeCatalogAudit(tx, {
        organizationId: input.organizationId,
        venueId: input.venueId,
        actor: input.actor,
        action: 'CATALOG_LEGACY_PRODUCT_CREATED',
        entity: 'Product',
        entityId: input.productId,
      })
    },

    async transitionToEnforced(
      tx: GovernanceTransaction,
      input: EnforceCatalogGovernanceInput,
    ): Promise<{ governanceState: 'ENFORCED'; catalogGovernanceEnforcedAt: Date }> {
      requireActor(input.actor)
      if (input.actor.type !== 'HUMAN' || input.actor.impersonating) {
        throw new ForbiddenError('La transición de gobierno requiere un actor humano no suplantado')
      }
      await dependencies.assertControlPlaneAccess(tx, input.organizationId, input.actor)
      const venue = await dependencies.acquireFence(tx, input)
      const enforcedAt = input.enforcedAt ?? dependencies.now()

      // WHY: The first timestamp is a permanent chronology fence; exact replay
      // is idempotent, while moving or clearing it would manufacture legacy rows.
      if (venue.catalogGovernanceEnforcedAt && venue.catalogGovernanceEnforcedAt.getTime() !== enforcedAt.getTime()) {
        throw new ConflictError(
          'La fecha de entrada en vigor del gobierno del catálogo es inmutable.',
          'CATALOG_GOVERNANCE_CUTOFF_IMMUTABLE',
        )
      }
      if (venue.catalogGovernanceEnforcedAt !== null) {
        let rollout: { governanceState: string } | null
        try {
          rollout = await tx.catalogVenueRollout.findUnique({
            where: { organizationId_venueId: { organizationId: input.organizationId, venueId: input.venueId } },
            select: { governanceState: true },
          })
        } catch {
          throw new ServiceUnavailableError(
            'No fue posible validar el rollout del Catálogo maestro.',
            'CATALOG_GOVERNANCE_DEPENDENCY_UNAVAILABLE',
          )
        }
        if (!rollout) {
          throw new ServiceUnavailableError(
            'No fue posible validar el rollout del Catálogo maestro.',
            'CATALOG_GOVERNANCE_DEPENDENCY_UNAVAILABLE',
          )
        }
        // WHY: Exact replay after both durable states reached ENFORCED is a
        // true no-op; rewriting updatedBy/updatedAt or audit would falsify history.
        if (rollout.governanceState === 'ENFORCED') {
          return { governanceState: 'ENFORCED', catalogGovernanceEnforcedAt: enforcedAt }
        }
      }
      if (venue.catalogGovernanceEnforcedAt === null) {
        const cutoffWrite = await tx.venue.updateMany({
          where: { id: input.venueId, organizationId: input.organizationId, catalogGovernanceEnforcedAt: null },
          data: { catalogGovernanceEnforcedAt: enforcedAt },
        })
        if (cutoffWrite.count !== 1) {
          throw new ConflictError('La fecha de gobierno cambió durante la transición.', 'CATALOG_GOVERNANCE_CUTOFF_IMMUTABLE')
        }
      }

      const rolloutWrite = await tx.catalogVenueRollout.updateMany({
        where: { organizationId: input.organizationId, venueId: input.venueId },
        data: { governanceState: 'ENFORCED', updatedById: input.actor.staffId },
      })
      if (rolloutWrite.count !== 1) {
        throw new ServiceUnavailableError(
          'No fue posible actualizar el rollout del Catálogo maestro.',
          'CATALOG_GOVERNANCE_DEPENDENCY_UNAVAILABLE',
        )
      }

      // WHY: Audit shares the caller transaction, so its failure rolls back
      // both the rollout state and the write-once Venue cutoff.
      await dependencies.writeCatalogAudit(tx, {
        organizationId: input.organizationId,
        venueId: input.venueId,
        actor: input.actor,
        action: 'CATALOG_GOVERNANCE_ENFORCED',
        entity: 'CatalogVenueRollout',
        after: { governanceState: 'ENFORCED', catalogGovernanceEnforcedAt: enforcedAt.toISOString() },
      })
      return { governanceState: 'ENFORCED', catalogGovernanceEnforcedAt: enforcedAt }
    },
  }
}

const service = createCatalogGovernanceService()

export async function assertLegacyCatalogGovernance(tx: GovernanceTransaction, input: LegacyCatalogGovernanceInput): Promise<void> {
  return service.assertLegacy(tx, input)
}

export async function assertLegacyCatalogGovernanceForVenue(
  tx: GovernanceTransaction,
  input: LegacyCatalogGovernanceForVenueInput,
): Promise<void> {
  const venue = await tx.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true } })
  if (!venue) throw new AppError('Sucursal no encontrada', 404)
  // WHY: Legacy callers know the Venue but not always its organization; the
  // same transaction resolves tenant identity before taking the shared fence.
  return service.assertLegacy(tx, { ...input, organizationId: venue.organizationId })
}

export async function assertLegacyCatalogProductUpdateGovernance(
  tx: GovernanceTransaction,
  input: Omit<LegacyCatalogProductUpdateInput, 'organizationId'>,
): Promise<{ id: string; active: boolean }> {
  const venue = await tx.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true } })
  if (!venue) throw new AppError('Sucursal no encontrada', 404)
  return service.assertLegacyProductUpdate(tx, { ...input, organizationId: venue.organizationId })
}

export async function assertLegacyCatalogGovernanceComputedForVenue(
  tx: GovernanceTransaction,
  input: Omit<LegacyCatalogGovernanceComputedInput, 'organizationId'>,
  inspectAfterFence: () => Promise<boolean>,
): Promise<void> {
  const venue = await tx.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true } })
  if (!venue) throw new AppError('Sucursal no encontrada', 404)
  return service.assertLegacyComputed(tx, { ...input, organizationId: venue.organizationId }, inspectAfterFence)
}

export async function writeLegacyServiceProductCreationAuditForVenue(
  tx: GovernanceTransaction,
  input: Omit<LegacyServiceProductCreationAuditInput, 'organizationId'>,
): Promise<void> {
  const venue = await tx.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true } })
  if (!venue) throw new AppError('Sucursal no encontrada', 404)
  return service.writeLegacyServiceProductCreationAudit(tx, { ...input, organizationId: venue.organizationId })
}

export async function assertLegacyProductReferencesForVenue(
  tx: GovernanceTransaction,
  input: { venueId: string; categoryId?: string; printStationId?: string | null },
): Promise<void> {
  // WHY: Product FKs are legacy single-column relations. Validate their tenant
  // ownership after the Venue fence and in the Product transaction so a
  // foreign category/print station cannot be linked across venues.
  if (input.categoryId !== undefined) {
    const category = await tx.menuCategory.findFirst({
      where: { id: input.categoryId, venueId: input.venueId },
      select: { id: true },
    })
    if (!category) throw new AppError('Categoría no encontrada', 404)
  }
  if (input.printStationId) {
    const printStation = await tx.printStation.findFirst({
      where: { id: input.printStationId, venueId: input.venueId },
      select: { id: true },
    })
    if (!printStation) throw new AppError('Estación de impresión no encontrada', 404)
  }
}

export async function assertDemoSeedCatalogGovernance(tx: GovernanceTransaction, venueId: string): Promise<void> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue) throw new AppError('Sucursal no encontrada', 404)
  const fence = await acquireCatalogGovernanceVenueFence(tx, { venueId, organizationId: venue.organizationId })
  // WHY: Demo fixtures are legacy-only bootstrap data. Once a chronology
  // cutoff exists they cannot create sellable rows under any rollout mode.
  if (fence.catalogGovernanceEnforcedAt !== null) {
    throw new AppError('El demo no puede sembrar Products después del cutoff.', 422, true, 'CATALOG_GOVERNANCE_REQUIRED')
  }
}

export async function transitionCatalogGovernanceToEnforced(
  tx: GovernanceTransaction,
  input: EnforceCatalogGovernanceInput,
): Promise<{ governanceState: 'ENFORCED'; catalogGovernanceEnforcedAt: Date }> {
  return service.transitionToEnforced(tx, input)
}
