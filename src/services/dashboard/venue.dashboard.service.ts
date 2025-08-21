// src/services/dashboard/venue.dashboard.service.ts
import prisma from '../../utils/prismaClient' // Tu instancia de Prisma Client
import { CreateVenueDto } from '../../schemas/dashboard/venue.schema' // Ajusta la ruta
import { Venue } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError' // Tu error personalizado
import { generateSlug } from '../../utils/slugify'

// Función para generar slugs (podría estar en un utilitario)

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

export async function listVenuesForOrganization(orgId: string, queryOptions: any /* ListVenuesQueryDto */): Promise<Venue[]> {
  // Aquí implementarías la lógica para paginación, filtros, ordenación basados en queryOptions
  return prisma.venue.findMany({
    // orderBy: { [queryOptions.sortBy || 'createdAt']: queryOptions.sortOrder || 'desc' },
    // skip: (queryOptions.page - 1) * queryOptions.limit,
    // take: queryOptions.limit,
  })
}

export async function getVenueById(orgId: string, venueId: string): Promise<Venue> {
  const venue = await prisma.venue.findUnique({
    where: {
      id: venueId,
    },
    include: {
      menuCategories: true,
      modifierGroups: true,
      menus: true,
      terminals: true,
      staff: true,
      inventories: true,
      tables: true,
      shifts: true,
      orders: true,
      payments: true,
      transactions: true,
      reviews: true,
      features: true,
    },
  })
  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }
  return venue
}

export async function updateVenue(orgId: string, venueId: string, updateData: any): Promise<Venue> {
  // Verify that the venue belongs to the organization
  const existingVenue = await prisma.venue.findFirst({
    where: { id: venueId, organizationId: orgId },
  })

  if (!existingVenue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found in organization`)
  }

  // Prepare the update data
  const venueUpdateData: any = {
    name: updateData.name,
    address: updateData.address,
    city: updateData.city,
    country: updateData.country,
    phone: updateData.phone,
    email: updateData.email,
    website: updateData.website,
    instagram: updateData.instagram,
    image: updateData.image,
    logo: updateData.logo,
    cuisine: updateData.cuisine,
    type: updateData.type,
    utc: updateData.utc,
    language: updateData.language,
    dynamicMenu: updateData.dynamicMenu,
    wifiName: updateData.wifiName,
    wifiPassword: updateData.wifiPassword,
    posName: updateData.posName,
    posUniqueId: updateData.posUniqueId,
    softRestaurantVenueId: updateData.softRestaurantVenueId,
    tipPercentage1: updateData.tipPercentage1,
    tipPercentage2: updateData.tipPercentage2,
    tipPercentage3: updateData.tipPercentage3,
    tipPercentages: updateData.tipPercentages,
    askNameOrdering: updateData.askNameOrdering,
    googleBusinessId: updateData.googleBusinessId,
    stripeAccountId: updateData.stripeAccountId,
    specialPayment: updateData.specialPayment,
    specialPaymentRef: updateData.specialPaymentRef,
  }

  // Handle feature updates if provided
  if (updateData.feature) {
    venueUpdateData.feature = updateData.feature
  }

  // Handle menta updates if provided (simplified for now)
  if (updateData.merchantIdA !== undefined) venueUpdateData.merchantIdA = updateData.merchantIdA
  if (updateData.merchantIdB !== undefined) venueUpdateData.merchantIdB = updateData.merchantIdB
  if (updateData.apiKeyA !== undefined) venueUpdateData.apiKeyA = updateData.apiKeyA
  if (updateData.apiKeyB !== undefined) venueUpdateData.apiKeyB = updateData.apiKeyB

  // Remove null/undefined values
  Object.keys(venueUpdateData).forEach(key => {
    if (venueUpdateData[key] === null || venueUpdateData[key] === undefined) {
      delete venueUpdateData[key]
    }
  })

  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: venueUpdateData,
    include: {
      features: true,
    },
  })

  return updatedVenue
}

export async function deleteVenue(orgId: string, venueId: string): Promise<void> {
  // Verify that the venue belongs to the organization
  const existingVenue = await prisma.venue.findFirst({
    where: { id: venueId, organizationId: orgId },
  })

  if (!existingVenue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found in organization`)
  }

  // Delete the venue (this will cascade to related records based on schema)
  await prisma.venue.delete({
    where: { id: venueId },
  })
}
