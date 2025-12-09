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
import { Venue, AccountType, EntityType, VerificationStatus, VenueStatus, StaffRole } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { generateSlug } from '../../utils/slugify'
import logger from '../../config/logger'
import { deleteVenueFolder, deleteFileFromStorage } from '../storage.service'
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
import { notifySuperadminsNewKycSubmission } from '../superadmin/kycReview.service'
import { cleanDemoData } from '../onboarding/demoCleanup.service'
import { deleteOnboardingProgress } from '../onboarding/onboardingProgress.service'
import { OPERATIONAL_VENUE_STATUSES, canDeleteVenue, isDemoVenue, isTrialVenue } from '@/lib/venueStatus.constants'

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

/**
 * Get venue by slug (for KYC resubmission page)
 * Returns minimal venue data with KYC status
 */
export async function getVenueBySlug(orgId: string, venueSlug: string, options?: { skipOrgCheck?: boolean }): Promise<Venue> {
  const whereClause: any = { slug: venueSlug }
  if (!options?.skipOrgCheck) {
    whereClause.organizationId = orgId
  }

  const venue = await prisma.venue.findUnique({
    where: whereClause,
    select: {
      id: true,
      name: true,
      slug: true,
      kycStatus: true,
      kycRejectionReason: true,
      entityType: true,
      organizationId: true,
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with slug ${venueSlug} not found`)
  }

  return venue as Venue
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

  // 🗑️ AUTO-CLEANUP: Delete old logo from Firebase Storage if it's being changed/removed
  if (safeUpdateData.logo !== undefined) {
    // Logo field is being updated
    const oldLogo = existingVenue.logo
    const newLogo = safeUpdateData.logo || null // Treat empty string as null

    // If logo is changing and there was an old logo, delete it from storage
    if (oldLogo && oldLogo !== newLogo) {
      logger.info(`🗑️  Auto-cleanup: Deleting old logo from Firebase Storage`, {
        venueId,
        oldLogo,
        newLogo: newLogo || '(removed)',
      })

      await deleteFileFromStorage(oldLogo).catch(error => {
        logger.error(`❌ Failed to auto-delete old logo from storage (non-blocking)`, {
          venueId,
          oldLogo,
          error: error.message,
        })
        // Don't throw - continue with update even if storage cleanup fails
        // This prevents blocking venue updates if Firebase Storage has issues
      })
    }
  }

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

  // SECURITY: Mexican law (SAT) requires data retention for tax audits
  // Only demo venues (status: LIVE_DEMO or TRIAL) can be hard deleted
  // Real venues must use closeVenue() instead to retain data
  if (!canDeleteVenue(existingVenue.status)) {
    throw new BadRequestError(
      'Cannot delete real venues (Mexican law requires data retention for SAT audits). Use closeVenue() to mark the venue as permanently closed while retaining data.',
    )
  }

  logger.info(`🗑️ Deleting demo venue: ${existingVenue.name} (${existingVenue.slug})`, {
    venueId,
    status: existingVenue.status, // Single source of truth
    isDemoVenue: isDemoVenue(existingVenue.status),
  })

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

  // Check if organization has any remaining venues
  const remainingVenues = await prisma.venue.count({
    where: { organizationId: existingVenue.organizationId },
  })

  // If no more venues, reset onboarding so user can start fresh
  if (remainingVenues === 0) {
    logger.info(`🔄 No remaining venues for organization ${existingVenue.organizationId}, resetting onboarding progress`)

    try {
      // Delete onboarding progress
      await deleteOnboardingProgress(existingVenue.organizationId)
      logger.info(`  ✅ Deleted onboarding progress`)

      // Reset organization's onboarding completed status
      await prisma.organization.update({
        where: { id: existingVenue.organizationId },
        data: { onboardingCompletedAt: null },
      })
      logger.info(`  ✅ Reset organization onboarding status`)
    } catch (error) {
      // Don't fail venue deletion if onboarding reset fails
      logger.warn(`⚠️ Failed to reset onboarding progress: ${error}`)
    }
  }
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
  staffId: string, // Who performed the conversion (audit trail)
  conversionData: {
    // Entity type (PERSONA_FISICA or PERSONA_MORAL)
    entityType: EntityType
    // Fiscal info - Optional for PERSONA_FISICA, required for PERSONA_MORAL
    // For PERSONA_FISICA: extracted from Constancia de Situación Fiscal during verification
    rfc?: string | null
    legalName?: string | null
    fiscalRegime?: string | null
    // Documents - Required for all entity types (Blumonpay requirements)
    idDocumentUrl: string
    rfcDocumentUrl: string
    comprobanteDomicilioUrl: string
    caratulaBancariaUrl: string
    // Documents - PERSONA_MORAL only
    actaDocumentUrl?: string | null
    poderLegalUrl?: string | null
    // Legacy field (backwards compatibility)
    taxDocumentUrl?: string | null
    // Stripe integration
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

  // Verify that the venue is actually in demo mode (TRIAL status)
  // Uses status as single source of truth instead of deprecated isOnboardingDemo boolean
  if (!isTrialVenue(existingVenue.status)) {
    logger.error('Attempted to convert non-demo venue', { venueId, status: existingVenue.status })
    throw new BadRequestError('This venue is not in demo mode')
  }

  // 🧹 Clean demo data before converting to real venue
  // This removes demo orders, payments, reviews, etc. while keeping menu/products/tables
  try {
    const cleanupResult = await cleanDemoData(venueId)
    logger.info(`🧹 Demo data cleaned for venue ${venueId}:`, cleanupResult)
  } catch (cleanupError) {
    logger.error(`⚠️ Demo cleanup failed for venue ${venueId}:`, cleanupError)
    // Don't block conversion if cleanup fails - venue can still operate
    // The demo data will just remain but venue will be marked as real
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

      // Create or get Stripe customer for the venue
      // Use organization name, then legal name, then venue name as fallback
      stripeCustomerId = await getOrCreateStripeCustomer(
        venueId,
        billingEmail,
        organization.name || conversionData.legalName || existingVenue.name,
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
      // ✅ Update status from TRIAL to PENDING_ACTIVATION (single source of truth)
      status: VenueStatus.PENDING_ACTIVATION,
      statusChangedAt: new Date(),
      statusChangedBy: staffId, // Audit trail: who performed the conversion
      demoExpiresAt: null,
      // Entity type (PERSONA_FISICA or PERSONA_MORAL)
      entityType: conversionData.entityType,
      // Store tax/business information
      rfc: conversionData.rfc,
      legalName: conversionData.legalName,
      fiscalRegime: conversionData.fiscalRegime,
      // Store all KYC documents (Blumonpay requirements)
      idDocumentUrl: conversionData.idDocumentUrl,
      rfcDocumentUrl: conversionData.rfcDocumentUrl,
      comprobanteDomicilioUrl: conversionData.comprobanteDomicilioUrl,
      caratulaBancariaUrl: conversionData.caratulaBancariaUrl,
      actaDocumentUrl: conversionData.actaDocumentUrl,
      poderLegalUrl: conversionData.poderLegalUrl,
      // Legacy field (backwards compatibility - use rfcDocumentUrl if taxDocumentUrl not provided)
      taxDocumentUrl: conversionData.taxDocumentUrl || conversionData.rfcDocumentUrl,
      // Set KYC status to PENDING_REVIEW since all documents are uploaded
      kycStatus: VerificationStatus.PENDING_REVIEW,
      kycRejectionReason: null,
      kycRejectedDocuments: [],
      // Store Stripe IDs if payment method was provided
      stripeCustomerId,
      stripePaymentMethodId,
    },
    include: {
      features: true,
    },
  })

  logger.info('Demo venue successfully converted to real with KYC documents', {
    venueId: updatedVenue.id,
    venueName: updatedVenue.name,
    entityType: conversionData.entityType,
    rfc: conversionData.rfc,
    kycStatus: updatedVenue.kycStatus,
  })

  // Notify superadmins about new KYC submission
  try {
    await notifySuperadminsNewKycSubmission(venueId, updatedVenue.name)
    logger.info('Superadmins notified about new KYC submission', { venueId })
  } catch (notifyError) {
    // Don't fail the conversion if notification fails - log and continue
    logger.error('Failed to notify superadmins about new KYC submission', { error: notifyError, venueId })
  }

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

// ==========================================
// VENUE STATUS MANAGEMENT (Mexican Regulatory Compliance)
// ==========================================
// Mexican law requires data retention - venues cannot be hard deleted
// Only Live Demo venues can be deleted (they are ephemeral by design)
// All other venues must be SUSPENDED or CLOSED (data retained for audit)

/**
 * Valid status transitions for venue lifecycle
 * State machine to prevent invalid transitions
 *
 * Key Design Decisions:
 * - LIVE_DEMO has no transitions (ephemeral - just delete)
 * - TRIAL → PENDING_ACTIVATION is NOT allowed (demos don't need KYC)
 * - TRIAL venues can only be SUSPENDED or CLOSED
 * - ADMIN_SUSPENDED can only be reactivated by SUPERADMIN (enforced in reactivateVenue)
 */
const VALID_STATUS_TRANSITIONS: Record<VenueStatus, VenueStatus[]> = {
  // Demo states - ephemeral, typically just deleted
  [VenueStatus.LIVE_DEMO]: [], // No transitions - just delete when done
  [VenueStatus.TRIAL]: [VenueStatus.SUSPENDED, VenueStatus.CLOSED, VenueStatus.ONBOARDING], // Can convert to real venue via ONBOARDING
  // Production states
  [VenueStatus.ONBOARDING]: [VenueStatus.TRIAL, VenueStatus.PENDING_ACTIVATION],
  [VenueStatus.PENDING_ACTIVATION]: [VenueStatus.ACTIVE, VenueStatus.SUSPENDED],
  [VenueStatus.ACTIVE]: [VenueStatus.SUSPENDED, VenueStatus.ADMIN_SUSPENDED, VenueStatus.CLOSED],
  [VenueStatus.SUSPENDED]: [VenueStatus.ACTIVE, VenueStatus.CLOSED],
  [VenueStatus.ADMIN_SUSPENDED]: [VenueStatus.ACTIVE, VenueStatus.CLOSED], // Only SUPERADMIN can reactivate
  [VenueStatus.CLOSED]: [], // Terminal state - no transitions allowed
}

/**
 * Suspend venue (user-initiated)
 * Venue owner or admin can suspend their own venue
 * Staff can no longer login, but all data is retained
 *
 * @param orgId - Organization ID
 * @param venueId - Venue ID to suspend
 * @param staffId - Staff ID performing the action
 * @param reason - Reason for suspension (for audit trail)
 * @param options - Optional parameters
 * @returns Updated venue
 */
export async function suspendVenue(
  orgId: string,
  venueId: string,
  staffId: string,
  reason: string,
  options: { skipOrgCheck?: boolean } = {},
): Promise<Venue> {
  logger.info(`🔒 Suspending venue ${venueId} by staff ${staffId}`)

  // Get venue with current status
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Validate transition
  if (!VALID_STATUS_TRANSITIONS[venue.status].includes(VenueStatus.SUSPENDED)) {
    throw new BadRequestError(
      `Cannot suspend venue from status ${venue.status}. Venue must be in TRIAL, PENDING_ACTIVATION, or ACTIVE status.`,
    )
  }

  // Update venue status
  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      status: VenueStatus.SUSPENDED,
      statusChangedAt: new Date(),
      statusChangedBy: staffId,
      suspensionReason: reason,
      active: false, // Backwards compatibility
    },
  })

  logger.info(`✅ Venue ${venueId} suspended successfully. Reason: ${reason}`)
  return updatedVenue
}

/**
 * Admin suspend venue (Avoqado-initiated)
 * Only SUPERADMIN can use this - for non-payment, policy violations, etc.
 *
 * @param venueId - Venue ID to suspend
 * @param staffId - Superadmin staff ID performing the action
 * @param reason - Reason for suspension (for audit trail)
 * @returns Updated venue
 */
export async function adminSuspendVenue(venueId: string, staffId: string, reason: string): Promise<Venue> {
  logger.info(`🔒 Admin suspending venue ${venueId} by superadmin ${staffId}`)

  // Get venue with current status
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Validate transition
  if (!VALID_STATUS_TRANSITIONS[venue.status].includes(VenueStatus.ADMIN_SUSPENDED)) {
    throw new BadRequestError(`Cannot admin-suspend venue from status ${venue.status}. Venue must be in ACTIVE status.`)
  }

  // Update venue status
  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      status: VenueStatus.ADMIN_SUSPENDED,
      statusChangedAt: new Date(),
      statusChangedBy: staffId,
      suspensionReason: reason,
      active: false, // Backwards compatibility
    },
  })

  logger.info(`✅ Venue ${venueId} admin-suspended by superadmin. Reason: ${reason}`)
  return updatedVenue
}

/**
 * Close venue permanently
 * Data is retained for Mexican regulatory compliance (SAT audit requirements)
 * This is a TERMINAL state - cannot be reversed
 *
 * @param orgId - Organization ID
 * @param venueId - Venue ID to close
 * @param staffId - Staff ID performing the action
 * @param reason - Reason for closure (for audit trail)
 * @param options - Optional parameters
 * @returns Updated venue
 */
export async function closeVenue(
  orgId: string,
  venueId: string,
  staffId: string,
  reason: string,
  options: { skipOrgCheck?: boolean } = {},
): Promise<Venue> {
  logger.warn(`⚠️ CLOSING venue ${venueId} permanently (terminal state) by staff ${staffId}`)

  // Get venue with current status
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Validate transition - can only close from SUSPENDED or ADMIN_SUSPENDED
  if (!VALID_STATUS_TRANSITIONS[venue.status].includes(VenueStatus.CLOSED)) {
    throw new BadRequestError(
      `Cannot close venue from status ${venue.status}. Venue must be in ACTIVE, SUSPENDED, or ADMIN_SUSPENDED status.`,
    )
  }

  // Update venue status
  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      status: VenueStatus.CLOSED,
      statusChangedAt: new Date(),
      statusChangedBy: staffId,
      suspensionReason: reason || venue.suspensionReason, // Keep existing reason if not provided
      active: false, // Backwards compatibility
    },
  })

  logger.warn(`⚠️ Venue ${venueId} CLOSED permanently. This action cannot be reversed. Reason: ${reason}`)
  return updatedVenue
}

/**
 * Reactivate suspended venue
 * Only SUPERADMIN can reactivate venues
 * Cannot reactivate CLOSED venues (terminal state)
 *
 * @param venueId - Venue ID to reactivate
 * @param staffId - Superadmin staff ID performing the action
 * @returns Updated venue
 */
export async function reactivateVenue(
  orgId: string,
  venueId: string,
  staffId: string,
  options: { skipOrgCheck?: boolean } = {},
): Promise<Venue> {
  logger.info(`🔓 Reactivating venue ${venueId} by staff ${staffId}`)

  // Get venue with current status
  const venue = await prisma.venue.findFirst({
    where: {
      id: venueId,
      ...(options.skipOrgCheck ? {} : { organizationId: orgId }),
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Can only reactivate SUSPENDED venues (user-initiated)
  // ADMIN_SUSPENDED requires superadmin role (validated in controller via skipOrgCheck)
  if (venue.status !== VenueStatus.SUSPENDED && venue.status !== VenueStatus.ADMIN_SUSPENDED) {
    throw new BadRequestError(
      `Cannot reactivate venue from status ${venue.status}. Only SUSPENDED or ADMIN_SUSPENDED venues can be reactivated.`,
    )
  }

  // If ADMIN_SUSPENDED, only superadmin can reactivate
  if (venue.status === VenueStatus.ADMIN_SUSPENDED && !options.skipOrgCheck) {
    throw new BadRequestError('ADMIN_SUSPENDED venues can only be reactivated by a superadmin.')
  }

  // Update venue status back to ACTIVE
  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      status: VenueStatus.ACTIVE,
      statusChangedAt: new Date(),
      statusChangedBy: staffId,
      suspensionReason: null, // Clear suspension reason
      active: true, // Backwards compatibility
    },
  })

  logger.info(`✅ Venue ${venueId} reactivated successfully`)
  return updatedVenue
}

/**
 * Update venue status (generic transition)
 * Use this for status transitions during onboarding flow
 *
 * @param venueId - Venue ID
 * @param newStatus - New status to set
 * @param staffId - Staff ID performing the action (optional)
 * @returns Updated venue
 */
export async function updateVenueStatus(venueId: string, newStatus: VenueStatus, staffId?: string): Promise<Venue> {
  logger.info(`📝 Updating venue ${venueId} status to ${newStatus}`)

  // Get venue with current status
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Validate transition
  if (!VALID_STATUS_TRANSITIONS[venue.status].includes(newStatus)) {
    throw new BadRequestError(`Invalid status transition from ${venue.status} to ${newStatus}`)
  }

  // Calculate active boolean based on new status (using centralized constants)
  const isActive = OPERATIONAL_VENUE_STATUSES.includes(newStatus)

  // Update venue status
  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      status: newStatus,
      statusChangedAt: new Date(),
      statusChangedBy: staffId || null,
      active: isActive, // Backwards compatibility
      // Clear suspension reason if transitioning to non-suspended state
      ...(isActive ? { suspensionReason: null } : {}),
    },
  })

  logger.info(`✅ Venue ${venueId} status updated to ${newStatus}`)
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

    // Create Stripe customer for this venue
    stripeCustomerId = await getOrCreateStripeCustomer(venueId, ownerEmail, ownerName, venue.name, venue.slug)

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
      stripePaymentMethodId: true,
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

  // Auto-set first payment method as default if none is set
  if (paymentMethods.length > 0 && !venue.stripePaymentMethodId) {
    const firstPaymentMethod = paymentMethods[0]
    logger.info('🔄 Auto-setting first payment method as default', {
      venueId,
      paymentMethodId: firstPaymentMethod.id,
    })

    // Set as default in Stripe
    await setDefaultPaymentMethod(venue.stripeCustomerId, firstPaymentMethod.id)

    // Update venue record
    await prisma.venue.update({
      where: { id: venueId },
      data: { stripePaymentMethodId: firstPaymentMethod.id },
    })

    logger.info('✅ First payment method auto-set as default', {
      venueId,
      paymentMethodId: firstPaymentMethod.id,
    })
  }

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

    // Create Stripe customer for venue
    stripeCustomerId = await getOrCreateStripeCustomer(venueId, ownerEmail, ownerName, venue.name, venue.slug)

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
