import { Prisma } from '@prisma/client'
import AppError from '../../errors/AppError'
import type { CatalogImportPreviewCursorPositionV1, CatalogImportPreviewSection } from './catalogImportPreviewProjection.service'
import { CATALOG_IMPORT_REFERENCE_NAME_PROOF_MAX_SCALARS_V1 } from './catalogImportPreviewReferenceProjection.service'
import {
  catalogImportReferenceMarkerBaseHashSql,
  catalogImportReferenceMarkerDigestSql,
  catalogImportReferenceParentBindingSql,
  catalogImportReferenceParentNameProofSql,
  catalogImportReferenceParentProofSql,
} from './catalogImportReadReferenceProofQueries.service'
import { CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 } from './identifierNormalization.service'
import { CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1 } from './catalogImportDependencySnapshot.service'
import {
  catalogImportErrorsShapeSql,
  catalogImportExactObjectShapeSql,
  catalogImportItemLineShapeSql,
  catalogImportLineIdentitySql,
  catalogImportPayloadIntegritySql,
  catalogImportReviewLineShapeSql,
} from './catalogImportReadValidation.service'

export interface CatalogImportReadQueryTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

export interface CatalogImportBatchQueryV1 {
  organizationId: string
  importBatchId: string
}

export interface CatalogImportSectionQueryV1 extends CatalogImportBatchQueryV1 {
  section: CatalogImportPreviewSection
  after: CatalogImportPreviewCursorPositionV1 | null
  take: number
}

export interface CatalogImportItemDetailQueryV1 extends CatalogImportBatchQueryV1 {
  sourceRow: number
}

// Task 11 consumes only bounded profileVersion scalars from the immutable
// import dependency snapshot; live profiles must never rewrite error history.
export async function queryCatalogImportProfileVersionsTx(
  tx: CatalogImportReadQueryTransaction,
  input: CatalogImportBatchQueryV1,
): Promise<Array<Record<string, unknown>>> {
  if (!validId(input.organizationId) || !validId(input.importBatchId)) return failQuery()
  return tx.$queryRaw(Prisma.sql`
    SELECT b."id" AS "batchId",
      CASE WHEN jsonb_typeof(b."dependencies" -> 'profiles') = 'array'
        THEN jsonb_array_length(b."dependencies" -> 'profiles') <= ${CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1} ELSE false END AS "collectionShapeValid",
      COALESCE(entry.ordinality, 0)::int AS "ordinal",
      CASE WHEN entry.value IS NULL THEN true ELSE ${catalogImportExactObjectShapeSql(Prisma.sql`entry.value`, [
        'id',
        'profileVersion',
        'rulesSchemaVersion',
        'businessType',
        'operationalRole',
        'requiredFields',
        'additionalRules',
      ])} END AS "rowShapeValid",
      left(entry.value ->> 'profileVersion', 12) AS "profileVersion"
    FROM "CatalogImportBatch" b
    LEFT JOIN LATERAL jsonb_array_elements(${boundedArrayForExpansion(
      Prisma.sql`b."dependencies" -> 'profiles'`,
      CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1,
    )})
      WITH ORDINALITY AS entry(value, ordinality) ON true
    WHERE b."organizationId" = ${input.organizationId} AND b."id" = ${input.importBatchId}
    ORDER BY entry.ordinality ASC NULLS FIRST
    LIMIT ${CATALOG_IMPORT_PROFILE_SNAPSHOT_CAP_V1 + 1}`)
}

const VALID_SECTIONS = new Set<CatalogImportPreviewSection>([
  'ITEMS',
  'ORGANIZATION_VALUES',
  'BUSINESS_TYPES',
  'REFERENCE_PROPOSALS',
  'VENUE_BINDING_REQUESTS',
  'ERRORS',
])
function failQuery(): never {
  throw new AppError('Consulta de preview inválida.', 422, true, 'CATALOG_IMPORT_QUERY_INVALID')
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

function arrayLength(path: Prisma.Sql): Prisma.Sql {
  // WHY: Batch integrity rejects a malformed container before section/detail
  // queries; this guarded expression only keeps PostgreSQL evaluation total.
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'array' THEN jsonb_array_length(${path}) ELSE 0 END`
}

function boundedArrayForExpansion(path: Prisma.Sql, maximum: number): Prisma.Sql {
  // WHY: Nested CASE is an explicit evaluation barrier before any lateral SRF;
  // an oversized durable array becomes empty projection data and preflight 409.
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'array' THEN CASE
    WHEN jsonb_array_length(${path}) BETWEEN 0 AND ${maximum} THEN ${path} ELSE '[]'::jsonb END
    ELSE '[]'::jsonb END`
}

function boundedTextProof(path: Prisma.Sql, maximumScalars: number): Prisma.Sql {
  // WHY: One overflow scalar is enough for Node to distinguish an exact
  // boundary from truncated durable text without hydrating an unbounded value.
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'string'
    THEN left((${path}) #>> '{}', ${maximumScalars}) ELSE NULL END`
}

export async function queryCatalogImportPreviewBatchTx(
  tx: CatalogImportReadQueryTransaction,
  input: CatalogImportBatchQueryV1,
): Promise<Record<string, unknown> | null> {
  if (!validId(input.organizationId) || !validId(input.importBatchId)) return failQuery()
  // WHY: Scalar JSON paths avoid hydrating the potentially multi-megabyte
  // dependency snapshot. SQL proves bounded structure; confirm remains the
  // only full Task 5/NFKC/WHATWG authority before writes.
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT b."id", b."organizationId", b."schemaVersion", b."targetHash", b."previewTokenHash", b."staffId",
      b."state"::text AS "state", b."previewExpiresAt", integrity."lineCount", integrity."itemCount",
      integrity."invalidLineCount", integrity."invalidPayloadCount", integrity."oversizedSheetCount",
      (${catalogImportExactObjectShapeSql(Prisma.sql`b."dependencies" -> 'capacity'`, [
        'schemaVersion',
        'costModelVersion',
        'measurement',
        'workUnits',
        'limit',
        'withinLimit',
        'breakdown',
      ])} AND ${catalogImportExactObjectShapeSql(Prisma.sql`b."dependencies" #> '{capacity,breakdown}'`, [
        'base',
        'referenceProposals',
        'createItems',
        'updateItems',
        'retireItems',
        'organizationValues',
        'deactivations',
      ])} AND proposals."invalidReferenceMarkerCount" = 0 AND (b."state"::text = 'FAILED' OR
        b."dependencies" #>> '{capacity,breakdown,referenceProposals}' = proposals."actualReferenceProposals"::text))
        AS "capacityIntegrityValid",
      b."dependencies" #>> '{capacity,schemaVersion}' AS "capacitySchemaVersion",
      b."dependencies" #>> '{capacity,costModelVersion}' AS "capacityCostModelVersion",
      b."dependencies" #>> '{capacity,measurement}' AS "capacityMeasurement",
      b."dependencies" #>> '{capacity,workUnits}' AS "capacityWorkUnits",
      b."dependencies" #>> '{capacity,limit}' AS "capacityLimit",
      b."dependencies" #>> '{capacity,withinLimit}' AS "capacityWithinLimit",
      b."dependencies" #>> '{capacity,breakdown,base}' AS "capacityBase",
      b."dependencies" #>> '{capacity,breakdown,referenceProposals}' AS "capacityReferences",
      b."dependencies" #>> '{capacity,breakdown,createItems}' AS "capacityCreates",
      b."dependencies" #>> '{capacity,breakdown,updateItems}' AS "capacityUpdates",
      b."dependencies" #>> '{capacity,breakdown,retireItems}' AS "capacityRetires",
      b."dependencies" #>> '{capacity,breakdown,organizationValues}' AS "capacityValues",
      b."dependencies" #>> '{capacity,breakdown,deactivations}' AS "capacityDeactivations"
    FROM "CatalogImportBatch" b
    CROSS JOIN LATERAL (
      SELECT
        COUNT(*)::text AS "lineCount",
        COUNT(*) FILTER (WHERE l."sourceSheet" = 'Items')::text AS "itemCount",
        COUNT(*) FILTER (WHERE (
          l."sourceSheet" IN ('Metadata','Items','OrganizationValues','BusinessTypes','VenueBindingRequests')
          AND l."sourceRow" BETWEEN 1 AND 2147483647
          AND CASE b."state"::text
            WHEN 'PREVIEWED' THEN l."status"::text = 'READY'
            WHEN 'FAILED' THEN l."status"::text IN ('READY','INVALID')
            WHEN 'APPLIED' THEN (l."sourceSheet" = 'Items' AND l."status"::text = 'APPLIED') OR
              (l."sourceSheet" IN ('OrganizationValues','BusinessTypes','VenueBindingRequests') AND l."status"::text = 'READY')
            ELSE false END
          AND ${catalogImportLineIdentitySql()}
          AND ${catalogImportErrorsShapeSql()}
        ) IS NOT TRUE)::text AS "invalidLineCount",
        COUNT(*) FILTER (WHERE (${catalogImportPayloadIntegritySql()}) IS NOT TRUE)::text AS "invalidPayloadCount",
        (SELECT COUNT(*) FROM (SELECT bounded."sourceSheet" FROM "CatalogImportLine" bounded
          WHERE bounded."organizationId" = b."organizationId" AND bounded."batchId" = b."id"
          GROUP BY bounded."sourceSheet" HAVING COUNT(*) > 20000) oversized)::text AS "oversizedSheetCount"
      FROM "CatalogImportLine" l
      WHERE l."organizationId" = b."organizationId" AND l."batchId" = b."id"
    ) integrity
    CROSS JOIN LATERAL (
      WITH raw_proposals AS (
        SELECT ${catalogImportReferenceMarkerDigestSql(Prisma.sql`proposal.value -> 'capacityMarker'`)} AS marker,
          CASE WHEN proposal.value ->> 'referenceType' = 'FAMILY' AND jsonb_typeof(proposal.value -> 'parentId') <> 'null'
            THEN 4 ELSE 3 END AS cost
        FROM "CatalogImportLine" proposal_line
        CROSS JOIN LATERAL jsonb_array_elements(${boundedArrayForExpansion(
          Prisma.sql`proposal_line."payload" -> 'referenceProposals'`,
          4,
        )}) proposal(value)
        WHERE proposal_line."organizationId" = b."organizationId" AND proposal_line."batchId" = b."id"
          AND proposal_line."sourceSheet" = 'Items'
      ), unique_proposals AS (
        SELECT marker, MAX(cost)::bigint AS cost FROM raw_proposals WHERE marker IS NOT NULL GROUP BY marker
      )
      SELECT COALESCE((SELECT SUM(cost) FROM unique_proposals), 0)::bigint AS "actualReferenceProposals",
        (SELECT COUNT(*) FROM raw_proposals WHERE marker IS NULL)::bigint AS "invalidReferenceMarkerCount"
    ) proposals
    WHERE b."organizationId" = ${input.organizationId} AND b."id" = ${input.importBatchId}
    LIMIT 1`)
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    organizationId: row.organizationId,
    schemaVersion: row.schemaVersion,
    targetHash: row.targetHash,
    previewTokenHash: row.previewTokenHash,
    staffId: row.staffId,
    state: row.state,
    previewExpiresAt: row.previewExpiresAt,
    lineCount: row.lineCount,
    itemCount: row.itemCount,
    capacityIntegrityValid: row.capacityIntegrityValid,
    invalidLineCount: row.invalidLineCount,
    invalidPayloadCount: row.invalidPayloadCount,
    oversizedSheetCount: row.oversizedSheetCount,
    capacity: {
      schemaVersion: row.capacitySchemaVersion,
      costModelVersion: row.capacityCostModelVersion,
      measurement: row.capacityMeasurement,
      workUnits: row.capacityWorkUnits,
      limit: row.capacityLimit,
      withinLimit: row.capacityWithinLimit,
      breakdown: {
        base: row.capacityBase,
        referenceProposals: row.capacityReferences,
        createItems: row.capacityCreates,
        updateItems: row.capacityUpdates,
        retireItems: row.capacityRetires,
        organizationValues: row.capacityValues,
        deactivations: row.capacityDeactivations,
      },
    },
  }
}

export async function queryCatalogImportPreviewSectionPageTx(
  tx: CatalogImportReadQueryTransaction,
  input: CatalogImportSectionQueryV1,
): Promise<Array<Record<string, unknown>>> {
  if (!validId(input.organizationId) || !validId(input.importBatchId) || !VALID_SECTIONS.has(input.section)) return failQuery()
  if (!Number.isInteger(input.take) || input.take < 2 || input.take > 51) return failQuery()
  const afterRow = input.after?.sourceRow ?? 0
  const afterOrdinal = input.after?.ordinal ?? 0
  const afterSheet = input.after?.sourceSheet ?? ''

  // WHY: Every branch is a closed SQL projection. Dynamic section text never
  // enters SQL, and LIMIT applies before Node receives any page rows.
  if (input.section === 'ITEMS') {
    return tx.$queryRaw(Prisma.sql`
      SELECT l."sourceSheet", l."sourceRow", 0::int AS "ordinal", l."status"::text AS "status",
        ${catalogImportItemLineShapeSql()} AS "durableShapeValid",
        left(l."payload" #>> '{command,operation}', 17) AS "operation", l."catalogItemId",
        ${boundedTextProof(
          Prisma.sql`l."payload" #> '{command,input,sku}'`,
          CATALOG_IMPORT_REFERENCE_NAME_PROOF_MAX_SCALARS_V1,
        )} AS "proofCorporateSku",
        left(l."payload" #>> '{command,input,name}', 257) AS "name",
        left(l."payload" #>> '{command,input,kind}', 65) AS "itemKind",
        ${arrayLength(Prisma.sql`l."payload" #> '{command,input,organizationValues}'`)} AS "organizationValueCount",
        ${arrayLength(Prisma.sql`l."payload" #> '{command,input,businessTypes}'`)} AS "businessTypeCount",
        ${arrayLength(Prisma.sql`l."payload" -> 'referenceProposals'`)} AS "referenceProposalCount",
        ${arrayLength(Prisma.sql`l."payload" -> 'venueBindingRequests'`)} AS "venueBindingRequestCount",
        ${arrayLength(Prisma.sql`l."errors"`)} AS "errorCount"
      FROM "CatalogImportLine" l
      WHERE l."organizationId" = ${input.organizationId} AND l."batchId" = ${input.importBatchId}
        AND l."sourceSheet" = 'Items' AND l."sourceRow" > ${afterRow}
      ORDER BY l."sourceRow" ASC
      LIMIT ${input.take}`)
  }
  if (input.section === 'ORGANIZATION_VALUES') {
    // WHY: One ordered union exposes both physical workbook UPSERTs and the
    // exact tombstones confirmation will apply; sheet/row/ordinal is collision-free.
    return tx.$queryRaw(Prisma.sql`
      SELECT review."sourceSheet", review."sourceRow", review."ordinal", review."status", review."durableShapeValid",
        review."action", review."proofCorporateSku", review."kind", review."currency", review."amount", review."expectedRuleRevision"
      FROM (
        SELECT l."sourceSheet", l."sourceRow", 0::int AS "ordinal", l."status"::text AS "status",
          ${catalogImportReviewLineShapeSql('ORGANIZATION_VALUES', [
            'schemaVersion',
            'section',
            'corporateSku',
            'kind',
            'amount',
            'currency',
            'expectedRuleRevision',
          ])} AS "durableShapeValid",
          'UPSERT'::text AS "action", ${boundedTextProof(
            Prisma.sql`l."payload" -> 'corporateSku'`,
            CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 + 1,
          )} AS "proofCorporateSku",
          left(l."payload" ->> 'kind', 65) AS "kind", left(l."payload" ->> 'currency', 17) AS "currency",
          left(l."payload" ->> 'amount', 65) AS "amount", l."payload" ->> 'expectedRuleRevision' AS "expectedRuleRevision"
        FROM "CatalogImportLine" l
        WHERE l."organizationId" = ${input.organizationId} AND l."batchId" = ${input.importBatchId}
          AND l."sourceSheet" = 'OrganizationValues'
        UNION ALL
        SELECT l."sourceSheet", l."sourceRow", entry.ordinality::int AS "ordinal", l."status"::text AS "status",
          (${catalogImportItemLineShapeSql()} AND ${catalogImportExactObjectShapeSql(Prisma.sql`entry.value`, [
            'kind',
            'currency',
            'expectedRuleRevision',
          ])}) AS "durableShapeValid",
          'DEACTIVATE'::text AS "action", ${boundedTextProof(
            Prisma.sql`l."payload" #> '{command,input,sku}'`,
            CATALOG_IMPORT_REFERENCE_NAME_PROOF_MAX_SCALARS_V1,
          )} AS "proofCorporateSku",
          left(entry.value ->> 'kind', 65) AS "kind", left(entry.value ->> 'currency', 17) AS "currency",
          NULL::text AS "amount", entry.value ->> 'expectedRuleRevision' AS "expectedRuleRevision"
        FROM "CatalogImportLine" l
        CROSS JOIN LATERAL jsonb_array_elements(${boundedArrayForExpansion(
          Prisma.sql`l."payload" #> '{command,input,organizationValueDeactivations}'`,
          20_000,
        )}) WITH ORDINALITY AS entry(value, ordinality)
        WHERE l."organizationId" = ${input.organizationId} AND l."batchId" = ${input.importBatchId}
          AND l."sourceSheet" = 'Items' AND l."payload" #>> '{command,operation}' = 'UPDATE'
      ) review
      WHERE review."sourceSheet" > ${afterSheet} OR (review."sourceSheet" = ${afterSheet}
        AND (review."sourceRow" > ${afterRow} OR
          (review."sourceRow" = ${afterRow} AND review."ordinal" > ${afterOrdinal})))
      ORDER BY review."sourceSheet" ASC, review."sourceRow" ASC, review."ordinal" ASC
      LIMIT ${input.take}`)
  }
  if (input.section === 'BUSINESS_TYPES') {
    return tx.$queryRaw(Prisma.sql`
      SELECT l."sourceSheet", l."sourceRow", 0::int AS "ordinal", l."status"::text AS "status",
        ${catalogImportReviewLineShapeSql('BUSINESS_TYPES', ['schemaVersion', 'section', 'corporateSku', 'businessType'])} AS "durableShapeValid",
        ${boundedTextProof(
          Prisma.sql`l."payload" -> 'corporateSku'`,
          CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 + 1,
        )} AS "proofCorporateSku", left(l."payload" ->> 'businessType', 65) AS "businessType"
      FROM "CatalogImportLine" l
      WHERE l."organizationId" = ${input.organizationId} AND l."batchId" = ${input.importBatchId}
        AND l."sourceSheet" = 'BusinessTypes' AND l."sourceRow" > ${afterRow}
      ORDER BY l."sourceRow" ASC
      LIMIT ${input.take}`)
  }
  if (input.section === 'REFERENCE_PROPOSALS') {
    return tx.$queryRaw(Prisma.sql`
      SELECT l."sourceSheet", l."sourceRow", COALESCE(entry.ordinality, 1)::int AS "ordinal", l."status"::text AS "status",
        ${catalogImportItemLineShapeSql()} AS "durableShapeValid",
        left(entry.value ->> 'operation', 17) AS "operation", left(entry.value ->> 'referenceType', 33) AS "referenceType",
        ${boundedTextProof(
          Prisma.sql`entry.value -> 'name'`,
          CATALOG_IMPORT_REFERENCE_NAME_PROOF_MAX_SCALARS_V1,
        )} AS "proofName", ${catalogImportReferenceParentProofSql()} AS "proofParentId",
        ${catalogImportReferenceParentNameProofSql()} AS "proofParentName",
        ${catalogImportReferenceMarkerBaseHashSql()} AS "proofMarkerBaseHash",
        ${catalogImportReferenceParentBindingSql()} AS "proofParentBindingValid"
      FROM "CatalogImportLine" l
      LEFT JOIN LATERAL jsonb_array_elements(${boundedArrayForExpansion(Prisma.sql`l."payload" -> 'referenceProposals'`, 4)})
        WITH ORDINALITY AS entry(value, ordinality) ON true
      WHERE l."organizationId" = ${input.organizationId} AND l."batchId" = ${input.importBatchId} AND l."sourceSheet" = 'Items'
        AND (l."sourceRow" > ${afterRow} OR (l."sourceRow" = ${afterRow} AND entry.ordinality > ${afterOrdinal}))
        AND (entry.value IS NOT NULL OR jsonb_typeof(l."payload" -> 'referenceProposals') <> 'array')
      ORDER BY l."sourceRow" ASC, entry.ordinality ASC
      LIMIT ${input.take}`)
  }
  if (input.section === 'VENUE_BINDING_REQUESTS') {
    return tx.$queryRaw(Prisma.sql`
      SELECT l."sourceSheet", l."sourceRow", 0::int AS "ordinal", l."status"::text AS "status",
        ${catalogImportReviewLineShapeSql('VENUE_BINDING_REQUESTS', [
          'schemaVersion',
          'section',
          'corporateSku',
          'venueId',
          'requestedAction',
          'productId',
          'localSku',
          'categoryId',
          'initialPrice',
          'currency',
        ])} AS "durableShapeValid",
        ${boundedTextProof(
          Prisma.sql`l."payload" -> 'corporateSku'`,
          CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 + 1,
        )} AS "proofCorporateSku", left(l."payload" ->> 'venueId', 257) AS "venueId",
        left(l."payload" ->> 'requestedAction', 17) AS "requestedAction", left(l."payload" ->> 'productId', 257) AS "productId",
        ${boundedTextProof(
          Prisma.sql`l."payload" -> 'localSku'`,
          CATALOG_INDEXED_TEXT_MAX_SCALARS_V1 + 1,
        )} AS "proofLocalSku", left(l."payload" ->> 'categoryId', 257) AS "categoryId",
        left(l."payload" ->> 'initialPrice', 65) AS "initialPrice", left(l."payload" ->> 'currency', 17) AS "currency"
      FROM "CatalogImportLine" l
      WHERE l."organizationId" = ${input.organizationId} AND l."batchId" = ${input.importBatchId}
        AND l."sourceSheet" = 'VenueBindingRequests' AND l."sourceRow" > ${afterRow}
      ORDER BY l."sourceRow" ASC
      LIMIT ${input.take}`)
  }
  return tx.$queryRaw(Prisma.sql`
    SELECT left(entry.value ->> 'source_sheet', 65) AS "sourceSheet", entry.value ->> 'source_row' AS "sourceRow",
      COALESCE(entry.ordinality, 1)::int AS "ordinal", l."sourceSheet" AS "cursorSourceSheet", l."sourceRow" AS "cursorSourceRow",
      ${catalogImportErrorsShapeSql()} AS "durableShapeValid",
      l."status"::text AS "status", left(entry.value ->> 'column', 129) AS "column",
      left(entry.value ->> 'error_code', 129) AS "errorCode", left(entry.value ->> 'message', 513) AS "message",
      left(entry.value ->> 'rejected_value', 257) AS "rejectedValue", left(entry.value ->> 'suggestion', 513) AS "suggestion"
    FROM "CatalogImportLine" l
    LEFT JOIN LATERAL jsonb_array_elements(${boundedArrayForExpansion(Prisma.sql`l."errors"`, 128)})
      WITH ORDINALITY AS entry(value, ordinality) ON true
    WHERE l."organizationId" = ${input.organizationId} AND l."batchId" = ${input.importBatchId}
      AND (l."sourceSheet" > ${afterSheet} OR (l."sourceSheet" = ${afterSheet} AND
        (l."sourceRow" > ${afterRow} OR (l."sourceRow" = ${afterRow} AND entry.ordinality > ${afterOrdinal}))))
      AND (entry.value IS NOT NULL OR NOT ${catalogImportErrorsShapeSql()})
    ORDER BY l."sourceSheet" ASC, l."sourceRow" ASC, entry.ordinality ASC
    LIMIT ${input.take}`)
}

export async function queryCatalogImportPreviewItemDetailTx(
  tx: CatalogImportReadQueryTransaction,
  input: CatalogImportItemDetailQueryV1,
): Promise<Record<string, unknown> | null> {
  if (!validId(input.organizationId) || !validId(input.importBatchId) || !Number.isInteger(input.sourceRow)) return failQuery()
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT l."sourceSheet", l."sourceRow", 0::int AS "ordinal", l."status"::text AS "status",
      ${catalogImportItemLineShapeSql()} AS "durableShapeValid",
      left(l."payload" #>> '{command,operation}', 17) AS "operation", l."catalogItemId",
      ${boundedTextProof(
        Prisma.sql`l."payload" #> '{command,input,sku}'`,
        CATALOG_IMPORT_REFERENCE_NAME_PROOF_MAX_SCALARS_V1,
      )} AS "proofCorporateSku", left(l."payload" #>> '{command,input,kind}', 65) AS "itemKind",
      left(l."payload" #>> '{command,input,name}', 257) AS "name", left(l."payload" #>> '{command,input,description}', 513) AS "description",
      left(l."payload" #>> '{command,input,imageUrl}', 257) AS "imageUrl", left(l."payload" #>> '{command,input,brandId}', 257) AS "brandId",
      left(l."payload" #>> '{command,input,manufacturerId}', 257) AS "manufacturerId", left(l."payload" #>> '{command,input,familyId}', 257) AS "familyId",
      left(l."payload" #>> '{command,input,presentationLabel}', 257) AS "presentationLabel", left(l."payload" #>> '{command,input,unit}', 65) AS "unit",
      left(l."payload" #>> '{command,input,productType}', 65) AS "productType", left(l."payload" #>> '{command,input,taxRate}', 65) AS "taxRate",
      left(l."payload" #>> '{command,input,satProductKey}', 65) AS "satProductKey", left(l."payload" #>> '{command,input,satUnitKey}', 65) AS "satUnitKey",
      left(l."payload" #>> '{command,input,objetoImp}', 65) AS "objetoImp", left(l."payload" #>> '{command,input,iepsMode}', 65) AS "iepsMode",
      left(l."payload" #>> '{command,input,iepsRate}', 65) AS "iepsRate", left(l."payload" #>> '{command,input,iepsQuota}', 65) AS "iepsQuota",
      left(l."payload" #>> '{command,input,iepsQuotaUnit}', 65) AS "iepsQuotaUnit",
      ${arrayLength(Prisma.sql`l."payload" #> '{command,input,organizationValues}'`)} AS "organizationValueCount",
      ${arrayLength(Prisma.sql`l."payload" #> '{command,input,businessTypes}'`)} AS "businessTypeCount",
      ${arrayLength(Prisma.sql`l."payload" -> 'referenceProposals'`)} AS "referenceProposalCount",
      ${arrayLength(Prisma.sql`l."payload" -> 'venueBindingRequests'`)} AS "venueBindingRequestCount",
      ${arrayLength(Prisma.sql`l."errors"`)} AS "errorCount"
    FROM "CatalogImportLine" l
    WHERE l."organizationId" = ${input.organizationId} AND l."batchId" = ${input.importBatchId}
      AND l."sourceSheet" = 'Items' AND l."sourceRow" = ${input.sourceRow}
    LIMIT 1`)
  return rows[0] ?? null
}
