import { FloorElementType } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

interface FloorElementResponse {
  id: string
  type: FloorElementType
  positionX: number
  positionY: number
  width: number | null
  height: number | null
  rotation: number
  endX: number | null
  endY: number | null
  label: string | null
  color: string | null
  areaId: string | null
  active: boolean
}

interface CreateFloorElementData {
  type: FloorElementType
  positionX: number
  positionY: number
  width?: number
  height?: number
  rotation?: number
  endX?: number
  endY?: number
  label?: string
  color?: string
  areaId?: string
}

interface UpdateFloorElementData {
  positionX?: number
  positionY?: number
  width?: number
  height?: number
  rotation?: number
  endX?: number
  endY?: number
  label?: string
  color?: string
  areaId?: string
  active?: boolean
}

/**
 * Get all floor elements for a venue
 * Returns decorative elements (walls, bars, labels, etc.)
 */
export async function getFloorElements(venueId: string): Promise<FloorElementResponse[]> {
  logger.info(`🎨 [FLOOR ELEMENT SERVICE] Getting floor elements for venue ${venueId}`)

  const elements = await prisma.floorElement.findMany({
    where: { venueId, active: true },
    orderBy: { createdAt: 'asc' },
  })

  const response: FloorElementResponse[] = elements.map(element => ({
    id: element.id,
    type: element.type,
    positionX: element.positionX,
    positionY: element.positionY,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    endX: element.endX,
    endY: element.endY,
    label: element.label,
    color: element.color,
    areaId: element.areaId,
    active: element.active,
  }))

  logger.info(`✅ [FLOOR ELEMENT SERVICE] Retrieved ${response.length} floor elements`)

  return response
}

/**
 * Create a new floor element
 */
export async function createFloorElement(venueId: string, data: CreateFloorElementData): Promise<FloorElementResponse> {
  logger.info(`🎨 [FLOOR ELEMENT SERVICE] Creating floor element type ${data.type} for venue ${venueId}`)

  // Validate coordinates are in valid range (0-1)
  if (data.positionX < 0 || data.positionX > 1 || data.positionY < 0 || data.positionY > 1) {
    throw new BadRequestError(`Invalid coordinates. Position values must be between 0 and 1 (X: ${data.positionX}, Y: ${data.positionY})`)
  }

  // Validate end coordinates for WALL type
  if (data.type === 'WALL') {
    if (data.endX === undefined || data.endY === undefined) {
      throw new BadRequestError('WALL elements require endX and endY coordinates')
    }
    if (data.endX < 0 || data.endX > 1 || data.endY < 0 || data.endY > 1) {
      throw new BadRequestError(`Invalid end coordinates. Values must be between 0 and 1 (endX: ${data.endX}, endY: ${data.endY})`)
    }
  }

  // Validate dimensions for rectangular elements
  if (data.type === 'BAR_COUNTER' || data.type === 'SERVICE_AREA') {
    if (data.width === undefined || data.height === undefined) {
      throw new BadRequestError(`${data.type} elements require width and height`)
    }
    if (data.width <= 0 || data.width > 1 || data.height <= 0 || data.height > 1) {
      throw new BadRequestError(
        `Invalid dimensions. Width and height must be between 0 and 1 (width: ${data.width}, height: ${data.height})`,
      )
    }
  }

  // Validate area exists if provided
  if (data.areaId) {
    const area = await prisma.area.findFirst({
      where: { id: data.areaId, venueId },
    })
    if (!area) {
      throw new NotFoundError(`Area not found in venue ${venueId}`)
    }
  }

  const element = await prisma.floorElement.create({
    data: {
      venueId,
      type: data.type,
      positionX: data.positionX,
      positionY: data.positionY,
      width: data.width ?? null,
      height: data.height ?? null,
      rotation: data.rotation ?? 0,
      endX: data.endX ?? null,
      endY: data.endY ?? null,
      label: data.label ?? null,
      color: data.color ?? null,
      areaId: data.areaId ?? null,
    },
  })

  logger.info(`✅ [FLOOR ELEMENT SERVICE] Created floor element ${element.id} (${element.type})`)

  return {
    id: element.id,
    type: element.type,
    positionX: element.positionX,
    positionY: element.positionY,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    endX: element.endX,
    endY: element.endY,
    label: element.label,
    color: element.color,
    areaId: element.areaId,
    active: element.active,
  }
}

/**
 * Update a floor element
 */
export async function updateFloorElement(venueId: string, elementId: string, data: UpdateFloorElementData): Promise<FloorElementResponse> {
  logger.info(`🎨 [FLOOR ELEMENT SERVICE] Updating floor element ${elementId}`)

  // Validate element exists and belongs to venue
  const element = await prisma.floorElement.findFirst({
    where: { id: elementId, venueId },
  })

  if (!element) {
    throw new NotFoundError(`Floor element not found in venue ${venueId}`)
  }

  // Validate coordinates if provided
  if (data.positionX !== undefined && (data.positionX < 0 || data.positionX > 1)) {
    throw new BadRequestError(`Invalid positionX. Must be between 0 and 1 (value: ${data.positionX})`)
  }
  if (data.positionY !== undefined && (data.positionY < 0 || data.positionY > 1)) {
    throw new BadRequestError(`Invalid positionY. Must be between 0 and 1 (value: ${data.positionY})`)
  }
  if (data.endX !== undefined && (data.endX < 0 || data.endX > 1)) {
    throw new BadRequestError(`Invalid endX. Must be between 0 and 1 (value: ${data.endX})`)
  }
  if (data.endY !== undefined && (data.endY < 0 || data.endY > 1)) {
    throw new BadRequestError(`Invalid endY. Must be between 0 and 1 (value: ${data.endY})`)
  }

  // Validate area exists if provided
  if (data.areaId) {
    const area = await prisma.area.findFirst({
      where: { id: data.areaId, venueId },
    })
    if (!area) {
      throw new NotFoundError(`Area not found in venue ${venueId}`)
    }
  }

  const updatedElement = await prisma.floorElement.update({
    where: { id: elementId },
    data: {
      positionX: data.positionX ?? undefined,
      positionY: data.positionY ?? undefined,
      width: data.width !== undefined ? data.width : undefined,
      height: data.height !== undefined ? data.height : undefined,
      rotation: data.rotation ?? undefined,
      endX: data.endX !== undefined ? data.endX : undefined,
      endY: data.endY !== undefined ? data.endY : undefined,
      label: data.label !== undefined ? data.label : undefined,
      color: data.color !== undefined ? data.color : undefined,
      areaId: data.areaId !== undefined ? data.areaId : undefined,
      active: data.active ?? undefined,
    },
  })

  logger.info(`✅ [FLOOR ELEMENT SERVICE] Floor element ${elementId} updated`)

  return {
    id: updatedElement.id,
    type: updatedElement.type,
    positionX: updatedElement.positionX,
    positionY: updatedElement.positionY,
    width: updatedElement.width,
    height: updatedElement.height,
    rotation: updatedElement.rotation,
    endX: updatedElement.endX,
    endY: updatedElement.endY,
    label: updatedElement.label,
    color: updatedElement.color,
    areaId: updatedElement.areaId,
    active: updatedElement.active,
  }
}

/**
 * Delete a floor element (soft delete by setting active: false)
 */
export async function deleteFloorElement(venueId: string, elementId: string): Promise<void> {
  logger.info(`🎨 [FLOOR ELEMENT SERVICE] Deleting floor element ${elementId}`)

  // Validate element exists and belongs to venue
  const element = await prisma.floorElement.findFirst({
    where: { id: elementId, venueId },
  })

  if (!element) {
    throw new NotFoundError(`Floor element not found in venue ${venueId}`)
  }

  // Soft delete by setting active: false
  await prisma.floorElement.update({
    where: { id: elementId },
    data: { active: false },
  })

  logger.info(`✅ [FLOOR ELEMENT SERVICE] Floor element ${elementId} deleted (soft delete)`)
}
