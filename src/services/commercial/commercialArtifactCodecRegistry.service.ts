import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { hashCanonicalJsonV2 } from './commercialCanonicalJsonV2.service'
import {
  CommercialContractV2ValidationError,
  validateCommercialCampaignV2,
  validateCommercialCatalogV2,
  validateCommercialQuoteIntrinsicV2,
  validateCommercialQuoteV2,
} from './commercialContractV2.service'
import { reconcileCommercialQuoteAuthoritiesV2 } from './commercialQuoteContractV2.service'
import { parseCommercialMoneyV2 } from './commercialMoneyV2.service'
import { assertCommercialContractV1 } from './commercialContract.service'
import {
  assertCommercialArtifactEnvelopeData,
  captureEnvelopeDiscriminants,
  captureEmitDiscriminants,
  deepFreezeCommercialArtifact,
  isVerifiedObjectCandidate,
  materializeArtifactSnapshot,
  readOwnData,
  toValidIso,
  verifyArtifactChecksum,
} from './commercialArtifactCodecBoundary.service'
import { artifactCode, CommercialArtifactCodecError, failCommercialArtifactCodec } from './commercialArtifactCodecErrors.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'
import type { CommercialCampaignVersionV1, CommercialQuoteV1 } from '@/types/commercialQuote'
import {
  assertCampaignV1Identity,
  assertCampaignV1Shape,
  assertQuoteV1CampaignPair,
  assertQuoteV1Identity,
  assertQuoteV1Shape,
  projectCampaignMoneyV1,
  projectQuoteMoneyV1,
} from './commercialArtifactCodecV1.service'
import {
  assertCampaignV2Identity,
  assertQuoteV2Identity,
  projectCampaignMoneyV2,
  projectQuoteMoneyV2,
} from './commercialArtifactCodecV2.service'
import { resolveCommercialArtifactCodec } from './commercialArtifactCodecRegistryDefinition.service'
import type {
  CommercialArtifactCodecRegistration,
  CommercialArtifactDecodeInput,
  CommercialArtifactEmitInputV2,
  CommercialCatalogEmitInputV2,
  CommercialCatalogDecodeInput,
  CommercialCatalogMoneyProjection,
  CommercialCampaignEmitInputV2,
  CommercialCampaignDecodeInput,
  CommercialCampaignMoneyProjection,
  DecodedCommercialArtifact,
  DecodedCommercialCampaign,
  DecodedCommercialCatalog,
  DecodedCommercialQuote,
  DecodedCommercialQuoteV2,
  EmittedCommercialArtifactV2,
  CommercialQuoteEmitInputV2,
  CommercialQuoteMoneyProjection,
  CommercialQuoteDecodeInput,
  CommercialRuntimeEmitInput,
  VerifiedCommercialArtifactV2,
} from '@/types/commercialCodec'

export { CommercialArtifactCodecError } from './commercialArtifactCodecErrors.service'
export { COMMERCIAL_ARTIFACT_CODEC_REGISTRY } from './commercialArtifactCodecRegistryDefinition.service'

const decodedArtifacts = new WeakSet<object>()
const verifiedAuthorities = new WeakSet<object>()
const emittedArtifacts = new WeakSet<object>()

export type CatalogV2Result = EmittedCommercialArtifactV2 & {
  kind: 'CATALOG'
  schemaVersion: 2
  mode: 'READ_WRITE'
  snapshot: CommercialCatalogSnapshotV2
  money: CommercialCatalogMoneyProjection
}

export type CampaignV2Result = EmittedCommercialArtifactV2 & {
  kind: 'CAMPAIGN'
  schemaVersion: 2
  mode: 'READ_WRITE'
  snapshot: CommercialCampaignSnapshotV2
  money: CommercialCampaignMoneyProjection
}

export type QuoteV2Result = EmittedCommercialArtifactV2 & {
  kind: 'QUOTE'
  schemaVersion: 2
  mode: 'READ_WRITE'
  snapshot: CommercialQuoteSnapshotV2
  money: CommercialQuoteMoneyProjection
}

export type VerifiedStoredCommercialCatalogV2 = DecodedCommercialCatalog & {
  kind: 'CATALOG'
  schemaVersion: 2
  mode: 'READ_WRITE'
  snapshot: CommercialCatalogSnapshotV2
}

export type VerifiedStoredCommercialCatalogV1 = DecodedCommercialCatalog & {
  kind: 'CATALOG'
  schemaVersion: 1
  mode: 'READ_ONLY'
  snapshot: CommercialCatalogSnapshotV1
}

export type VerifiedStoredCommercialCatalog = VerifiedStoredCommercialCatalogV1 | VerifiedStoredCommercialCatalogV2

export type VerifiedStoredCommercialCampaignV2 = DecodedCommercialCampaign & {
  kind: 'CAMPAIGN'
  schemaVersion: 2
  mode: 'READ_WRITE'
  snapshot: CommercialCampaignSnapshotV2
}

export type VerifiedStoredCommercialQuoteV2 = DecodedCommercialQuoteV2 & {
  kind: 'QUOTE'
  schemaVersion: 2
  mode: 'READ_WRITE'
  snapshot: CommercialQuoteSnapshotV2
}

function assertV2ContractVersion(kind: 'CATALOG' | 'CAMPAIGN' | 'QUOTE', snapshot: object): void {
  const contractVersion = (snapshot as { contractVersion?: unknown }).contractVersion
  if (typeof contractVersion !== 'string') failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  if (contractVersion !== '2.0.0') failCommercialArtifactCodec(artifactCode(kind, 'CONTRACT_UNSUPPORTED'))
}

function validateKnownV2<T>(kind: 'CATALOG' | 'CAMPAIGN' | 'QUOTE', operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof CommercialArtifactCodecError) throw error
    if (error instanceof CommercialContractV2ValidationError && error.code.endsWith('_CONTRACT_UNSUPPORTED')) {
      failCommercialArtifactCodec(artifactCode(kind, 'CONTRACT_UNSUPPORTED'))
    }
    return failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  }
}

function reconcileKnownQuoteV2(operation: () => CommercialQuoteSnapshotV2): CommercialQuoteSnapshotV2 {
  try {
    return operation()
  } catch (error) {
    if (error instanceof CommercialArtifactCodecError) throw error
    return failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  }
}

function assertArtifactRoot(kind: 'CATALOG' | 'CAMPAIGN' | 'QUOTE', value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  }
}

function readPayloadField(envelope: object, key: string, kind: 'CATALOG' | 'CAMPAIGN' | 'QUOTE'): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(envelope, key)
  if (!descriptor) failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  if (!descriptor.enumerable || !('value' in descriptor)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  return descriptor.value
}

function readChecksumField(envelope: object): unknown {
  return Object.getOwnPropertyDescriptor(envelope, 'checksum')?.value
}

function assertCatalogIdentity(
  snapshot: CommercialCatalogSnapshotV1 | CommercialCatalogSnapshotV2,
  rowContextValue: unknown,
  rowSchemaVersion: 1 | 2,
): void {
  if (!isVerifiedObjectCandidate(rowContextValue)) {
    failCommercialArtifactCodec('COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
  }
  let row: Record<string, unknown>
  try {
    row = {
      kind: readOwnData(rowContextValue, 'kind'),
      id: readOwnData(rowContextValue, 'id'),
      schemaVersion: readOwnData(rowContextValue, 'schemaVersion'),
      publishedAt: readOwnData(rowContextValue, 'publishedAt'),
    }
  } catch {
    return failCommercialArtifactCodec('COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
  }
  if (
    row.kind !== 'CATALOG' ||
    row.schemaVersion !== rowSchemaVersion ||
    row.id !== snapshot.publicationId ||
    toValidIso(row.publishedAt) !== snapshot.publishedAt ||
    snapshot.market.country !== 'MX' ||
    snapshot.market.currency !== 'MXN' ||
    snapshot.market.timezone !== 'America/Mexico_City' ||
    snapshot.market.taxLabel !== 'IVA' ||
    snapshot.market.taxRateBasisPoints !== 1600
  ) {
    failCommercialArtifactCodec('COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
  }
}

function catalogMoney(snapshot: CommercialCatalogSnapshotV1 | CommercialCatalogSnapshotV2) {
  const parseAmount = (price: { amountMinor: number } | { amount: string }): bigint =>
    'amountMinor' in price ? BigInt(price.amountMinor) : parseCommercialMoneyV2(price.amount)
  return {
    prices: [
      ...snapshot.products.flatMap(product =>
        product.prices.map(price => ({
          ownerType: 'PRODUCT' as const,
          ownerCode: product.code,
          priceCode: price.code,
          amountMinor: parseAmount(price as never),
        })),
      ),
      ...snapshot.bundles.flatMap(bundle =>
        bundle.prices.map(price => ({
          ownerType: 'BUNDLE' as const,
          ownerCode: bundle.code,
          priceCode: price.code,
          amountMinor: parseAmount(price as never),
        })),
      ),
    ],
  }
}

function decodeCatalog(envelope: object, codec: CommercialArtifactCodecRegistration): DecodedCommercialCatalog {
  const rowSchemaVersion = codec.schemaVersion
  const snapshotValue = readPayloadField(envelope, 'snapshot', 'CATALOG')
  const snapshot = materializeArtifactSnapshot<CommercialCatalogSnapshotV1 | CommercialCatalogSnapshotV2>(
    'CATALOG',
    rowSchemaVersion,
    snapshotValue,
  )
  assertArtifactRoot('CATALOG', snapshot)
  if (!Number.isInteger(snapshot.schemaVersion)) failCommercialArtifactCodec('COMMERCIAL_CATALOG_SHAPE_INVALID')
  if (snapshot.schemaVersion !== rowSchemaVersion) failCommercialArtifactCodec('COMMERCIAL_CATALOG_IDENTITY_MISMATCH')
  if (rowSchemaVersion === 2) {
    assertV2ContractVersion('CATALOG', snapshot)
  }
  try {
    if (rowSchemaVersion === 1) assertCommercialContractV1(snapshot)
    else validateKnownV2('CATALOG', () => validateCommercialCatalogV2(snapshot))
  } catch (error) {
    if (error instanceof CommercialArtifactCodecError) throw error
    failCommercialArtifactCodec('COMMERCIAL_CATALOG_SHAPE_INVALID')
  }
  const expectedChecksum =
    rowSchemaVersion === 1
      ? hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot)
      : hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot)
  const checksum = readChecksumField(envelope)
  verifyArtifactChecksum('CATALOG', checksum, expectedChecksum)
  const rowContext = readPayloadField(envelope, 'rowContext', 'CATALOG')
  assertCatalogIdentity(snapshot, rowContext, rowSchemaVersion)
  const result = deepFreezeCommercialArtifact({
    kind: 'CATALOG' as const,
    schemaVersion: rowSchemaVersion,
    mode: codec.mode,
    snapshot,
    checksum,
    money: catalogMoney(snapshot),
  })
  decodedArtifacts.add(result)
  verifiedAuthorities.add(result)
  return result
}

function decodeCampaign(envelope: object, codec: CommercialArtifactCodecRegistration): DecodedCommercialCampaign {
  const rowSchemaVersion = codec.schemaVersion
  const snapshot = materializeArtifactSnapshot<CommercialCampaignVersionV1 | CommercialCampaignSnapshotV2>(
    'CAMPAIGN',
    rowSchemaVersion,
    readPayloadField(envelope, 'snapshot', 'CAMPAIGN'),
  )
  assertArtifactRoot('CAMPAIGN', snapshot)
  if (!Number.isInteger(snapshot.schemaVersion)) failCommercialArtifactCodec('COMMERCIAL_CAMPAIGN_SHAPE_INVALID')
  if (snapshot.schemaVersion !== rowSchemaVersion) failCommercialArtifactCodec('COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH')
  if (rowSchemaVersion === 2) assertV2ContractVersion('CAMPAIGN', snapshot)
  let validated: CommercialCampaignVersionV1 | CommercialCampaignSnapshotV2 = snapshot
  if (rowSchemaVersion === 1) assertCampaignV1Shape(snapshot)
  else validated = validateKnownV2('CAMPAIGN', () => validateCommercialCampaignV2(snapshot))
  const expectedChecksum =
    rowSchemaVersion === 1
      ? hashCanonicalJsonV1('commercial-campaign-snapshot-v1', validated)
      : hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, validated)
  const checksum = readChecksumField(envelope)
  verifyArtifactChecksum('CAMPAIGN', checksum, expectedChecksum)
  if (rowSchemaVersion === 1) {
    assertCampaignV1Identity(validated as CommercialCampaignVersionV1, readPayloadField(envelope, 'rowContext', 'CAMPAIGN'))
  } else {
    assertCampaignV2Identity(validated as CommercialCampaignSnapshotV2, readPayloadField(envelope, 'rowContext', 'CAMPAIGN'))
  }
  const result = deepFreezeCommercialArtifact({
    kind: 'CAMPAIGN' as const,
    schemaVersion: rowSchemaVersion,
    mode: codec.mode,
    snapshot: validated,
    checksum,
    money:
      rowSchemaVersion === 1
        ? projectCampaignMoneyV1(validated as CommercialCampaignVersionV1)
        : projectCampaignMoneyV2(validated as CommercialCampaignSnapshotV2),
  })
  decodedArtifacts.add(result)
  verifiedAuthorities.add(result)
  return result
}

function captureQuoteAuthorities(envelope: object): {
  catalog: CommercialCatalogDecodeInput
  campaign: CommercialCampaignDecodeInput | null
} {
  const authorities = readPayloadField(envelope, 'authorities', 'QUOTE')
  if (!isVerifiedObjectCandidate(authorities)) failCommercialArtifactCodec('COMMERCIAL_QUOTE_SHAPE_INVALID')
  try {
    const catalog = readOwnData(authorities, 'catalog') as CommercialCatalogDecodeInput
    const campaign = readOwnData(authorities, 'campaign') as CommercialCampaignDecodeInput | null
    return { catalog, campaign }
  } catch {
    return failCommercialArtifactCodec('COMMERCIAL_QUOTE_SHAPE_INVALID')
  }
}

function decodeExpectedAuthority(
  input: CommercialCatalogDecodeInput | CommercialCampaignDecodeInput,
  expectedKind: 'CATALOG' | 'CAMPAIGN',
): DecodedCommercialCatalog | DecodedCommercialCampaign {
  const discriminants = captureEnvelopeDiscriminants(input)
  if (discriminants.kind !== expectedKind) failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  const decoded = decodeAndVerifyCommercialArtifact(input)
  if (decoded.kind !== expectedKind) failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  return decoded as DecodedCommercialCatalog | DecodedCommercialCampaign
}

function decodeQuote(envelope: object, codec: CommercialArtifactCodecRegistration): DecodedCommercialQuote {
  const rowSchemaVersion = codec.schemaVersion
  const snapshot = materializeArtifactSnapshot<CommercialQuoteV1 | CommercialQuoteSnapshotV2>(
    'QUOTE',
    rowSchemaVersion,
    readPayloadField(envelope, 'snapshot', 'QUOTE'),
  )
  assertArtifactRoot('QUOTE', snapshot)
  if (!Number.isInteger(snapshot.schemaVersion)) failCommercialArtifactCodec('COMMERCIAL_QUOTE_SHAPE_INVALID')
  if (snapshot.schemaVersion !== rowSchemaVersion) failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  if (rowSchemaVersion === 2) assertV2ContractVersion('QUOTE', snapshot)
  if (rowSchemaVersion === 1) assertQuoteV1Shape(snapshot)

  let validated: CommercialQuoteV1 | CommercialQuoteSnapshotV2 = snapshot
  if (rowSchemaVersion === 2) {
    validated = validateKnownV2('QUOTE', () => validateCommercialQuoteIntrinsicV2(snapshot))
  }
  const expectedChecksum =
    rowSchemaVersion === 1
      ? hashCanonicalJsonV1('commercial-quote-v1', validated)
      : hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE, validated)
  const checksum = readChecksumField(envelope)
  verifyArtifactChecksum('QUOTE', checksum, expectedChecksum)

  const authorityInputs = captureQuoteAuthorities(envelope)
  const catalog = decodeExpectedAuthority(authorityInputs.catalog, 'CATALOG') as DecodedCommercialCatalog
  const campaignDecoded =
    authorityInputs.campaign === null ? null : (decodeExpectedAuthority(authorityInputs.campaign, 'CAMPAIGN') as DecodedCommercialCampaign)
  if (catalog.schemaVersion !== rowSchemaVersion || (campaignDecoded !== null && campaignDecoded.schemaVersion !== rowSchemaVersion)) {
    failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
  }
  if (rowSchemaVersion === 1) {
    assertQuoteV1CampaignPair(validated as CommercialQuoteV1)
  } else {
    const quoteV2 = validated as CommercialQuoteSnapshotV2
    const catalogV2 = catalog.snapshot as CommercialCatalogSnapshotV2
    const campaignV2 = campaignDecoded?.snapshot as CommercialCampaignSnapshotV2 | undefined
    if (
      catalogV2.publicationId !== quoteV2.catalogPublicationId ||
      (campaignV2?.campaignVersionId ?? null) !== quoteV2.campaignVersionId ||
      (campaignV2?.campaignCode ?? null) !== quoteV2.campaignCode
    ) {
      failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
    }
    validated = reconcileKnownQuoteV2(() =>
      reconcileCommercialQuoteAuthoritiesV2(quoteV2, { catalog: catalogV2, campaign: campaignV2 ?? null }),
    )
  }
  const rowContext = readPayloadField(envelope, 'rowContext', 'QUOTE')
  const verifiedScope =
    rowSchemaVersion === 1
      ? assertQuoteV1Identity(validated as CommercialQuoteV1, rowContext, catalog, campaignDecoded as DecodedCommercialCampaign | null)
      : assertQuoteV2Identity(
          validated as CommercialQuoteSnapshotV2,
          rowContext,
          catalog,
          campaignDecoded as DecodedCommercialCampaign | null,
        )
  const result = deepFreezeCommercialArtifact({
    kind: 'QUOTE' as const,
    schemaVersion: rowSchemaVersion,
    mode: codec.mode,
    snapshot: validated,
    checksum,
    money:
      rowSchemaVersion === 1
        ? projectQuoteMoneyV1(validated as CommercialQuoteV1)
        : projectQuoteMoneyV2(validated as CommercialQuoteSnapshotV2),
    scope: verifiedScope.scope,
    lineage: verifiedScope.lineage,
  })
  decodedArtifacts.add(result)
  verifiedAuthorities.add(result)
  return result
}

export function decodeAndVerifyCommercialArtifact(input: CommercialArtifactDecodeInput): DecodedCommercialArtifact {
  const { envelope, kind, rowSchemaVersion } = captureEnvelopeDiscriminants(input)
  const codec = resolveCommercialArtifactCodec(kind, rowSchemaVersion)
  if (!codec) failCommercialArtifactCodec(artifactCode(kind, 'SCHEMA_UNSUPPORTED'))
  assertCommercialArtifactEnvelopeData(envelope)
  if (kind !== 'QUOTE' && Object.prototype.hasOwnProperty.call(envelope, 'authorities')) {
    failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  }
  if (codec.kind === 'CATALOG') return decodeCatalog(envelope, codec)
  if (codec.kind === 'CAMPAIGN') return decodeCampaign(envelope, codec)
  return decodeQuote(envelope, codec)
}

function readEmitField(envelope: object, key: string, kind: 'CATALOG' | 'CAMPAIGN' | 'QUOTE'): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(envelope, key)
  if (!descriptor) failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  if (!descriptor.enumerable || !('value' in descriptor)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_ENVELOPE_INVALID')
  }
  return descriptor.value
}

function verifiedAuthority(value: unknown, expectedKind: 'CATALOG' | 'CAMPAIGN'): VerifiedCommercialArtifactV2 {
  if (!isVerifiedObjectCandidate(value) || !verifiedAuthorities.has(value)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
  const candidate = value as VerifiedCommercialArtifactV2
  if (candidate.kind !== expectedKind || candidate.schemaVersion !== 2 || candidate.mode !== 'READ_WRITE') {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
  return candidate
}

function captureEmitQuoteAuthorities(envelope: object): {
  catalog: VerifiedCommercialArtifactV2
  campaign: VerifiedCommercialArtifactV2 | null
} {
  const authorities = readEmitField(envelope, 'authorities', 'QUOTE')
  if (!isVerifiedObjectCandidate(authorities)) failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  let catalogValue: unknown
  let campaignValue: unknown
  try {
    catalogValue = readOwnData(authorities, 'catalog')
    campaignValue = readOwnData(authorities, 'campaign')
  } catch {
    return failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
  return {
    catalog: verifiedAuthority(catalogValue, 'CATALOG'),
    campaign: campaignValue === null ? null : verifiedAuthority(campaignValue, 'CAMPAIGN'),
  }
}

function emitV2(envelope: object, codec: CommercialArtifactCodecRegistration): EmittedCommercialArtifactV2 {
  if (codec.schemaVersion !== 2 || codec.mode !== 'READ_WRITE') {
    failCommercialArtifactCodec(artifactCode(codec.kind, 'SCHEMA_UNSUPPORTED'))
  }
  const kind = codec.kind
  if (kind !== 'QUOTE' && Object.prototype.hasOwnProperty.call(envelope, 'authorities')) {
    failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  }
  const authorities = kind === 'QUOTE' ? captureEmitQuoteAuthorities(envelope) : null
  const value = materializeArtifactSnapshot<CommercialCatalogSnapshotV2 | CommercialCampaignSnapshotV2 | CommercialQuoteSnapshotV2>(
    kind,
    2,
    readEmitField(envelope, 'domainValue', kind),
  )
  assertArtifactRoot(kind, value)
  if (!Number.isInteger(value.schemaVersion)) failCommercialArtifactCodec(artifactCode(kind, 'SHAPE_INVALID'))
  if (value.schemaVersion !== 2) failCommercialArtifactCodec(artifactCode(kind, 'IDENTITY_MISMATCH'))
  assertV2ContractVersion(kind, value)

  let snapshot: CommercialCatalogSnapshotV2 | CommercialCampaignSnapshotV2 | CommercialQuoteSnapshotV2
  let checksum: string
  let money: EmittedCommercialArtifactV2['money']
  if (kind === 'CATALOG') {
    snapshot = validateKnownV2('CATALOG', () => validateCommercialCatalogV2(value))
    checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot)
    money = catalogMoney(snapshot)
  } else if (kind === 'CAMPAIGN') {
    snapshot = validateKnownV2('CAMPAIGN', () => validateCommercialCampaignV2(value))
    checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, snapshot)
    money = projectCampaignMoneyV2(snapshot)
  } else {
    const catalogSnapshot = authorities!.catalog.snapshot as CommercialCatalogSnapshotV2
    const campaignSnapshot = authorities!.campaign?.snapshot as CommercialCampaignSnapshotV2 | undefined
    const quote = value as CommercialQuoteSnapshotV2
    if (
      catalogSnapshot.publicationId !== quote.catalogPublicationId ||
      (campaignSnapshot?.campaignVersionId ?? null) !== quote.campaignVersionId ||
      (campaignSnapshot?.campaignCode ?? null) !== quote.campaignCode
    ) {
      failCommercialArtifactCodec('COMMERCIAL_QUOTE_IDENTITY_MISMATCH')
    }
    snapshot = validateKnownV2('QUOTE', () =>
      validateCommercialQuoteV2(quote, { catalog: catalogSnapshot, campaign: campaignSnapshot ?? null }),
    )
    checksum = hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE, snapshot)
    money = projectQuoteMoneyV2(snapshot)
  }
  const result = deepFreezeCommercialArtifact({ kind, schemaVersion: 2 as const, mode: codec.mode, snapshot, checksum, money })
  verifiedAuthorities.add(result)
  emittedArtifacts.add(result)
  return result
}

export function emitCommercialArtifact(input: CommercialRuntimeEmitInput): EmittedCommercialArtifactV2 {
  const { envelope, kind, schemaVersion } = captureEmitDiscriminants(input)
  if (schemaVersion === 1) failCommercialArtifactCodec('COMMERCIAL_V1_EMISSION_DISABLED')
  const codec = resolveCommercialArtifactCodec(kind, schemaVersion)
  if (!codec || codec.mode !== 'READ_WRITE') failCommercialArtifactCodec(artifactCode(kind, 'SCHEMA_UNSUPPORTED'))
  assertCommercialArtifactEnvelopeData(envelope)
  return emitV2(envelope, codec)
}

export function emitCommercialArtifactV2(input: CommercialCatalogEmitInputV2): CatalogV2Result
export function emitCommercialArtifactV2(input: CommercialCampaignEmitInputV2): CampaignV2Result
export function emitCommercialArtifactV2(input: CommercialQuoteEmitInputV2): QuoteV2Result
export function emitCommercialArtifactV2(input: CommercialArtifactEmitInputV2): CatalogV2Result | CampaignV2Result | QuoteV2Result {
  const emitted = emitCommercialArtifact(input)
  if (input.kind === 'CATALOG') {
    assertEmittedCommercialCatalogV2(emitted)
    return emitted
  }
  if (input.kind === 'CAMPAIGN') {
    assertEmittedCommercialCampaignV2(emitted)
    return emitted
  }
  assertEmittedCommercialQuoteV2(emitted)
  return emitted
}

function isEmittedCommercialArtifactV2(
  value: unknown,
  kind: 'CATALOG' | 'CAMPAIGN' | 'QUOTE',
): value is CatalogV2Result | CampaignV2Result | QuoteV2Result {
  if (!isVerifiedObjectCandidate(value) || !emittedArtifacts.has(value)) return false
  const artifact = value as EmittedCommercialArtifactV2
  return artifact.kind === kind && artifact.schemaVersion === 2 && artifact.mode === 'READ_WRITE'
}

export function isEmittedCommercialCatalogV2(value: unknown): value is CatalogV2Result {
  return isEmittedCommercialArtifactV2(value, 'CATALOG')
}

export function isEmittedCommercialCampaignV2(value: unknown): value is CampaignV2Result {
  return isEmittedCommercialArtifactV2(value, 'CAMPAIGN')
}

export function isEmittedCommercialQuoteV2(value: unknown): value is QuoteV2Result {
  return isEmittedCommercialArtifactV2(value, 'QUOTE')
}

export function assertEmittedCommercialCatalogV2(value: unknown): asserts value is CatalogV2Result {
  if (!isEmittedCommercialCatalogV2(value)) failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
}

export function assertEmittedCommercialCampaignV2(value: unknown): asserts value is CampaignV2Result {
  if (!isEmittedCommercialCampaignV2(value)) failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
}

export function assertEmittedCommercialQuoteV2(value: unknown): asserts value is QuoteV2Result {
  if (!isEmittedCommercialQuoteV2(value)) failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
}

function isVerifiedStoredCommercialArtifactV2(
  value: unknown,
  kind: 'CATALOG' | 'CAMPAIGN' | 'QUOTE',
): value is VerifiedStoredCommercialCatalogV2 | VerifiedStoredCommercialCampaignV2 | VerifiedStoredCommercialQuoteV2 {
  if (!isVerifiedObjectCandidate(value) || !decodedArtifacts.has(value)) return false
  const artifact = value as DecodedCommercialArtifact
  return artifact.kind === kind && artifact.schemaVersion === 2 && artifact.mode === 'READ_WRITE'
}

export function assertVerifiedStoredCommercialCatalogV2(value: unknown): asserts value is VerifiedStoredCommercialCatalogV2 {
  if (!isVerifiedStoredCommercialArtifactV2(value, 'CATALOG')) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
}

export function assertVerifiedStoredCommercialCatalog(value: unknown): asserts value is VerifiedStoredCommercialCatalog {
  if (!isVerifiedObjectCandidate(value) || !decodedArtifacts.has(value)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
  const artifact = value as DecodedCommercialArtifact
  if (
    artifact.kind !== 'CATALOG' ||
    !((artifact.schemaVersion === 1 && artifact.mode === 'READ_ONLY') || (artifact.schemaVersion === 2 && artifact.mode === 'READ_WRITE'))
  ) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
}

export function assertVerifiedStoredCommercialCampaignV2(value: unknown): asserts value is VerifiedStoredCommercialCampaignV2 {
  if (!isVerifiedStoredCommercialArtifactV2(value, 'CAMPAIGN')) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
}

export function assertVerifiedStoredCommercialQuoteV2(value: unknown): asserts value is VerifiedStoredCommercialQuoteV2 {
  if (!isVerifiedStoredCommercialArtifactV2(value, 'QUOTE')) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
}

export function decodeAndVerifyStoredCommercialCatalogV2(input: CommercialCatalogDecodeInput): VerifiedStoredCommercialCatalogV2 {
  const decoded = decodeAndVerifyCommercialArtifact(input)
  assertVerifiedStoredCommercialCatalogV2(decoded)
  return decoded
}

export function decodeAndVerifyStoredCommercialCatalog(input: CommercialCatalogDecodeInput): VerifiedStoredCommercialCatalog {
  const decoded = decodeAndVerifyCommercialArtifact(input)
  assertVerifiedStoredCommercialCatalog(decoded)
  return decoded
}

export function decodeAndVerifyStoredCommercialCampaignV2(input: CommercialCampaignDecodeInput): VerifiedStoredCommercialCampaignV2 {
  const decoded = decodeAndVerifyCommercialArtifact(input)
  assertVerifiedStoredCommercialCampaignV2(decoded)
  return decoded
}

export function decodeAndVerifyStoredCommercialQuoteV2(input: CommercialQuoteDecodeInput): VerifiedStoredCommercialQuoteV2 {
  const decoded = decodeAndVerifyCommercialArtifact(input)
  assertVerifiedStoredCommercialQuoteV2(decoded)
  return decoded
}

export function assertCommercialQuoteAcceptable(decoded: DecodedCommercialQuote): asserts decoded is DecodedCommercialQuoteV2 {
  if (typeof decoded !== 'object' || decoded === null || !decodedArtifacts.has(decoded)) {
    failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  }
  if (decoded.kind !== 'QUOTE') failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')
  if (decoded.schemaVersion === 1) failCommercialArtifactCodec('COMMERCIAL_QUOTE_V1_ACCEPTANCE_DISABLED')
  if (decoded.scope.kind !== 'VENUE') failCommercialArtifactCodec('COMMERCIAL_QUOTE_SUBJECT_NOT_ACCEPTABLE')
}
