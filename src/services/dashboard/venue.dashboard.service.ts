// src/services/dashboard/venue.dashboard.service.ts

/**
 * Venue Dashboard Service
 *
 * ⚠️ DESIGN PRINCIPLE: HTTP-Agnostic Business Logic Layer
 *
 * Services are the CORE of the application and contain ALL business logic:
 * - Database operations (via Prisma)
 * - Business validations (uniqueness checks, constraints)
 * - Complex calculations and transformations
 * - Integration with external services (Stripe, Storage, etc.)
 *
 * Services are HTTP-agnostic:
 * ✅ Accept primitive types and DTOs (string, number, objects)
 * ✅ Return data or throw errors (never touch req/res)
 * ✅ Throw AppError subclasses for business rule violations
 * ❌ Never import Express types (Request, Response)
 * ❌ Never deal with HTTP status codes directly
 *
 * Why HTTP-agnostic?
 * - Reusable from anywhere: HTTP controllers, CLI scripts, background jobs, tests
 * - Easier to test: No HTTP mocking needed, just call functions with data
 * - True separation of concerns: Business logic ≠ Transport layer
 * - Framework independent: Could switch from Express to Fastify without touching services
 */
import prisma from '../../utils/prismaClient'
import { CreateVenueDto } from '../../schemas/dashboard/venue.schema'
import { EnhancedCreateVenueBody } from '../../schemas/dashboard/cost-management.schema'
import { Venue, AccountType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { generateSlug } from '../../utils/slugify'
import logger from '../../config/logger'
import { deleteVenueFolder } from '../storage.service'
import {
  getOrCreateStripeCustomer,
  updatePaymentMethod,
  createTrialSubscriptions,
  createCustomerPortalSession,
  syncFeaturesToStripe,
  listPaymentMethods,
  detachPaymentMethod,
  setDefaultPaymentMethod,
  createTrialSetupIntent,
} from '../stripe.service'

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

export async function getVenueById(orgId: string, venueId: string, options?: { skipOrgCheck?: boolean }): Promise<Venue> {
  // SUPERADMIN can access venues across organizations (skipOrgCheck = true)
  // Other roles (including OWNER) are restricted to their own organization
  const whereClause: any = { id: venueId }
  if (!options?.skipOrgCheck) {
    whereClause.organizationId = orgId
  }

  const venue = await prisma.venue.findFirst({
    where: whereClause,
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

export async function updateVenue(orgId: string, venueId: string, updateData: any, options?: { skipOrgCheck?: boolean }): Promise<Venue> {
  // Verify that the venue belongs to the organization (unless SUPERADMIN)
  const whereClause: any = { id: venueId }
  if (!options?.skipOrgCheck) {
    whereClause.organizationId = orgId
  }

  const existingVenue = await prisma.venue.findFirst({
    where: whereClause,
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

export async function deleteVenue(orgId: string, venueId: string, options?: { skipOrgCheck?: boolean }): Promise<void> {
  // Verify that the venue belongs to the organization (unless SUPERADMIN)
  const whereClause: any = { id: venueId }
  if (!options?.skipOrgCheck) {
    whereClause.organizationId = orgId
  }

  const existingVenue = await prisma.venue.findFirst({
    where: whereClause,
  })

  if (!existingVenue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found in organization`)
  }

  // Delete all Firebase Storage files for this venue BEFORE deleting database records
  // This is a "best effort" deletion - we don't want to block venue deletion if storage cleanup fails
  logger.info(`🗑️  Deleting Firebase Storage files for venue: ${existingVenue.slug}`)
  await deleteVenueFolder(existingVenue.slug).catch(error => {
    logger.error(`❌ Failed to delete Firebase Storage folder for venue ${existingVenue.slug}`, error)
    // Continue with database deletion even if storage cleanup fails
  })

  // Use a transaction to delete all related data in the correct order
  await prisma.$transaction(async tx => {
    logger.info(`🗑️  Starting venue deletion for venueId: ${venueId}`)

    // 1. Delete OrderItems (depends on Orders)
    const orderIds = await tx.order.findMany({
      where: { venueId },
      select: { id: true },
    })
    const orderIdList = orderIds.map(o => o.id)

    if (orderIdList.length > 0) {
      const deletedOrderItems = await tx.orderItem.deleteMany({
        where: { orderId: { in: orderIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedOrderItems.count} OrderItems`)

      // 2. Delete OrderItemModifiers (depends on OrderItems)
      const deletedOrderItemModifiers = await tx.orderItemModifier.deleteMany({
        where: { orderItem: { orderId: { in: orderIdList } } },
      })
      logger.info(`  ✓ Deleted ${deletedOrderItemModifiers.count} OrderItemModifiers`)

      // 3. Delete Payments (depends on Orders)
      const deletedPayments = await tx.payment.deleteMany({
        where: { orderId: { in: orderIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedPayments.count} Payments`)

      // 4. Delete PaymentAllocations (depends on Payments)
      const deletedPaymentAllocations = await tx.paymentAllocation.deleteMany({
        where: { payment: { orderId: { in: orderIdList } } },
      })
      logger.info(`  ✓ Deleted ${deletedPaymentAllocations.count} PaymentAllocations`)

      // 5. Delete VenueTransactions (depends on Payments via paymentId)
      const paymentIds = await tx.payment.findMany({
        where: { orderId: { in: orderIdList } },
        select: { id: true },
      })
      const paymentIdList = paymentIds.map(p => p.id)

      if (paymentIdList.length > 0) {
        const deletedVenueTransactions = await tx.venueTransaction.deleteMany({
          where: { paymentId: { in: paymentIdList } },
        })
        logger.info(`  ✓ Deleted ${deletedVenueTransactions.count} VenueTransactions`)
      }

      // 6. Delete Orders
      const deletedOrders = await tx.order.deleteMany({
        where: { venueId },
      })
      logger.info(`  ✓ Deleted ${deletedOrders.count} Orders`)
    }

    // 7. Delete Product-related data
    const productIds = await tx.product.findMany({
      where: { venueId },
      select: { id: true },
    })
    const productIdList = productIds.map(p => p.id)

    if (productIdList.length > 0) {
      // Delete RecipeLines (depends on Recipes)
      const recipeIds = await tx.recipe.findMany({
        where: { productId: { in: productIdList } },
        select: { id: true },
      })
      const recipeIdList = recipeIds.map(r => r.id)

      if (recipeIdList.length > 0) {
        const deletedRecipeLines = await tx.recipeLine.deleteMany({
          where: { recipeId: { in: recipeIdList } },
        })
        logger.info(`  ✓ Deleted ${deletedRecipeLines.count} RecipeLines`)
      }

      // Delete Recipes
      const deletedRecipes = await tx.recipe.deleteMany({
        where: { productId: { in: productIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedRecipes.count} Recipes`)

      // Delete ProductModifierGroups
      const deletedProductModifierGroups = await tx.productModifierGroup.deleteMany({
        where: { productId: { in: productIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedProductModifierGroups.count} ProductModifierGroups`)

      // Delete Inventory records
      const deletedInventory = await tx.inventory.deleteMany({
        where: { productId: { in: productIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedInventory.count} Inventory records`)

      // Hard delete Products (venue deletion is destructive, so we remove all data)
      const deletedProducts = await tx.product.deleteMany({
        where: { venueId },
      })
      logger.info(`  ✓ Deleted ${deletedProducts.count} Products`)
    }

    // 8. Delete Modifiers and ModifierGroups
    const modifierGroupIds = await tx.modifierGroup.findMany({
      where: { venueId },
      select: { id: true },
    })
    const modifierGroupIdList = modifierGroupIds.map(mg => mg.id)

    if (modifierGroupIdList.length > 0) {
      const deletedModifiers = await tx.modifier.deleteMany({
        where: { groupId: { in: modifierGroupIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedModifiers.count} Modifiers`)
    }

    const deletedModifierGroups = await tx.modifierGroup.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedModifierGroups.count} ModifierGroups`)

    // 9. Delete MenuCategories and MenuCategoryAssignments
    const categoryIds = await tx.menuCategory.findMany({
      where: { venueId },
      select: { id: true },
    })
    const categoryIdList = categoryIds.map(c => c.id)

    if (categoryIdList.length > 0) {
      const deletedMenuCategoryAssignments = await tx.menuCategoryAssignment.deleteMany({
        where: { categoryId: { in: categoryIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedMenuCategoryAssignments.count} MenuCategoryAssignments`)
    }

    const deletedMenuCategories = await tx.menuCategory.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedMenuCategories.count} MenuCategories`)

    // 10. Delete RawMaterials and related data
    const rawMaterialIds = await tx.rawMaterial.findMany({
      where: { venueId },
      select: { id: true },
    })
    const rawMaterialIdList = rawMaterialIds.map(rm => rm.id)

    if (rawMaterialIdList.length > 0) {
      const deletedStockBatches = await tx.stockBatch.deleteMany({
        where: { rawMaterialId: { in: rawMaterialIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedStockBatches.count} StockBatches`)

      const deletedRawMaterialMovements = await tx.rawMaterialMovement.deleteMany({
        where: { rawMaterialId: { in: rawMaterialIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedRawMaterialMovements.count} RawMaterialMovements`)

      const deletedLowStockAlerts = await tx.lowStockAlert.deleteMany({
        where: { rawMaterialId: { in: rawMaterialIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedLowStockAlerts.count} LowStockAlerts`)
    }

    const deletedRawMaterials = await tx.rawMaterial.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedRawMaterials.count} RawMaterials`)

    // 11. Delete StaffVenue relationships
    const deletedStaffVenue = await tx.staffVenue.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedStaffVenue.count} StaffVenue relationships`)

    // 12. Delete VenueFeatures
    const deletedVenueFeatures = await tx.venueFeature.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedVenueFeatures.count} VenueFeatures`)

    // 13. Delete VenueSettings
    const deletedVenueSettings = await tx.venueSettings.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedVenueSettings.count} VenueSettings`)

    // 14. Delete Terminals
    const deletedTerminals = await tx.terminal.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedTerminals.count} Terminals`)

    // 15. Delete Reviews (not linked to payments, which cascade delete automatically)
    const deletedReviews = await tx.review.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedReviews.count} Reviews`)

    // 16. Delete Areas and Tables
    const areaIds = await tx.area.findMany({
      where: { venueId },
      select: { id: true },
    })
    const areaIdList = areaIds.map(a => a.id)

    if (areaIdList.length > 0) {
      const deletedTables = await tx.table.deleteMany({
        where: { areaId: { in: areaIdList } },
      })
      logger.info(`  ✓ Deleted ${deletedTables.count} Tables`)
    }

    const deletedAreas = await tx.area.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedAreas.count} Areas`)

    // 17. Delete other venue-related data
    const deletedVenuePaymentConfig = await tx.venuePaymentConfig.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedVenuePaymentConfig.count} VenuePaymentConfigs`)

    const deletedVenuePricingStructure = await tx.venuePricingStructure.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedVenuePricingStructure.count} VenuePricingStructures`)

    const deletedVenueRolePermissions = await tx.venueRolePermission.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedVenueRolePermissions.count} VenueRolePermissions`)

    const deletedMonthlyVenueProfit = await tx.monthlyVenueProfit.deleteMany({
      where: { venueId },
    })
    logger.info(`  ✓ Deleted ${deletedMonthlyVenueProfit.count} MonthlyVenueProfits`)

    // 18. Finally, delete the Venue itself
    await tx.venue.delete({
      where: { id: venueId },
    })
    logger.info(`  ✅ Venue ${venueId} deleted successfully`)
  })

  logger.info(`🎉 Venue deletion complete for venueId: ${venueId}`)
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

/**
 * Convert a demo venue to a real (production) venue
 */
export async function convertDemoVenue(
  orgId: string,
  venueId: string,
  conversionData: {
    rfc: string
    legalName: string
    fiscalRegime: string
    taxDocumentUrl?: string | null
    idDocumentUrl?: string | null
    selectedFeatures?: string[]
    paymentMethodId?: string
  },
  options?: { skipOrgCheck?: boolean },
): Promise<Venue> {
  logger.info('Converting demo venue to real', { orgId, venueId })

  // Verify that the venue belongs to the organization (unless SUPERADMIN)
  const whereClause: any = { id: venueId }
  if (!options?.skipOrgCheck) {
    whereClause.organizationId = orgId
  }

  const existingVenue = await prisma.venue.findFirst({
    where: whereClause,
  })

  if (!existingVenue) {
    logger.error('Venue not found for conversion', { venueId, orgId })
    throw new NotFoundError(`Venue with ID ${venueId} not found in organization`)
  }

  // Verify that the venue is actually in demo mode
  if (!existingVenue.isDemo) {
    logger.error('Attempted to convert non-demo venue', { venueId })
    throw new BadRequestError('This venue is not in demo mode')
  }

  // 🎯 STRIPE INTEGRATION: Create customer and attach payment method
  let stripeCustomerId: string | undefined
  let stripePaymentMethodId: string | undefined

  // Only process Stripe if payment method is provided
  if (conversionData.paymentMethodId) {
    logger.info('🔄 Processing Stripe customer and payment method', { venueId, orgId })

    try {
      // Get organization to obtain contact email and name
      const organization = await prisma.organization.findUnique({
        where: { id: orgId },
        include: {
          staff: {
            take: 1, // Get first staff member for billing contact
            orderBy: { createdAt: 'asc' }, // Oldest = likely owner
          },
        },
      })

      if (!organization) {
        throw new NotFoundError(`Organization with ID ${orgId} not found`)
      }

      // Use organization email or first staff member's email for Stripe customer
      const billingEmail = organization.email || organization.staff[0]?.email
      if (!billingEmail) {
        throw new BadRequestError('Organization does not have a valid email for billing')
      }

      // Create or get Stripe customer for the organization (with venue info)
      stripeCustomerId = await getOrCreateStripeCustomer(
        orgId,
        billingEmail,
        organization.name || conversionData.legalName,
        existingVenue.name, // venueName
        existingVenue.slug, // venueSlug
      )

      // Attach payment method to customer and set as default
      await updatePaymentMethod(stripeCustomerId, conversionData.paymentMethodId)
      stripePaymentMethodId = conversionData.paymentMethodId

      logger.info('✅ Stripe customer and payment method configured', {
        venueId,
        stripeCustomerId,
        stripePaymentMethodId,
      })
    } catch (error) {
      logger.error('❌ Error setting up Stripe customer/payment method', { error, venueId, orgId })
      // Re-throw error to prevent venue conversion if Stripe setup fails
      throw error
    }
  }

  // Update the venue to convert from demo to real
  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      isDemo: false,
      demoExpiresAt: null,
      // Store tax information in venue fields
      // Note: You may want to create a separate VenueTaxInfo model if you need more fields
      rfc: conversionData.rfc,
      legalName: conversionData.legalName,
      fiscalRegime: conversionData.fiscalRegime,
      taxDocumentUrl: conversionData.taxDocumentUrl,
      idDocumentUrl: conversionData.idDocumentUrl,
      // Store Stripe IDs if payment method was provided
      stripeCustomerId,
      stripePaymentMethodId,
    },
    include: {
      features: true,
    },
  })

  logger.info('Demo venue successfully converted to real', {
    venueId: updatedVenue.id,
    venueName: updatedVenue.name,
    rfc: conversionData.rfc,
  })

  // 🎯 STRIPE INTEGRATION: Create trial subscriptions for selected features
  if (conversionData.selectedFeatures && conversionData.selectedFeatures.length > 0 && stripeCustomerId) {
    logger.info('🔄 Creating trial subscriptions for selected features', {
      venueId,
      featureCount: conversionData.selectedFeatures.length,
      features: conversionData.selectedFeatures,
    })

    try {
      // Ensure features are synced to Stripe (creates products/prices if missing)
      logger.info('🔄 Ensuring features are synced to Stripe...')
      await syncFeaturesToStripe()

      const subscriptionIds = await createTrialSubscriptions(
        stripeCustomerId,
        venueId,
        conversionData.selectedFeatures,
        5, // 5 days trial period
        updatedVenue.name, // venueName
        updatedVenue.slug, // venueSlug
      )

      logger.info('✅ Trial subscriptions created successfully', {
        venueId,
        subscriptionCount: subscriptionIds.length,
        subscriptionIds,
      })
    } catch (error) {
      logger.error('❌ Error creating trial subscriptions', {
        error,
        venueId,
        features: conversionData.selectedFeatures,
      })
      // Don't throw - venue conversion already succeeded, subscriptions can be created later
      // This allows user to still access the venue even if Stripe subscriptions fail
    }
  }

  return updatedVenue
}

/**
 * Update venue payment method
 * Updates the Stripe payment method for a venue
 *
 * @param orgId - Organization ID
 * @param venueId - Venue ID
 * @param paymentMethodId - New Stripe payment method ID
 * @param options - Optional parameters
 * @returns Updated venue
 */
export async function updateVenuePaymentMethod(
  orgId: string,
  venueId: string,
  paymentMethodId: string,
  options: { skipOrgCheck?: boolean } = {},
): Promise<void> {
  logger.info('Updating venue payment method', { venueId, paymentMethodId })

  // Get venue with Stripe customer ID
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
    select: {
      id: true,
      name: true,
      stripeCustomerId: true,
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  if (!venue.stripeCustomerId) {
    throw new BadRequestError('Venue does not have Stripe customer configured')
  }

  // Update payment method in Stripe
  await updatePaymentMethod(venue.stripeCustomerId, paymentMethodId)

  // Update payment method ID in database
  await prisma.venue.update({
    where: { id: venueId },
    data: {
      stripePaymentMethodId: paymentMethodId,
    },
  })

  logger.info('✅ Venue payment method updated successfully', {
    venueId,
    venueName: venue.name,
    paymentMethodId,
  })
}

/**
 * Create Stripe Customer Portal session
 * Generates a secure URL to Stripe's hosted billing portal
 *
 * @param orgId - Organization ID
 * @param venueId - Venue ID
 * @param returnUrl - URL to redirect user after they're done
 * @param options - Optional parameters
 * @returns Portal session URL
 */
export async function createVenueBillingPortalSession(
  orgId: string,
  venueId: string,
  returnUrl: string,
  options: { skipOrgCheck?: boolean } = {},
): Promise<string> {
  logger.info('Creating billing portal session', { venueId, returnUrl })

  // Get venue with Stripe customer ID
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      stripeCustomerId: true,
      organizationId: true,
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // If venue doesn't have Stripe customer, create one
  let stripeCustomerId = venue.stripeCustomerId
  if (!stripeCustomerId) {
    logger.info('🆕 Venue has no Stripe customer - creating one now', {
      venueId,
      venueName: venue.name,
      orgId: venue.organizationId,
    })

    // Get organization details
    const organization = await prisma.organization.findUnique({
      where: { id: venue.organizationId },
      select: {
        id: true,
        name: true,
        email: true,
      },
    })

    if (!organization) {
      throw new NotFoundError('Organization not found')
    }

    // Find an OWNER of this organization (via any venue in the org)
    const ownerStaffVenue = await prisma.staffVenue.findFirst({
      where: {
        role: 'OWNER',
        venue: {
          organizationId: organization.id,
        },
      },
      select: {
        staff: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    const ownerEmail = ownerStaffVenue?.staff.email || organization.email
    const ownerName = ownerStaffVenue ? `${ownerStaffVenue.staff.firstName} ${ownerStaffVenue.staff.lastName}` : organization.name

    // Create Stripe customer for this venue/organization
    stripeCustomerId = await getOrCreateStripeCustomer(organization.id, ownerEmail, ownerName, venue.name, venue.slug)

    // Update venue with new customer ID
    await prisma.venue.update({
      where: { id: venueId },
      data: { stripeCustomerId },
    })

    logger.info('✅ Stripe customer created and linked to venue', {
      venueId,
      stripeCustomerId,
    })
  }

  // Create portal session
  const portalUrl = await createCustomerPortalSession(stripeCustomerId, returnUrl)

  logger.info('✅ Billing portal session created', {
    venueId,
    venueName: venue.name,
  })

  return portalUrl
}

/**
 * List payment methods for a venue
 *
 * @param orgId - Organization ID
 * @param venueId - Venue ID
 * @param options - Optional parameters
 * @returns Array of payment methods
 */
export async function listVenuePaymentMethods(orgId: string, venueId: string, options: { skipOrgCheck?: boolean } = {}) {
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
    select: {
      id: true,
      stripeCustomerId: true,
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  if (!venue.stripeCustomerId) {
    // No customer yet - return empty array
    return []
  }

  const paymentMethods = await listPaymentMethods(venue.stripeCustomerId)
  return paymentMethods
}

/**
 * Detach a payment method from a venue
 *
 * @param orgId - Organization ID
 * @param venueId - Venue ID
 * @param paymentMethodId - Stripe payment method ID
 * @param options - Optional parameters
 */
export async function detachVenuePaymentMethod(
  orgId: string,
  venueId: string,
  paymentMethodId: string,
  options: { skipOrgCheck?: boolean } = {},
) {
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
    select: {
      id: true,
      stripeCustomerId: true,
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  if (!venue.stripeCustomerId) {
    throw new BadRequestError('Venue does not have Stripe customer configured')
  }

  await detachPaymentMethod(paymentMethodId)
  logger.info('✅ Payment method detached from venue', { venueId, paymentMethodId })
}

/**
 * Set default payment method for a venue
 *
 * @param orgId - Organization ID
 * @param venueId - Venue ID
 * @param paymentMethodId - Stripe payment method ID
 * @param options - Optional parameters
 */
export async function setVenueDefaultPaymentMethod(
  orgId: string,
  venueId: string,
  paymentMethodId: string,
  options: { skipOrgCheck?: boolean } = {},
) {
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
    select: {
      id: true,
      stripeCustomerId: true,
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  if (!venue.stripeCustomerId) {
    throw new BadRequestError('Venue does not have Stripe customer configured')
  }

  await setDefaultPaymentMethod(venue.stripeCustomerId, paymentMethodId)

  // Update venue record with the default payment method ID
  await prisma.venue.update({
    where: { id: venueId },
    data: { stripePaymentMethodId: paymentMethodId },
  })

  logger.info('✅ Default payment method set for venue', { venueId, paymentMethodId })
}

/**
 * Create SetupIntent for a venue (to collect payment method)
 *
 * @param orgId - Organization ID
 * @param venueId - Venue ID
 * @param options - Optional parameters
 * @returns SetupIntent client secret
 */
export async function createVenueSetupIntent(orgId: string, venueId: string, options: { skipOrgCheck?: boolean } = {}) {
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      stripeCustomerId: true,
      organizationId: true,
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // If venue doesn't have Stripe customer, create one
  let stripeCustomerId = venue.stripeCustomerId
  if (!stripeCustomerId) {
    logger.info('🆕 Venue has no Stripe customer - creating one now', {
      venueId,
      venueName: venue.name,
      orgId: venue.organizationId,
    })

    // Get organization details
    const organization = await prisma.organization.findUnique({
      where: { id: venue.organizationId },
      select: { id: true, name: true, email: true },
    })

    if (!organization) {
      throw new NotFoundError(`Organization with ID ${venue.organizationId} not found`)
    }

    // Find an OWNER of this organization
    const ownerStaffVenue = await prisma.staffVenue.findFirst({
      where: {
        role: 'OWNER',
        venue: { organizationId: organization.id },
      },
      select: {
        staff: {
          select: { email: true, firstName: true, lastName: true },
        },
      },
    })

    const ownerEmail = ownerStaffVenue?.staff.email || organization.email
    const ownerName = ownerStaffVenue ? `${ownerStaffVenue.staff.firstName} ${ownerStaffVenue.staff.lastName}` : organization.name

    // Create Stripe customer
    stripeCustomerId = await getOrCreateStripeCustomer(organization.id, ownerEmail, ownerName, venue.name, venue.slug)

    // Update venue with new customer ID
    await prisma.venue.update({
      where: { id: venueId },
      data: { stripeCustomerId },
    })

    logger.info('✅ Stripe customer created and linked to venue', { venueId, stripeCustomerId })
  }

  // Create SetupIntent
  const clientSecret = await createTrialSetupIntent(stripeCustomerId)
  logger.info('✅ SetupIntent created for venue', { venueId, stripeCustomerId })

  return clientSecret
}
