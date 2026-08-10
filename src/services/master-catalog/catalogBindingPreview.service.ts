import { CatalogItemKind, CatalogItemPriceKind, CatalogItemPriceScope, CatalogItemStatus, Prisma, ProductType, Unit } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError'
import type {
  CatalogBindingCandidateV1,
  CatalogBindingDecisionInput,
  CatalogBindingPreview,
  CatalogBindingPreviewInput,
  CatalogBindingPreviewLine,
  CatalogCommandContext,
} from '../../types/master-catalog'
import { hashCanonicalJsonV1 } from './catalogHash.service'
import { readCatalogBindingProspectiveReadinessTx } from './catalogBindingReadiness.service'
import { parseCatalogMoney } from './catalogMoney.service'
import { validateCatalogProductTypeV1 } from './catalogProductType.service'
import { normalizeCatalogVenueLocalSkuV1 } from './identifierNormalization.service'

const PREVIEW_TTL_MS = 30 * 60 * 1_000
const MAX_LINES = 100
const MAX_CANDIDATES = 100
const ID_MAX = 200

const PRODUCT_SELECT = {
  id: true,
  venueId: true,
  sku: true,
  gtin: true,
  name: true,
  description: true,
  categoryId: true,
  type: true,
  price: true,
  cost: true,
  taxRate: true,
  satProductKey: true,
  satUnitKey: true,
  objetoImp: true,
  imageUrl: true,
  unit: true,
  active: true,
  deletedAt: true,
  updatedAt: true,
} as const

type CatalogBindingTransaction = Prisma.TransactionClient
type ProductSnapshot = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>

export interface CatalogBindingPreviewDependencies {
  prisma: Pick<PrismaClient, '$transaction'>
  assertLiveAccessTx(tx: CatalogBindingTransaction, context: CatalogCommandContext): Promise<void>
  now(): Date
  randomToken(): string
}

export interface EvaluatedBindingLine {
  publicLine: CatalogBindingPreviewLine
  dependency: Prisma.InputJsonObject
  application: CatalogBindingApplicationSnapshot
}

export interface CatalogBindingTargetEvaluation {
  lines: EvaluatedBindingLine[]
  targetHash: string
}

export interface CatalogBindingApplicationSnapshot {
  item: {
    id: string
    kind: CatalogItemKind
    revision: number
    name: string
    description: string | null
    imageUrl: string | null
    unit: Unit | null
    taxRate: string
    satProductKey: string | null
    satUnitKey: string | null
    objetoImp: string
    productType: ProductType
    purchaseCost: string | null
  }
  venue: { id: string; currency: string }
  selectedProduct: { id: string; updatedAt: Date } | null
}

interface ValidatedBindingLine {
  catalogItemId: string
  venueId: string
  decision: CatalogBindingDecisionInput | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/\S/u.test(value) || value.length > ID_MAX) throw new ValidationError(`${field} inválido`)
  return value
}

function normalizeDecision(value: unknown): CatalogBindingDecisionInput | null {
  if (value === undefined) return null
  if (!isRecord(value) || typeof value.decision !== 'string') throw new ValidationError('decision inválida')
  if (value.decision === 'LINK' && hasExactKeys(value, ['decision', 'productId'])) {
    return { decision: 'LINK', productId: requireId(value.productId, 'productId') }
  }
  if (value.decision === 'SKIP' && hasExactKeys(value, ['decision'])) return { decision: 'SKIP' }
  if (value.decision === 'CREATE' && hasExactKeys(value, ['decision', 'create']) && isRecord(value.create)) {
    if (!hasExactKeys(value.create, ['categoryId', 'localSku', 'initialPrice'])) throw new ValidationError('CREATE inválido')
    let localSku: string
    let initialPrice: string
    try {
      localSku = normalizeCatalogVenueLocalSkuV1({ code: value.create.localSku as string, format: 'SKU' }).normalizedCode
      initialPrice = parseCatalogMoney(value.create.initialPrice)
    } catch {
      throw new ValidationError('CREATE contiene SKU o precio inválido')
    }
    return { decision: 'CREATE', create: { categoryId: requireId(value.create.categoryId, 'categoryId'), localSku, initialPrice } }
  }
  throw new ValidationError('decision inválida')
}

function validatePreviewInput(input: CatalogBindingPreviewInput): ValidatedBindingLine[] {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['lines']) ||
    !Array.isArray(input.lines) ||
    input.lines.length < 1 ||
    input.lines.length > MAX_LINES
  ) {
    throw new ValidationError('lines debe contener entre 1 y 100 vínculos')
  }
  const seen = new Set<string>()
  return input.lines.map(raw => {
    if (
      !isRecord(raw) ||
      !Object.prototype.hasOwnProperty.call(raw, 'catalogItemId') ||
      !Object.prototype.hasOwnProperty.call(raw, 'venueId')
    ) {
      throw new ValidationError('Línea de binding inválida')
    }
    const allowed = raw.decision === undefined ? ['catalogItemId', 'venueId'] : ['catalogItemId', 'venueId', 'decision']
    if (!hasExactKeys(raw, allowed)) throw new ValidationError('Línea de binding inválida')
    const catalogItemId = requireId(raw.catalogItemId, 'catalogItemId')
    const venueId = requireId(raw.venueId, 'venueId')
    const identity = `${catalogItemId}\u0000${venueId}`
    if (seen.has(identity)) throw new ValidationError('Cada item/venue debe aparecer una sola vez')
    seen.add(identity)
    return { catalogItemId, venueId, decision: normalizeDecision(raw.decision) }
  })
}

function candidateProjection(row: ProductSnapshot): CatalogBindingCandidateV1 {
  return {
    id: row.id,
    sku: row.sku,
    gtin: row.gtin,
    name: row.name,
    categoryId: row.categoryId,
    active: row.active,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function candidateDependency(row: ProductSnapshot): Prisma.InputJsonObject {
  return {
    ...candidateProjection(row),
    description: row.description,
    type: row.type,
    price: row.price.toFixed(2),
    cost: row.cost?.toFixed(2) ?? null,
    taxRate: row.taxRate.toFixed(4),
    satProductKey: row.satProductKey,
    satUnitKey: row.satUnitKey,
    objetoImp: row.objetoImp,
    imageUrl: row.imageUrl,
    unit: row.unit,
  }
}

async function evaluateLine(
  tx: CatalogBindingTransaction,
  organizationId: string,
  line: ValidatedBindingLine,
): Promise<EvaluatedBindingLine> {
  const item = await tx.catalogItem.findFirst({
    where: { id: line.catalogItemId, organizationId, status: CatalogItemStatus.ACTIVE },
    select: {
      id: true,
      organizationId: true,
      sku: true,
      kind: true,
      status: true,
      revision: true,
      name: true,
      description: true,
      imageUrl: true,
      unit: true,
      taxRate: true,
      satProductKey: true,
      satUnitKey: true,
      objetoImp: true,
      productType: true,
      prices: {
        where: { scope: CatalogItemPriceScope.ORGANIZATION, kind: CatalogItemPriceKind.PURCHASE_COST, active: true },
        select: { id: true, kind: true, scope: true, amount: true, currency: true, active: true, revision: true, updatedAt: true },
        orderBy: [{ currency: 'asc' }, { id: 'asc' }],
      },
    },
  })
  const venue = await tx.venue.findFirst({
    where: { id: line.venueId, organizationId },
    select: { id: true, organizationId: true, currency: true, updatedAt: true },
  })
  if (!item || !venue) throw new NotFoundError('Item o sucursal de catálogo no encontrado')
  let productTypeValid = true
  try {
    validateCatalogProductTypeV1({ kind: item.kind, productType: item.productType })
  } catch {
    productTypeValid = false
  }

  // WHY: The only discovery matcher is one bounded raw equality through Prisma;
  // inactive/deleted rows remain visible because they reserve codes.
  const rawCandidates = await tx.product.findMany({
    where: { venueId: venue.id, OR: [{ sku: item.sku }, { gtin: item.sku }] },
    select: PRODUCT_SELECT,
    orderBy: { id: 'asc' },
    take: MAX_CANDIDATES + 1,
  })
  if (rawCandidates.length > MAX_CANDIDATES) throw new ConflictError('Demasiados candidatos exactos', 'CATALOG_BINDING_CANDIDATE_OVERFLOW')
  const candidates = [...new Map(rawCandidates.map(candidate => [candidate.id, candidate] as const)).values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  const productBindings = candidates.length
    ? await tx.catalogVenueBinding.findMany({
        where: { organizationId, venueId: venue.id, productId: { in: candidates.map(candidate => candidate.id) } },
        select: { id: true, catalogItemId: true, productId: true, revision: true, status: true },
        orderBy: { id: 'asc' },
        take: MAX_CANDIDATES,
      })
    : []
  const existingBinding = await tx.catalogVenueBinding.findFirst({
    where: { organizationId, catalogItemId: item.id, venueId: venue.id },
    select: { id: true, productId: true, revision: true, status: true, updatedAt: true },
  })

  let proposal: CatalogBindingPreviewLine['proposal'] = candidates.length ? 'LINK' : 'CREATE'
  let status: CatalogBindingPreviewLine['status'] = existingBinding ? 'CONFLICT' : 'READY'
  let errorCode: string | null = existingBinding ? 'CATALOG_ITEM_ALREADY_BOUND' : null
  let category: { id: string; venueId: string; updatedAt: Date } | null = null
  let reservations: ProductSnapshot[] = []
  const selectedProductId = line.decision?.decision === 'LINK' ? line.decision.productId : null
  const selectedCandidate = selectedProductId ? candidates.find(candidate => candidate.id === selectedProductId) : null
  if (line.decision?.decision === 'LINK') {
    proposal = 'LINK'
    if (!selectedCandidate) [status, errorCode] = ['INVALID', 'CATALOG_BINDING_LINK_NOT_CANDIDATE']
    else if (selectedCandidate.deletedAt) [status, errorCode] = ['INVALID', 'CATALOG_BINDING_PRODUCT_DELETED']
    else if (productBindings.some(binding => binding.productId === selectedCandidate.id)) {
      ;[status, errorCode] = ['CONFLICT', 'CATALOG_PRODUCT_ALREADY_BOUND']
    }
  } else if (line.decision?.decision === 'CREATE') {
    proposal = 'CREATE'
    category = await tx.menuCategory.findFirst({
      where: { id: line.decision.create.categoryId, venueId: venue.id },
      select: { id: true, venueId: true, updatedAt: true },
    })
    if (!category) [status, errorCode] = ['INVALID', 'CATALOG_BINDING_CATEGORY_NOT_FOUND']
    reservations = await tx.product.findMany({
      where: { venueId: venue.id, OR: [{ sku: line.decision.create.localSku }, { gtin: line.decision.create.localSku }] },
      select: PRODUCT_SELECT,
      orderBy: { id: 'asc' },
      take: 2,
    })
    if (reservations.length) [status, errorCode] = ['CONFLICT', 'CATALOG_BINDING_LOCAL_SKU_RESERVED']
    if (item.kind === CatalogItemKind.RETAIL_PRODUCT && !item.prices.some(price => price.currency === venue.currency)) {
      ;[status, errorCode] = ['INVALID', 'CATALOG_BINDING_PURCHASE_COST_MISSING']
    }
  } else if (line.decision?.decision === 'SKIP') {
    // WHY: SKIP records the reviewed outcome and never claims either scarce
    // binding side, so unrelated existing bindings/reservations cannot block it.
    proposal = 'SKIP'
    status = 'READY'
    errorCode = null
  }
  if (!productTypeValid) [status, errorCode] = ['INVALID', 'CATALOG_BINDING_PRODUCT_TYPE_INVALID']

  const prospectiveReadiness = await readCatalogBindingProspectiveReadinessTx(tx, {
    itemKind: item.kind,
    venueId: venue.id,
    decision: line.decision,
    selectedProductId: selectedCandidate?.id ?? null,
  })
  const readiness = prospectiveReadiness.state

  const publicLine: CatalogBindingPreviewLine = {
    catalogItemId: item.id,
    venueId: venue.id,
    proposal,
    decision: line.decision,
    status,
    errorCode,
    candidates: candidates.map(candidateProjection),
    readiness,
  }
  return {
    publicLine,
    application: {
      item: {
        id: item.id,
        kind: item.kind,
        revision: item.revision,
        name: item.name,
        description: item.description,
        imageUrl: item.imageUrl,
        unit: item.unit,
        taxRate: item.taxRate.toFixed(4),
        satProductKey: item.satProductKey,
        satUnitKey: item.satUnitKey,
        objetoImp: item.objetoImp,
        productType: item.productType,
        purchaseCost: item.prices.find(price => price.currency === venue.currency)?.amount.toFixed(2) ?? null,
      },
      venue: { id: venue.id, currency: venue.currency },
      selectedProduct: selectedCandidate ? { id: selectedCandidate.id, updatedAt: selectedCandidate.updatedAt } : null,
    },
    dependency: {
      schemaVersion: 1,
      catalogItem: {
        id: item.id,
        sku: item.sku,
        kind: item.kind,
        revision: item.revision,
        status: item.status,
        name: item.name,
        description: item.description,
        imageUrl: item.imageUrl,
        unit: item.unit,
        taxRate: item.taxRate.toFixed(4),
        satProductKey: item.satProductKey,
        satUnitKey: item.satUnitKey,
        objetoImp: item.objetoImp,
        productType: item.productType,
        purchaseCosts: item.prices.map(price => ({
          id: price.id,
          amount: price.amount.toFixed(2),
          currency: price.currency,
          revision: price.revision,
          updatedAt: price.updatedAt.toISOString(),
        })),
      },
      venue: { id: venue.id, organizationId: venue.organizationId, currency: venue.currency, updatedAt: venue.updatedAt.toISOString() },
      candidates: candidates.map(candidateDependency),
      productBindings: productBindings as unknown as Prisma.InputJsonValue,
      existingBinding: existingBinding ? { ...existingBinding, updatedAt: existingBinding.updatedAt.toISOString() } : null,
      category: category ? { ...category, updatedAt: category.updatedAt.toISOString() } : null,
      reservations: reservations.map(candidateDependency),
      decision: line.decision as unknown as Prisma.InputJsonValue,
      readiness,
      readinessDependency: prospectiveReadiness.dependency,
    },
  }
}

export async function previewCatalogBindingsWithDependencies(
  dependencies: CatalogBindingPreviewDependencies,
  context: CatalogCommandContext,
  input: CatalogBindingPreviewInput,
): Promise<CatalogBindingPreview> {
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating) throw new ForbiddenError('Binding requiere actor humano')
  const humanActor = context.actor
  return dependencies.prisma.$transaction(async tx => {
    await dependencies.assertLiveAccessTx(tx, context)
    const { lines: evaluated, targetHash } = await evaluateCatalogBindingTargetTx(tx, context.organizationId, input)
    const canConfirm = evaluated.every(line => line.publicLine.decision !== null && line.publicLine.status === 'READY')
    if (!canConfirm) {
      // WHY: Discovery and invalid reviews never mint or persist a bearer; only
      // a fully explicit human decision can become confirm authority.
      return {
        bindingBatchId: null,
        previewToken: null,
        targetHash,
        expiresAt: null,
        canConfirm: false,
        lines: evaluated.map(line => line.publicLine),
      }
    }

    const now = dependencies.now()
    const previewExpiresAt = new Date(now.getTime() + PREVIEW_TTL_MS)
    const previewToken = dependencies.randomToken()
    const batch = await tx.catalogBindingBatch.create({
      data: {
        organizationId: context.organizationId,
        state: 'PREVIEWED',
        schemaVersion: 1,
        requestHash: hashCanonicalJsonV1('catalog-binding-request', {
          organizationId: context.organizationId,
          staffId: humanActor.staffId,
          targetHash,
        }),
        requestHashVersion: 1,
        targetHash,
        previewTokenHash: createHash('sha256').update(previewToken).digest('hex'),
        previewExpiresAt,
        dependencies: { schemaVersion: 1, lines: evaluated.map(line => line.dependency) },
        actorType: 'HUMAN',
        staffId: humanActor.staffId,
        createdAt: now,
      },
      select: { id: true },
    })
    for (const line of evaluated) {
      await tx.catalogBindingLine.create({
        data: {
          organizationId: context.organizationId,
          batchId: batch.id,
          catalogItemId: line.publicLine.catalogItemId,
          venueId: line.publicLine.venueId,
          productId: line.publicLine.decision?.decision === 'LINK' ? line.publicLine.decision.productId : null,
          status: 'READY',
          proposal: line.publicLine.proposal,
          decision: line.publicLine.decision?.decision,
          before: { candidates: line.publicLine.candidates } as unknown as Prisma.InputJsonValue,
          after: line.publicLine.decision as unknown as Prisma.InputJsonValue,
        },
      })
    }
    return {
      bindingBatchId: batch.id,
      previewToken,
      targetHash,
      expiresAt: previewExpiresAt.toISOString(),
      canConfirm: true,
      lines: evaluated.map(line => line.publicLine),
    }
  })
}

export async function evaluateCatalogBindingTargetTx(
  tx: CatalogBindingTransaction,
  organizationId: string,
  input: CatalogBindingPreviewInput,
): Promise<CatalogBindingTargetEvaluation> {
  const evaluated: EvaluatedBindingLine[] = []
  for (const line of validatePreviewInput(input)) evaluated.push(await evaluateLine(tx, organizationId, line))
  return {
    lines: evaluated,
    targetHash: hashCanonicalJsonV1(
      'catalog-binding-target',
      evaluated.map(line => line.dependency),
    ),
  }
}
