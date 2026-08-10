import { Prisma } from '@prisma/client'
import {
  CATALOG_IMPORT_REFERENCE_MARKER_MAX_SCALARS_V1,
  CATALOG_IMPORT_REFERENCE_MARKER_MAX_UTF8_BYTES_V1,
  CATALOG_IMPORT_REFERENCE_NAME_PROOF_MAX_SCALARS_V1,
  CATALOG_IMPORT_REFERENCE_PARENT_MAX_SCALARS_V1,
  CATALOG_IMPORT_REFERENCE_PARENT_MAX_UTF8_BYTES_V1,
} from './catalogImportPreviewReferenceProjection.service'

function boundedProposalArray(path: Prisma.Sql): Prisma.Sql {
  // WHY: Parent existence is proved only inside the frozen four-proposal item
  // envelope; the SRF never traverses an attacker-sized durable array.
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'array' THEN CASE
    WHEN jsonb_array_length(${path}) BETWEEN 0 AND 4 THEN ${path} ELSE '[]'::jsonb END
    ELSE '[]'::jsonb END`
}

function boundedTextProof(path: Prisma.Sql, maximumScalars: number): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'string'
    THEN left((${path}) #>> '{}', ${maximumScalars}) ELSE NULL END`
}

function parentShapeSql(): Prisma.Sql {
  return Prisma.sql`CASE entry.value ->> 'referenceType'
    WHEN 'FAMILY' THEN CASE WHEN entry.value ? 'parentId' THEN
      CASE jsonb_typeof(entry.value -> 'parentId')
        WHEN 'null' THEN true
        WHEN 'string' THEN CASE WHEN length(entry.value ->> 'parentId') BETWEEN 1 AND ${CATALOG_IMPORT_REFERENCE_PARENT_MAX_SCALARS_V1}
          THEN octet_length(entry.value ->> 'parentId') <= ${CATALOG_IMPORT_REFERENCE_PARENT_MAX_UTF8_BYTES_V1}
          ELSE false END
        ELSE false END
      ELSE false END
    WHEN 'BRAND' THEN NOT (entry.value ? 'parentId')
    WHEN 'MANUFACTURER' THEN NOT (entry.value ? 'parentId')
    ELSE false END`
}

export function catalogImportReferenceParentProofSql(): Prisma.Sql {
  return Prisma.sql`CASE WHEN entry.value ->> 'referenceType' = 'FAMILY'
    AND jsonb_typeof(entry.value -> 'parentId') = 'string' THEN
      CASE WHEN length(entry.value ->> 'parentId') BETWEEN 1 AND ${CATALOG_IMPORT_REFERENCE_PARENT_MAX_SCALARS_V1}
        AND octet_length(entry.value ->> 'parentId') <= ${CATALOG_IMPORT_REFERENCE_PARENT_MAX_UTF8_BYTES_V1}
        THEN entry.value ->> 'parentId' ELSE NULL END
    ELSE NULL END`
}

function markerEnvelopeSql(path: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'string' THEN
    CASE WHEN length((${path}) #>> '{}') BETWEEN 1 AND ${CATALOG_IMPORT_REFERENCE_MARKER_MAX_SCALARS_V1}
      THEN octet_length((${path}) #>> '{}') <= ${CATALOG_IMPORT_REFERENCE_MARKER_MAX_UTF8_BYTES_V1}
      ELSE false END
    ELSE false END`
}

export function catalogImportReferenceMarkerDigestSql(path: Prisma.Sql): Prisma.Sql {
  // WHY: Capacity reconciliation groups a fixed digest only after the exact
  // marker envelope; hostile marker text never becomes a grouping key.
  return Prisma.sql`CASE WHEN ${markerEnvelopeSql(path)}
    THEN encode(sha256(convert_to((${path}) #>> '{}', 'UTF8')), 'hex') ELSE NULL END`
}

function parentSuffixSql(): Prisma.Sql {
  return Prisma.sql`(':PARENT:' || COALESCE(${catalogImportReferenceParentProofSql()}, 'ROOT'))`
}

function rootSiblingPredicateSql(root: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`jsonb_typeof(${root}) = 'object'
    AND ${root} ->> 'operation' = 'CREATE'
    AND ${root} ->> 'referenceType' = 'FAMILY'
    AND jsonb_typeof(${root} -> 'parentId') = 'null'
    AND ${root} ->> 'capacityMarker' = entry.value ->> 'parentId'`
}

function rootSiblingExistsSql(): Prisma.Sql {
  const root = Prisma.sql`root_proposal.value`
  return Prisma.sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(${boundedProposalArray(Prisma.sql`l."payload" -> 'referenceProposals'`)}) root_proposal(value)
    WHERE ${rootSiblingPredicateSql(root)}
  )`
}

export function catalogImportReferenceParentNameProofSql(): Prisma.Sql {
  const root = Prisma.sql`root_proposal.value`
  // WHY: Node needs the sibling's full bounded raw name to recompute its root
  // marker with the shared Unicode normalizer; no raw proposal object escapes.
  return Prisma.sql`CASE WHEN entry.value ->> 'referenceType' = 'FAMILY'
    AND left(entry.value ->> 'parentId', 10) = '@proposal:' THEN (
      SELECT ${boundedTextProof(Prisma.sql`${root} -> 'name'`, CATALOG_IMPORT_REFERENCE_NAME_PROOF_MAX_SCALARS_V1)}
      FROM jsonb_array_elements(${boundedProposalArray(Prisma.sql`l."payload" -> 'referenceProposals'`)}) root_proposal(value)
      WHERE ${rootSiblingPredicateSql(root)}
      LIMIT 1
    ) ELSE NULL END`
}

export function catalogImportReferenceParentBindingSql(): Prisma.Sql {
  const marker = Prisma.sql`entry.value ->> 'capacityMarker'`
  const suffix = parentSuffixSql()
  const markerParentExists = Prisma.sql`CASE WHEN left(entry.value ->> 'parentId', 10) = '@proposal:'
    THEN ${rootSiblingExistsSql()} ELSE true END`
  return Prisma.sql`CASE WHEN ${parentShapeSql()} AND ${markerEnvelopeSql(Prisma.sql`entry.value -> 'capacityMarker'`)} THEN
    CASE WHEN entry.value ->> 'referenceType' = 'FAMILY' THEN
      right(${marker}, length(${suffix})) = ${suffix} AND length(${marker}) > length(${suffix}) AND ${markerParentExists}
      ELSE true END
    ELSE false END`
}

export function catalogImportReferenceMarkerBaseHashSql(): Prisma.Sql {
  const marker = Prisma.sql`entry.value ->> 'capacityMarker'`
  const suffix = parentSuffixSql()
  const base = Prisma.sql`CASE WHEN entry.value ->> 'referenceType' = 'FAMILY'
    THEN left(${marker}, length(${marker}) - length(${suffix})) ELSE ${marker} END`
  // WHY: Only a fixed SHA-256 proof crosses SQL. Node recomputes the same V1
  // base after it validates the complete raw name and root-parent proof.
  return Prisma.sql`CASE WHEN ${catalogImportReferenceParentBindingSql()}
    THEN encode(sha256(convert_to(${base}, 'UTF8')), 'hex') ELSE NULL END`
}
