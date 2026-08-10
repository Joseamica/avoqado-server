import { Prisma } from '@prisma/client'
import AppError from '../../errors/AppError'
import type { CatalogCommandContext, CatalogWorkbookUpload } from '../../types/master-catalog'
import { hashCanonicalJsonV1 } from './catalogHash.service'
import { assertCatalogOrganizationValueRevisions, validateCatalogItemInput } from './catalogItemValidation.service'
import type { CatalogItemAggregateCommand, CatalogReferenceProposal } from './catalogItem.types'
import {
  calculateCatalogImportConfirmCapacityCooperativelyV1,
  calculateCatalogImportConfirmCapacityV1,
  markCatalogImportConfirmDeactivationOverflowV1,
} from './catalogImportCapacity.service'
import { CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS } from './catalogImport.types'
import type { CatalogImportDependencySnapshotV1, CatalogImportStagedLine, CatalogImportValidationDependencies } from './catalogImport.types'
import { loadCatalogImportLookup } from './catalogImportLookup.service'
import { persistCatalogImportPreviewTx } from './catalogImportStagingPersistence.service'
import {
  projectCatalogImportValidatedCommandV1,
  stageCatalogImportReferenceProposalsV1,
  type CatalogImportStagedPayloadV1,
} from './catalogImportStagedPayload.service'
import {
  addCatalogImportRetireAncillaryFindingsV1,
  parseCatalogImportItemRowV1,
  validateCatalogImportItemIdentityV1,
} from './catalogImportItemRow.service'
import { createCatalogImportCooperativeCheckpoint, hashCatalogImportUploadBuffer } from './catalogImportCanonical.service'
import {
  addCatalogImportProfileFindings,
  addCatalogImportOrganizationRevisionFindings,
  groupCatalogImportRows,
  parseCatalogImportBusinessTypes,
  parseCatalogImportOrganizationValues,
  projectCatalogImportCanonicalLineV1,
  resolveCatalogImportProductType,
  resolveCatalogImportReference,
  validateCatalogImportMetadata,
} from './catalogImportMapping.service'
import { parseCatalogImportBindingRequests } from './catalogImportBinding.service'
import { buildCatalogImportReviewLinesV1 } from './catalogImportReviewLines.service'
import {
  addCatalogImportFinding,
  addCatalogImportFindingOnce,
  appendCatalogImportStandaloneErrorLines,
} from './catalogImportFieldValidation.service'

const PREVIEW_TTL_MS = 30 * 60 * 1_000

export function createCatalogImportValidationService(dependencies: CatalogImportValidationDependencies) {
  return {
    async preview(context: CatalogCommandContext, upload: CatalogWorkbookUpload) {
      if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
        throw new AppError('La importación requiere un actor humano activo.', 403, true, 'CATALOG_HUMAN_ACTOR_REQUIRED')
      }
      // WHY: Preserve the proven HUMAN identity across async transaction
      // callbacks without weakening the service-principal actor union.
      const actorStaffId = context.actor.staffId
      // WHY: A short live-access preflight denies revoked callers before they
      // consume worker/ZIP capacity; staging rechecks later to close TOCTOU.
      await dependencies.prisma.$transaction(async tx => {
        await dependencies.assertLiveAccessTx(tx, context)
      }, CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS)
      const workbook = await dependencies.parseWorkbook(upload)
      const fileSha256 = await hashCatalogImportUploadBuffer(upload.buffer)
      return dependencies.prisma.$transaction(async tx => {
        await dependencies.assertLiveAccessTx(tx, context)
        const checkpoint = createCatalogImportCooperativeCheckpoint()
        const errors = await validateCatalogImportMetadata(workbook, context.organizationId, checkpoint)
        if ((workbook.sheets.Items?.rows.length ?? 0) === 0) {
          // WHY: A structurally valid but empty workbook cannot become a bearer
          // that fails only after the human attempts confirmation.
          addCatalogImportFinding(
            errors,
            'Items',
            1,
            'operation',
            'CATALOG_IMPORT_EMPTY',
            undefined,
            'Agrega al menos una fila CREATE, UPDATE o RETIRE.',
          )
        }
        const valueRows = await groupCatalogImportRows(workbook, 'OrganizationValues', errors, checkpoint)
        const businessRows = await groupCatalogImportRows(workbook, 'BusinessTypes', errors, checkpoint)
        const bindingRows = await groupCatalogImportRows(workbook, 'VenueBindingRequests', errors, checkpoint)
        const lookup = await loadCatalogImportLookup(tx, context.organizationId, workbook, checkpoint)
        const snapshot: CatalogImportDependencySnapshotV1 = {
          schemaVersion: 1,
          capacity: calculateCatalogImportConfirmCapacityV1([]),
          items: [],
          priceDependentItemIds: [],
          organizationValues: [],
          references: [],
          mappings: [],
          profiles: lookup.profileDependencies,
        }
        const staged: CatalogImportStagedLine[] = []
        const capacityPayloads: CatalogImportStagedPayloadV1[] = []
        const itemIdentityState = {
          seenSkus: new Set<string>(),
          seenTargetIds: new Set<string>(),
          capturedItemIds: new Set<string>(),
          capturedPriceItemIds: new Set<string>(),
        }
        const capturedPriceIds = new Set<string>()
        const referenceResolutionState = {
          capturedReferences: new Set<string>(),
          proposedReferences: new Set<string>(),
          familyParentByNormalizedName: new Map<string, string | null>(),
        }
        const capturedMappings = new Set<string>()
        for (const row of workbook.sheets.Items?.rows ?? []) {
          const beforeErrors = errors.length
          const parsedRow = parseCatalogImportItemRowV1(row, errors)
          const { operation, sku, normalizedSku, catalogItemId, expectedRevision } = parsedRow
          const { current, duplicateSku } = validateCatalogImportItemIdentityV1(row, parsedRow, lookup, snapshot, itemIdentityState, errors)
          if (duplicateSku) {
            // WHY: One normalized SKU denotes one aggregate. Once the row is
            // deterministically invalid, repeating its 20k ancillary children
            // would create quadratic CPU/memory and duplicate review payloads.
            staged.push({
              sourceSheet: 'Items',
              sourceRow: row.sourceRow,
              status: 'INVALID',
              payload: { schemaVersion: 1 },
              errors: errors.slice(beforeErrors),
              catalogItemId: null,
            })
            await checkpoint()
            continue
          }
          let command: CatalogItemAggregateCommand
          let commandIsCanonical = operation === 'RETIRE'
          const proposals: Extract<CatalogReferenceProposal, { operation: 'CREATE' }>[] = []
          if (operation === 'RETIRE') {
            await addCatalogImportRetireAncillaryFindingsV1(
              normalizedSku,
              [
                ['OrganizationValues', valueRows],
                ['BusinessTypes', businessRows],
                ['VenueBindingRequests', bindingRows],
              ],
              errors,
              checkpoint,
            )
            command = {
              operation: 'RETIRE',
              input: { catalogItemId: catalogItemId ?? '@invalid', expectedRevision: expectedRevision ?? 1 },
            }
          } else {
            const scalar = parsedRow.scalar!
            const brandId = resolveCatalogImportReference(
              'BRAND',
              scalar.brandName,
              lookup.referencesByType.BRAND,
              row,
              'brand',
              errors,
              proposals,
              snapshot,
              referenceResolutionState,
            )
            const manufacturerId = resolveCatalogImportReference(
              'MANUFACTURER',
              scalar.manufacturerName,
              lookup.referencesByType.MANUFACTURER,
              row,
              'manufacturer',
              errors,
              proposals,
              snapshot,
              referenceResolutionState,
            )
            const familyId = resolveCatalogImportReference(
              'FAMILY',
              scalar.familyName,
              lookup.referencesByType.FAMILY,
              row,
              'family',
              errors,
              proposals,
              snapshot,
              referenceResolutionState,
              null,
            )
            const subfamilyId = resolveCatalogImportReference(
              'FAMILY',
              scalar.subfamilyName,
              lookup.referencesByType.FAMILY,
              row,
              'subfamily',
              errors,
              proposals,
              snapshot,
              referenceResolutionState,
              familyId,
            )
            const productType = resolveCatalogImportProductType(
              scalar.productTypeRaw,
              scalar.kind,
              lookup.mappingsByAlias,
              row,
              errors,
              snapshot,
              capturedMappings,
            )
            const organizationValues = await parseCatalogImportOrganizationValues(
              valueRows.get(normalizedSku) ?? [],
              operation,
              errors,
              checkpoint,
            )
            const businessTypes = await parseCatalogImportBusinessTypes(businessRows.get(normalizedSku) ?? [], errors, checkpoint)
            const currentPrices = [...(lookup.pricesByItemId.get(catalogItemId ?? '') ?? [])]
            if (operation === 'UPDATE') {
              await addCatalogImportOrganizationRevisionFindings(
                valueRows.get(normalizedSku) ?? [],
                organizationValues,
                currentPrices,
                errors,
                checkpoint,
              )
            }
            const activeKeys = new Set(organizationValues.map(value => `${value.kind}:${value.currency}`))
            const deactivations = currentPrices
              .filter(price => price.active && !activeKeys.has(`${price.kind}:${price.currency}`))
              .map(price => ({ kind: price.kind, currency: price.currency, expectedRuleRevision: price.revision }))
            for (const price of currentPrices) {
              const priceId = price.id ?? `${price.catalogItemId}:${price.kind}:${price.currency}`
              // WHY: Preview captures every active rule (including tombstones)
              // plus inactive keys explicitly retained/reactivated by the
              // command, but excludes irrelevant historical inactive rows.
              if ((!price.active && !activeKeys.has(`${price.kind}:${price.currency}`)) || capturedPriceIds.has(priceId)) continue
              capturedPriceIds.add(priceId)
              snapshot.organizationValues.push({
                id: priceId,
                catalogItemId: price.catalogItemId,
                kind: price.kind,
                scope: price.scope,
                currency: price.currency,
                revision: price.revision,
                active: price.active,
              })
            }
            const input = {
              sku,
              kind: scalar.kind,
              name: scalar.name,
              description: scalar.description,
              imageUrl: scalar.imageUrl,
              brandId,
              manufacturerId,
              familyId: subfamilyId,
              presentationLabel: scalar.presentationLabel,
              unit: scalar.unit,
              productType,
              taxRate: scalar.taxRate,
              satProductKey: scalar.satProductKey,
              satUnitKey: scalar.satUnitKey,
              objetoImp: scalar.objetoImp,
              iepsMode: scalar.iepsMode,
              iepsRate: scalar.iepsRate,
              iepsQuota: scalar.iepsQuota,
              iepsQuotaUnit: scalar.iepsQuotaUnit,
              businessTypes,
              organizationValues,
            }
            const updateInput = {
              ...input,
              catalogItemId: catalogItemId ?? '@invalid',
              expectedRevision: expectedRevision ?? 1,
              organizationValueDeactivations: deactivations,
            }
            command = operation === 'CREATE' ? { operation: 'CREATE', input } : { operation: 'UPDATE', input: updateInput }
            try {
              const validated = validateCatalogItemInput(operation === 'CREATE' ? input : updateInput, operation)
              if (operation === 'UPDATE') assertCatalogOrganizationValueRevisions(validated, currentPrices)
              command = projectCatalogImportValidatedCommandV1(
                operation,
                validated,
                operation === 'UPDATE'
                  ? { catalogItemId: updateInput.catalogItemId, expectedRevision: updateInput.expectedRevision }
                  : undefined,
              )
              commandIsCanonical = true
            } catch {
              if (errors.length === beforeErrors) {
                // WHY: Leaf readers are the coordinate authority. A Task 5
                // rejection with no matching finding signals validator drift;
                // fail closed without pretending an arbitrary field is wrong.
                addCatalogImportFindingOnce(
                  errors,
                  'Items',
                  row.sourceRow,
                  'operation',
                  'CATALOG_IMPORT_VALIDATOR_DRIFT',
                  row.values.operation,
                  'Actualiza el importador y vuelve a generar el preview.',
                )
              }
              await checkpoint()
            }
            addCatalogImportProfileFindings(
              lookup.profiles,
              businessTypes,
              new Set([
                'sku',
                'imageUrl',
                'name',
                'description',
                'brandId',
                'manufacturerId',
                'familyId',
                'subfamily',
                'presentationLabel',
                'unit',
                'kind',
                'productType',
                'organizationSalePrice',
                'organizationPurchaseCost',
                'currency',
                'taxRate',
                'ieps',
                'satProductKey',
                'satUnitKey',
                'objetoImp',
                'createdById',
                'createdAt',
                'updatedById',
                'updatedAt',
                'businessTypes',
              ]),
              row,
              errors,
            )
          }
          const requests =
            operation === 'RETIRE'
              ? []
              : await parseCatalogImportBindingRequests(
                  bindingRows.get(normalizedSku) ?? [],
                  lookup.venueById,
                  lookup.productById,
                  lookup.categoryById,
                  errors,
                  checkpoint,
                )
          // WHY: Ancillary findings belong to their original review lines;
          // the Items line status represents only its own physical coordinate.
          const itemErrors = errors
            .slice(beforeErrors)
            .filter(error => error.source_sheet === 'Items' && error.source_row === row.sourceRow)
          const itemPayload = {
            schemaVersion: 1 as const,
            command,
            referenceProposals: stageCatalogImportReferenceProposalsV1(proposals),
            venueBindingRequests: requests,
          }
          if (!itemErrors.length && commandIsCanonical) capacityPayloads.push(itemPayload)
          staged.push({
            sourceSheet: 'Items',
            sourceRow: row.sourceRow,
            status: itemErrors.length ? 'INVALID' : 'READY',
            payload: itemPayload as unknown as Prisma.InputJsonValue,
            errors: itemErrors,
            // WHY: Only a live tenant lookup may satisfy the composite FK;
            // rejected submitted IDs stay in bounded diagnostics/payload only.
            catalogItemId: command.operation === 'CREATE' ? null : (current?.id ?? null),
          })
          await checkpoint()
        }

        let capacity = await calculateCatalogImportConfirmCapacityCooperativelyV1(capacityPayloads, checkpoint)
        if (lookup.activePriceHydrationOverflow && capacity.measurement === 'EXACT') {
          capacity = markCatalogImportConfirmDeactivationOverflowV1(capacity)
        }
        snapshot.capacity = capacity
        // WHY: Capacity is batch-level, hash-bound review metadata. It must not
        // invent a physical row coordinate (or push a 50k workbook to 50,001
        // durable lines); persistence exposes the bounded blocking reason.

        // WHY: Ancillary rows may describe only an item present in this same
        // import; an orphan SKU never mutates or infers an existing item.
        for (const [sheet, grouped] of [
          ['OrganizationValues', valueRows],
          ['BusinessTypes', businessRows],
          ['VenueBindingRequests', bindingRows],
        ] as const) {
          for (const [sku, rows] of grouped) {
            const row = rows[0]
            if (!itemIdentityState.seenSkus.has(sku) && row) {
              if (!sku.startsWith('@invalid-row:')) {
                addCatalogImportFinding(errors, sheet, row.sourceRow, 'corporate_sku', 'CATALOG_TARGET_NOT_FOUND', row.values.corporate_sku)
              }
              // WHY: Orphan ancillary rows remain fully diagnosable instead of
              // hiding invalid money/enums behind their missing item join.
              if (sheet === 'OrganizationValues') {
                await parseCatalogImportOrganizationValues(rows, 'CREATE', errors, checkpoint)
              } else if (sheet === 'BusinessTypes') {
                await parseCatalogImportBusinessTypes(rows, errors, checkpoint)
              } else {
                await parseCatalogImportBindingRequests(rows, lookup.venueById, lookup.productById, lookup.categoryById, errors, checkpoint)
              }
            }
            await checkpoint()
          }
        }
        staged.push(...(await buildCatalogImportReviewLinesV1(workbook, errors, checkpoint)))
        await appendCatalogImportStandaloneErrorLines(staged, errors, checkpoint)
        // WHY: PostgreSQL returns confirm rows by sheet/sourceRow; preview uses
        // the same ordinal sequence before hashing so physical XML order cannot
        // create a bearer that is impossible to confirm.
        staged.sort((left, right) => {
          if (left.sourceSheet < right.sourceSheet) return -1
          if (left.sourceSheet > right.sourceSheet) return 1
          return left.sourceRow - right.sourceRow
        })
        const canonical = await dependencies.canonicalizeRows(staged, {
          projectRow: projectCatalogImportCanonicalLineV1,
        })
        const now = dependencies.now()
        const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS)
        const previewToken = dependencies.randomToken()
        const requestHash = hashCanonicalJsonV1('catalog-import-request', {
          organizationId: context.organizationId,
          actorId: actorStaffId,
          fileSha256,
          targetHash: canonical.hash,
        })
        return persistCatalogImportPreviewTx(tx, {
          organizationId: context.organizationId,
          staffId: actorStaffId,
          fileSha256,
          requestHash,
          targetHash: canonical.hash,
          previewToken,
          expiresAt,
          now,
          dependencies: snapshot,
          staged,
          errors,
        })
      }, CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS)
    },
  }
}
