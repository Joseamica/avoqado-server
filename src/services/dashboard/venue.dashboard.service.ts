// src/services/dashboard/venue.dashboard.service.ts
import prisma from '../../utils/prismaClient' // Tu instancia de Prisma Client
import { CreateVenueDto } from '../../schemas/dashboard/venue.schema' // Ajusta la ruta
import { EnhancedCreateVenueBody } from '../../schemas/dashboard/cost-management.schema'
import { Venue, AccountType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError' // Tu error personalizado
import { generateSlug } from '../../utils/slugify'
import logger from '../../config/logger'

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

export async function listVenuesForOrganization(orgId: string, _queryOptions: any /* ListVenuesQueryDto */): Promise<Venue[]> {
  // Aquí implementarías la lógica para paginación, filtros, ordenación basados en queryOptions
  return prisma.venue.findMany({
    where: {
      organizationId: orgId,
    },
    // orderBy: { [queryOptions.sortBy || 'createdAt']: queryOptions.sortOrder || 'desc' },
    // skip: (queryOptions.page - 1) * queryOptions.limit,
    // take: queryOptions.limit,
  })
}

export async function getVenueById(orgId: string, venueId: string): Promise<Venue> {
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      organizationId: orgId,
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

  // Exclude organizationId from updates (prevent accidental modification)
  const { organizationId: _, ...safeUpdateData } = updateData

  // Prepare the update data
  const venueUpdateData: any = {
    name: safeUpdateData.name,
    address: safeUpdateData.address,
    city: safeUpdateData.city,
    country: safeUpdateData.country,
    phone: safeUpdateData.phone,
    email: safeUpdateData.email,
    website: safeUpdateData.website,
    instagram: safeUpdateData.instagram,
    image: safeUpdateData.image,
    logo: safeUpdateData.logo,
    cuisine: safeUpdateData.cuisine,
    type: safeUpdateData.type,
    timezone: safeUpdateData.timezone,
    utc: safeUpdateData.utc,
    language: safeUpdateData.language,
    dynamicMenu: safeUpdateData.dynamicMenu,
    wifiName: safeUpdateData.wifiName,
    wifiPassword: safeUpdateData.wifiPassword,
    posName: safeUpdateData.posName,
    posUniqueId: safeUpdateData.posUniqueId,
    softRestaurantVenueId: safeUpdateData.softRestaurantVenueId,
    tipPercentage1: safeUpdateData.tipPercentage1,
    tipPercentage2: safeUpdateData.tipPercentage2,
    tipPercentage3: safeUpdateData.tipPercentage3,
    tipPercentages: safeUpdateData.tipPercentages,
    askNameOrdering: safeUpdateData.askNameOrdering,
    googleBusinessId: safeUpdateData.googleBusinessId,
    stripeAccountId: safeUpdateData.stripeAccountId,
    specialPayment: safeUpdateData.specialPayment,
    specialPaymentRef: safeUpdateData.specialPaymentRef,
  }

  // Handle feature updates if provided
  if (safeUpdateData.feature) {
    venueUpdateData.feature = safeUpdateData.feature
  }

  // Handle menta updates if provided (simplified for now)
  if (safeUpdateData.merchantIdA !== undefined) venueUpdateData.merchantIdA = safeUpdateData.merchantIdA
  if (safeUpdateData.merchantIdB !== undefined) venueUpdateData.merchantIdB = safeUpdateData.merchantIdB
  if (safeUpdateData.apiKeyA !== undefined) venueUpdateData.apiKeyA = safeUpdateData.apiKeyA
  if (safeUpdateData.apiKeyB !== undefined) venueUpdateData.apiKeyB = safeUpdateData.apiKeyB

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

/**
 * Enhanced venue creation with payment processing and pricing configuration
 */
export async function createEnhancedVenue(orgId: string, userId: string, venueData: EnhancedCreateVenueBody) {
  logger.info('Creating enhanced venue', { orgId, userId, venueName: venueData.name })

  // Start a transaction to ensure data consistency
  return await prisma.$transaction(async tx => {
    // 1. Generate slug if not provided
    let slugToUse = generateSlug(venueData.name)

    // 2. Check slug uniqueness within organization
    const existingVenueWithSlug = await tx.venue.findFirst({
      where: {
        organizationId: orgId,
        slug: slugToUse,
      },
    })

    if (existingVenueWithSlug) {
      slugToUse = `${slugToUse}-${Date.now()}` // Make it unique
    }

    // 3. Create the venue with enhanced data
    const newVenue = await tx.venue.create({
      data: {
        name: venueData.name,
        type: venueData.type as any, // Cast to enum
        logo: venueData.logo,
        slug: slugToUse,
        organizationId: orgId,

        // Location information
        address: venueData.address,
        city: venueData.city,
        state: venueData.state,
        zipCode: venueData.zipCode,

        // Contact information
        phone: venueData.phone,
        email: venueData.email,
        website: venueData.website || null,

        // Business configuration
        // pos: venueData.pos as any, // Cast to enum
        currency: venueData.currency,
        timezone: venueData.timezone,

        // Set as active by default
        active: true,
      },
    })

    logger.info('Venue created', { venueId: newVenue.id, venueName: newVenue.name })

    // 4. Setup payment processing if enabled
    if (venueData.enablePaymentProcessing) {
      await setupPaymentProcessing(tx, newVenue.id, venueData)
    }

    // 5. Setup pricing structure if enabled
    if (venueData.setupPricingStructure) {
      await setupPricingStructure(tx, newVenue.id, venueData)
    }

    // 6. Create default staff member (venue owner)
    // await tx.staffVenue.create({
    //   data: {
    //     userId: userId,
    //     venueId: newVenue.id,
    //     role: 'OWNER', // Highest role
    //     active: true,
    //   },
    // })

    logger.info('Enhanced venue creation completed', {
      venueId: newVenue.id,
      paymentProcessing: venueData.enablePaymentProcessing,
      pricingStructure: venueData.setupPricingStructure,
    })

    return {
      venueId: newVenue.id,
      venue: newVenue,
      paymentProcessing: venueData.enablePaymentProcessing,
      pricingStructure: venueData.setupPricingStructure,
    }
  })
}

/**
 * Setup payment processing configuration for venue
 */
async function setupPaymentProcessing(tx: any, venueId: string, venueData: EnhancedCreateVenueBody) {
  logger.info('Setting up payment processing', { venueId })

  // Default routing rules if not provided
  const defaultRoutingRules = {
    factura: 'secondary',
    amount_over: 5000,
    peak_hours: {
      start: '18:00',
      end: '22:00',
      account: 'secondary',
    },
  }

  const routingRules = venueData.routingRules || defaultRoutingRules

  // Create venue payment configuration
  const paymentConfig = await tx.venuePaymentConfig.create({
    data: {
      venueId: venueId,
      primaryAccountId: venueData.primaryAccountId || null,
      secondaryAccountId: venueData.secondaryAccountId || null,
      tertiaryAccountId: venueData.tertiaryAccountId || null,
      routingRules: routingRules,
      preferredProcessor: 'AUTO',
    },
  })

  logger.info('Payment processing configured', { venueId, configId: paymentConfig.id })
}

/**
 * Setup pricing structure for venue
 */
async function setupPricingStructure(tx: any, venueId: string, venueData: EnhancedCreateVenueBody) {
  logger.info('Setting up pricing structure', { venueId, pricingTier: venueData.pricingTier })

  // Define pricing tiers
  const pricingTiers = {
    STANDARD: {
      debitRate: 0.02, // 2.0%
      creditRate: 0.03, // 3.0%
      amexRate: 0.04, // 4.0%
      internationalRate: 0.045, // 4.5%
      fixedFeePerTransaction: 0.75,
      monthlyServiceFee: 799.0,
    },
    PREMIUM: {
      debitRate: 0.018, // 1.8%
      creditRate: 0.028, // 2.8%
      amexRate: 0.038, // 3.8%
      internationalRate: 0.043, // 4.3%
      fixedFeePerTransaction: 0.7,
      monthlyServiceFee: 1299.0,
    },
    ENTERPRISE: {
      debitRate: 0.015, // 1.5%
      creditRate: 0.025, // 2.5%
      amexRate: 0.035, // 3.5%
      internationalRate: 0.04, // 4.0%
      fixedFeePerTransaction: 0.65,
      monthlyServiceFee: 1999.0,
    },
    CUSTOM: {
      debitRate: venueData.debitRate || 0.02,
      creditRate: venueData.creditRate || 0.03,
      amexRate: venueData.amexRate || 0.04,
      internationalRate: venueData.internationalRate || 0.045,
      fixedFeePerTransaction: venueData.fixedFeePerTransaction || 0.75,
      monthlyServiceFee: venueData.monthlyServiceFee || 799.0,
    },
  }

  const tier = pricingTiers[venueData.pricingTier || 'STANDARD']

  // Create pricing structure for PRIMARY account type
  const pricingStructure = await tx.venuePricingStructure.create({
    data: {
      venueId: venueId,
      accountType: AccountType.PRIMARY,
      debitRate: tier.debitRate,
      creditRate: tier.creditRate,
      amexRate: tier.amexRate,
      internationalRate: tier.internationalRate,
      fixedFeePerTransaction: tier.fixedFeePerTransaction,
      monthlyServiceFee: tier.monthlyServiceFee,
      minimumMonthlyVolume: venueData.minimumMonthlyVolume || null,
      effectiveFrom: new Date(),
      active: true,
      contractReference: `VENUE-${venueId}-${venueData.pricingTier || 'STANDARD'}-${Date.now()}`,
      notes: `Automatic pricing setup for ${venueData.pricingTier || 'STANDARD'} tier`,
    },
  })

  logger.info('Pricing structure configured', {
    venueId,
    pricingId: pricingStructure.id,
    tier: venueData.pricingTier,
    monthlyFee: tier.monthlyServiceFee,
  })
}
