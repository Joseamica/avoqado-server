import { ActivityActorType, BusinessType, CatalogOperationState, Prisma, VenueOperationalRole } from '@prisma/client'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../errors/AppError'
import type {
  CatalogCommandContext,
  CatalogValidationProfileConfirmInput,
  CatalogValidationProfilePreview,
  CatalogValidationProfilePreviewInput,
  CatalogValidationProfileResult,
} from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
import { recoverCatalogValidationProfileResultV1 } from './catalogValidationProfileRecovery.service'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'
import { assertCatalogValidationRuleJsonV1 } from './catalogValidationRuleJson.service'
import { acquireCatalogMutationLock } from './catalogMutationLock.service'

const PROFILE_OPERATION = 'VALIDATION_PROFILE_CHANGE'
const PROFILE_RULES_SCHEMA_VERSION = 1 as const
const PROFILE_PREVIEW_TTL_MS = 30 * 60 * 1000
const POSTGRES_INT_MAX = 2_147_483_647
const SHA256_HEX = /^[0-9a-f]{64}$/
const FORBIDDEN_RELAXATION_KEYS = new Set([
  'excludedfields',
  'optionalfields',
  'overriderequiredfields',
  'relaxbaseline',
  'removerequiredfields',
])

type ProfileTargetV1 = Prisma.InputJsonObject & {
  schemaVersion: 1
  name: string
  businessType: BusinessType | null
  operationalRole: VenueOperationalRole | null
  requiredFields: string[]
  additionalRules: Prisma.InputJsonObject | null
}

interface ProfileSetRowV1 {
  id: string
  profileVersion: number
  rulesSchemaVersion: number
  businessType: BusinessType | null
  operationalRole: VenueOperationalRole | null
  requiredFields: string[]
  additionalRules: Prisma.JsonValue | null
  active: boolean
  updatedAt: Date
}

interface ProfileDependenciesV1 {
  schemaVersion: 1
  profileSetHash: string
  target: ProfileTargetV1
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function opaqueStringsEqual(left: string, right: string): boolean {
  // WHY: Opaque idempotency bytes cannot be trim/Unicode-normalized into another operation identity.
  return Buffer.from(left, 'utf8').equals(Buffer.from(right, 'utf8'))
}

function containsRelaxationDirective(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRelaxationDirective)
  if (!isPlainObject(value)) return false
  return Object.entries(value).some(
    ([key, nested]) =>
      FORBIDDEN_RELAXATION_KEYS.has(key.normalize('NFC').replace(/[_-]/g, '').toLowerCase()) || containsRelaxationDirective(nested),
  )
}

function normalizeRequiredFields(fields: readonly string[]): string[] {
  if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) {
    throw new ValidationError('requiredFields debe ser una lista de texto')
  }
  const normalized = fields.map(field => field.normalize('NFC').trim())
  if (normalized.some(field => field.length === 0 || field.length > 128)) {
    throw new ValidationError('requiredFields contiene un campo inválido')
  }
  return [...new Set(normalized)].sort(compareOrdinal)
}

function normalizeTarget(input: CatalogValidationProfilePreviewInput): ProfileTargetV1 {
  if (typeof input.name !== 'string') throw new ValidationError('name de perfil inválido')
  const name = input.name.normalize('NFC').trim()
  if (name.length === 0 || name.length > 120) throw new ValidationError('name de perfil inválido')

  const businessType = input.businessType ?? null
  const operationalRole = input.operationalRole ?? null
  if (businessType !== null && !Object.values(BusinessType).includes(businessType)) throw new ValidationError('businessType inválido')
  if (operationalRole !== null && !Object.values(VenueOperationalRole).includes(operationalRole)) {
    throw new ValidationError('operationalRole inválido')
  }
  if (input.additionalRules != null && !isPlainObject(input.additionalRules))
    throw new ValidationError('additionalRules debe ser un objeto')
  if (input.additionalRules != null) {
    try {
      // WHY: Profile preview and durable confirm share the same bounded JSON
      // producer policy as Task 7 before canonicalization or persistence.
      assertCatalogValidationRuleJsonV1(input.additionalRules)
    } catch {
      throw new ValidationError('additionalRules excede el contrato JSON V1')
    }
  }
  if (input.additionalRules != null && containsRelaxationDirective(input.additionalRules)) {
    // WHY: Rejecting nested relaxation vocabulary prevents a future evaluator from weakening H1.
    throw new ValidationError('El perfil no puede relajar el baseline H1')
  }

  let additionalRules: Prisma.InputJsonObject | null = null
  if (input.additionalRules != null) {
    try {
      additionalRules = JSON.parse(canonicalJsonV1(input.additionalRules)) as Prisma.InputJsonObject
    } catch {
      throw new ValidationError('additionalRules inválido')
    }
  }

  return {
    schemaVersion: 1,
    name,
    businessType,
    operationalRole,
    requiredFields: normalizeRequiredFields(input.requiredFields),
    additionalRules,
  }
}

async function assertProfileAccess(context: CatalogCommandContext, tx: Prisma.TransactionClient): Promise<void> {
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating)
    throw new ForbiddenError('Sólo OWNER humano puede administrar perfiles')
  const access = await resolveMasterCatalogAccess({
    organizationId: context.organizationId,
    principal: context.actor,
    capability: 'MANAGE_PROFILE',
    requiredGate: 'CORE',
    prisma: tx,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') {
    throw new ServiceUnavailableError('No fue posible revalidar acceso al catálogo', 'CATALOG_ACCESS_UNAVAILABLE')
  }
  if (!access.canMutateContent) throw new ForbiddenError('Sólo OWNER con Catalog Core activo puede administrar perfiles')
}

function canonicalProfileSet(rows: readonly ProfileSetRowV1[]): unknown[] {
  return [...rows]
    .sort((left, right) => left.profileVersion - right.profileVersion || compareOrdinal(left.id, right.id))
    .map(row => ({
      id: row.id,
      profileVersion: row.profileVersion,
      rulesSchemaVersion: row.rulesSchemaVersion,
      businessType: row.businessType,
      operationalRole: row.operationalRole,
      requiredFields: normalizeRequiredFields(row.requiredFields),
      additionalRules: row.additionalRules,
      active: row.active,
      updatedAt: row.updatedAt.toISOString(),
    }))
}

function profileSetHash(organizationId: string, name: string, rows: readonly ProfileSetRowV1[]): string {
  return hashCanonicalJsonV1('catalog-validation-profile-set', { organizationId, name, profiles: canonicalProfileSet(rows) })
}

function nextProfileVersion(rows: readonly ProfileSetRowV1[]): number {
  let maximum = 0
  for (const row of rows) {
    if (!Number.isSafeInteger(row.profileVersion) || row.profileVersion < 1 || row.profileVersion > POSTGRES_INT_MAX) {
      throw new ConflictError('Versión de perfil persistida inválida', 'CATALOG_VALIDATION_PROFILE_VERSION_INVALID')
    }
    maximum = Math.max(maximum, row.profileVersion)
  }
  if (maximum === POSTGRES_INT_MAX) {
    throw new ConflictError('Se agotaron las versiones del perfil', 'CATALOG_VALIDATION_PROFILE_VERSION_EXHAUSTED')
  }
  return maximum + 1
}

async function readProfileSet(tx: Prisma.TransactionClient, organizationId: string, name: string): Promise<ProfileSetRowV1[]> {
  return tx.catalogValidationProfile.findMany({
    where: { organizationId, name },
    select: {
      id: true,
      profileVersion: true,
      rulesSchemaVersion: true,
      businessType: true,
      operationalRole: true,
      requiredFields: true,
      additionalRules: true,
      active: true,
      updatedAt: true,
    },
    orderBy: [{ profileVersion: 'asc' }, { id: 'asc' }],
  })
}

function parseDependencies(value: Prisma.JsonValue | null): ProfileDependenciesV1 {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.profileSetHash !== 'string' ||
    !SHA256_HEX.test(value.profileSetHash)
  ) {
    throw new ConflictError('Preview de perfil inválido', 'CATALOG_VALIDATION_PROFILE_PREVIEW_INVALID')
  }
  if (!isPlainObject(value.target)) throw new ConflictError('Preview de perfil inválido', 'CATALOG_VALIDATION_PROFILE_PREVIEW_INVALID')

  try {
    const target = normalizeTarget({
      idempotencyKey: 'persisted-preview',
      name: value.target.name as string,
      businessType: (value.target.businessType as BusinessType | null) ?? null,
      operationalRole: (value.target.operationalRole as VenueOperationalRole | null) ?? null,
      requiredFields: value.target.requiredFields as string[],
      additionalRules: (value.target.additionalRules as Prisma.InputJsonObject | null) ?? null,
    })
    if (value.target.schemaVersion !== 1) throw new Error('schema')
    return { schemaVersion: 1, profileSetHash: value.profileSetHash, target }
  } catch (error) {
    if (error instanceof ConflictError) throw error
    throw new ConflictError('Preview de perfil inválido', 'CATALOG_VALIDATION_PROFILE_PREVIEW_INVALID')
  }
}

function tokenMatches(rawToken: string, expectedHash: string | null): boolean {
  const actual = Buffer.from(sha256(rawToken), 'hex')
  const expected = SHA256_HEX.test(expectedHash ?? '') ? Buffer.from(expectedHash as string, 'hex') : Buffer.alloc(32)
  // WHY: Fixed 32-byte buffers keep comparison time independent of bearer/digest validity.
  return timingSafeEqual(actual, expected) && SHA256_HEX.test(expectedHash ?? '')
}

function isPrismaUniqueConflict(error: unknown): boolean {
  return isPlainObject(error) && error.code === 'P2002'
}

function rejectRecoveredPreview(existing: { requestHash: string; state: CatalogOperationState } | null, requestHash: string): never {
  if (!existing) throw new ConflictError('La reserva idempotente concurrente no está disponible', 'IDEMPOTENCY_RESERVATION_CONFLICT')
  if (!opaqueStringsEqual(existing.requestHash, requestHash)) {
    throw new ConflictError('La idempotency key ya pertenece a otro target', 'IDEMPOTENCY_KEY_REUSED')
  }
  // WHY: Digest-only PREVIEWED state cannot reconstruct/re-expose the bearer; callers retain it or use a new key.
  if (existing.state === CatalogOperationState.PREVIEWED) {
    throw new ConflictError(
      'Conserva el preview token original o usa una key nueva',
      'CATALOG_VALIDATION_PROFILE_PREVIEW_TOKEN_NOT_RECOVERABLE',
    )
  }
  throw new ConflictError('La idempotency key ya fue utilizada; recupera confirmación o usa una key nueva', 'IDEMPOTENCY_KEY_ALREADY_USED')
}

export async function previewCatalogValidationProfileCommand(
  context: CatalogCommandContext,
  input: CatalogValidationProfilePreviewInput,
  resolveEffectiveFields: (requiredFields: readonly string[]) => string[],
): Promise<CatalogValidationProfilePreview> {
  const target = normalizeTarget(input)
  if (typeof input.idempotencyKey !== 'string' || !/\S/u.test(input.idempotencyKey) || input.idempotencyKey.length > 200) {
    throw new ValidationError('idempotencyKey inválido')
  }
  const idempotencyKey = input.idempotencyKey
  const targetHash = hashCanonicalJsonV1('catalog-validation-profile-target', target)

  try {
    return await prisma.$transaction(async tx => {
      await assertProfileAccess(context, tx)
      const profiles = await readProfileSet(tx, context.organizationId, target.name)
      const proposedProfileVersion = nextProfileVersion(profiles)
      const previewToken = randomBytes(32).toString('base64url')
      const previewExpiresAt = new Date(Date.now() + PROFILE_PREVIEW_TTL_MS)
      const dependencies: Prisma.InputJsonObject = {
        schemaVersion: 1,
        profileSetHash: profileSetHash(context.organizationId, target.name, profiles),
        target,
      }

      // WHY: This sole state-machine row stores only the token digest and its id is the profileBatchId.
      const record = await tx.catalogIdempotencyRecord.create({
        data: {
          organizationId: context.organizationId,
          operation: PROFILE_OPERATION,
          idempotencyKey,
          requestHash: targetHash,
          requestHashVersion: 1,
          state: CatalogOperationState.PREVIEWED,
          resourceType: 'CatalogValidationProfile',
          targetHash,
          previewTokenHash: sha256(previewToken),
          previewExpiresAt,
          dependencies,
          actorType: ActivityActorType.HUMAN,
          staffId: context.actor.type === 'HUMAN' ? context.actor.staffId : null,
        },
        select: { id: true },
      })

      return {
        profileBatchId: record.id,
        previewToken,
        targetHash,
        expiresAt: previewExpiresAt.toISOString(),
        proposedProfileVersion,
        rulesSchemaVersion: PROFILE_RULES_SCHEMA_VERSION,
        requiredFields: resolveEffectiveFields(target.requiredFields),
      }
    })
  } catch (error) {
    if (!isPrismaUniqueConflict(error)) throw error
    // WHY: A P2002 aborts its transaction, so recovery re-reads on the outer client after rollback.
    const existing = await prisma.catalogIdempotencyRecord.findFirst({
      where: { organizationId: context.organizationId, operation: PROFILE_OPERATION, idempotencyKey },
    })
    return rejectRecoveredPreview(existing, targetHash)
  }
}

export async function confirmCatalogValidationProfile(
  context: CatalogCommandContext,
  input: CatalogValidationProfileConfirmInput,
): Promise<CatalogValidationProfileResult> {
  if (input.confirm !== true) throw new ValidationError('confirm debe ser true')
  if (
    typeof input.profileBatchId !== 'string' ||
    !/\S/u.test(input.profileBatchId) ||
    typeof input.idempotencyKey !== 'string' ||
    !/\S/u.test(input.idempotencyKey) ||
    typeof input.previewToken !== 'string' ||
    input.previewToken.length === 0
  ) {
    throw new ValidationError('Confirmación de perfil inválida')
  }

  return prisma.$transaction(async tx => {
    await assertProfileAccess(context, tx)
    const record = await tx.catalogIdempotencyRecord.findFirst({
      where: { id: input.profileBatchId, organizationId: context.organizationId, operation: PROFILE_OPERATION },
    })
    if (!record) throw new NotFoundError('Preview de perfil no encontrado')
    if (!opaqueStringsEqual(record.idempotencyKey, input.idempotencyKey)) throw new ConflictError('Idempotency key no coincide')
    if (context.actor.type !== 'HUMAN' || record.actorType !== ActivityActorType.HUMAN || record.staffId !== context.actor.staffId) {
      throw new ForbiddenError('El actor no coincide con el preview')
    }
    if (!tokenMatches(input.previewToken, record.previewTokenHash)) throw new ConflictError('Preview token inválido')

    const dependencies = parseDependencies(record.dependencies)
    if (hashCanonicalJsonV1('catalog-validation-profile-target', dependencies.target) !== record.targetHash) {
      throw new ConflictError('Target de preview inválido', 'CATALOG_VALIDATION_PROFILE_PREVIEW_INVALID')
    }
    if (record.state === CatalogOperationState.APPLIED) {
      const recovered = recoverCatalogValidationProfileResultV1(record)
      if (!recovered) throw new ConflictError('Resultado idempotente inválido', 'CATALOG_VALIDATION_PROFILE_RESULT_INVALID')
      return recovered
    }
    if (record.state !== CatalogOperationState.PREVIEWED) throw new ConflictError('Preview de perfil no confirmable')
    if (!record.previewExpiresAt || record.previewExpiresAt.getTime() <= Date.now()) throw new ConflictError('Preview de perfil expirado')

    // WHY: Lock order is globally fixed as organization mutation then profile
    // name. Imports can revalidate profiles while holding the first lock, and
    // concurrent profile writers cannot slip into that dependency window.
    await acquireCatalogMutationLock(tx, context.organizationId)

    // WHY: The global version key is organization+name, so this second lock
    // serializes even absent rows and different scopes under the same name.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`h1a:validation-profile:${context.organizationId}:${dependencies.target.name}`}, 0))`,
    )

    // WHY: A competing confirmer may have completed while this transaction
    // waited on the advisory lock; re-reading turns that race into idempotent recovery.
    const lockedRecord = await tx.catalogIdempotencyRecord.findFirst({
      where: { id: input.profileBatchId, organizationId: context.organizationId, operation: PROFILE_OPERATION },
    })
    if (!lockedRecord) throw new NotFoundError('Preview de perfil no encontrado')
    if (!opaqueStringsEqual(lockedRecord.idempotencyKey, input.idempotencyKey)) throw new ConflictError('Idempotency key no coincide')
    if (
      context.actor.type !== 'HUMAN' ||
      lockedRecord.actorType !== ActivityActorType.HUMAN ||
      lockedRecord.staffId !== context.actor.staffId
    ) {
      throw new ForbiddenError('El actor no coincide con el preview')
    }
    if (!tokenMatches(input.previewToken, lockedRecord.previewTokenHash)) throw new ConflictError('Preview token inválido')
    const lockedDependencies = parseDependencies(lockedRecord.dependencies)
    if (
      lockedRecord.targetHash !== record.targetHash ||
      lockedDependencies.target.name !== dependencies.target.name ||
      hashCanonicalJsonV1('catalog-validation-profile-target', lockedDependencies.target) !== lockedRecord.targetHash
    ) {
      throw new ConflictError('Target de preview inválido', 'CATALOG_VALIDATION_PROFILE_PREVIEW_INVALID')
    }
    if (lockedRecord.state === CatalogOperationState.APPLIED) {
      const recovered = recoverCatalogValidationProfileResultV1(lockedRecord)
      if (!recovered) throw new ConflictError('Resultado idempotente inválido', 'CATALOG_VALIDATION_PROFILE_RESULT_INVALID')
      return recovered
    }
    if (lockedRecord.state !== CatalogOperationState.PREVIEWED) throw new ConflictError('Preview de perfil no confirmable')
    if (!lockedRecord.previewExpiresAt || lockedRecord.previewExpiresAt.getTime() <= Date.now()) {
      throw new ConflictError('Preview de perfil expirado')
    }

    const liveProfiles = await readProfileSet(tx, context.organizationId, lockedDependencies.target.name)
    if (profileSetHash(context.organizationId, lockedDependencies.target.name, liveProfiles) !== lockedDependencies.profileSetHash) {
      throw new ConflictError('El perfil cambió después del preview', 'CATALOG_VALIDATION_PROFILE_STALE')
    }
    const profileVersion = nextProfileVersion(liveProfiles)

    // WHY: Historical rule content remains immutable; only the exact prior
    // scope's lifecycle bit is deactivated before a fresh global version exists.
    await tx.catalogValidationProfile.updateMany({
      where: {
        organizationId: context.organizationId,
        name: lockedDependencies.target.name,
        businessType: lockedDependencies.target.businessType,
        operationalRole: lockedDependencies.target.operationalRole,
        active: true,
      },
      data: { active: false },
    })
    const profile = await tx.catalogValidationProfile.create({
      data: {
        organizationId: context.organizationId,
        name: lockedDependencies.target.name,
        profileVersion,
        rulesSchemaVersion: PROFILE_RULES_SCHEMA_VERSION,
        businessType: lockedDependencies.target.businessType,
        operationalRole: lockedDependencies.target.operationalRole,
        requiredFields: lockedDependencies.target.requiredFields,
        additionalRules: lockedDependencies.target.additionalRules ?? Prisma.DbNull,
        active: true,
        createdById: context.actor.staffId,
        updatedById: context.actor.staffId,
      },
      select: { id: true, profileVersion: true, rulesSchemaVersion: true, active: true },
    })
    const result: CatalogValidationProfileResult = {
      profileBatchId: lockedRecord.id,
      profileId: profile.id,
      profileVersion: profile.profileVersion,
      rulesSchemaVersion: PROFILE_RULES_SCHEMA_VERSION,
      active: true,
    }

    await writeCatalogAudit(tx, {
      organizationId: context.organizationId,
      actor: context.actor,
      action: 'CATALOG_VALIDATION_PROFILE_CONFIRMED',
      entity: 'CatalogValidationProfile',
      entityId: profile.id,
      batchId: lockedRecord.id,
      idempotencyKeyHash: sha256(input.idempotencyKey),
      before: canonicalProfileSet(liveProfiles) as Prisma.InputJsonValue,
      after: {
        id: profile.id,
        name: lockedDependencies.target.name,
        profileVersion,
        rulesSchemaVersion: PROFILE_RULES_SCHEMA_VERSION,
        businessType: lockedDependencies.target.businessType,
        operationalRole: lockedDependencies.target.operationalRole,
        requiredFields: lockedDependencies.target.requiredFields,
        additionalRules: lockedDependencies.target.additionalRules,
        active: true,
      },
    })
    const applied = await tx.catalogIdempotencyRecord.updateMany({
      where: {
        id: lockedRecord.id,
        organizationId: context.organizationId,
        operation: PROFILE_OPERATION,
        state: CatalogOperationState.PREVIEWED,
      },
      data: {
        state: CatalogOperationState.APPLIED,
        resourceType: 'CatalogValidationProfile',
        resourceId: profile.id,
        result: result as unknown as Prisma.InputJsonObject,
        completedAt: new Date(),
      },
    })
    if (applied.count !== 1) throw new ConflictError('El preview cambió durante la confirmación')

    return result
  })
}
