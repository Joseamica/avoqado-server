import { Product, Prisma, ProductType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'

export interface CreateProductDto {
  name: string
  description?: string
  price: number
  type: ProductType
  imageUrl?: string
  sku: string
  categoryId: string
  modifierGroupIds?: string[]
}

export interface UpdateProductDto {
  name?: string
  description?: string
  price?: number
  type?: ProductType
  imageUrl?: string | null
  sku?: string
  categoryId?: string
  modifierGroupIds?: string[]
  active?: boolean
  displayOrder?: number
}

export interface ReorderProductsDto {
  id: string
  displayOrder: number
}

/**
 * Get all products for a venue (excluding soft-deleted)
 */
export async function getProducts(venueId: string, options?: { includeRecipe?: boolean; categoryId?: string }): Promise<Product[]> {
  const products = await prisma.product.findMany({
    where: {
      venueId,
      deletedAt: null, // Exclude soft-deleted products
      ...(options?.categoryId && { categoryId: options.categoryId }),
    },
    include: {
      category: true,
      inventory: true, // ✅ Include simple stock inventory
      modifierGroups: {
        include: {
          group: true,
        },
      },
      ...(options?.includeRecipe && {
        recipe: {
          include: {
            lines: {
              include: {
                rawMaterial: true,
              },
            },
          },
        },
      }),
    },
    orderBy: { displayOrder: 'asc' },
  })

  return products
}

/**
 * Get a single product by ID (excluding soft-deleted)
 */
export async function getProduct(venueId: string, productId: string): Promise<Product | null> {
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      venueId,
      deletedAt: null, // Exclude soft-deleted products
    },
    include: {
      category: true,
      modifierGroups: {
        include: {
          group: {
            include: {
              modifiers: true,
            },
          },
        },
        orderBy: { displayOrder: 'asc' },
      },
    },
  })

  return product
}

/**
 * Create a new product
 */
export async function createProduct(venueId: string, productData: CreateProductDto): Promise<Product> {
  const { modifierGroupIds, ...productFields } = productData

  // Get the next display order
  const maxOrder = await prisma.product.findFirst({
    where: { venueId },
    orderBy: { displayOrder: 'desc' },
    select: { displayOrder: true },
  })

  const displayOrder = (maxOrder?.displayOrder || 0) + 1

  const product = await prisma.product.create({
    data: {
      name: productFields.name,
      description: productFields.description,
      price: productFields.price,
      type: productFields.type,
      imageUrl: productFields.imageUrl,
      sku: productFields.sku,
      categoryId: productFields.categoryId,
      venueId,
      displayOrder,
      active: true,
      modifierGroups: modifierGroupIds?.length
        ? {
            create: modifierGroupIds.map((groupId, index) => ({
              groupId,
              displayOrder: index,
            })),
          }
        : undefined,
    },
    include: {
      category: true,
      modifierGroups: {
        include: {
          group: true,
        },
      },
    },
  })

  return product
}

/**
 * Update an existing product
 */
export async function updateProduct(venueId: string, productId: string, productData: UpdateProductDto): Promise<Product> {
  const { modifierGroupIds, ...productFields } = productData

  // First check if product exists and belongs to venue
  const existingProduct = await prisma.product.findFirst({
    where: { id: productId, venueId },
  })

  if (!existingProduct) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  // If modifierGroupIds is provided, update the relationships
  const updateData: any = productFields

  if (modifierGroupIds !== undefined) {
    // Validate that all provided modifier group IDs exist and belong to the venue
    if (modifierGroupIds.length > 0) {
      const validModifierGroups = await prisma.modifierGroup.findMany({
        where: {
          id: { in: modifierGroupIds },
          venueId,
        },
        select: { id: true },
      })

      const validGroupIds = validModifierGroups.map(group => group.id)
      const invalidGroupIds = modifierGroupIds.filter(id => !validGroupIds.includes(id))

      if (invalidGroupIds.length > 0) {
        throw new AppError(`Invalid modifier group IDs: ${invalidGroupIds.join(', ')}`, 400)
      }

      updateData.modifierGroups = {
        deleteMany: {}, // Remove all existing relationships
        create: validGroupIds.map((groupId, index) => ({
          groupId,
          displayOrder: index,
        })),
      }
    } else {
      // No modifier groups selected, just remove all existing relationships
      updateData.modifierGroups = {
        deleteMany: {}, // Remove all existing relationships
      }
    }
  }

  const product = await prisma.product.update({
    where: { id: productId },
    data: updateData,
    include: {
      category: true,
      modifierGroups: {
        include: {
          group: true,
        },
      },
    },
  })

  return product
}

/**
 * Delete a product (soft delete)
 */
export async function deleteProduct(venueId: string, productId: string, userId: string): Promise<void> {
  // First check if product exists and belongs to venue (and is not already deleted)
  const existingProduct = await prisma.product.findFirst({
    where: {
      id: productId,
      venueId,
      deletedAt: null, // Ensure product is not already soft-deleted
    },
  })

  if (!existingProduct) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  // Soft delete: set deletedAt and deletedBy instead of physically removing the record
  await prisma.product.update({
    where: { id: productId },
    data: {
      deletedAt: new Date(),
      deletedBy: userId,
    },
  })
}

/**
 * Reorder products by updating their display order
 */
export async function reorderProducts(venueId: string, reorderData: ReorderProductsDto[]): Promise<Prisma.BatchPayload[]> {
  const transactions = reorderData.map(item =>
    prisma.product.updateMany({
      where: { id: item.id, venueId },
      data: { displayOrder: item.displayOrder },
    }),
  )

  return prisma.$transaction(transactions)
}

/**
 * Assign a modifier group to a product
 */
export async function assignModifierGroupToProduct(
  venueId: string,
  productId: string,
  data: { modifierGroupId: string; displayOrder?: number },
): Promise<any> {
  // Check if product exists and belongs to venue
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  // Check if modifier group exists and belongs to venue
  const modifierGroup = await prisma.modifierGroup.findFirst({
    where: { id: data.modifierGroupId, venueId },
  })

  if (!modifierGroup) {
    throw new AppError(`Modifier group with ID ${data.modifierGroupId} not found in venue ${venueId}`, 404)
  }

  // Get next display order if not provided
  let displayOrder = data.displayOrder
  if (displayOrder === undefined) {
    const maxOrder = await prisma.productModifierGroup.findFirst({
      where: { productId },
      orderBy: { displayOrder: 'desc' },
      select: { displayOrder: true },
    })
    displayOrder = (maxOrder?.displayOrder || 0) + 1
  }

  const assignment = await prisma.productModifierGroup.create({
    data: {
      productId,
      groupId: data.modifierGroupId,
      displayOrder,
    },
    include: {
      group: true,
    },
  })

  return assignment
}

/**
 * Remove a modifier group from a product
 */
export async function removeModifierGroupFromProduct(venueId: string, productId: string, modifierGroupId: string): Promise<void> {
  // Check if product exists and belongs to venue
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  await prisma.productModifierGroup.deleteMany({
    where: {
      productId,
      groupId: modifierGroupId,
    },
  })
}
