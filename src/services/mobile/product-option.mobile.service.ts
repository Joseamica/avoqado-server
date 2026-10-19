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

/** Who asked, for the audit trail: the POS (default) or the dashboard's option library. */
type OptionSource = 'MOBILE' | 'DASHBOARD'

interface CreateOptionParams {
  venueId: string
  staffId: string
  name: string
  values: CreateOptionValue[]
  source?: OptionSource
}

interface UpdateOptionParams {
  venueId: string
  staffId: string
  optionId: string
  name?: string
  values?: CreateOptionValue[]
  source?: OptionSource
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
  const { venueId, staffId, name, values, source = 'MOBILE' } = params

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

  const normalizedValues = normalizeOptionValues(values)

  const option = await prisma.productOption.create({
    data: {
      venueId,
      name: name.trim(),
      values: {
        create: normalizedValues,
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
    data: { name: option.name, valueCount: values.length, source },
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
  const { venueId, staffId, optionId, name, values, source = 'MOBILE' } = params

  // Validar y normalizar ANTES de tocar nada (auditoría R7): con `values: "x"` antes se borraban todos los valores y luego
  // tronaba en `.map`. `null`/ausente = no cambiar los valores (el POS puede renombrar sólo la opción, auditoría N7).
  if (values != null && !Array.isArray(values)) {
    throw new BadRequestError('Los valores deben ser una lista')
  }
  const normalizedValues = values ? normalizeOptionValues(values) : []

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

  // Reemplazo todo o nada: si el alta de los nuevos falla, los valores de antes siguen ahí. Una lista que queda vacía al
  // normalizar (sólo valores en blanco) no reemplaza nada, igual que una lista vacía.
  const updated = await prisma.$transaction(async tx => {
    // Candado de la opción: dos ediciones simultáneas se forman en fila. Sin él, el borrado de la segunda no ve los valores
    // que la primera acaba de crear y quedan los dos juegos.
    const fila = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ProductOption" WHERE id = ${optionId} AND "venueId" = ${venueId} FOR UPDATE`
    if (!fila.length) throw new NotFoundError('Opción de producto no encontrada')
    if (normalizedValues.length) {
      await tx.productOptionValue.deleteMany({ where: { optionId } })
      await tx.productOptionValue.createMany({ data: normalizedValues.map(v => ({ optionId, ...v })) })
    }
    if (name?.trim()) {
      await tx.productOption.update({ where: { id: optionId }, data: { name: name.trim() } })
    }
    return tx.productOption.findUniqueOrThrow({
      where: { id: optionId },
      include: { values: { orderBy: { sortOrder: 'asc' } } },
    })
  })

  logAction({
    staffId,
    venueId,
    action: 'PRODUCT_OPTION_UPDATED',
    entity: 'ProductOption',
    entityId: option.id,
    data: { name: updated.name, source },
  })

  return formatOption(updated)
}

// ============================================================================
// DELETE OPTION
// ============================================================================

/**
 * Delete a product option and all its values (cascade).
 */
export async function deleteProductOption(optionId: string, venueId: string, staffId: string, source: OptionSource = 'MOBILE') {
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
    data: { name: option.name, source },
  })

  return { id: optionId, deleted: true }
}

// ============================================================================
// HELPERS
// ============================================================================

/** Acepta todos los formatos del POS: ["S"], [{ value: "S" }], [{ name: "S" }] o mezclados. Los vacíos se descartan. */
function normalizeOptionValues(values: unknown[]): Array<{ value: string; sortOrder: number }> {
  return values
    .map((v: any, index: number) => {
      let val: string
      if (typeof v === 'string') {
        val = v
      } else if (v && typeof v === 'object') {
        val = v.value || v.name || v.label || String(v)
      } else {
        val = String(v ?? '')
      }
      return {
        value: (val || '').trim(),
        sortOrder: typeof v === 'object' && v !== null ? (v.sortOrder ?? index) : index,
      }
    })
    .filter(v => v.value.length > 0)
}

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
