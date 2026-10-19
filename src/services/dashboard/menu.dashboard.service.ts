import prisma from '../../utils/prismaClient'
import {
  IvaTratamiento,
  Menu,
  MenuCategory,
  Prisma,
  ModifierGroup,
  Modifier,
  ProductGroupSource,
  ProductModifierGroup,
  ProductType,
  Unit,
} from '@prisma/client'
import { CreateMenuCategoryDto, UpdateMenuCategoryDto, ReorderMenuCategoriesDto } from '../../schemas/dashboard/menuCategory.schema'
import {
  CreateMenuDto,
  UpdateMenuDto,
  CloneMenuDto,
  ReorderMenusDto,
  ReorderProductsDto,
  AssignCategoryToMenuDto,
  CreateModifierGroupDto,
  UpdateModifierGroupDto,
  CreateModifierDto,
  UpdateModifierDto,
  AssignModifierGroupToProductDto,
} from '../../schemas/dashboard/menu.schema'
import AppError, { NotFoundError, BadRequestError } from '../../errors/AppError'
import { generateSlug } from '../../utils/slugify'
import { deleteFileFromStorage } from '../storage.service'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'
import { logAction } from './activity-log.service'
import { archivarProductos } from './product.dashboard.service'
import { productGroupInclude, withVariantFields } from '../product-variants/variantPayload'
import { assertLooseProductForModifiers, assertNoGroupedProducts } from '../product-variants/groupOwnedFields'
import { groupOwnedFieldError, isGroupWriterViolation } from '../product-variants/variantErrors'
import { MAX_OPTIONS, MAX_VARIANTS_PER_GROUP, assertAllowedGroupType } from '../product-variants/variantNaming'
import {
  assertNoMasterCatalog,
  createVariantRows,
  lockGroup,
  type GroupContext,
  type VariantRowInput,
} from '../product-variants/productGroup.service'
import {
  checkVariantRowsAgainstDb,
  createGroupTx,
  ensureOptionValuesTx,
  familyIdentityConflict,
  groupContextOf,
  loadGroupContextTx,
  loadGroupForWrite,
  lockGroupForCleanup,
  manualGroupByName,
  optionValuesCapacity,
} from '../product-variants/groupWriterTx'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { bloquearParaCambiarIva } from '../fiscal/exclusionContable'
import { ETIQUETA_DE_IVA, TRATAMIENTOS_OFRECIDOS_V1 } from '../fiscal/ivaTratamiento'
import {
  ensureQuantityInventoryRow,
  inventoryMethodForNewProduct,
  isNonInventoriable,
  NON_INVENTORIABLE_MESSAGE,
} from './quantityInventoryRow'
import type { CatalogActor } from '../../types/master-catalog'
import {
  assertLegacyCatalogGovernanceComputedForVenue,
  assertLegacyCatalogGovernanceForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../master-catalog/catalogGovernance.service'

// Sin tipo de retorno explícito: lo lee la TPV (`/tpv/venues/:venueId/menus`) y cada producto lleva los 4 campos de variantes.
export async function getMenus(venueId: string) {
  const menus = await prisma.menu.findMany({
    where: { venueId },
    include: {
      categories: {
        orderBy: {
          displayOrder: 'asc',
        },
        include: {
          category: {
            include: {
              products: { where: { deletedAt: null }, include: productGroupInclude },
            },
          },
        },
      },
    },
    orderBy: {
      displayOrder: 'asc',
    },
  })
  // Variantes: productGroupId/Name/ImageUrl + variantOptions (nunca un campo «variants»).
  return menus.map(menu => ({
    ...menu,
    categories: menu.categories.map(asignacion => ({
      ...asignacion,
      category: { ...asignacion.category, products: asignacion.category.products.map(withVariantFields) },
    })),
  }))
}

/** Lo agruparon entre el pre-chequeo y la escritura: el trigger del escritor único lo frena; 409 en español, nunca 500. */
function rechazoDelEscritorUnico(e: unknown): never {
  if (isGroupWriterViolation(e)) throw groupOwnedFieldError('con variantes')
  throw e
}

export async function createMenuCategory(venueId: string, data: CreateMenuCategoryDto): Promise<MenuCategory> {
  // Variantes (A9): mover una talla a otra categoría se hace desde su padre; se rechaza ANTES de crear la categoría.
  await assertNoGroupedProducts(
    prisma,
    venueId,
    (data.avoqadoProducts ?? []).map((p: { value: string }) => p.value),
    'la categoría',
  )
  const slug = generateSlug(data.name)

  const existingCategory = await prisma.menuCategory.findUnique({
    where: { venueId_slug: { venueId, slug } },
  })

  if (existingCategory) {
    throw new BadRequestError(`Ya existe una categoría con el nombre '${data.name}' en este establecimiento.`)
  }

  const createData: Prisma.MenuCategoryCreateInput = {
    // Explicitly map fields from DTO to ensure type safety and avoid passing unwanted properties
    name: data.name,
    description: data.description,
    displayOrder: data.displayOrder,
    imageUrl: data.imageUrl,
    color: data.color,
    icon: data.icon,
    active: data.active,
    availableFrom: data.availableFrom,
    availableUntil: data.availableUntil,
    // availableDays: data.availableDays, // Handled below
    slug, // generated slug
    venue: { connect: { id: venueId } },
    // Campos fiscales SAT (CFDI 4.0) — defaults para productos de la categoría
    ...(data.defaultSatProductKey !== undefined && { defaultSatProductKey: data.defaultSatProductKey }),
    ...(data.defaultSatUnitKey !== undefined && { defaultSatUnitKey: data.defaultSatUnitKey }),
  }

  if (data.parentId) {
    // Only connect if parentId is a non-empty string
    createData.parent = { connect: { id: data.parentId } }
  }
  // If data.parentId is null or undefined, it's omitted, Prisma won't try to set it to null.

  // Estación de impresión (ruteo de comandas) — relation field, not a raw scalar
  // (MenuCategoryCreateInput is the "checked" Prisma input, so the FK must be set
  // via the relation object, same as `parent` above).
  if (data.printStationId) {
    createData.printStation = { connect: { id: data.printStationId } }
  }

  // Handle availableDays specifically for null case
  if (data.availableDays === null) {
    createData.availableDays = undefined // Treat null as 'not set' for create
  } else if (data.availableDays) {
    // If availableDays is an array of objects with value property (from MultiSelector)
    if (
      Array.isArray(data.availableDays) &&
      data.availableDays.length > 0 &&
      typeof data.availableDays[0] === 'object' &&
      'value' in data.availableDays[0]
    ) {
      createData.availableDays = data.availableDays.map((day: any) => day.value)
    } else {
      createData.availableDays = data.availableDays
    }
  }

  const category = await prisma.menuCategory.create({ data: createData })

  // Handle menu assignments
  if (data.avoqadoMenus && data.avoqadoMenus.length > 0) {
    const menuAssignments = data.avoqadoMenus.map(menu => ({
      menuId: menu.value,
      categoryId: category.id,
    }))

    await prisma.menuCategoryAssignment.createMany({
      data: menuAssignments,
    })
  }

  // Handle product assignments
  if (data.avoqadoProducts && data.avoqadoProducts.length > 0) {
    const productIds = data.avoqadoProducts.map(product => product.value)

    await prisma.product
      .updateMany({
        where: {
          id: { in: productIds },
          venueId: venueId,
        },
        data: {
          categoryId: category.id,
        },
      })
      .catch(rechazoDelEscritorUnico)
  }

  // 🔌 REAL-TIME: Broadcast category creation via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    const affectedItemCount = data.avoqadoProducts?.length || 0

    broadcastingService.broadcastMenuCategoryUpdated(venueId, {
      categoryId: category.id,
      categoryName: category.name,
      action: 'CREATED',
      displayOrder: category.displayOrder,
      active: category.active,
      parentId: category.parentId,
      affectedItemCount,
    })

    logger.info('🔌 Menu category created event broadcasted', {
      venueId,
      categoryId: category.id,
      categoryName: category.name,
      affectedItemCount,
    })
  }

  logAction({ venueId, action: 'MENU_CATEGORY_CREATED', entity: 'MenuCategory', entityId: category.id, data: { name: category.name } })

  return category
}

export async function getMenuCategoryById(venueId: string, categoryId: string): Promise<MenuCategory> {
  const category = await prisma.menuCategory.findUnique({
    where: { id: categoryId, venueId },
    include: {
      products: { where: { deletedAt: null } },
      menus: {
        include: {
          menu: true,
        },
      },
    }, // Include children and products as needed
  })

  if (!category) {
    throw new NotFoundError(`Menu category with ID ${categoryId} not found in venue ${venueId}.`)
  }
  return category
}

export async function listMenuCategoriesForVenue(venueId: string): Promise<MenuCategory[]> {
  return prisma.menuCategory.findMany({
    where: { venueId, parentId: null }, // Fetch top-level categories
    orderBy: { displayOrder: 'asc' },
    include: {
      menus: true,
      children: {
        // Recursively fetch children
        orderBy: { displayOrder: 'asc' },
        include: { children: true },
      },
      products: { where: { deletedAt: null }, orderBy: { displayOrder: 'asc' } },
    },
  })
}

export async function updateMenuCategory(venueId: string, categoryId: string, data: UpdateMenuCategoryDto): Promise<MenuCategory> {
  // Variantes (A9): igual que al crear — antes de tocar nada. Sólo cuentan los que CAMBIARÍAN de categoría (Codex #7).
  await assertNoGroupedProducts(
    prisma,
    venueId,
    (data.avoqadoProducts ?? []).map((p: { value: string }) => p.value),
    'la categoría',
    { categoryId },
  )
  const category = await prisma.menuCategory.findUnique({
    where: { id: categoryId, venueId },
  })

  if (!category) {
    throw new NotFoundError(`Menu category with ID ${categoryId} not found in venue ${venueId}.`)
  }

  const updateData: Prisma.MenuCategoryUpdateInput = {}

  if (data.name && data.name !== category.name) {
    updateData.name = data.name
    const newSlugFromName = generateSlug(data.name) // Ensure slug is a string for the check
    updateData.slug = newSlugFromName
    const existingCategoryWithNewSlug = await prisma.menuCategory.findUnique({
      where: { venueId_slug: { venueId, slug: newSlugFromName } }, // Use the string variable here
    })
    if (existingCategoryWithNewSlug && existingCategoryWithNewSlug.id !== categoryId) {
      throw new BadRequestError(`A category with the name '${data.name}' already exists in this venue.`)
    }
  } else if (data.name) {
    updateData.name = data.name // Name provided but same as before, no slug change needed
  }

  // Assign other updatable fields from DTO if they exist
  if (data.description !== undefined) updateData.description = data.description
  if (data.displayOrder !== undefined) updateData.displayOrder = data.displayOrder
  if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl
  if (data.color !== undefined) updateData.color = data.color
  if (data.icon !== undefined) updateData.icon = data.icon
  if (data.active !== undefined) updateData.active = data.active

  // Handle time fields with explicit null/undefined handling
  if ('availableFrom' in data) {
    updateData.availableFrom = data.availableFrom || null
  }
  if ('availableUntil' in data) {
    updateData.availableUntil = data.availableUntil || null
  }

  // Handle availableDays specifically for null and array cases in update
  if ('availableDays' in data) {
    if (data.availableDays === null) {
      updateData.availableDays = { set: [] } // Explicitly set to empty array if DTO provides null
    } else if (Array.isArray(data.availableDays)) {
      // If availableDays is an array of objects with value property (from MultiSelector)
      if (data.availableDays.length > 0 && typeof data.availableDays[0] === 'object' && 'value' in data.availableDays[0]) {
        updateData.availableDays = (data.availableDays as any[]).map((day: any) => day.value)
      } else {
        updateData.availableDays = data.availableDays // This implies { set: data.availableDays }
      }
    }
    // If data.availableDays is undefined (but key was present), Prisma treats it as no-op for this field.
  }

  // Campos fiscales SAT (CFDI 4.0) — defaults para productos de la categoría
  if ('defaultSatProductKey' in data) updateData.defaultSatProductKey = data.defaultSatProductKey ?? null
  if ('defaultSatUnitKey' in data) updateData.defaultSatUnitKey = data.defaultSatUnitKey ?? null

  // Estación de impresión (ruteo de comandas) — relation field, not a raw scalar
  // (MenuCategoryUpdateInput is the "checked" Prisma input, so the FK must be set
  // via the relation object, same as `parent` below).
  if ('printStationId' in data) {
    if (data.printStationId === null) {
      updateData.printStation = { disconnect: true }
    } else if (typeof data.printStationId === 'string') {
      updateData.printStation = { connect: { id: data.printStationId } }
    }
  }

  // Handle parentId explicitly
  if ('parentId' in data) {
    // parentId was present in the input DTO
    if (data.parentId === null) {
      // Client wants to remove parent
      updateData.parent = { disconnect: true }
    } else if (typeof data.parentId === 'string') {
      // Client wants to set/change parent
      updateData.parent = { connect: { id: data.parentId } }
    }
    // If data.parentId is undefined (but key was present), it implies no change to parent if not handled
    // Prisma treats undefined as 'do not update'.
  }

  // Handle avoqadoMenus (Menu Assignments)
  if (data.avoqadoMenus) {
    // 1. Delete existing assignments for this category
    // Note: We don't delete assignments by ID, but by categoryId relationship
    // However, menuCategoryAssignment is Many-to-Many.
    // We want to set which menus this category belongs to.
    await prisma.menuCategoryAssignment.deleteMany({
      where: { categoryId },
    })

    // 2. Create new assignments
    if (data.avoqadoMenus.length > 0) {
      const menuAssignments = data.avoqadoMenus.map(menu => ({
        menuId: menu.value,
        categoryId: categoryId,
      }))

      await prisma.menuCategoryAssignment.createMany({
        data: menuAssignments,
      })
    }
  }

  // Handle avoqadoProducts (Product Assignments)
  if (data.avoqadoProducts && data.avoqadoProducts.length > 0) {
    const productIds = data.avoqadoProducts.map(product => product.value)

    // Move selected products to this category
    await prisma.product
      .updateMany({
        where: {
          id: { in: productIds },
          venueId: venueId,
        },
        data: {
          categoryId: categoryId,
        },
      })
      .catch(rechazoDelEscritorUnico)
  }

  const updatedCategory = await prisma.menuCategory.update({
    where: { id: categoryId, venueId },
    data: updateData,
  })

  // 🔌 REAL-TIME: Broadcast category update via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    // Count products in this category
    const productCount = await prisma.product.count({
      where: { categoryId, deletedAt: null },
    })

    // Determine action based on what changed
    const action = data.active !== undefined && data.active !== category.active ? (data.active ? 'ENABLED' : 'DISABLED') : 'UPDATED'

    broadcastingService.broadcastMenuCategoryUpdated(venueId, {
      categoryId: updatedCategory.id,
      categoryName: updatedCategory.name,
      action,
      displayOrder: updatedCategory.displayOrder,
      active: updatedCategory.active,
      parentId: updatedCategory.parentId,
      affectedItemCount: productCount,
    })

    logger.info('🔌 Menu category updated event broadcasted', {
      venueId,
      categoryId: updatedCategory.id,
      categoryName: updatedCategory.name,
      action,
      affectedItemCount: productCount,
    })
  }

  logAction({
    venueId,
    action: 'MENU_CATEGORY_UPDATED',
    entity: 'MenuCategory',
    entityId: updatedCategory.id,
    data: { name: updatedCategory.name },
  })

  return updatedCategory
}

export async function deleteMenuCategory(venueId: string, categoryId: string): Promise<MenuCategory> {
  const category = await prisma.menuCategory.findUnique({
    where: { id: categoryId, venueId },
    include: { children: true },
  })

  if (!category) {
    throw new NotFoundError(`Menu category with ID ${categoryId} not found in venue ${venueId}.`)
  }

  // Plan 5 (D6, Ruling P5-R7): los productos ARCHIVADOS no cuentan — el dueño ya no los ve. Pero `Product.categoryId` es
  // RESTRICT: una categoría que sólo conserva archivados no se puede borrar de verdad; se APAGA, como en «Reemplazar menú».
  const productCount = await prisma.product.count({ where: { categoryId, deletedAt: null } })
  if (productCount > 0) {
    throw new BadRequestError('Cannot delete category: it still contains products. Please move or delete them first.')
  }
  if (category.children && category.children.length > 0) {
    throw new BadRequestError('Cannot delete category: it still has sub-categories. Please delete them first.')
  }
  // Variantes (decisión 3a): `ProductGroup.categoryId` también es RESTRICT — una familia (aun archivada o deshecha) que la
  // referencia la conserva apagada, igual que un archivado.
  const conArchivados =
    (await prisma.product.count({ where: { categoryId } })) > 0 || (await prisma.productGroup.count({ where: { categoryId } })) > 0

  // Delete image from Firebase Storage if it exists (apagada, la conserva para cuando una importación la traiga de vuelta)
  if (category.imageUrl && !conArchivados) {
    logger.info(`🗑️  Deleting category image from storage: ${category.imageUrl}`)
    await deleteFileFromStorage(category.imageUrl).catch(error => {
      logger.error(`❌ Failed to delete category image from storage`, error)
      // Continue with deletion even if storage cleanup fails
    })
  }

  let deletedCategory: MenuCategory
  if (conArchivados) {
    // F5-1: apagada y FUERA de los menús (getMenus no filtra `active`); las dos restauraciones de la importación la vuelven a
    // asignar con `upsert`.
    await prisma.menuCategoryAssignment.deleteMany({ where: { categoryId } })
    deletedCategory = await prisma.menuCategory.update({ where: { id: categoryId }, data: { active: false } })
  } else {
    deletedCategory = await prisma.menuCategory.delete({ where: { id: categoryId } })
  }

  // 🔌 REAL-TIME: Broadcast category deletion via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastMenuCategoryDeleted(venueId, {
      categoryId: deletedCategory.id,
      categoryName: deletedCategory.name,
      action: 'DELETED',
      displayOrder: deletedCategory.displayOrder,
      active: deletedCategory.active,
      parentId: deletedCategory.parentId,
      affectedItemCount: 0, // No products since we validate empty before delete
    })

    logger.info('🔌 Menu category deleted event broadcasted', {
      venueId,
      categoryId: deletedCategory.id,
      categoryName: deletedCategory.name,
    })
  }

  logAction({
    venueId,
    action: 'MENU_CATEGORY_DELETED',
    entity: 'MenuCategory',
    entityId: deletedCategory.id,
    data: { name: deletedCategory.name },
  })

  return deletedCategory
}

export async function reorderMenuCategories(venueId: string, reorderData: ReorderMenuCategoriesDto): Promise<Prisma.BatchPayload[]> {
  const transactions = reorderData.map(item =>
    prisma.menuCategory.updateMany({
      where: { id: item.id, venueId }, // Ensure category belongs to the venue
      data: { displayOrder: item.displayOrder },
    }),
  )
  // Note: updateMany doesn't throw if a record isn't found by default.
  // You might want to verify all IDs exist and belong to the venue before transaction for stricter validation.
  const result = await prisma.$transaction(transactions)

  logAction({ venueId, action: 'MENU_CATEGORIES_REORDERED', entity: 'MenuCategory' })

  return result
}

// ==========================================
// MENU SERVICES
// ==========================================

export async function createMenu(venueId: string, data: CreateMenuDto): Promise<Menu> {
  const createData: Prisma.MenuCreateInput = {
    venue: { connect: { id: venueId } },
    name: data.name,
    description: data.description,
    type: data.type,
    displayOrder: data.displayOrder ?? 0,
    isDefault: data.isDefault ?? false,
    active: data.active ?? true,
    startDate: data.startDate,
    endDate: data.endDate,
    availableFrom: data.availableFrom,
    availableUntil: data.availableUntil,
    availableDays: data.availableDays ?? [],
  }

  // Handle category assignments if provided
  if (data.categoryIds) {
    createData.categories = {
      create: data.categoryIds.map((categoryId, index) => ({
        categoryId,
        displayOrder: index, // Maintain order from selection
      })),
    }
  }

  const menu = await prisma.menu.create({
    data: createData,
    include: {
      categories: {
        orderBy: { displayOrder: 'asc' },
        include: {
          category: {
            include: {
              products: { where: { deletedAt: null } },
            },
          },
        },
      },
    },
  })

  logAction({ venueId, action: 'MENU_CREATED', entity: 'Menu', entityId: menu.id, data: { name: menu.name } })

  return menu
}

export async function getMenuById(venueId: string, menuId: string): Promise<Menu> {
  const menu = await prisma.menu.findUnique({
    where: { id: menuId, venueId },
    include: {
      categories: {
        orderBy: { displayOrder: 'asc' },
        include: {
          category: {
            include: {
              products: {
                where: { deletedAt: null },
                orderBy: { displayOrder: 'asc' },
                include: {
                  modifierGroups: {
                    orderBy: { displayOrder: 'asc' },
                    include: {
                      group: {
                        include: {
                          modifiers: { where: { active: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })

  if (!menu) {
    throw new NotFoundError(`Menu with ID ${menuId} not found in venue ${venueId}.`)
  }

  return menu
}

export async function updateMenu(venueId: string, menuId: string, data: UpdateMenuDto): Promise<Menu> {
  const menu = await prisma.menu.findUnique({
    where: { id: menuId, venueId },
  })

  if (!menu) {
    throw new NotFoundError(`Menu with ID ${menuId} not found in venue ${venueId}.`)
  }

  const updateData: Prisma.MenuUpdateInput = {}

  // Update fields if provided
  if (data.name !== undefined) updateData.name = data.name
  if (data.description !== undefined) updateData.description = data.description
  if (data.type !== undefined) updateData.type = data.type
  if (data.displayOrder !== undefined) updateData.displayOrder = data.displayOrder
  if (data.isDefault !== undefined) updateData.isDefault = data.isDefault
  if (data.active !== undefined) updateData.active = data.active
  if (data.startDate !== undefined) updateData.startDate = data.startDate
  if (data.endDate !== undefined) updateData.endDate = data.endDate
  if (data.availableFrom !== undefined) updateData.availableFrom = data.availableFrom
  if (data.availableUntil !== undefined) updateData.availableUntil = data.availableUntil
  if (data.availableDays !== undefined) updateData.availableDays = data.availableDays

  // Update category assignments if categoryIds is provided
  if (data.categoryIds) {
    // We use a transaction to delete all existing assignments and create new ones
    // This is the simplest way to sync categories and handle reordering
    const updatedMenu = await prisma.$transaction(async tx => {
      // 1. Update basic menu details
      if (Object.keys(updateData).length > 0) {
        await tx.menu.update({
          where: { id: menuId },
          data: updateData,
        })
      }

      // 2. Delete all existing category assignments
      await tx.menuCategoryAssignment.deleteMany({
        where: { menuId },
      })

      // 3. Create new assignments
      if (data.categoryIds && data.categoryIds.length > 0) {
        await tx.menuCategoryAssignment.createMany({
          data: data.categoryIds.map((categoryId, index) => ({
            menuId,
            categoryId,
            displayOrder: index, // Maintain order from selection
          })),
        })
      }

      // 4. Return updated menu with categories
      return tx.menu.findUniqueOrThrow({
        where: { id: menuId },
        include: {
          categories: {
            orderBy: { displayOrder: 'asc' },
            include: {
              category: {
                include: {
                  products: { where: { deletedAt: null } },
                },
              },
            },
          },
        },
      })
    })

    logAction({ venueId, action: 'MENU_UPDATED', entity: 'Menu', entityId: updatedMenu.id, data: { name: updatedMenu.name } })

    return updatedMenu
  }

  const updatedMenu = await prisma.menu.update({
    where: { id: menuId, venueId },
    data: updateData,
    include: {
      categories: {
        orderBy: { displayOrder: 'asc' },
        include: {
          category: {
            include: {
              products: { where: { deletedAt: null } },
            },
          },
        },
      },
    },
  })

  logAction({ venueId, action: 'MENU_UPDATED', entity: 'Menu', entityId: updatedMenu.id, data: { name: updatedMenu.name } })

  return updatedMenu
}

export async function deleteMenu(venueId: string, menuId: string): Promise<Menu> {
  const menu = await prisma.menu.findUnique({
    where: { id: menuId, venueId },
    include: {
      categories: { include: { category: { include: { products: true } } } },
    },
  })

  if (!menu) {
    throw new NotFoundError(`Menu with ID ${menuId} not found in venue ${venueId}.`)
  }

  // Check if it's the default menu
  if (menu.isDefault) {
    throw new BadRequestError('Cannot delete the default menu. Please set another menu as default first.')
  }

  // Delete menu (categories assignments will be deleted by cascade)
  const deletedMenu = await prisma.menu.delete({
    where: { id: menuId },
  })

  logAction({ venueId, action: 'MENU_DELETED', entity: 'Menu', entityId: deletedMenu.id, data: { name: deletedMenu.name } })

  return deletedMenu
}

export async function cloneMenu(venueId: string, menuId: string, data: CloneMenuDto): Promise<Menu> {
  const originalMenu = await prisma.menu.findUnique({
    where: { id: menuId, venueId },
    include: {
      categories: {
        include: {
          category: true,
        },
      },
    },
  })

  if (!originalMenu) {
    throw new NotFoundError(`Menu with ID ${menuId} not found in venue ${venueId}.`)
  }

  // Get the highest display order for new menu
  const maxDisplayOrder = await prisma.menu.findFirst({
    where: { venueId },
    orderBy: { displayOrder: 'desc' },
    select: { displayOrder: true },
  })

  const newDisplayOrder = (maxDisplayOrder?.displayOrder ?? 0) + 1

  // Create the cloned menu
  const clonedMenu = await prisma.menu.create({
    data: {
      venue: { connect: { id: venueId } },
      name: data.name,
      description: originalMenu.description,
      type: originalMenu.type,
      displayOrder: newDisplayOrder,
      isDefault: false, // Cloned menu is never default
      active: originalMenu.active,
      startDate: originalMenu.startDate,
      endDate: originalMenu.endDate,
      availableFrom: originalMenu.availableFrom,
      availableUntil: originalMenu.availableUntil,
      availableDays: originalMenu.availableDays,
    },
  })

  // Clone category assignments if copyCategories is true
  if (data.copyCategories && originalMenu.categories.length > 0) {
    const categoryAssignments = originalMenu.categories.map(assignment => ({
      menuId: clonedMenu.id,
      categoryId: assignment.categoryId,
      displayOrder: assignment.displayOrder,
    }))

    await prisma.menuCategoryAssignment.createMany({
      data: categoryAssignments,
    })
  }

  // Return the cloned menu with its categories
  const result = await getMenuById(venueId, clonedMenu.id)

  logAction({ venueId, action: 'MENU_CLONED', entity: 'Menu', entityId: clonedMenu.id, data: { name: clonedMenu.name } })

  return result
}

export async function reorderMenus(venueId: string, reorderData: ReorderMenusDto): Promise<Prisma.BatchPayload[]> {
  const transactions = reorderData.map(item =>
    prisma.menu.updateMany({
      where: { id: item.id, venueId },
      data: { displayOrder: item.displayOrder },
    }),
  )

  const result = await prisma.$transaction(transactions)

  logAction({ venueId, action: 'MENUS_REORDERED', entity: 'Menu' })

  return result
}

export async function assignCategoryToMenu(venueId: string, menuId: string, data: AssignCategoryToMenuDto): Promise<any> {
  // Verify menu exists and belongs to venue
  const menu = await prisma.menu.findUnique({
    where: { id: menuId, venueId },
  })

  if (!menu) {
    throw new NotFoundError(`Menu with ID ${menuId} not found in venue ${venueId}.`)
  }

  // Verify category exists and belongs to venue
  const category = await prisma.menuCategory.findUnique({
    where: { id: data.categoryId, venueId },
  })

  if (!category) {
    throw new NotFoundError(`Category with ID ${data.categoryId} not found in venue ${venueId}.`)
  }

  // Check if assignment already exists
  const existingAssignment = await prisma.menuCategoryAssignment.findUnique({
    where: {
      menuId_categoryId: {
        menuId: menuId,
        categoryId: data.categoryId,
      },
    },
  })

  if (existingAssignment) {
    throw new BadRequestError(`Category ${data.categoryId} is already assigned to menu ${menuId}.`)
  }

  // Create the assignment
  return prisma.menuCategoryAssignment.create({
    data: {
      menuId: menuId,
      categoryId: data.categoryId,
      displayOrder: data.displayOrder ?? 0,
    },
    include: {
      category: true,
      menu: true,
    },
  })
}

export async function removeCategoryFromMenu(venueId: string, menuId: string, categoryId: string): Promise<void> {
  // Verify menu exists and belongs to venue
  const menu = await prisma.menu.findUnique({
    where: { id: menuId, venueId },
  })

  if (!menu) {
    throw new NotFoundError(`Menu with ID ${menuId} not found in venue ${venueId}.`)
  }

  // Find and delete the assignment
  const assignment = await prisma.menuCategoryAssignment.findUnique({
    where: {
      menuId_categoryId: {
        menuId: menuId,
        categoryId: categoryId,
      },
    },
  })

  if (!assignment) {
    throw new NotFoundError(`Category ${categoryId} is not assigned to menu ${menuId}.`)
  }

  await prisma.menuCategoryAssignment.delete({
    where: {
      menuId_categoryId: {
        menuId: menuId,
        categoryId: categoryId,
      },
    },
  })
}

// ==========================================
// MODIFIER GROUPS & MODIFIERS SERVICES
// ==========================================

type ModifierGroupQuery = {
  page?: number
  limit?: number
  search?: string
  active?: boolean
  sortBy?: 'name' | 'displayOrder' | 'createdAt' | 'updatedAt'
  sortOrder?: 'asc' | 'desc'
}

export async function getModifierGroups(venueId: string, query: ModifierGroupQuery = {}): Promise<ModifierGroup[]> {
  const { page, limit, search, active, sortBy, sortOrder } = query

  const where: Prisma.ModifierGroupWhereInput = {
    venueId,
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    ...(active !== undefined ? { active } : {}),
  }

  const order: Record<string, 'asc' | 'desc'> = {}
  if (sortBy) {
    order[sortBy] = sortOrder ?? 'asc'
  } else {
    order['displayOrder'] = 'asc'
  }

  const args: Prisma.ModifierGroupFindManyArgs = {
    where,
    orderBy: order as any,
    include: {
      modifiers: {
        include: {
          // ✅ WORLD-CLASS: Include raw material info for inventory tracking
          rawMaterial: {
            select: { id: true, name: true, unit: true, currentStock: true },
          },
        },
      },
    },
  }
  if (page && limit) {
    args.skip = (page - 1) * limit
    args.take = limit
  }

  return prisma.modifierGroup.findMany(args)
}

export async function createModifierGroup(venueId: string, data: CreateModifierGroupDto): Promise<ModifierGroup> {
  const created = await prisma.modifierGroup.create({
    data: {
      venue: { connect: { id: venueId } },
      name: data.name,
      description: data.description ?? undefined,
      required: data.required ?? false,
      allowMultiple: data.allowMultiple ?? false,
      minSelections: data.minSelections ?? 0,
      maxSelections: data.maxSelections ?? undefined,
      displayOrder: data.displayOrder ?? 0,
      active: data.active ?? true,
      ...(data.modifiers && data.modifiers.length
        ? {
            modifiers: {
              create: data.modifiers.map(m => ({
                name: m.name,
                price: m.price,
                active: m.active ?? true,
                sku: m.sku ?? null,
              })),
            },
          }
        : {}),
    },
    include: { modifiers: true },
  })

  logAction({ venueId, action: 'MODIFIER_GROUP_CREATED', entity: 'ModifierGroup', entityId: created.id, data: { name: created.name } })

  return created
}

export async function getModifierGroupById(venueId: string, modifierGroupId: string): Promise<ModifierGroup & { modifiers: Modifier[] }> {
  const group = await prisma.modifierGroup.findFirst({
    where: { id: modifierGroupId, venueId },
    include: {
      modifiers: {
        include: {
          rawMaterial: {
            select: { id: true, name: true, unit: true, currentStock: true },
          },
        },
      },
    },
  })

  if (!group) {
    throw new NotFoundError(`Modifier group with ID ${modifierGroupId} not found in venue ${venueId}.`)
  }
  return group
}

export async function updateModifierGroup(
  venueId: string,
  modifierGroupId: string,
  data: UpdateModifierGroupDto,
): Promise<ModifierGroup & { modifiers: Modifier[] }> {
  const existing = await prisma.modifierGroup.findFirst({ where: { id: modifierGroupId, venueId } })
  if (!existing) {
    throw new NotFoundError(`Modifier group with ID ${modifierGroupId} not found in venue ${venueId}.`)
  }

  const updateData: Prisma.ModifierGroupUpdateInput = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.description !== undefined) updateData.description = data.description
  if (data.required !== undefined) updateData.required = data.required
  if (data.allowMultiple !== undefined) updateData.allowMultiple = data.allowMultiple
  if (data.minSelections !== undefined) updateData.minSelections = data.minSelections
  if (data.maxSelections !== undefined) updateData.maxSelections = data.maxSelections
  if (data.displayOrder !== undefined) updateData.displayOrder = data.displayOrder
  if (data.active !== undefined) updateData.active = data.active

  // Note: Modifiers should be managed via dedicated endpoints (create/update/delete modifier)

  const updated = await prisma.modifierGroup.update({
    where: { id: modifierGroupId },
    data: updateData,
    include: { modifiers: true },
  })

  logAction({ venueId, action: 'MODIFIER_GROUP_UPDATED', entity: 'ModifierGroup', entityId: updated.id, data: { name: updated.name } })

  return updated
}

export async function deleteModifierGroup(venueId: string, modifierGroupId: string): Promise<void> {
  const existing = await prisma.modifierGroup.findFirst({ where: { id: modifierGroupId, venueId } })
  if (!existing) {
    throw new NotFoundError(`Modifier group with ID ${modifierGroupId} not found in venue ${venueId}.`)
  }

  // Codex #3: el negocio primero, como los escritores de extras (el motor de variantes toma su cerco antes de rehacer los
  // enlaces de una familia). Sin él, el borrado bloqueaba el grupo y esperaba esos enlaces mientras la edición, al
  // recrearlos, esperaba al grupo: deadlock.
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR SHARE`
    await tx.modifierGroup.delete({ where: { id: modifierGroupId } })
  })

  logAction({ venueId, action: 'MODIFIER_GROUP_DELETED', entity: 'ModifierGroup', entityId: existing.id, data: { name: existing.name } })
}

async function findVenueRawMaterialForModifier(venueId: string, rawMaterialId: string) {
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId },
    select: { id: true, avgCostPerUnit: true },
  })
  if (!rawMaterial) {
    throw new NotFoundError(`Raw material with ID ${rawMaterialId} not found in venue ${venueId}.`)
  }
  return rawMaterial
}

function modifierCost(
  rawMaterial: { avgCostPerUnit: Prisma.Decimal } | null,
  quantityPerUnit: Prisma.Decimal | number | null | undefined,
): Prisma.Decimal | null {
  return rawMaterial && quantityPerUnit ? rawMaterial.avgCostPerUnit.mul(quantityPerUnit) : null
}

export async function createModifier(venueId: string, modifierGroupId: string, data: CreateModifierDto): Promise<Modifier> {
  const group = await prisma.modifierGroup.findFirst({ where: { id: modifierGroupId, venueId } })
  if (!group) {
    throw new NotFoundError(`Modifier group with ID ${modifierGroupId} not found in venue ${venueId}.`)
  }

  const rawMaterial = data.rawMaterialId ? await findVenueRawMaterialForModifier(venueId, data.rawMaterialId) : null

  const modifier = await prisma.modifier.create({
    data: {
      group: { connect: { id: modifierGroupId } },
      name: data.name,
      price: data.price,
      active: data.active ?? true,
      sku: data.sku ?? null,
      durationMin: data.durationMin ?? null,
      ...(rawMaterial
        ? {
            rawMaterial: { connect: { id: rawMaterial.id } },
            quantityPerUnit: data.quantityPerUnit ?? null,
            unit: data.unit ?? null,
            ...(data.inventoryMode ? { inventoryMode: data.inventoryMode } : {}),
            cost: modifierCost(rawMaterial, data.quantityPerUnit),
          }
        : {}),
    },
  })

  logAction({ venueId, action: 'MODIFIER_CREATED', entity: 'Modifier', entityId: modifier.id, data: { name: modifier.name } })

  return modifier
}

export async function getModifierById(venueId: string, modifierGroupId: string, modifierId: string): Promise<Modifier> {
  const group = await prisma.modifierGroup.findFirst({ where: { id: modifierGroupId, venueId } })
  if (!group) {
    throw new NotFoundError(`Modifier group with ID ${modifierGroupId} not found in venue ${venueId}.`)
  }

  const modifier = await prisma.modifier.findFirst({
    where: { id: modifierId, groupId: modifierGroupId },
    include: {
      rawMaterial: {
        select: { id: true, name: true, unit: true, currentStock: true },
      },
    },
  })
  if (!modifier) {
    throw new NotFoundError(`Modifier with ID ${modifierId} not found in group ${modifierGroupId}.`)
  }
  return modifier
}

export async function updateModifier(
  venueId: string,
  modifierGroupId: string,
  modifierId: string,
  data: UpdateModifierDto,
): Promise<Modifier> {
  const group = await prisma.modifierGroup.findFirst({ where: { id: modifierGroupId, venueId } })
  if (!group) {
    throw new NotFoundError(`Modifier group with ID ${modifierGroupId} not found in venue ${venueId}.`)
  }

  const existing = await prisma.modifier.findFirst({ where: { id: modifierId, groupId: modifierGroupId } })
  if (!existing) {
    throw new NotFoundError(`Modifier with ID ${modifierId} not found in group ${modifierGroupId}.`)
  }

  const updateData: Prisma.ModifierUpdateInput = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.price !== undefined) updateData.price = data.price
  if (data.active !== undefined) updateData.active = data.active
  if (data.sku !== undefined) updateData.sku = data.sku
  if (data.durationMin !== undefined) updateData.durationMin = data.durationMin

  // ✅ WORLD-CLASS: Inventory configuration for modifiers (Toast/Square pattern)
  let needsCostRecalculation = false
  let rawMaterialForCost: { avgCostPerUnit: Prisma.Decimal } | null = null

  if (data.rawMaterialId !== undefined) {
    // Validate raw material exists in the venue if provided
    if (data.rawMaterialId !== null) {
      rawMaterialForCost = await findVenueRawMaterialForModifier(venueId, data.rawMaterialId)
      needsCostRecalculation = true
    } else {
      // rawMaterialId is being set to null - clear cost
      updateData.cost = null
    }
    updateData.rawMaterial = data.rawMaterialId ? { connect: { id: data.rawMaterialId } } : { disconnect: true }
  }
  if (data.quantityPerUnit !== undefined) {
    updateData.quantityPerUnit = data.quantityPerUnit
    if (data.quantityPerUnit !== null) needsCostRecalculation = true
    else updateData.cost = null // sin cantidad no hay costo: no se deja el viejo ni se calcula con la cantidad anterior
  }
  if (data.unit !== undefined) updateData.unit = data.unit
  // null = el extra se quedó sin inventario. El modo es columna obligatoria (default ADDITION): se deja como está.
  if (data.inventoryMode != null) updateData.inventoryMode = data.inventoryMode

  // ✅ AUTO-CALCULATE COST: avgCostPerUnit × quantityPerUnit
  if (needsCostRecalculation) {
    // Get raw material data if we don't have it yet (quantityPerUnit changed but rawMaterialId didn't)
    if (!rawMaterialForCost && existing.rawMaterialId) {
      rawMaterialForCost = await prisma.rawMaterial.findUnique({
        where: { id: existing.rawMaterialId },
        select: { avgCostPerUnit: true },
      })
    }

    // Calculate cost if we have both raw material and quantity
    // null = la cantidad se borró en esta misma petición: NO cae a la guardada.
    const effectiveQuantity = data.quantityPerUnit === undefined ? existing.quantityPerUnit : data.quantityPerUnit
    const cost = modifierCost(rawMaterialForCost, effectiveQuantity)
    if (cost) updateData.cost = cost
  }

  const updatedModifier = await prisma.modifier.update({
    where: { id: modifierId },
    data: updateData,
    include: {
      rawMaterial: {
        select: { id: true, name: true, unit: true, currentStock: true },
      },
    },
  })

  logAction({
    venueId,
    action: 'MODIFIER_UPDATED',
    entity: 'Modifier',
    entityId: updatedModifier.id,
    data: {
      name: updatedModifier.name,
      ...(data.sku !== undefined && data.sku !== existing.sku ? { sku: { from: existing.sku, to: data.sku } } : {}),
    },
  })

  return updatedModifier
}

export async function deleteModifier(venueId: string, modifierGroupId: string, modifierId: string): Promise<void> {
  const group = await prisma.modifierGroup.findFirst({ where: { id: modifierGroupId, venueId } })
  if (!group) {
    throw new NotFoundError(`Modifier group with ID ${modifierGroupId} not found in venue ${venueId}.`)
  }

  const existing = await prisma.modifier.findFirst({ where: { id: modifierId, groupId: modifierGroupId } })
  if (!existing) {
    throw new NotFoundError(`Modifier with ID ${modifierId} not found in group ${modifierGroupId}.`)
  }

  await prisma.modifier.delete({ where: { id: modifierId } })

  logAction({ venueId, action: 'MODIFIER_DELETED', entity: 'Modifier', entityId: existing.id, data: { name: existing.name } })
}

export async function assignModifierGroupToProduct(
  venueId: string,
  productId: string,
  data: AssignModifierGroupToProductDto,
): Promise<ProductModifierGroup> {
  return prisma.$transaction(async tx => {
    // Verify product belongs to venue and is not a variant (its extras belong to the parent)
    await assertLooseProductForModifiers(tx, venueId, productId, `Product with ID ${productId} not found in venue ${venueId}.`)

    // Verify group belongs to venue
    const group = await tx.modifierGroup.findFirst({ where: { id: data.modifierGroupId, venueId } })
    if (!group) {
      throw new NotFoundError(`Modifier group with ID ${data.modifierGroupId} not found in venue ${venueId}.`)
    }

    // Check if assignment exists
    const existing = await tx.productModifierGroup.findUnique({
      where: { productId_groupId: { productId, groupId: data.modifierGroupId } },
    })
    if (existing) {
      throw new BadRequestError(`Modifier group ${data.modifierGroupId} is already assigned to product ${productId}.`)
    }

    return tx.productModifierGroup.create({
      data: {
        product: { connect: { id: productId } },
        group: { connect: { id: data.modifierGroupId } },
        displayOrder: data.displayOrder ?? 0,
      },
    })
  })
}

export async function removeModifierGroupFromProduct(venueId: string, productId: string, modifierGroupId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    // Verify product belongs to venue and is not a variant (its extras belong to the parent)
    await assertLooseProductForModifiers(tx, venueId, productId, `Product with ID ${productId} not found in venue ${venueId}.`)

    const assignment = await tx.productModifierGroup.findUnique({
      where: { productId_groupId: { productId, groupId: modifierGroupId } },
    })
    if (!assignment) {
      throw new NotFoundError(`Modifier group ${modifierGroupId} is not assigned to product ${productId}.`)
    }

    await tx.productModifierGroup.delete({
      where: { productId_groupId: { productId, groupId: modifierGroupId } },
    })
  })
}

export async function reorderProducts(venueId: string, reorderData: ReorderProductsDto): Promise<Prisma.BatchPayload[]> {
  const transactions = reorderData.map(item =>
    prisma.product.updateMany({
      where: { id: item.id, venueId }, // Ensure product belongs to the venue
      data: { displayOrder: item.displayOrder },
    }),
  )

  return prisma.$transaction(transactions)
}

export interface ImportMenuData {
  mode: 'merge' | 'replace'
  categories: {
    name: string
    slug: string
    products: {
      name: string
      sku: string
      // Additive (Shopify importer). Absent ⇒ the column is not touched, on create or update: today's imports never
      // brought them. `gtin` is unique per venue — the caller must not send one another product of the venue already has.
      gtin?: string
      imageUrl?: string
      // Additive (Shopify importer): asks for «por cantidad» exactly like `trackInventory: true` below, under the SAME rules
      // (a type without stock rejects the file; a product on a recipe, or one turned off keeping its Inventory row, is kept
      // as it is and counted). The difference: it also sets this unit, and only creates the Inventory row in 0 when there is
      // none — it never touches an existing row's stock or minimum (the sheet's `trackInventory` writes `minStock`).
      inventoryByQuantity?: { unit: Unit }
      price: number
      cost?: number
      description?: string
      // Square-aligned types (new) + Legacy types (backwards compatibility)
      type?:
        | 'REGULAR'
        | 'FOOD_AND_BEV'
        | 'APPOINTMENTS_SERVICE'
        | 'CLASS'
        | 'EVENT'
        | 'DIGITAL'
        | 'DONATION'
        | 'FOOD'
        | 'BEVERAGE'
        | 'ALCOHOL'
        | 'RETAIL'
        | 'SERVICE'
        | 'OTHER'
      // Minutos del servicio con cita. OPCIONAL a propósito: hay locales que no
      // quieren fijar tiempos y el motor de reservas cae al `defaultDurationMin`
      // del venue. Ausente ≠ null: si no viene, el update NO toca la columna.
      duration?: number | null
      tags?: string[]
      allergens?: string[]
      trackInventory?: boolean
      unit?: string
      currentStock?: number
      minStock?: number
      modifierGroups?: {
        name: string
        required: boolean
        allowMultiple: boolean
        minSelections: number
        maxSelections: number | null
        modifiers: {
          name: string
          price: number
        }[]
      }[]
      // Variantes (bloque 5, V8): con PRODUCT_VARIANTS, la fila es una talla de esta familia (MANUAL). `key` = identidad entre
      // archivos (el Handle del archivo de Shopify); sin `key`, se empareja por nombre. Todo opcional a propósito: una familia
      // incompleta se rechaza por fila (nunca entra suelta) y se reporta en `filasDeFamiliaRechazadas`. Sin la función se ignora.
      family?: {
        key?: string
        name?: string
        options?: Array<{ name?: string; value?: string }>
      }
    }[]
  }[]
}

/** The row asks for «por cantidad»: the dashboard sheet's `trackInventory`, or the Shopify loader's `inventoryByQuantity`. */
function asksForQuantity(product: ImportMenuData['categories'][number]['products'][number]): boolean {
  return product.trackInventory === true || Boolean(product.inventoryByQuantity)
}

type FilaImport = ImportMenuData['categories'][number]['products'][number]

/** Lo de la TALLA que escribe la fila, igual en un re-import que en una talla recién creada (bloque 5, Codex r4 H6): precio, costo,
 *  etiquetas, alérgenos, duración, código y unidad. Nunca un campo del padre de una talla agrupada: ésos los agrega quien llama, y
 *  sólo para un producto suelto. Pura: cada escritor hace su `update` detrás de su cerco del catálogo. */
function camposDeTalla(productData: FilaImport, ctx: { porCantidad: boolean; displayOrder: number }): Prisma.ProductUncheckedUpdateInput {
  // A blank gtin is absent: '' would collide on @@unique([venueId, gtin]) with the next blank one.
  const gtin = productData.gtin?.trim()
  return {
    price: productData.price,
    cost: productData.cost ?? null,
    displayOrder: ctx.displayOrder,
    tags: productData.tags || [],
    allergens: productData.allergens || [],
    // Ausente ≠ null: re-importar precios no puede borrar la duración
    // ya configurada y desconfigurar la agenda del local.
    ...(productData.duration !== undefined ? { duration: productData.duration } : {}),
    // Sin `trackInventory` (undefined) la columna no se toca: re-importar no apaga lo que ya se contaba.
    trackInventory: ctx.porCantidad ? true : undefined,
    inventoryMethod: ctx.porCantidad ? 'QUANTITY' : undefined,
    ...(gtin ? { gtin } : {}),
    // The unit only goes with «por cantidad» (same guards as the row's `porCantidad`).
    ...(ctx.porCantidad && productData.inventoryByQuantity ? { unit: productData.inventoryByQuantity.unit } : {}),
    // Codex C5-2: the file adopts it (same id) ⇒ the owner's, no longer demo: converting the venue must not delete it.
    isDemo: false,
  }
}

/**
 * Las tallas recién creadas por el import quedan igual que si las hubiera actualizado un re-import: `camposDeTalla` + el inventario
 * de su fila (mínimo, saldo de apertura con su movimiento, unidad). Detrás del cerco del catálogo (crear tallas = CREATE).
 */
async function aplicarCamposDeTalla(
  tx: Prisma.TransactionClient,
  tallas: Array<{ productId: string; fila: FilaImport; displayOrder: number }>,
  ctx: { venueId: string; actor: CatalogActor },
): Promise<void> {
  await assertLegacyCatalogGovernanceForVenue(tx, { venueId: ctx.venueId, operation: 'CREATE', willBeVendable: true, actor: ctx.actor })
  for (const t of tallas) {
    const porCantidad = asksForQuantity(t.fila) // una talla nueva no tiene receta ni fila apagada
    const product = await tx.product.update({
      where: { id: t.productId },
      data: camposDeTalla(t.fila, { porCantidad, displayOrder: t.displayOrder }),
    })
    await inventarioDeLaFila(tx, product, t.fila, porCantidad, ctx.venueId)
  }
}

/** El inventario que pide la fila (`trackInventory` con su mínimo y saldo de apertura, o `inventoryByQuantity`). */
async function inventarioDeLaFila(
  tx: Prisma.TransactionClient,
  product: Parameters<typeof ensureQuantityInventoryRow>[1],
  productData: FilaImport,
  porCantidad: boolean,
  venueId: string,
): Promise<void> {
  // Handle inventory tracking if specified
  if (productData.trackInventory) {
    const existingInventory = await tx.inventory.findFirst({
      where: { productId: product.id },
    })
    const saldoInicial = productData.currentStock || 0
    // Fila que recibe el saldo de apertura (y su movimiento), si alguna.
    let aperturaEn: string | null = null

    if (existingInventory) {
      // 🔴 El re-import NUNCA toca `currentStock` de un inventario existente
      // (auditoría 2026-08-12): antes escribía `currentStock || 0`, así que un
      // re-import de catálogo sin ese campo BORRABA el stock de todo el venue,
      // sin InventoryMovement ni bitácora. El saldo solo se mueve por ventas,
      // conteos, recepciones y ajustes — caminos que sí dejan rastro.
      // `minimumStock` sí se actualiza: es configuración, no saldo.
      await tx.inventory.update({
        where: { id: existingInventory.id },
        data: {
          minimumStock: productData.minStock || 0,
          ...(existingInventory.isDemo ? { isDemo: false } : {}), // Codex C5-2: adopted with its product
        },
      })
      // Salvo la APERTURA PENDIENTE: la fila en 0 y sin kardex que deja
      // `ensureQuantityInventoryRow` al activar «por cantidad» antes de importar.
      // Ahí el saldo del archivo ES el inicial. La condición va en el propio UPDATE:
      // una venta que llegue entre la lectura y aquí ya dejó historia y no se pisa.
      if (saldoInicial !== 0) {
        const { count } = await tx.inventory.updateMany({
          where: { id: existingInventory.id, currentStock: 0, movements: { none: {} } },
          data: { currentStock: saldoInicial },
        })
        if (count > 0) aperturaEn = existingInventory.id
      }
    } else {
      // Create new inventory entry
      const nuevoInventario = await tx.inventory.create({
        data: {
          productId: product.id,
          venueId,
          currentStock: saldoInicial,
          minimumStock: productData.minStock || 0,
        },
      })
      if (saldoInicial !== 0) aperturaEn = nuevoInventario.id
    }

    // 🔴 El saldo de apertura deja movimiento (audit Codex xhigh
    // 2026-08-14): un inventario que nace con saldo pero sin kardex
    // hace imposible la reconciliación `saldo == apertura + Σ deltas`
    // desde el día uno. Sin saldo inicial no se inventa un movimiento
    // de cero — sería ruido.
    if (aperturaEn) {
      await tx.inventoryMovement.create({
        data: {
          inventoryId: aperturaEn,
          type: 'ADJUSTMENT',
          quantity: saldoInicial,
          previousStock: 0,
          newStock: saldoInicial,
          reason: 'Saldo inicial (importación de menú)',
        },
      })
    }
  }

  // Shopify loader, counted by piece ⇒ it must have its Inventory row (born in 0, no kardex; an existing one is never
  // touched). A product kept on its recipe or kept off gets nothing (`porCantidad` is false).
  if (porCantidad && productData.inventoryByQuantity) await ensureQuantityInventoryRow(tx, product)
}

// ── Variantes, bloque 5 (spec §0 V8, B10): el import arma familias ──

/** Una fila rechazada, con su motivo (el servicio las devuelve todas; el controlador HTTP recorta a 50). */
export interface FilaDeFamiliaRechazada {
  sku: string
  name: string
  motivo: string
}
interface FilaDeFamilia {
  p: FilaImport
  catIndex: number
  prodIndex: number
  optionNames: string[]
  values: string[]
}
interface FamiliaDelArchivo {
  key: string | null
  name: string
  filas: FilaDeFamilia[]
}
interface PlanDeFamilia {
  /** La familia MANUAL viva a la que se suman las tallas; null = se crea. */
  groupId: string | null
  /** Su contexto real (sin los valores que faltan); null si se rechazó entera antes de leerla. */
  ctx: GroupContext | null
  buenas: FilaDeFamilia[]
  malas: Array<{ fila: FilaDeFamilia; motivo: string }>
}

const claveFamilia = (s: string) => s.trim().toLocaleLowerCase('es-MX')
const juegoDeOpciones = (nombres: string[]) => nombres.map(claveFamilia).join('\u0000')
const EXTRAS_EN_FAMILIA = 'Los extras de una familia se ponen en el panel'
const FAMILIA_CON_CATALOGO_MAESTRO = 'Este negocio usa el catálogo maestro; las variantes no están disponibles aquí.'
const rechazoDe = (p: FilaImport, motivo: string): FilaDeFamiliaRechazada => ({ sku: p.sku, name: p.name, motivo })

/** El motivo (texto del error de negocio) o null si la regla pasa. */
async function motivoDe(regla: () => unknown): Promise<string | null> {
  try {
    await regla()
    return null
  } catch (e) {
    if (e instanceof AppError) return e.message
    throw e
  }
}

/** La familia de la fila con los límites del motor y del panel (nombre 1..120, 1..3 opciones, opción y valor 1..40, los de
 *  `productGroup.schema.ts`: nada importado queda sin poderse editar), o el motivo por el que la fila se rechaza ENTERA (exista o
 *  no su SKU; Codex r4 H3). Una fila de familia con extras también. */
function leerFamiliaDeFila(
  p: FilaImport,
): (Omit<FilaDeFamilia, 'p' | 'catIndex' | 'prodIndex'> & { key: string | null; name: string }) | string {
  if (p.modifierGroups?.length) return EXTRAS_EN_FAMILIA
  const name = p.family?.name?.trim() ?? ''
  if (!name) return 'La familia necesita un nombre.'
  if ([...name].length > 120) return 'El nombre de la familia puede tener hasta 120 caracteres.'
  const opciones = p.family?.options ?? []
  if (!opciones.length || opciones.length > MAX_OPTIONS) return 'La familia necesita de 1 a 3 opciones (por ejemplo Talla).'
  const optionNames: string[] = []
  const values: string[] = []
  for (const o of opciones) {
    const opcion = o.name?.trim() ?? ''
    if (!opcion) return 'El nombre de una opción está vacío.'
    if ([...opcion].length > 40) return `El nombre de la opción «${opcion}» puede tener hasta 40 caracteres.`
    if (optionNames.some(x => claveFamilia(x) === claveFamilia(opcion))) return `La opción «${opcion}» está repetida.`
    const valor = o.value?.trim() ?? ''
    if (!valor) return `Falta el valor de «${opcion}».`
    if ([...valor].length > 40) return `El valor «${valor}» de ${opcion} puede tener hasta 40 caracteres.`
    optionNames.push(opcion)
    values.push(valor)
  }
  return { key: p.family?.key?.trim() || null, name, optionNames, values }
}

const filaDeVariante = (f: FilaDeFamilia): VariantRowInput => ({
  values: f.values,
  price: f.p.price,
  cost: f.p.cost ?? null,
  sku: f.p.sku,
  gtin: f.p.gtin?.trim() || null,
  // Inventario POR FILA: S sin inventario y M con inventario en la misma familia (una talla nueva no tiene receta ni fila apagada).
  trackInventory: asksForQuantity(f.p),
})

/**
 * Lo que se haría con una familia del archivo contra la base de AHORA, sin escribir nada (salvo `lockGroup` de la que ya existe):
 * qué filas entran y por qué se rechaza cada una de las otras. Se corre ANTES de la limpieza de «reemplazar» y otra vez justo antes
 * de escribir (lo que el propio import escribió en medio, como un código o un SKU de una fila suelta, también cuenta).
 */
async function planearFamilia(
  tx: Prisma.TransactionClient,
  venueId: string,
  fam: FamiliaDelArchivo,
  createdById: string | null,
): Promise<PlanDeFamilia> {
  const malas: PlanDeFamilia['malas'] = []
  const opciones = juegoDeOpciones(fam.filas[0].optionNames)
  let buenas: FilaDeFamilia[] = []
  for (const fila of fam.filas) {
    const motivo =
      juegoDeOpciones(fila.optionNames) !== opciones
        ? 'Las filas de una familia llevan las mismas opciones, en el mismo orden.'
        : await motivoDe(() => assertAllowedGroupType((fila.p.type ?? 'FOOD') as ProductType))
    if (motivo) malas.push({ fila, motivo })
    else buenas.push(fila)
  }
  const todas = (motivo: string, groupId: string | null = null, ctx: GroupContext | null = null): PlanDeFamilia => ({
    groupId,
    ctx,
    buenas: [],
    malas: [...malas, ...buenas.map(fila => ({ fila, motivo }))],
  })
  if (!buenas.length) return todas('')
  if (await motivoDe(() => assertNoMasterCatalog(tx, venueId))) return todas(FAMILIA_CON_CATALOGO_MAESTRO)

  // Identidad entre archivos (Codex r4 H5): con `key`, SÓLO la MANUAL viva con ese identificador; sin `key`, por nombre.
  let existente: { id: string } | null
  if (fam.key) {
    existente = await tx.productGroup.findFirst({
      where: { venueId, source: ProductGroupSource.MANUAL, externalId: fam.key, deletedAt: null },
      select: { id: true },
    })
    const homonima = existente ? null : await manualGroupByName(tx, venueId, fam.name)
    if (homonima) return todas(`Ya existe otra familia «${homonima.name}»: renómbrala o usa el mismo identificador`)
  } else existente = await manualGroupByName(tx, venueId, fam.name)

  let ctx: GroupContext
  if (existente) {
    await lockGroup(tx, venueId, existente.id)
    const g = await loadGroupForWrite(tx, existente.id)
    ctx = groupContextOf(g, { trackInventory: false, createdById })
    if (juegoDeOpciones(ctx.options.map(o => o.name)) !== opciones) return todas('La familia ya existe con otras opciones', g.id, ctx)
    // El mismo texto que addVariants: nadie nace con un IVA que ya no se ofrece.
    if (!TRATAMIENTOS_OFRECIDOS_V1.includes(g.ivaTratamiento))
      return todas(
        `Esta familia tiene IVA «${ETIQUETA_DE_IVA[g.ivaTratamiento]}», que ya no se ofrece; cámbialo a 16 %, tasa 0 % o exento antes de agregar variantes.`,
        g.id,
        ctx,
      )
  } else {
    const ocupada = await familyIdentityConflict(tx, venueId, { source: ProductGroupSource.MANUAL, name: fam.name, externalId: fam.key })
    if (ocupada) return todas(ocupada)
    ctx = {
      venueId,
      groupId: '', // todavía no existe: las revisiones contra la base no encuentran combinaciones suyas
      parentName: fam.name,
      description: null,
      imageUrl: null,
      categoryId: '',
      type: ProductType.REGULAR,
      printStationId: null,
      satProductKey: null,
      satUnitKey: null,
      iva: {},
      modifierGroupIds: [],
      trackInventory: false,
      createdById,
      options: fam.filas[0].optionNames.map((name, position) => ({ id: `nueva-${position}`, name, position, values: [] })),
    }
  }

  // Se valida contra un contexto EN MEMORIA que ya trae los valores por agregar (validateVariantRow exige que existan); nada se
  // escribe antes. Una fila rechazada no le deja su valor a la familia.
  const conValores: GroupContext = {
    ...ctx,
    options: ctx.options.map((o, k) => {
      const values = [...o.values]
      for (const f of buenas)
        if (!values.some(v => claveFamilia(v.value) === claveFamilia(f.values[k])))
          values.push({ id: `por-agregar-${k}-${values.length}`, value: f.values[k], position: values.length })
      return { ...o, values }
    }),
  }
  const motivos = await checkVariantRowsAgainstDb(tx, conValores, buenas.map(filaDeVariante))
  buenas = buenas.filter((fila, i) => {
    if (motivos[i]) malas.push({ fila, motivo: motivos[i]! })
    return !motivos[i]
  })
  if (!buenas.length) return { groupId: existente?.id ?? null, ctx, buenas, malas }
  const sinCupo = optionValuesCapacity(
    ctx,
    ctx.options.map((_, k) => buenas.map(f => f.values[k])),
  )
  if (sinCupo) return todas(sinCupo, existente?.id ?? null, ctx)
  const vivas = existente ? await tx.product.count({ where: { productGroupId: existente.id, deletedAt: null } }) : 0
  if (vivas + buenas.length > MAX_VARIANTS_PER_GROUP)
    return todas(`Un producto puede tener hasta ${MAX_VARIANTS_PER_GROUP} variantes.`, existente?.id ?? null, ctx)
  return { groupId: existente?.id ?? null, ctx, buenas, malas }
}

/**
 * Escribe un plan ya revisado: crea la familia MANUAL (categoría, tipo, foto y descripción de su primera fila buena; IVA por
 * defecto; `externalId = key`) o le agrega los valores que faltan, crea las tallas (`createVariantRows`) y a cada una le aplica lo
 * demás de su fila (`aplicarCamposDeTalla`), así queda igual que si la hubiera actualizado un re-import.
 */
async function escribirFamilia(
  tx: Prisma.TransactionClient,
  venueId: string,
  fam: FamiliaDelArchivo,
  plan: PlanDeFamilia,
  categoriaDe: string[],
  actor: CatalogActor,
): Promise<{ groupId: string; nueva: boolean; ids: string[] }> {
  const createdById = actor.type === 'HUMAN' ? actor.staffId : null
  const primera = plan.buenas[0]
  let ctx: GroupContext
  let groupId = plan.groupId
  if (!groupId) {
    ;({ groupId } = await createGroupTx(tx, venueId, {
      name: fam.name,
      categoryId: categoriaDe[primera.catIndex],
      type: (primera.p.type ?? 'FOOD') as ProductType,
      imageUrl: primera.p.imageUrl ?? null,
      description: primera.p.description || null,
      ivaTratamiento: IvaTratamiento.IVA_16,
      source: ProductGroupSource.MANUAL,
      externalId: fam.key,
      options: plan.ctx!.options.map((o, k) => ({
        name: o.name,
        values: [...new Map(plan.buenas.map(f => [claveFamilia(f.values[k]), f.values[k]])).values()],
      })),
    }))
    ctx = await loadGroupContextTx(tx, groupId, { trackInventory: false, createdById })
  } else {
    ctx = plan.ctx!
    for (const f of plan.buenas) ctx = await ensureOptionValuesTx(tx, ctx, f.values)
  }
  // Foto propia sólo si es otra que la de la familia (la primera fila le dio la suya).
  const filas = plan.buenas.map(f => ({
    ...filaDeVariante(f),
    variantImageUrl: f.p.imageUrl && f.p.imageUrl !== ctx.imageUrl ? f.p.imageUrl : null,
  }))
  const ids = await createVariantRows(tx, ctx, filas, 0, actor)
  await aplicarCamposDeTalla(
    tx,
    plan.buenas.map((f, i) => ({ productId: ids[i], fila: f.p, displayOrder: f.prodIndex })),
    { venueId, actor },
  )
  if (actor.type === 'SERVICE')
    for (const productId of ids) await writeLegacyServiceProductCreationAuditForVenue(tx, { venueId, productId, actor })
  return { groupId, nueva: !plan.groupId, ids }
}

/** «Reemplazar» borra: con alguna fila de familia mala no se reemplaza NADA (Codex r5 R5-2; la transacción entera se deshace). */
const filasMalasEnReemplazo = (rechazadas: FilaDeFamiliaRechazada[]) =>
  new AppError(
    'Algunas filas de familia no se pueden importar; corrígelas y vuelve a intentar. El menú no se reemplazó.',
    400,
    true,
    'MENU_IMPORT_FAMILY_ROWS_REJECTED',
    { filasDeFamiliaRechazadas: { total: rechazadas.length, ejemplos: rechazadas } },
  )

const GOVERNANCE_DIAGNOSTIC_ROWS_MAX = 100
const GOVERNANCE_DIAGNOSTIC_SKU_SCALARS_MAX = 128

function boundedGovernanceDiagnosticSku(value: string): { sku: string; skuTruncated: boolean } {
  const scalars = Array.from(value)
  // WHY: A row cap alone still permits multi-megabyte error payloads. Slice
  // complete Unicode scalars so diagnostics stay valid JSON and bounded.
  return {
    sku: scalars.slice(0, GOVERNANCE_DIAGNOSTIC_SKU_SCALARS_MAX).join(''),
    skuTruncated: scalars.length > GOVERNANCE_DIAGNOSTIC_SKU_SCALARS_MAX,
  }
}

export async function importMenu(venueId: string, data: ImportMenuData, actor: CatalogActor) {
  let categoriesCreated = 0
  let productsCreated = 0
  let productsUpdated = 0
  let modifierGroupsCreated = 0
  let modifiersCreated = 0
  let productsArchived = 0
  let productsRestored = 0
  let productsKeptOnRecipe = 0
  let productsKeptUntracked = 0
  // Variantes: su nombre, categoría, foto y extras vienen del padre; el archivo no los pisa (se actualiza lo suyo: precio…).
  let variantesConservadas = 0
  // Variantes archivadas que el archivo trae de vuelta pero cuyo padre ya tiene 250 vivas: se quedan archivadas (tope del padre).
  let variantesSinCupo = 0
  // Ronda 1 (N2): padres que esta importación archiva (3c, en «reemplazar») o revive; su bitácora va DESPUÉS del commit.
  const familiasArchivadas: string[] = []
  const familiasRestauradas: string[] = []
  // Bloque 5 (V8): familias que el archivo crea o a las que les suma tallas (bitácora después del commit, como las de arriba).
  const familiasCreadasIds: string[] = []
  const familiasAmpliadas: string[] = []
  let tallasEnFamilias = 0
  // Tallas archivadas cuya familia (archivada) ya tiene otra viva con su identidad: no revive (Codex r5 R5-1, familia 2).
  let variantesDeFamiliaReemplazada = 0
  // Filas con `family` de un SKU que ya existía suelto: se actualiza como hoy; no se agrupa solo.
  let sueltosQueYaExistian = 0
  const rechazadas: FilaDeFamiliaRechazada[] = []
  const createdById = actor.type === 'HUMAN' ? actor.staffId : null

  // Variantes (V8): sólo con PRODUCT_VARIANTS el archivo arma familias. En Gratis, `family` se ignora sin validar y la fila entra suelta.
  const filasConFamilia = data.categories.flatMap(c => c.products).filter(p => p.family)
  const conFamilias = filasConFamilia.length > 0 && (await venueHasFeatureAccess(venueId, 'PRODUCT_VARIANTS'))
  const filasConFamiliaSinPlan = conFamilias ? 0 : filasConFamilia.length
  // El SKU de una fila de familia se guarda recortado (allocateSkus); si se buscara crudo, re-importar el mismo archivo no encontraría
  // la talla y diría «ya lo usa otro producto». Se recorta aquí, antes de cualquier búsqueda (Task 5, revisión). Edita la fila en su lugar.
  if (conFamilias) for (const p of filasConFamilia) p.sku = p.sku.trim()

  // Una clase, una cita, algo digital o un donativo no llevan existencias: se rechaza el archivo entero ANTES de escribir nada
  // (misma regla y mensaje que el alta y la edición de producto en el dashboard y en Artículos de Android/iOS).
  const sinExistencias = data.categories.flatMap(c => c.products).find(p => isNonInventoriable(p.type || 'FOOD', asksForQuantity(p)))
  if (sinExistencias)
    throw new AppError(`${NON_INVENTORIABLE_MESSAGE} (SKU ${boundedGovernanceDiagnosticSku(sinExistencias.sku).sku})`, 400)

  const importacion = prisma.$transaction(
    async tx => {
      // Orden de candados: organización (sumar tallas puede escribir el IVA de su familia) → cerco del negocio → familias → productos.
      if (conFamilias) await bloquearParaCambiarIva(tx, { venueId })
      const incomingProducts = data.categories.flatMap((category, categoryIndex) =>
        category.products.map((product, productIndex) => ({ product, categoryIndex, productIndex })),
      )
      let wouldCreate = incomingProducts
      try {
        await assertLegacyCatalogGovernanceComputedForVenue(tx, { venueId, operation: 'CREATE', actor }, async () => {
          const existingSkus =
            data.mode === 'replace' || incomingProducts.length === 0
              ? new Set<string>()
              : new Set(
                  (
                    await tx.product.findMany({
                      // Plan 5 (D3): an ARCHIVED SKU counts as a creation — restoring puts a product back on sale, like creating it.
                      where: { venueId, sku: { in: incomingProducts.map(entry => entry.product.sku) }, deletedAt: null },
                      select: { sku: true },
                    })
                  ).map(product => product.sku),
                )
          wouldCreate = data.mode === 'replace' ? incomingProducts : incomingProducts.filter(entry => !existingSkus.has(entry.product.sku))
          return wouldCreate.length > 0
        })
      } catch (error) {
        if (error instanceof AppError && error.code === 'CATALOG_GOVERNANCE_REQUIRED') {
          throw new AppError(error.message, 422, true, error.code, {
            action: 'OPEN_MASTER_CATALOG',
            total: wouldCreate.length,
            truncated: wouldCreate.length > GOVERNANCE_DIAGNOSTIC_ROWS_MAX,
            errors: wouldCreate.slice(0, GOVERNANCE_DIAGNOSTIC_ROWS_MAX).map(entry => ({
              categoryOrdinal: entry.categoryIndex + 1,
              productOrdinal: entry.productIndex + 1,
              ...boundedGovernanceDiagnosticSku(entry.product.sku),
              code: 'CATALOG_GOVERNANCE_REQUIRED',
            })),
          })
        }
        throw error
      }

      // Variantes (V8): las filas con familia se clasifican ANTES de escribir nada y antes de la limpieza de «reemplazar». La forma
      // va antes de elegir actualizar o crear (Codex r4 H3): una familia inválida rechaza la fila entera aunque su SKU exista. Una
      // fila nueva no se crea en la primera pasada: se junta por llave (`key` o el nombre normalizado) y va a la segunda.
      const fueraDeLaPrimeraPasada = new Set<FilaImport>()
      const familiasDelArchivo: FamiliaDelArchivo[] = []
      if (conFamilias) {
        const conFamilia = incomingProducts.filter(entry => entry.product.family)
        const existentes = new Map(
          (
            await tx.product.findMany({
              where: { venueId, sku: { in: conFamilia.map(entry => entry.product.sku) } },
              select: { sku: true, productGroupId: true },
              take: conFamilia.length, // único por (negocio, SKU)
            })
          ).map(p => [p.sku, p]),
        )
        const porLlave = new Map<string, FamiliaDelArchivo>()
        for (const { product: p, categoryIndex, productIndex } of conFamilia) {
          const forma = leerFamiliaDeFila(p)
          if (typeof forma === 'string') {
            rechazadas.push(rechazoDe(p, forma))
            fueraDeLaPrimeraPasada.add(p)
            continue
          }
          const ya = existentes.get(p.sku)
          if (ya) {
            if (!ya.productGroupId) sueltosQueYaExistian++
            continue // la rama «actualizar» de hoy
          }
          fueraDeLaPrimeraPasada.add(p)
          const llave = forma.key ? `key:${forma.key}` : `nombre:${claveFamilia(forma.name)}`
          let fam = porLlave.get(llave)
          if (!fam) porLlave.set(llave, (fam = { key: forma.key, name: forma.name, filas: [] }))
          fam.filas.push({ p, catIndex: categoryIndex, prodIndex: productIndex, optionNames: forma.optionNames, values: forma.values })
        }
        const nombres = new Set<string>()
        for (const fam of porLlave.values()) {
          if (nombres.has(claveFamilia(fam.name))) {
            rechazadas.push(...fam.filas.map(f => rechazoDe(f.p, 'Otra familia del archivo ya se llama así')))
            continue
          }
          nombres.add(claveFamilia(fam.name))
          const plan = await planearFamilia(tx, venueId, fam, createdById)
          rechazadas.push(...plan.malas.map(m => rechazoDe(m.fila.p, m.motivo)))
          if (plan.buenas.length) familiasDelArchivo.push({ ...fam, filas: plan.buenas })
        }
        if (data.mode === 'replace' && rechazadas.length) throw filasMalasEnReemplazo(rechazadas)
      }
      // WHY: Fence, current-SKU inspection and bounded diagnostics all finish
      // before replace archives or any menu write, so stale preflight cannot
      // reject a row created while waiting or leave a partially replaced menu.
      // REPLACE MODE (plan 5, D2): the old menu goes, but NO product is ever hard-deleted — the ones the file does not bring are
      // ARCHIVED (their sales, IVA, recipe, inventory, kardex and live payment links stay); the ones it brings are updated
      // below, and an archived SKU comes back (D3). Assignments and menus are deleted as before; modifiers too, except the ones
      // something alive still uses (P5-R15).
      if (data.mode === 'replace') {
        // Codex #8: the ARCHIVED families the file brings back (an archived variant of theirs is in it). Under the Venue fence
        // no family writer moves in between (they take it FOR SHARE first). Their category is not turned off (step 5), so the
        // family comes back visible — and one turned off by hand stays off.
        const revivir = (
          await tx.productGroup.findMany({
            where: {
              venueId,
              deletedAt: { not: null },
              products: { some: { deletedAt: { not: null }, sku: { in: incomingProducts.map(entry => entry.product.sku) } } },
            },
            select: { id: true },
            take: incomingProducts.length, // each file SKU revives at most one family
          })
        ).map(g => g.id)
        const familiaVivaOQueVuelve: Prisma.ProductGroupWhereInput = { OR: [{ deletedAt: null }, { id: { in: revivir } }] }

        // 1. Remove product-modifier links first — only LOOSE products' (variants keep their parent's; rondas 2-3, N1)
        await tx.productModifierGroup.deleteMany({ where: { product: { venueId, productGroupId: null } } })

        // 2-3. Modifiers and groups (plan 5, P5-R15): a group a live payment link (one of its extras) or a variable recipe still
        //      uses is KEPT, turned OFF with all its extras — deleting it would cascade the link's paid extra away (the link would
        //      charge less) and unlink the recipe. The rest are deleted as before (OrderItemModifier keeps its denormalized name).
        //      Codex C5-1: lock the venue's groups and extras FIRST (after the Venue fence; nothing new Order → Venue). A link or
        //      recipe being saved holds its extra/group until it commits, so this waits for it, and the deletes below — SEPARATE
        //      statements, so in READ COMMITTED they see what committed meanwhile — keep what it uses. One that arrives after the
        //      lock waits for this transaction and, if its extra was deleted, fails on the foreign key instead of losing it silently.
        await tx.$executeRaw`SELECT 1 FROM "ModifierGroup" WHERE "venueId" = ${venueId} FOR UPDATE`
        await tx.$executeRaw`SELECT 1 FROM "Modifier" m JOIN "ModifierGroup" g ON g."id" = m."groupId" WHERE g."venueId" = ${venueId} FOR UPDATE OF m`
        // Variantes (Codex #1, ronda 2): a group ANY family uses — live or archived, through the parent or its variants' links —
        // is the family's, not the file's: neither deleted nor turned off, its extras too. An archived family that a later
        // import revives comes back with its extras exactly as they were, and one turned off by hand stays off.
        const usadoPorFamilia: Prisma.ModifierGroupWhereInput = {
          OR: [{ productGroupLinks: { some: {} } }, { products: { some: { product: { productGroupId: { not: null } } } } }],
        }
        const extrasEnUso: Prisma.ModifierGroupWhereInput = {
          OR: [{ linkedRecipeLines: { some: {} } }, { modifiers: { some: { paymentLinkItems: { some: {} } } } }, usadoPorFamilia],
        }
        await tx.modifier.deleteMany({ where: { group: { venueId, NOT: extrasEnUso } } })
        await tx.modifierGroup.deleteMany({ where: { venueId, NOT: extrasEnUso } })
        await tx.modifier.updateMany({ where: { group: { venueId, NOT: usadoPorFamilia } }, data: { active: false } })
        await tx.modifierGroup.updateMany({ where: { venueId, NOT: usadoPorFamilia }, data: { active: false } })

        // 4. Archive (never delete) the products the file does not bring
        productsArchived = await archivarProductos(
          tx,
          { venueId, sku: { notIn: incomingProducts.map(entry => entry.product.sku) } },
          actor.type === 'HUMAN' ? actor.staffId : null,
          familiasArchivadas,
        )

        // 5. Menu structure. Categories (D4): the ones with no product at all are deleted; the rest keep archived products
        //    (`Product.categoryId` is RESTRICT) and are turned OFF — the loop below turns back ON the ones the file brings.
        await tx.menuCategoryAssignment.deleteMany({ where: { menu: { venueId } } })
        // Variantes (decisión 3b): `ProductGroup.categoryId` también es RESTRICT — una que referencia una familia se apaga.
        await tx.menuCategory.deleteMany({ where: { venueId, products: { none: {} }, productGroups: { none: {} } } })
        // Ronda 1 (N1): la de una familia VIVA tampoco se apaga — sus variantes no cambian de categoría con el archivo. Corre
        // después del paso 4: la familia que se quedó sin variantes ya se archivó y su categoría sí se apaga. Codex #8: la de
        // una familia que el archivo revive, tampoco (sin eso la familia vuelve invisible). La que ya estaba apagada, sigue así.
        await tx.menuCategory.updateMany({
          where: { venueId, NOT: { productGroups: { some: familiaVivaOQueVuelve } } },
          data: { active: false },
        })
        await tx.menu.deleteMany({ where: { venueId } })
      }

      // Get or create default menu for imported items
      let defaultMenu = await tx.menu.findFirst({
        where: { venueId, name: 'Main Menu' },
      })

      if (!defaultMenu) {
        defaultMenu = await tx.menu.create({
          data: {
            venueId,
            name: 'Main Menu',
            description: 'Imported menu',
            active: true,
            displayOrder: 0,
          },
        })
      }

      // Process categories and products
      const categoriaDe: string[] = [] // por índice de categoría del archivo: la de las familias que se crean en la segunda pasada
      for (const [catIndex, categoryData] of data.categories.entries()) {
        // Plan 5 (D4): by name and, when none, by slug — creating another one with the same slug would hit @@unique([venueId, slug]).
        let category =
          (await tx.menuCategory.findFirst({ where: { venueId, name: categoryData.name } })) ??
          (await tx.menuCategory.findFirst({ where: { venueId, slug: categoryData.slug } }))

        if (!category) {
          // Create new category
          category = await tx.menuCategory.create({
            data: {
              venueId,
              name: categoryData.name,
              slug: categoryData.slug,
              displayOrder: catIndex,
            },
          })
          categoriesCreated++

          // Assign category to default menu
          await tx.menuCategoryAssignment.create({
            data: {
              menuId: defaultMenu.id,
              categoryId: category.id,
              displayOrder: catIndex,
            },
          })
        } else {
          // The category the file brings is sold again: replace turned OFF the ones keeping archived products and deleted every
          // menu, and one turned off by hand may not be in the main menu. `upsert`: the file may repeat a category.
          // Codex C5-2: the file adopts it (same id), so a demo one stops being demo — otherwise converting the demo venue deletes
          // it, or fails on the RESTRICT key of a product the file put in it.
          if (!category.active || category.isDemo) {
            await tx.menuCategory.update({
              where: { id: category.id },
              data: { ...(category.active ? {} : { active: true }), ...(category.isDemo ? { isDemo: false } : {}) },
            })
          }
          if (data.mode === 'replace' || !category.active) {
            await tx.menuCategoryAssignment.upsert({
              where: { menuId_categoryId: { menuId: defaultMenu.id, categoryId: category.id } },
              create: { menuId: defaultMenu.id, categoryId: category.id, displayOrder: catIndex },
              update: {},
            })
          }
        }

        categoriaDe[catIndex] = category.id

        // Process products in this category
        for (const [prodIndex, productData] of categoryData.products.entries()) {
          if (fueraDeLaPrimeraPasada.has(productData)) continue
          // Check if product exists by SKU (merge mode)
          const existingProduct = await tx.product.findFirst({
            where: { venueId, sku: productData.sku },
            include: { recipe: { select: { id: true } }, inventory: { select: { id: true } } },
          })
          // `trackInventory` (or the Shopify loader's `inventoryByQuantity`) ⇒ el producto se cuenta «por cantidad». Antes sólo
          // se escribía la fila de Inventory y el producto no se configuraba: tenía existencias y sus ventas NO descontaban. Dos
          // excepciones, que se quedan como están y se cuentan: un producto con receta (se descontaría el producto en vez de sus
          // insumos), y uno que se apagó conservando su fila — el export del dashboard escribe `track_inventory` según si EXISTE
          // la fila, así que exportar y volver a importar lo prendería sin que nadie lo pidiera. Los que dañó la importación
          // vieja los repara su script, no esto.
          const pideCantidad = asksForQuantity(productData)
          const conReceta = existingProduct?.inventoryMethod === 'RECIPE' || Boolean(existingProduct?.recipe)
          const apagadoConFila = existingProduct?.trackInventory === false && Boolean(existingProduct?.inventory)
          const porCantidad = pideCantidad && !conReceta && !apagadoConFila
          if (pideCantidad && conReceta) productsKeptOnRecipe++
          else if (pideCantidad && apagadoConFila) productsKeptUntracked++
          // Additive fields (Shopify importer): written only when present, on create AND update — an import without them
          // (every import before them) writes exactly what it wrote before. A blank gtin is absent: '' would collide on
          // @@unique([venueId, gtin]) with the next blank one. The unit only goes with «por cantidad» (same guards as above).
          const gtin = productData.gtin?.trim()
          const shopifyImportFields: { gtin?: string; imageUrl?: string; unit?: Unit } = {
            ...(gtin ? { gtin } : {}),
            ...(productData.imageUrl ? { imageUrl: productData.imageUrl } : {}),
            ...(porCantidad && productData.inventoryByQuantity ? { unit: productData.inventoryByQuantity.unit } : {}),
          }

          // Variantes: su nombre, categoría, foto y extras vienen del padre; el archivo no los pisa.
          const grupoId = existingProduct?.productGroupId ?? null
          const deGrupo = grupoId != null

          let product
          if (existingProduct) {
            // Plan 5 (D3, founder's option A): an ARCHIVED SKU brings back the SAME product (same id, its history, recipe,
            // inventory and IVA) through this same update; the fence above already counted it as a creation.
            const archivado = Boolean(existingProduct.deletedAt)
            // Variantes (auditoría N6, ronda 3 N10): una variante archivada vuelve sólo si su padre tiene cupo (250 vivas). El padre
            // se bloquea (orden negocio → padre → variantes: el cerco del negocio ya está tomado) y, si estaba archivado, revive con
            // ella: una variante viva no puede colgar de un padre archivado que nadie puede editar.
            let restaurar = archivado
            if (grupoId && archivado) {
              const padre = await lockGroupForCleanup(tx, venueId, grupoId)
              const vivas = await tx.product.count({ where: { productGroupId: grupoId, deletedAt: null } })
              // Bloque 5 (Codex r5 R5-1, familia 2): una familia archivada cuya identidad (SHOPIFY o MANUAL por su llave; MANUAL
              // también por su nombre) ya tiene otra viva no revive: la talla se queda archivada y la fila no aborta el import.
              const reemplazada =
                padre.deletedAt != null &&
                (await familyIdentityConflict(
                  tx,
                  venueId,
                  { source: padre.source, name: padre.name, externalId: padre.externalId },
                  grupoId,
                )) !== null
              restaurar = !reemplazada && vivas < MAX_VARIANTS_PER_GROUP
              if (reemplazada) variantesDeFamiliaReemplazada++
              else if (!restaurar) variantesSinCupo++
              else if (padre.deletedAt) {
                await tx.productGroup.update({ where: { id: grupoId }, data: { deletedAt: null, deletedBy: null } })
                familiasRestauradas.push(grupoId)
              }
            }
            if (restaurar) {
              // P5-R16: the pre-count may have seen this SKU alive and another request archived it since (archiving does not
              // take the Venue fence). Restoring = activating ⇒ ask the fence again, in this transaction, before writing.
              // F5-2: redundant in replace by construction (its pre-count already counts every file SKU as a creation); it is
              // here for merge's race.
              await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'ACTIVATE', willBeVendable: true, actor })
            }
            // Update existing product: lo de la talla (`camposDeTalla`, lo mismo que recibe una talla nueva) y, sólo si es suelto, lo
            // que en una talla agrupada es del padre.
            product = await tx.product.update({
              where: { id: existingProduct.id },
              data: {
                ...(deGrupo
                  ? {}
                  : {
                      name: productData.name,
                      description: productData.description || null,
                      type: productData.type || 'FOOD',
                      categoryId: category.id,
                      ...(productData.imageUrl ? { imageUrl: productData.imageUrl } : {}),
                    }),
                ...camposDeTalla(productData, { porCantidad, displayOrder: prodIndex }),
                ...(restaurar ? { deletedAt: null, deletedBy: null, active: true } : {}),
              },
            })
            await inventarioDeLaFila(tx, product, productData, porCantidad, venueId)
            productsUpdated++
            if (restaurar) productsRestored++
            if (deGrupo) variantesConservadas++
          } else {
            // Create new product
            product = await tx.product.create({
              data: {
                venueId,
                createdById: actor.type === 'HUMAN' ? actor.staffId : null,
                name: productData.name,
                sku: productData.sku,
                price: productData.price,
                cost: productData.cost ?? null,
                description: productData.description || null,
                type: productData.type || 'FOOD',
                categoryId: category.id,
                displayOrder: prodIndex,
                tags: productData.tags || [],
                allergens: productData.allergens || [],
                // Nulo es válido: el motor de reservas cae al default del venue.
                duration: productData.duration ?? null,
                trackInventory: porCantidad,
                inventoryMethod: inventoryMethodForNewProduct(porCantidad, undefined),
                ...shopifyImportFields,
              },
            })
            if (actor.type === 'SERVICE') {
              await writeLegacyServiceProductCreationAuditForVenue(tx, { venueId, productId: product.id, actor })
            }
            productsCreated++
            await inventarioDeLaFila(tx, product, productData, porCantidad, venueId)
          }

          // Handle modifier groups — a variant's extras are its parent's: the file does not touch them (counted above)
          if (!deGrupo && productData.modifierGroups && productData.modifierGroups.length > 0) {
            // Remove existing modifier group assignments for this product
            await tx.productModifierGroup.deleteMany({
              where: { productId: product.id },
            })

            for (const [groupIndex, groupData] of productData.modifierGroups.entries()) {
              // Check if modifier group exists by name
              let modifierGroup = await tx.modifierGroup.findFirst({
                where: { venueId, name: groupData.name },
              })

              if (!modifierGroup) {
                // Create new modifier group
                modifierGroup = await tx.modifierGroup.create({
                  data: {
                    venueId,
                    name: groupData.name,
                    required: groupData.required,
                    allowMultiple: groupData.allowMultiple,
                    minSelections: groupData.minSelections,
                    maxSelections: groupData.maxSelections,
                  },
                })
                modifierGroupsCreated++
              } else if (data.mode === 'replace') {
                // Plan 5 (P5-R15): in replace the file is the truth. A reused group (replace kept it because a live link or a
                // recipe uses it) keeps its id and references, and takes the file's selection rules and comes back ON.
                await tx.modifierGroup.update({
                  where: { id: modifierGroup.id },
                  data: {
                    active: true,
                    required: groupData.required,
                    allowMultiple: groupData.allowMultiple,
                    minSelections: groupData.minSelections,
                    maxSelections: groupData.maxSelections,
                    ...(modifierGroup.isDemo ? { isDemo: false } : {}), // Codex C5-2: adopted by the file
                  },
                })
              } else if (!modifierGroup.active || modifierGroup.isDemo) {
                // Merge keeps today's behaviour (an existing group is not overwritten); it only turns back ON one that was off, and
                // (Codex C5-2) a demo one the file adopts stops being demo, or converting the venue would delete it with its links.
                await tx.modifierGroup.update({
                  where: { id: modifierGroup.id },
                  data: { active: true, ...(modifierGroup.isDemo ? { isDemo: false } : {}) },
                })
              }

              // Assign modifier group to product
              await tx.productModifierGroup.create({
                data: {
                  productId: product.id,
                  groupId: modifierGroup.id,
                  displayOrder: groupIndex,
                },
              })

              // Handle modifiers
              for (const modifierData of groupData.modifiers) {
                // Check if modifier exists by name in this group
                const existingModifier = await tx.modifier.findFirst({
                  where: { groupId: modifierGroup.id, name: modifierData.name },
                })

                if (!existingModifier) {
                  // Create new modifier
                  await tx.modifier.create({
                    data: {
                      groupId: modifierGroup.id,
                      name: modifierData.name,
                      price: modifierData.price,
                    },
                  })
                  modifiersCreated++
                } else if (data.mode === 'replace') {
                  // Plan 5 (P5-R15): replace applies the file's price to the reused extra (same id: live links and past sales keep
                  // pointing at it). Without it every POS keeps charging the old price (the server prices from Modifier.price).
                  await tx.modifier.update({
                    where: { id: existingModifier.id },
                    data: { active: true, price: modifierData.price, ...(existingModifier.isDemo ? { isDemo: false } : {}) },
                  })
                } else if (!existingModifier.active || existingModifier.isDemo) {
                  // Merge keeps today's behaviour (an existing extra is not overwritten); it only turns back ON one that was off, and
                  // (Codex C5-2) a demo one the file adopts stops being demo.
                  await tx.modifier.update({
                    where: { id: existingModifier.id },
                    data: { active: true, ...(existingModifier.isDemo ? { isDemo: false } : {}) },
                  })
                }
              }
            }
          }
        }
      }

      // Variantes (V8), segunda pasada, por llave en el orden del archivo: se vuelve a revisar cada familia contra la base de ahora
      // (las filas sueltas de este mismo archivo ya se escribieron) y se escribe lo que entra. En «reemplazar», cualquier rechazo
      // nuevo deshace TODO (400); en «combinar», la fila se reporta y las buenas entran.
      for (const fam of familiasDelArchivo) {
        const plan = await planearFamilia(tx, venueId, fam, createdById)
        const malas = plan.malas.map(m => rechazoDe(m.fila.p, m.motivo))
        if (malas.length && data.mode === 'replace') throw filasMalasEnReemplazo(malas)
        rechazadas.push(...malas)
        if (!plan.buenas.length) continue
        const escrito = await escribirFamilia(tx, venueId, fam, plan, categoriaDe, actor)
        ;(escrito.nueva ? familiasCreadasIds : familiasAmpliadas).push(escrito.groupId)
        tallasEnFamilias += escrito.ids.length
        productsCreated += escrito.ids.length
      }

      // Ronda 1 (N1): «reemplazar» borró todos los menús; la categoría de una familia viva sigue prendida, pero sin lugar en el
      // menú el POS no la ve. Vuelve al menú principal, después de las del archivo (las que el archivo trae ya están). Por
      // páginas de familias, sin tope que deje alguna fuera.
      if (data.mode === 'replace') {
        for (let desde = ''; ; ) {
          const familias = await tx.productGroup.findMany({
            where: { venueId, deletedAt: null, category: { active: true }, id: { gt: desde } },
            select: { id: true, categoryId: true },
            orderBy: { id: 'asc' },
            take: 500,
          })
          if (!familias.length) break
          await tx.menuCategoryAssignment.createMany({
            data: [...new Set(familias.map(f => f.categoryId))].map(categoryId => ({
              menuId: defaultMenu.id,
              categoryId,
              displayOrder: data.categories.length,
            })),
            skipDuplicates: true,
          })
          if (familias.length < 500) break
          desde = familias[familias.length - 1].id
        }
      }
    },
    {
      // Extended timeout for large menu imports (2 minutes)
      timeout: 120000,
      maxWait: 130000,
    },
  )
  // El trigger del escritor único ganó una carrera (un producto se agrupó mientras se importaba): 409, nunca 500.
  await importacion.catch(rechazoDelEscritorUnico)
  // Ronda 1 (N2): los padres que la importación archivó (se quedaron sin variantes) o revivió, cada uno con su renglón.
  const staffIdDelActor = actor.type === 'HUMAN' ? actor.staffId : undefined
  for (const [ids, action] of [
    [familiasArchivadas, 'PRODUCT_GROUP_ARCHIVED'],
    [familiasRestauradas, 'PRODUCT_GROUP_RESTORED'],
    [familiasCreadasIds, 'PRODUCT_GROUP_CREATED'],
    [familiasAmpliadas, 'PRODUCT_GROUP_VARIANTS_ADDED'],
  ] as const) {
    for (const groupId of ids) {
      void logAction({
        venueId,
        staffId: staffIdDelActor,
        action,
        entity: 'ProductGroup',
        entityId: groupId,
        data: { reason: 'MENU_IMPORT', mode: data.mode },
      })
    }
  }

  logAction({
    venueId,
    action: 'MENU_IMPORTED',
    entity: 'Menu',
    staffId: actor.type === 'HUMAN' ? actor.staffId : undefined,
    data: {
      mode: data.mode,
      categories: categoriesCreated,
      products: productsCreated + productsUpdated,
      productsArchived,
      productsRestored,
      productsKeptOnRecipe,
      productsKeptUntracked,
      variantesConservadas,
      variantesSinCupo,
      familiasCreadas: familiasCreadasIds.length,
      tallasEnFamilias,
      filasConFamiliaSinPlan,
      sueltosQueYaExistian,
      variantesDeFamiliaReemplazada,
      filasDeFamiliaRechazadas: rechazadas.length,
    },
  })

  return {
    success: true,
    message: 'Menu imported successfully',
    stats: {
      categories: categoriesCreated,
      products: productsCreated + productsUpdated,
      modifierGroups: modifierGroupsCreated,
      modifiers: modifiersCreated,
      // Plan 5: nuevos y aditivos (los clientes de hoy los ignoran)
      productsArchived,
      productsRestored,
      // Filas con `trackInventory` cuyo producto se descuenta por receta: no se convirtieron.
      productsKeptOnRecipe,
      // Filas con `trackInventory` de un producto que se apagó conservando su inventario: no se volvieron a prender.
      productsKeptUntracked,
      // Variantes: su nombre, categoría, foto y extras vienen del padre; el archivo no los pisa.
      variantesConservadas,
      // Variantes archivadas que no volvieron porque su padre ya tiene 250 vivas.
      variantesSinCupo,
      // Bloque 5 (V8): familias MANUAL que creó el archivo y tallas nuevas que entraron a una familia (nueva o existente).
      familiasCreadas: familiasCreadasIds.length,
      tallasEnFamilias,
      // Filas con familia en un negocio sin PRODUCT_VARIANTS: entraron sueltas.
      filasConFamiliaSinPlan,
      // Filas con familia de un SKU que ya existía suelto: se actualizó, no se agrupó.
      sueltosQueYaExistian,
      // Tallas archivadas que no volvieron porque su familia ya tiene otra viva con su identidad.
      variantesDeFamiliaReemplazada,
      // TODAS aquí; el controlador HTTP recorta `ejemplos` a 50.
      filasDeFamiliaRechazadas: { total: rechazadas.length, ejemplos: rechazadas },
    },
  }
}
