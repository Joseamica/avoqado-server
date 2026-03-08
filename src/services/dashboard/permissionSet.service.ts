import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { validatePermissionFormat } from '../../lib/permissions'
import logger from '@/config/logger'
import type { CreatePermissionSetInput, UpdatePermissionSetInput } from '../../schemas/dashboard/permissionSet.schema'

const MAX_PERMISSION_SETS_PER_VENUE = 20

export async function getAll(venueId: string) {
  return prisma.permissionSet.findMany({
    where: { venueId },
    include: {
      _count: { select: { staffVenues: true } },
    },
    orderBy: { name: 'asc' },
  })
}

export async function getById(venueId: string, id: string) {
  const permissionSet = await prisma.permissionSet.findFirst({
    where: { id, venueId },
    include: {
      _count: { select: { staffVenues: true } },
    },
  })

  if (!permissionSet) {
    throw new NotFoundError('Conjunto de permisos no encontrado')
  }

  return permissionSet
}

export async function create(venueId: string, data: CreatePermissionSetInput, createdBy: string) {
  // Check venue limit
  const count = await prisma.permissionSet.count({ where: { venueId } })
  if (count >= MAX_PERMISSION_SETS_PER_VENUE) {
    throw new BadRequestError(`No se pueden crear más de ${MAX_PERMISSION_SETS_PER_VENUE} conjuntos de permisos por venue`)
  }

  // Validate all permissions
  validatePermissions(data.permissions)

  const permissionSet = await prisma.permissionSet.create({
    data: {
      venueId,
      name: data.name,
      description: data.description,
      permissions: data.permissions,
      color: data.color,
      createdBy,
    },
    include: {
      _count: { select: { staffVenues: true } },
    },
  })

  logger.info('Permission set created', {
    venueId,
    permissionSetId: permissionSet.id,
    name: data.name,
    permissionsCount: data.permissions.length,
    createdBy,
  })

  return permissionSet
}

export async function update(venueId: string, id: string, data: UpdatePermissionSetInput) {
  // Verify it exists and belongs to the venue
  const existing = await prisma.permissionSet.findFirst({
    where: { id, venueId },
  })

  if (!existing) {
    throw new NotFoundError('Conjunto de permisos no encontrado')
  }

  // Validate permissions if provided
  if (data.permissions) {
    validatePermissions(data.permissions)
  }

  const permissionSet = await prisma.permissionSet.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.permissions !== undefined && { permissions: data.permissions }),
      ...(data.color !== undefined && { color: data.color }),
    },
    include: {
      _count: { select: { staffVenues: true } },
    },
  })

  logger.info('Permission set updated', {
    venueId,
    permissionSetId: id,
    name: permissionSet.name,
  })

  return permissionSet
}

export async function remove(venueId: string, id: string) {
  const existing = await prisma.permissionSet.findFirst({
    where: { id, venueId },
    include: { _count: { select: { staffVenues: true } } },
  })

  if (!existing) {
    throw new NotFoundError('Conjunto de permisos no encontrado')
  }

  await prisma.permissionSet.delete({ where: { id } })

  logger.info('Permission set deleted', {
    venueId,
    permissionSetId: id,
    name: existing.name,
    affectedStaff: existing._count.staffVenues,
  })

  return { deleted: true, affectedStaff: existing._count.staffVenues }
}

export async function duplicate(venueId: string, id: string, newName: string, createdBy: string) {
  const existing = await prisma.permissionSet.findFirst({
    where: { id, venueId },
  })

  if (!existing) {
    throw new NotFoundError('Conjunto de permisos no encontrado')
  }

  // Check venue limit
  const count = await prisma.permissionSet.count({ where: { venueId } })
  if (count >= MAX_PERMISSION_SETS_PER_VENUE) {
    throw new BadRequestError(`No se pueden crear más de ${MAX_PERMISSION_SETS_PER_VENUE} conjuntos de permisos por venue`)
  }

  const permissionSet = await prisma.permissionSet.create({
    data: {
      venueId,
      name: newName,
      description: existing.description,
      permissions: existing.permissions,
      color: existing.color,
      createdBy,
    },
    include: {
      _count: { select: { staffVenues: true } },
    },
  })

  logger.info('Permission set duplicated', {
    venueId,
    sourceId: id,
    newId: permissionSet.id,
    newName,
    createdBy,
  })

  return permissionSet
}

function validatePermissions(permissions: string[]) {
  for (const perm of permissions) {
    const error = validatePermissionFormat(perm)
    if (error) {
      throw new BadRequestError(`Permiso inválido: ${error}`)
    }
  }
}
