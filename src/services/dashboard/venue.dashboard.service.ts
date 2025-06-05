// src/services/dashboard/venue.dashboard.service.ts
import prisma from '../../utils/prismaClient' // Tu instancia de Prisma Client
import { CreateVenueDto } from '../../schemas/venue.schema' // Ajusta la ruta
import { Venue } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError' // Tu error personalizado

// Función para generar slugs (podría estar en un utilitario)
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
}

export async function createVenueForOrganization(orgId: string, venueData: CreateVenueDto): Promise<Venue> {
  let slugToUse = venueData.slug

  // 1. Lógica de negocio: generar slug si no se provee
  if (!slugToUse) {
    slugToUse = generateSlug(venueData.name)
  }

  // 2. Lógica de negocio: Verificar unicidad del slug DENTRO de la organización
  const existingVenueWithSlug = await prisma.venue.findFirst({
    where: {
      organizationId: orgId,
      slug: slugToUse,
    },
  })

  if (existingVenueWithSlug) {
    throw new BadRequestError(`El slug '${slugToUse}' ya está en uso en esta organización.`)
  }

  // 3. Interacción con la base de datos
  const newVenue = await prisma.venue.create({
    data: {
      ...venueData, // Los datos ya validados del DTO
      slug: slugToUse, // El slug final
      organizationId: orgId, // Asociar con la organización
      // Asegúrate de que los campos del DTO coincidan con los del modelo Prisma Venue
      // o realiza las transformaciones necesarias aquí.
      // latitude y longitude pueden necesitar conversión si Zod los parsea como string y Prisma espera Decimal/Number
      latitude: venueData.latitude !== undefined ? venueData.latitude : null,
      longitude: venueData.longitude !== undefined ? venueData.longitude : null,
      website: venueData.website !== undefined ? venueData.website : null,
      logo: venueData.logo !== undefined ? venueData.logo : null,
      primaryColor: venueData.primaryColor !== undefined ? venueData.primaryColor : null,
      secondaryColor: venueData.secondaryColor !== undefined ? venueData.secondaryColor : null,
      operationalSince: venueData.operationalSince !== undefined ? venueData.operationalSince : null,
    },
  })
  return newVenue
}

export async function getVenuesByOrganization(orgId: string, queryOptions: any /* ListVenuesQueryDto */): Promise<Venue[]> {
  // Aquí implementarías la lógica para paginación, filtros, ordenación basados en queryOptions
  return prisma.venue.findMany({
    where: {
      organizationId: orgId,
      // ... aplicar filtros basados en queryOptions.search ...
    },
    // orderBy: { [queryOptions.sortBy || 'createdAt']: queryOptions.sortOrder || 'desc' },
    // skip: (queryOptions.page - 1) * queryOptions.limit,
    // take: queryOptions.limit,
  })
}
