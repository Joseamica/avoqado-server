import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import { ConflictError } from '../../errors/AppError'
import type { CatalogPublicationResultLine } from '../../types/master-catalog'
import { hashCatalogManagedFieldsV1 } from './catalogHash.service'
import type { CatalogPublicationApplyLine, CatalogPublicationJson } from './catalogPublication.types'

const WRITE_CHUNK_SIZE = 500

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += WRITE_CHUNK_SIZE) {
    result.push(values.slice(index, index + WRITE_CHUNK_SIZE))
  }
  return result
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function afterSnapshot(line: CatalogPublicationApplyLine): Record<string, CatalogPublicationJson> {
  return Object.fromEntries(line.decisions.map(decision => [decision.field, decision.after]))
}

function changedPatch(line: CatalogPublicationApplyLine): Record<string, CatalogPublicationJson> {
  return Object.fromEntries(
    line.decisions
      .filter(decision => decision.decision === 'PUBLISH_CORPORATE' && json(decision.before) !== json(decision.after))
      .map(decision => [decision.field, decision.after]),
  )
}

function requireExactCount(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new ConflictError('La publicación perdió una fila durante el write bulk.', 'CATALOG_PUBLICATION_STATE_CONFLICT')
  }
}

async function writeProducts(tx: Prisma.TransactionClient, lines: CatalogPublicationApplyLine[]): Promise<void> {
  const changed = lines.map(line => ({ line, patch: changedPatch(line) })).filter(entry => Object.keys(entry.patch).length > 0)
  for (const chunk of chunks(changed)) {
    const values = chunk.map(({ line, patch }) => Prisma.sql`(${line.productId}, ${line.venueId}, ${json(patch)}::jsonb)`)
    // WHY: One VALUES-driven statement applies up to 500 heterogeneous Product
    // patches; it cannot degrade into 10,000 sequential Prisma updates.
    const affected = await tx.$executeRaw(Prisma.sql`
      WITH changes("productId", "venueId", patch) AS (VALUES ${Prisma.join(values)})
      UPDATE "Product" AS product
      SET
        "cost" = CASE WHEN changes.patch ? 'cost' THEN (changes.patch->>'cost')::numeric ELSE product."cost" END,
        "description" = CASE WHEN changes.patch ? 'description' THEN changes.patch->>'description' ELSE product."description" END,
        "imageUrl" = CASE WHEN changes.patch ? 'imageUrl' THEN changes.patch->>'imageUrl' ELSE product."imageUrl" END,
        "name" = CASE WHEN changes.patch ? 'name' THEN changes.patch->>'name' ELSE product."name" END,
        "objetoImp" = CASE WHEN changes.patch ? 'objetoImp' THEN changes.patch->>'objetoImp' ELSE product."objetoImp" END,
        "satProductKey" = CASE WHEN changes.patch ? 'satProductKey' THEN changes.patch->>'satProductKey' ELSE product."satProductKey" END,
        "satUnitKey" = CASE WHEN changes.patch ? 'satUnitKey' THEN changes.patch->>'satUnitKey' ELSE product."satUnitKey" END,
        "taxRate" = CASE WHEN changes.patch ? 'taxRate' THEN (changes.patch->>'taxRate')::numeric ELSE product."taxRate" END,
        "type" = CASE WHEN changes.patch ? 'type' THEN (changes.patch->>'type')::"ProductType" ELSE product."type" END,
        "unit" = CASE WHEN changes.patch ? 'unit' THEN (changes.patch->>'unit')::"Unit" ELSE product."unit" END,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM changes
      WHERE product.id = changes."productId"
        AND product."venueId" = changes."venueId"
        AND product."deletedAt" IS NULL
    `)
    requireExactCount(affected, chunk.length)
  }
}

async function writeBindings(
  tx: Prisma.TransactionClient,
  organizationId: string,
  staffId: string,
  lines: CatalogPublicationApplyLine[],
): Promise<void> {
  for (const chunk of chunks(lines)) {
    const values = chunk.map(line => {
      const snapshot = afterSnapshot(line)
      const managed = hashCatalogManagedFieldsV1({ hashVersion: 1, fieldMask: line.fieldMask, values: snapshot })
      return Prisma.sql`(${line.bindingId}, ${line.bindingRevision}, ${line.sourceCatalogRevision}, ${json(snapshot)}::jsonb, ${line.fieldMask}::text[], ${managed.hash}, ${staffId})`
    })
    // WHY: Provenance advances beside Product in the same transaction and is
    // tenant/revision scoped; approved local fields remain in the snapshot.
    const affected = await tx.$executeRaw(Prisma.sql`
      WITH changes("bindingId", revision, "catalogRevision", snapshot, mask, hash, "staffId") AS (VALUES ${Prisma.join(values)})
      UPDATE "CatalogVenueBinding" AS binding
      SET
        "lastPublishedCatalogRevision" = changes."catalogRevision",
        "lastPublishedManagedSnapshot" = changes.snapshot,
        "managedFieldMask" = changes.mask,
        "managedHashVersion" = 1,
        "lastPublishedManagedHash" = changes.hash,
        "productUpdatedAtObserved" = CURRENT_TIMESTAMP,
        revision = binding.revision + 1,
        "updatedById" = changes."staffId",
        "updatedAt" = CURRENT_TIMESTAMP
      FROM changes
      WHERE binding.id = changes."bindingId"
        AND binding."organizationId" = ${organizationId}
        AND binding.revision = changes.revision
        AND binding.status = 'LINKED'
    `)
    requireExactCount(affected, chunk.length)
  }
}

async function writeLineDetails(tx: Prisma.TransactionClient, organizationId: string, lines: CatalogPublicationApplyLine[]): Promise<void> {
  const decisions = lines.flatMap(line =>
    line.decisions.map(decision => ({
      id: cuid(),
      organizationId,
      lineId: line.lineId,
      bindingId: line.bindingId,
      field: decision.field,
      decision: decision.decision,
      before: decision.before as Prisma.InputJsonValue,
      proposed: decision.proposed as Prisma.InputJsonValue,
      after: decision.after as Prisma.InputJsonValue,
      overrideId: decision.overrideId,
      reason: decision.reason,
    })),
  )
  // WHY: Child decisions are confirmation effects, never PREVIEWED effects;
  // they must be inserted while the parent line is non-terminal because the
  // DB trigger bumps decisionInvariantVersion and APPLIED is immutable.
  for (const chunk of chunks(decisions)) {
    const created = await tx.catalogPublicationFieldDecision.createMany({ data: chunk })
    requireExactCount(created.count, chunk.length)
  }

  for (const chunk of chunks(lines)) {
    const lineValues = chunk.map(line => {
      const status = Object.keys(changedPatch(line)).length > 0 ? 'APPLIED' : 'NO_CHANGE'
      return Prisma.sql`(${line.lineId}, ${status}::"CatalogPublicationLineStatus", ${json(afterSnapshot(line))}::jsonb, ${line.supersedesLineId ?? null}, ${line.reversesLineId ?? null})`
    })
    // WHY: Terminal status is the final line mutation, after decision triggers
    // have completed, so deferred invariants see one closed immutable record.
    const affected = await tx.$executeRaw(Prisma.sql`
      WITH changes(id, status, after, "supersedesLineId", "reversesLineId") AS (VALUES ${Prisma.join(lineValues)})
      UPDATE "CatalogPublicationLine" AS line
      SET status = changes.status, after = changes.after,
          "supersedesLineId" = changes."supersedesLineId", "reversesLineId" = changes."reversesLineId",
          "updatedAt" = CURRENT_TIMESTAMP
      FROM changes
      WHERE line.id = changes.id AND line."organizationId" = ${organizationId}
        AND line.status IN ('READY', 'NO_CHANGE', 'LOCAL_DIVERGENCE')
    `)
    requireExactCount(affected, chunk.length)
  }
}

export async function persistCatalogPublicationTx(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; staffId: string; lines: CatalogPublicationApplyLine[] },
): Promise<CatalogPublicationResultLine[]> {
  await writeProducts(tx, input.lines)
  await writeBindings(tx, input.organizationId, input.staffId, input.lines)
  await writeLineDetails(tx, input.organizationId, input.lines)
  return input.lines.map(line => ({
    lineId: line.lineId,
    catalogItemId: line.catalogItemId,
    venueId: line.venueId,
    productId: line.productId,
    status: Object.keys(changedPatch(line)).length > 0 ? 'APPLIED' : 'NO_CHANGE',
  }))
}
