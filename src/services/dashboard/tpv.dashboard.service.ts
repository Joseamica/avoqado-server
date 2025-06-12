import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { PaginatedTerminalsResponse } from '../../schemas/dashboard/tpv.schema'
import { TerminalStatus, TerminalType } from '@prisma/client'

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
      where: {
        venueId,
      },
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
