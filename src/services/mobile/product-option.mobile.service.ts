/**
 * Mobile Product Option Service
 *
 * Product option (variant) management for iOS/Android POS apps.
 * Handles CRUD for product options like "Tamaño", "Color" with their values.
 */

import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import prisma from '../../utils/prismaClient'

// ============================================================================
// TYPES
// ============================================================================

interface CreateOptionValue {
  value: string
  sortOrder?: number
}

interface CreateOptionParams {
  venueId: string
  staffId: string
  name: string
  values: CreateOptionValue[]
}

interface UpdateOptionParams {
  venueId: string
  staffId: string
  optionId: string
  name?: string
  values?: CreateOptionValue[]
}

// ============================================================================
// LIST OPTIONS
// ============================================================================

/**
 * List all product options for a venue with their values.
 */
export async function listProductOptions(venueId: string) {
  const options = await prisma.productOption.findMany({
    where: { venueId },
    include: {
      values: {
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return options.map(formatOption)
}

// ============================================================================
// CREATE OPTION
// ============================================================================

/**
 * Create a new product option with its values.
 */
export async function createProductOption(params: CreateOptionParams) {
  const { venueId, staffId, name, values } = params

  if (!name || !name.trim()) {
    throw new BadRequestError('name es requerido')
  }

  if (!values || values.length === 0) {
    throw new BadRequestError('Se requiere al menos un valor para la opción')
  }

  // Check for duplicate option name in same venue
  const existing = await prisma.productOption.findFirst({
    where: {
      venueId,
      name: { equals: name.trim(), mode: 'insensitive' },
    },
  })

  if (existing) {
    throw new BadRequestError(`Ya existe una opción con el nombre "${name.trim()}"`)
  }

  const option = await prisma.productOption.create({
    data: {
      venueId,
      name: name.trim(),
      values: {
        create: values.map((v, index) => ({
          value: v.value.trim(),
          sortOrder: v.sortOrder ?? index,
        })),
      },
    },
    include: {
      values: {
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'PRODUCT_OPTION_CREATED',
    entity: 'ProductOption',
    entityId: option.id,
    data: { name: option.name, valueCount: values.length, source: 'MOBILE' },
  })

  return formatOption(option)
}

// ============================================================================
// UPDATE OPTION
// ============================================================================

/**
 * Update a product option and optionally replace its values.
 */
export async function updateProductOption(params: UpdateOptionParams) {
  const { venueId, staffId, optionId, name, values } = params

  const option = await prisma.productOption.findFirst({
    where: { id: optionId, venueId },
  })

  if (!option) {
    throw new NotFoundError('Opción de producto no encontrada')
  }

  // Check for duplicate name if name is being changed
  if (name && name.trim() !== option.name) {
    const existing = await prisma.productOption.findFirst({
      where: {
        venueId,
        name: { equals: name.trim(), mode: 'insensitive' },
        id: { not: optionId },
      },
    })

    if (existing) {
      throw new BadRequestError(`Ya existe una opción con el nombre "${name.trim()}"`)
    }
  }

  // If values are provided, delete existing and create new ones
  if (values && values.length > 0) {
    await prisma.productOptionValue.deleteMany({
      where: { optionId },
    })
  }

  const updated = await prisma.productOption.update({
    where: { id: optionId },
    data: {
      ...(name ? { name: name.trim() } : {}),
      ...(values && values.length > 0
        ? {
            values: {
              create: values.map((v, index) => ({
                value: v.value.trim(),
                sortOrder: v.sortOrder ?? index,
              })),
            },
          }
        : {}),
    },
    include: {
      values: {
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'PRODUCT_OPTION_UPDATED',
    entity: 'ProductOption',
    entityId: option.id,
    data: { name: updated.name, source: 'MOBILE' },
  })

  return formatOption(updated)
}

// ============================================================================
// DELETE OPTION
// ============================================================================

/**
 * Delete a product option and all its values (cascade).
 */
export async function deleteProductOption(optionId: string, venueId: string, staffId: string) {
  const option = await prisma.productOption.findFirst({
    where: { id: optionId, venueId },
  })

  if (!option) {
    throw new NotFoundError('Opción de producto no encontrada')
  }

  await prisma.productOption.delete({
    where: { id: optionId },
  })

  logAction({
    staffId,
    venueId,
    action: 'PRODUCT_OPTION_DELETED',
    entity: 'ProductOption',
    entityId: option.id,
    data: { name: option.name, source: 'MOBILE' },
  })

  return { id: optionId, deleted: true }
}

// ============================================================================
// HELPERS
// ============================================================================

function formatOption(option: any) {
  return {
    id: option.id,
    venueId: option.venueId,
    name: option.name,
    values: option.values
      ? option.values.map((v: any) => ({
          id: v.id,
          value: v.value,
          sortOrder: v.sortOrder,
        }))
      : [],
    createdAt: option.createdAt.toISOString(),
  }
}
