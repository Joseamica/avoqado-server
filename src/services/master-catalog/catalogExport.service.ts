import { BusinessType, CatalogItemKind, CatalogItemPriceScope, CatalogVenueBindingStatus, Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import type { CatalogReadContext } from '@/types/master-catalog'
import prisma from '@/utils/prismaClient'
import { MASTER_CATALOG_IMPORT_HEADERS } from '@/workers/masterCatalogXlsx.worker'
import { calculateRecipeCostV1, RecipeCostCalculationError } from '@/services/dashboard/recipe-cost-calculator'
import { validateCatalogProductTypeV1 } from './catalogProductType.service'
import { CATALOG_EXPORT_WORKBOOK_LIMITS_V1, type CatalogWorkbookValueV1, writeCatalogWorkbookV1 } from './catalogExportWorkbook.service'
import {
  CATALOG_EXPORT_HYDRATED_ROW_CAP_V1,
  type CatalogExportProfileV1,
  catalogExportProfileVersionsV1 as profileVersions,
  catalogExportRequiredFieldRowsV1 as requiredFieldRows,
  catalogExportSheetV1 as sheet,
  catalogExportTextColumnV1 as text,
  failCatalogExportCapacityV1 as failCapacity,
  failCatalogExportDataV1 as failData,
} from './catalogExportContract.service'

export const CATALOG_EXPORT_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export { CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 } from './catalogExportContract.service'

export interface CatalogExportFileV1 {
  filename: string
  contentType: typeof CATALOG_EXPORT_XLSX_MIME
  buffer: Buffer
}

interface CatalogExportPrismaV1 {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T>
}

interface CatalogExportDependenciesV1 {
  prisma?: CatalogExportPrismaV1
  now?: () => Date
  writeWorkbook?: typeof writeCatalogWorkbookV1
}

function recipeUnsupported(): never {
  return failData('La receta contiene un estado no representable por XLSX v1.', 'CATALOG_EXPORT_RECIPE_STATE_UNSUPPORTED')
}

export function createCatalogExportService(dependencies: CatalogExportDependenciesV1 = {}) {
  const db = dependencies.prisma ?? (prisma as unknown as CatalogExportPrismaV1)
  const now = dependencies.now ?? (() => new Date())
  const writeWorkbook = dependencies.writeWorkbook ?? writeCatalogWorkbookV1

  async function loadCatalog(context: CatalogReadContext, businessType: BusinessType | null) {
    return db.$transaction(
      async tx => {
        const itemWhere: Prisma.CatalogItemWhereInput = {
          organizationId: context.organizationId,
          ...(businessType ? { businessTypes: { some: { businessType } } } : {}),
        }
        const itemProbe = await tx.catalogItem.findMany({
          where: itemWhere,
          select: { id: true, kind: true },
          orderBy: [{ sku: 'asc' }, { id: 'asc' }],
          take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 + 1,
        })
        if (itemProbe.length > CATALOG_EXPORT_HYDRATED_ROW_CAP_V1) failCapacity({ grain: 'Items' })
        const itemIds = itemProbe.map(item => item.id)
        const itemKindById = new Map(itemProbe.map(item => [item.id, item.kind]))
        let hydratedRows = itemProbe.length
        const consume = (count: number, grain: string) => {
          if (count > CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 - hydratedRows) failCapacity({ grain })
          hydratedRows += count
        }
        const remaining = () => CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 - hydratedRows + 1
        const profileWhere: Prisma.CatalogValidationProfileWhereInput = {
          organizationId: context.organizationId,
          active: true,
          ...(businessType ? { operationalRole: null, OR: [{ businessType: null }, { businessType }] } : {}),
        }
        // WHY: Profile rules can contain large arrays. Probe only stable scalar
        // identity before the shared 5k hydration cap, then load full rules for
        // a business export only after that cap has accepted the row set.
        const profileProbe = await tx.catalogValidationProfile.findMany({
          where: profileWhere,
          select: { id: true, profileVersion: true },
          orderBy: [{ profileVersion: 'asc' }, { id: 'asc' }],
          take: remaining(),
        })
        consume(profileProbe.length, 'Profiles')
        const profileRows = businessType
          ? ((await tx.catalogValidationProfile.findMany({
              where: { ...profileWhere, id: { in: profileProbe.map(profile => profile.id) } },
              select: {
                id: true,
                profileVersion: true,
                rulesSchemaVersion: true,
                businessType: true,
                operationalRole: true,
                requiredFields: true,
                active: true,
              },
              orderBy: [{ profileVersion: 'asc' }, { id: 'asc' }],
              take: profileProbe.length,
            })) as CatalogExportProfileV1[])
          : (profileProbe as CatalogExportProfileV1[])
        if (profileRows.length !== profileProbe.length) failData('Los perfiles activos cambiaron dentro del snapshot de exportación.')
        const profiles = businessType
          ? profileRows.filter(
              profile =>
                profile.active &&
                profile.operationalRole === null &&
                (profile.businessType === null || profile.businessType === businessType),
            )
          : profileRows
        profileVersions(profiles)

        const priceProbe = await tx.catalogItemPrice.findMany({
          where: {
            organizationId: context.organizationId,
            catalogItemId: { in: itemIds },
            active: true,
            scope: CatalogItemPriceScope.ORGANIZATION,
          },
          select: { id: true },
          take: remaining(),
        })
        consume(priceProbe.length, 'OrganizationValues')
        const businessProbe = await tx.catalogItemBusinessType.findMany({
          where: { organizationId: context.organizationId, catalogItemId: { in: itemIds } },
          select: { id: true },
          take: remaining(),
        })
        consume(businessProbe.length, 'BusinessTypes')
        const bindingProbe = await tx.catalogVenueBinding.findMany({
          where: { organizationId: context.organizationId, catalogItemId: { in: itemIds } },
          select: { id: true, catalogItemId: true, product: { select: { recipe: { select: { id: true } } } } },
          take: remaining(),
        })
        consume(bindingProbe.length, 'VenueBindings')
        const identifierProbe = await tx.catalogIdentifier.findMany({
          where: { organizationId: context.organizationId, catalogItemId: { in: itemIds }, type: 'CORPORATE_SKU' },
          select: { id: true },
          take: remaining(),
        })
        consume(identifierProbe.length, 'Identifiers')
        const recipeIds = bindingProbe.flatMap(binding => (binding.product?.recipe ? [binding.product.recipe.id] : []))
        const recipeProbe = await tx.recipeLine.findMany({
          where: {
            recipeId: { in: recipeIds },
            recipe: {
              product: { catalogVenueBindings: { some: { organizationId: context.organizationId, catalogItemId: { in: itemIds } } } },
            },
          },
          select: { id: true },
          take: remaining(),
        })
        consume(recipeProbe.length, 'RecipeLines')
        const preparedCount = bindingProbe.filter(
          binding => itemKindById.get(binding.catalogItemId) === CatalogItemKind.PREPARED_DISH,
        ).length
        const requiredRows = businessType ? requiredFieldRows(businessType, profiles) : []
        const outputRows =
          itemProbe.length +
          priceProbe.length +
          businessProbe.length +
          bindingProbe.length +
          preparedCount +
          identifierProbe.length +
          requiredRows.length
        if (outputRows > CATALOG_EXPORT_WORKBOOK_LIMITS_V1.maxDataRows) failCapacity({ grain: 'Workbook', outputRows })

        const items = await tx.catalogItem.findMany({
          where: { organizationId: context.organizationId, id: { in: itemIds } },
          select: {
            id: true,
            sku: true,
            kind: true,
            name: true,
            description: true,
            imageUrl: true,
            presentationLabel: true,
            unit: true,
            productType: true,
            taxRate: true,
            satProductKey: true,
            satUnitKey: true,
            objetoImp: true,
            iepsMode: true,
            iepsRate: true,
            iepsQuota: true,
            iepsQuotaUnit: true,
            status: true,
            createdById: true,
            createdAt: true,
            updatedById: true,
            updatedAt: true,
            brand: { select: { name: true } },
            manufacturer: { select: { name: true } },
            family: {
              select: {
                name: true,
                status: true,
                parentId: true,
                parent: { select: { name: true, status: true, parentId: true } },
                children: { where: { organizationId: context.organizationId, status: 'ACTIVE' }, select: { id: true }, take: 1 },
              },
            },
          },
          orderBy: [{ sku: 'asc' }, { id: 'asc' }],
          take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1,
        })
        const prices = await tx.catalogItemPrice.findMany({
          where: {
            organizationId: context.organizationId,
            catalogItemId: { in: itemIds },
            active: true,
            scope: CatalogItemPriceScope.ORGANIZATION,
          },
          select: { catalogItemId: true, kind: true, amount: true, currency: true, revision: true },
          take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1,
        })
        const businessTypes = await tx.catalogItemBusinessType.findMany({
          where: { organizationId: context.organizationId, catalogItemId: { in: itemIds } },
          select: { catalogItemId: true, businessType: true },
          take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1,
        })
        const bindings = await tx.catalogVenueBinding.findMany({
          where: { organizationId: context.organizationId, catalogItemId: { in: itemIds } },
          select: {
            catalogItemId: true,
            venueId: true,
            status: true,
            lastPublishedCatalogRevision: true,
            venue: { select: { id: true, name: true, currency: true } },
            product: {
              select: {
                id: true,
                venueId: true,
                sku: true,
                categoryId: true,
                recipe: { select: { id: true, portionYield: true, prepTime: true, totalCost: true } },
              },
            },
          },
          take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1,
        })
        const identifiers = await tx.catalogIdentifier.findMany({
          where: { organizationId: context.organizationId, catalogItemId: { in: itemIds }, type: 'CORPORATE_SKU' },
          select: { catalogItemId: true, code: true, status: true, createdById: true, createdAt: true },
          take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1,
        })
        const recipeLines = await tx.recipeLine.findMany({
          where: {
            recipeId: { in: recipeIds },
            recipe: {
              product: { catalogVenueBindings: { some: { organizationId: context.organizationId, catalogItemId: { in: itemIds } } } },
            },
          },
          select: {
            id: true,
            recipeId: true,
            displayOrder: true,
            quantity: true,
            unit: true,
            rawMaterial: { select: { venueId: true, unit: true, costPerUnit: true, active: true, deletedAt: true } },
          },
          orderBy: [{ recipeId: 'asc' }, { displayOrder: 'asc' }, { id: 'asc' }],
          take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1,
        })
        const itemById = new Map(items.map(item => [item.id, item]))
        const skuFor = (id: string) => itemById.get(id)?.sku ?? failData('Una relación exportable perdió su artículo tenant-scoped.')
        const itemRows = items.map(item => {
          if (
            item.family.status !== 'ACTIVE' ||
            !item.family.parentId ||
            !item.family.parent ||
            item.family.parent.status !== 'ACTIVE' ||
            item.family.parent.parentId !== null ||
            item.family.children.length !== 0
          ) {
            return failData('La jerarquía family/subfamily del artículo no es válida.')
          }
          return {
            corporate_sku: item.sku,
            item_kind: item.kind,
            name: item.name,
            description: item.description,
            image_url: item.imageUrl,
            brand: item.brand.name,
            manufacturer: item.manufacturer.name,
            family: item.family.parent.name,
            subfamily: item.family.name,
            presentation: item.presentationLabel,
            unit: item.unit,
            product_type: item.productType,
            iva_rate: item.taxRate.toFixed(4),
            sat_product_key: item.satProductKey,
            sat_unit_key: item.satUnitKey,
            objeto_imp: item.objetoImp,
            ieps_mode: item.iepsMode,
            ieps_rate: item.iepsRate?.toFixed(6) ?? null,
            ieps_quota: item.iepsQuota?.toFixed(4) ?? null,
            ieps_quota_unit: item.iepsQuotaUnit,
            status: item.status,
            created_by: item.createdById,
            created_at: item.createdAt.toISOString(),
            updated_by: item.updatedById,
            updated_at: item.updatedAt.toISOString(),
          }
        })
        const valueRows = prices.map(price => ({
          corporate_sku: skuFor(price.catalogItemId),
          value_type: price.kind,
          amount: price.amount.toFixed(2),
          currency: price.currency,
          revision: price.revision,
        }))
        const businessRows = businessTypes.map(row => ({ corporate_sku: skuFor(row.catalogItemId), business_type: row.businessType }))
        const bindingRows = bindings.map(binding => ({
          corporate_sku: skuFor(binding.catalogItemId),
          venue_id: binding.venueId,
          venue_name: binding.venue.name,
          product_id: binding.product?.id ?? null,
          local_sku: binding.product?.sku ?? null,
          binding_status: binding.status,
          category_id: binding.product?.categoryId ?? null,
          last_published_revision: binding.lastPublishedCatalogRevision,
        }))
        const linesByRecipe = new Map<string, typeof recipeLines>()
        for (let index = 0; index < recipeLines.length; index += 1) {
          const line = recipeLines[index]
          const grouped = linesByRecipe.get(line.recipeId)
          if (grouped) grouped.push(line)
          else linesByRecipe.set(line.recipeId, [line])
          if ((index + 1) % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve))
        }
        const preparedRows: Array<Record<string, CatalogWorkbookValueV1>> = []
        for (const binding of bindings) {
          const item = itemById.get(binding.catalogItemId)
          if (!item || item.kind !== CatalogItemKind.PREPARED_DISH) continue
          try {
            validateCatalogProductTypeV1({ kind: item.kind, productType: item.productType })
          } catch {
            recipeUnsupported()
          }
          const product = binding.status === CatalogVenueBindingStatus.LINKED ? binding.product : null
          const recipe = product?.recipe ?? null
          let recipeStatus: 'MISSING_RECIPE' | 'INVALID_PORTION_YIELD' | 'MISSING_PREP_TIME' | 'EMPTY_LINES' | 'COST_STALE' | 'COMPLETE' =
            'MISSING_RECIPE'
          let batchCost: string | null = null
          let costPerPortion: string | null = null
          if (recipe) {
            const lines = linesByRecipe.get(recipe.id) ?? []
            if (
              lines.some(
                line => line.rawMaterial.venueId !== binding.venueId || !line.rawMaterial.active || line.rawMaterial.deletedAt !== null,
              )
            ) {
              recipeUnsupported()
            }
            let calculated: ReturnType<typeof calculateRecipeCostV1> | null = null
            if (lines.length > 0) {
              try {
                calculated = calculateRecipeCostV1({
                  portionYield: Number.isSafeInteger(recipe.portionYield) && recipe.portionYield > 0 ? recipe.portionYield : 1,
                  lines,
                })
              } catch (error) {
                if (error instanceof RecipeCostCalculationError) recipeUnsupported()
                throw error
              }
            }
            if (!Number.isSafeInteger(recipe.portionYield) || recipe.portionYield <= 0) recipeStatus = 'INVALID_PORTION_YIELD'
            else if (recipe.prepTime === null || !Number.isSafeInteger(recipe.prepTime) || recipe.prepTime <= 0)
              recipeStatus = 'MISSING_PREP_TIME'
            else if (lines.length === 0) recipeStatus = 'EMPTY_LINES'
            else {
              if (!calculated) recipeUnsupported()
              batchCost = calculated.batchCost.toFixed(4)
              costPerPortion = calculated.costPerPortion.toFixed(4)
              recipeStatus = calculated.costPerPortion.eq(new Decimal(recipe.totalCost).toDecimalPlaces(4, Decimal.ROUND_HALF_UP))
                ? 'COMPLETE'
                : 'COST_STALE'
            }
          }
          preparedRows.push({
            corporate_sku: item.sku,
            venue_id: binding.venueId,
            product_id: product?.id ?? null,
            recipe_id: recipe?.id ?? null,
            portion_yield: recipe?.portionYield ?? null,
            prep_time_minutes: recipe?.prepTime ?? null,
            total_recipe_cost: batchCost,
            cost_per_portion: costPerPortion,
            currency: product ? binding.venue.currency : null,
            recipe_status: recipeStatus,
          })
        }
        const identifierRows = identifiers.map(identifier => ({
          corporate_sku: skuFor(identifier.catalogItemId),
          code: identifier.code,
          format: 'SKU',
          status: identifier.status,
          created_by: identifier.createdById,
          created_at: identifier.createdAt.toISOString(),
        }))
        const sheets = [
          sheet('Items', itemRows),
          sheet('OrganizationValues', valueRows),
          sheet('BusinessTypes', businessRows),
          sheet('VenueBindings', bindingRows),
          sheet('PreparedDishDetails', preparedRows),
          sheet('Identifiers', identifierRows),
          sheet('Regions', []),
          sheet('RegionalValues', []),
        ]
        if (businessType) sheets.push(sheet('RequiredFields', requiredRows))
        return { sheets, profileVersion: profileVersions(profiles) }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    )
  }

  async function renderCatalog(context: CatalogReadContext, businessType: BusinessType | null): Promise<CatalogExportFileV1> {
    const snapshot = await loadCatalog(context, businessType)
    const filename = businessType ? 'catalog-by-business-type-v1.xlsx' : 'catalog-master-v1.xlsx'
    return {
      filename,
      contentType: CATALOG_EXPORT_XLSX_MIME,
      buffer: await writeWorkbook({
        metadata: {
          schemaVersion: '1',
          organizationId: context.organizationId,
          generatedAt: now().toISOString(),
          timezone: 'America/Mexico_City',
          filters: businessType ? JSON.stringify({ businessType }) : '{}',
          profileVersion: snapshot.profileVersion,
        },
        sheets: snapshot.sheets,
      }),
    }
  }

  async function catalogImportTemplate(context: CatalogReadContext): Promise<CatalogExportFileV1> {
    const profiles = await db.$transaction(
      tx =>
        tx.catalogValidationProfile.findMany({
          where: { organizationId: context.organizationId, active: true },
          select: { id: true, profileVersion: true },
          orderBy: [{ profileVersion: 'asc' }, { id: 'asc' }],
          take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 + 1,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    )
    if (profiles.length > CATALOG_EXPORT_HYDRATED_ROW_CAP_V1) failCapacity({ grain: 'Profiles' })
    const templateSheets = Object.entries(MASTER_CATALOG_IMPORT_HEADERS)
      .filter(([name]) => name !== 'Metadata')
      .map(([name, headers]) => ({
        name,
        grain: [headers[0]],
        columns: headers.map(header => text(header)),
        rows: [],
      }))
    return {
      filename: 'catalog-master-import-v1.xlsx',
      contentType: CATALOG_EXPORT_XLSX_MIME,
      buffer: await writeWorkbook({
        metadata: {
          documentType: 'catalog-master-import',
          schemaVersion: '1',
          organizationId: context.organizationId,
          generatedAt: now().toISOString(),
          timezone: 'America/Mexico_City',
          filters: '{}',
          profileVersion: profileVersions(profiles),
        },
        sheets: templateSheets,
      }),
    }
  }

  return {
    catalogMaster: (context: CatalogReadContext) => renderCatalog(context, null),
    catalogByBusinessType: (context: CatalogReadContext, businessType: BusinessType) => renderCatalog(context, businessType),
    catalogImportTemplate,
  }
}

const catalogExportService = createCatalogExportService({ prisma: prisma as unknown as CatalogExportPrismaV1 })
export const exportCatalogMasterV1 = catalogExportService.catalogMaster
export const exportCatalogByBusinessTypeV1 = catalogExportService.catalogByBusinessType
export const exportCatalogImportTemplateV1 = catalogExportService.catalogImportTemplate
export { exportCatalogImportErrorsV1 } from './catalogExportErrors.service'
