import prisma from '../../utils/prismaClient'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import { PaginatedTerminalsResponse, UpdateTpvBody, CreateTpvBody } from '../../schemas/dashboard/tpv.schema'
import { Terminal, TerminalStatus, TerminalType } from '@prisma/client'
import logger from '@/config/logger'

/**
 * Obtiene los datos de las terminales para un venue, con paginación y filtros.
 * @param venueId - El ID del venue.
 * @param page - El número de página actual.
 * @param pageSize - El tamaño de la página.
 * @param filters - Un objeto con filtros opcionales (status, type).
 * @returns Un objeto con la lista de terminales y metadatos de paginación.
 */
export async function getTerminalsData(
  venueId: string,
  page: number,
  pageSize: number,
  filters: { status?: TerminalStatus; type?: TerminalType },
): Promise<PaginatedTerminalsResponse> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }

  // 2. Calcular valores para la consulta de paginación
  const skip = (page - 1) * pageSize
  const take = pageSize

  // 3. Construir la cláusula 'where' para ser reutilizada
  const whereClause = {
    venueId,
    // Añadir filtros dinámicamente si fueron proporcionados
    ...(filters.status && { status: filters.status }),
    ...(filters.type && { type: filters.type }),
  }

  // 4. Ejecutar las consultas a la base de datos en paralelo
  const [terminals, total] = await prisma.$transaction([
    prisma.terminal.findMany({
      where: whereClause,
      orderBy: {
        name: 'asc', // Ordenar alfabéticamente por nombre
      },
      skip,
      take,
    }),
    prisma.terminal.count({
      where: whereClause,
    }),
  ])

  // 5. Estructurar y devolver la respuesta final
  return {
    data: terminals,
    meta: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Obtiene una terminal específica por ID y venueId.
 * @param venueId - El ID del venue.
 * @param tpvId - El ID de la terminal.
 * @returns La terminal encontrada.
 */
export async function getTpvById(venueId: string, tpvId: string): Promise<Terminal> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }
  if (!tpvId) {
    throw new NotFoundError('El ID del TPV es requerido.')
  }

  // 2. Buscar la terminal en la base de datos
  const terminal = await prisma.terminal.findFirst({
    where: {
      id: tpvId,
      venueId: venueId,
    },
  })

  // 3. Verificar si la terminal existe
  if (!terminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada en el venue ${venueId}.`)
  }

  return terminal
}

/**
 * Actualiza una terminal específica.
 * @param venueId - El ID del venue.
 * @param tpvId - El ID de la terminal.
 * @param updateData - Los datos a actualizar.
 * @returns La terminal actualizada.
 */
export async function updateTpv(venueId: string, tpvId: string, updateData: UpdateTpvBody): Promise<Terminal> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }
  if (!tpvId) {
    throw new NotFoundError('El ID del TPV es requerido.')
  }

  // 2. Verificar que la terminal existe y pertenece al venue
  const existingTerminal = await prisma.terminal.findFirst({
    where: {
      id: tpvId,
      venueId: venueId,
    },
  })

  if (!existingTerminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada en el venue ${venueId}.`)
  }

  // 3. Preparar los datos de actualización
  const updatePayload: any = { ...updateData, updatedAt: new Date() }

  // Si hay configuración como string, intentar parsearla como JSON
  if (updateData.config && typeof updateData.config === 'string') {
    try {
      updatePayload.config = JSON.parse(updateData.config)
    } catch (error) {
      // Si no es JSON válido, guardarlo como string
      logger.error('Error al parsear la configuración:', error)
      updatePayload.config = updateData.config
    }
  }

  // 4. Actualizar la terminal
  const updatedTerminal = await prisma.terminal.update({
    where: {
      id: tpvId,
    },
    data: updatePayload,
  })

  return updatedTerminal
}

/**
 * Crea una nueva terminal (TPV) para un venue.
 */
export async function createTpv(venueId: string, payload: CreateTpvBody): Promise<Terminal> {
  if (!venueId) throw new NotFoundError('El ID del Venue es requerido.')
  const { name, serialNumber } = payload
  if (!name || !serialNumber) {
    throw new NotFoundError('Nombre y número de serie son requeridos')
  }

  // Ensure serial number is unique
  const existing = await prisma.terminal.findUnique({ where: { serialNumber } })
  if (existing) {
    throw new NotFoundError(`Ya existe un terminal con número de serie ${serialNumber}`)
  }

  const created = await prisma.terminal.create({
    data: {
      venueId,
      name,
      serialNumber,
      type: (payload.type as any) || TerminalType.TPV_ANDROID,
      status: TerminalStatus.INACTIVE,
      config: payload.config as any,
    },
  })

  return created
}

/**
 * Elimina una terminal específica.
 * IMPORTANT: Solo permite eliminar terminales que NO estén activadas.
 * Terminales activadas deben ser marcadas como RETIRED en lugar de eliminadas.
 *
 * @param venueId - El ID del venue.
 * @param tpvId - El ID de la terminal.
 * @returns void
 */
export async function deleteTpv(venueId: string, tpvId: string): Promise<void> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }
  if (!tpvId) {
    throw new NotFoundError('El ID del TPV es requerido.')
  }

  // 2. Verificar que la terminal existe y pertenece al venue
  const existingTerminal = await prisma.terminal.findFirst({
    where: {
      id: tpvId,
      venueId: venueId,
    },
  })

  if (!existingTerminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada en el venue ${venueId}.`)
  }

  // 3. SECURITY: No permitir eliminar terminales activadas
  // Square/Toast pattern: Terminales activadas deben ser RETIRED, no eliminadas
  // Esto previene eliminar dispositivos que tienen datos históricos importantes
  if (existingTerminal.activatedAt) {
    throw new BadRequestError(`No se puede eliminar una terminal activada. Use el estado RETIRED para desactivar terminales en uso.`)
  }

  // 4. Eliminar la terminal
  await prisma.terminal.delete({
    where: {
      id: tpvId,
    },
  })

  logger.info(`Terminal ${tpvId} eliminada del venue ${venueId}`)
}
