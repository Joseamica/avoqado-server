import prisma from '../../utils/prismaClient'
import { Menu, MenuCategory, Prisma } from '@prisma/client'
import { CreateMenuCategoryDto, UpdateMenuCategoryDto, ReorderMenuCategoriesDto } from '../../schemas/dashboard/menuCategory.schema'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import { generateSlug } from '../../utils/slugify'

export async function getMenus(venueId: string): Promise<Menu[]> {
  return prisma.menu.findMany({
    where: { venueId },
    include: {
      categories: {
        orderBy: {
          displayOrder: 'asc',
        },
        include: {
          category: {
            include: {
              products: true,
            },
          },
        },
      },
    },
    orderBy: {
      displayOrder: 'asc',
    },
  })
}

export async function createMenuCategory(venueId: string, data: CreateMenuCategoryDto): Promise<MenuCategory> {
  const slug = generateSlug(data.name)

  const existingCategory = await prisma.menuCategory.findUnique({
    where: { venueId_slug: { venueId, slug } },
  })

  if (existingCategory) {
    throw new BadRequestError(`A category with the name '${data.name}' already exists in this venue.`)
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
  }

  if (data.parentId) {
    // Only connect if parentId is a non-empty string
    createData.parent = { connect: { id: data.parentId } }
  }
  // If data.parentId is null or undefined, it's omitted, Prisma won't try to set it to null.

  // Handle availableDays specifically for null case
  if (data.availableDays === null) {
    createData.availableDays = undefined // Treat null as 'not set' for create
  } else if (data.availableDays) {
    createData.availableDays = data.availableDays
  }

  return prisma.menuCategory.create({ data: createData })
}

export async function getMenuCategoryById(venueId: string, categoryId: string): Promise<MenuCategory> {
  const category = await prisma.menuCategory.findUnique({
    where: { id: categoryId, venueId },
    include: { children: true, products: true }, // Include children and products as needed
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
      children: {
        // Recursively fetch children
        orderBy: { displayOrder: 'asc' },
        include: { children: true },
      },
      products: { orderBy: { displayOrder: 'asc' } },
    },
  })
}

export async function updateMenuCategory(venueId: string, categoryId: string, data: UpdateMenuCategoryDto): Promise<MenuCategory> {
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
  if (data.availableFrom !== undefined) updateData.availableFrom = data.availableFrom
  if (data.availableUntil !== undefined) updateData.availableUntil = data.availableUntil

  // Handle availableDays specifically for null and array cases in update
  if (data.hasOwnProperty('availableDays')) {
    if (data.availableDays === null) {
      updateData.availableDays = { set: [] } // Explicitly set to empty array if DTO provides null
    } else if (Array.isArray(data.availableDays)) {
      updateData.availableDays = data.availableDays // This implies { set: data.availableDays }
    }
    // If data.availableDays is undefined (but key was present), Prisma treats it as no-op for this field.
  }

  // Handle parentId explicitly
  if (data.hasOwnProperty('parentId')) {
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

  return prisma.menuCategory.update({
    where: { id: categoryId, venueId }, // Ensure update is on the correct venue's category
    data: updateData,
  })
}

export async function deleteMenuCategory(venueId: string, categoryId: string): Promise<MenuCategory> {
  const category = await prisma.menuCategory.findUnique({
    where: { id: categoryId, venueId },
    include: { children: true },
  })

  if (!category) {
    throw new NotFoundError(`Menu category with ID ${categoryId} not found in venue ${venueId}.`)
  }

  // Basic check: prevent deletion if category has products or children, or implement cascading logic
  // For now, let Prisma's onDelete Cascade handle it if configured, or throw error
  const productCount = await prisma.product.count({ where: { categoryId } })
  if (productCount > 0) {
    throw new BadRequestError('Cannot delete category: it still contains products. Please move or delete them first.')
  }
  if (category.children && category.children.length > 0) {
    throw new BadRequestError('Cannot delete category: it still has sub-categories. Please delete them first.')
  }

  return prisma.menuCategory.delete({ where: { id: categoryId } })
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
  return prisma.$transaction(transactions)
}
