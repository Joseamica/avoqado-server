/**
 * Venue Creation Service (Onboarding)
 *
 * Handles creation of venues during onboarding flow.
 * Supports both demo venues (pre-populated) and real business venues.
 */

import { BusinessType, OnboardingType, VenueType } from '@prisma/client'
import { addDays } from 'date-fns'
import prisma from '@/utils/prismaClient'
import { generateSlug as slugify } from '@/utils/slugify'
import { seedDemoVenue } from './demoSeed.service'
import * as stripeService from '@/services/stripe.service'
import logger from '@/config/logger'

// Types
export interface CreateVenueInput {
  organizationId: string
  userId: string // User to assign as venue owner
  onboardingType: OnboardingType
  businessInfo: {
    name: string
    type?: BusinessType
    venueType?: VenueType
    timezone?: string
    address?: string
    city?: string
    state?: string
    country?: string
    zipCode?: string
    phone?: string
    email?: string
  }
  menuData?: {
    method: 'manual' | 'csv'
    categories?: Array<{ name: string; slug: string; description?: string }>
    products?: Array<{
      name: string
      sku: string
      description?: string
      price: number
      type?: string
      categorySlug: string
    }>
  }
  paymentInfo?: {
    clabe: string
    bankName?: string
    accountHolder?: string
  }
  selectedFeatures?: string[]
  stripePaymentMethodId?: string // Payment method collected via Stripe Elements
}

export interface CreateVenueResult {
  venue: {
    id: string
    slug: string
    name: string
    isDemo: boolean
  }
  categoriesCreated?: number
  productsCreated?: number
  demoDataSeeded?: boolean
}

/**
 * Creates a venue based on onboarding data
 *
 * @param input - Venue creation input data
 * @returns Created venue and metadata
 */
export async function createVenueFromOnboarding(input: CreateVenueInput): Promise<CreateVenueResult> {
  const { organizationId, userId, onboardingType, businessInfo, menuData, paymentInfo, selectedFeatures, stripePaymentMethodId } = input

  // Generate unique slug
  const baseSlug = slugify(businessInfo.name)
  const slug = await generateUniqueSlug(baseSlug)

  // Determine if demo
  const isDemo = onboardingType === 'DEMO'

  // Create venue
  const venue = await prisma.venue.create({
    data: {
      organizationId,
      name: businessInfo.name,
      slug,
      type: businessInfo.venueType || 'RESTAURANT',
      timezone: businessInfo.timezone || 'America/Mexico_City',
      currency: 'MXN',
      country: businessInfo.country || 'MX',

      // Location
      address: businessInfo.address,
      city: businessInfo.city,
      state: businessInfo.state,
      zipCode: businessInfo.zipCode,

      // Contact
      phone: businessInfo.phone,
      email: businessInfo.email,

      // Demo tracking
      isDemo,
      demoExpiresAt: isDemo ? addDays(new Date(), 30) : null, // 30 days trial
      onboardingCompletedAt: new Date(),

      // Active by default
      active: true,
      operationalSince: new Date(),
    },
  })

  // Assign venue to user as OWNER
  await prisma.staffVenue.create({
    data: {
      staffId: userId,
      venueId: venue.id,
      role: 'OWNER',
      active: true,
    },
  })

  // Create venue settings
  await prisma.venueSettings.create({
    data: {
      venueId: venue.id,
      trackInventory: selectedFeatures?.includes('inventory') || false,
      lowStockAlert: selectedFeatures?.includes('inventory') || false,
      autoCloseShifts: false,
      requirePinLogin: true,
    },
  })

  const result: CreateVenueResult = {
    venue: {
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      isDemo,
    },
  }

  // Handle demo venue
  if (isDemo) {
    await seedDemoVenue(venue.id)
    result.demoDataSeeded = true
  }
  // Handle real venue with menu data
  else if (menuData && menuData.categories && menuData.products) {
    const { categoriesCreated, productsCreated } = await createMenuFromOnboarding(venue.id, menuData)
    result.categoriesCreated = categoriesCreated
    result.productsCreated = productsCreated
  }

  // Create payment config if CLABE provided
  if (paymentInfo?.clabe) {
    // TODO: Create VenuePaymentConfig with CLABE
    // This will be implemented when payment provider integration is ready
    // For now, just store it as venue metadata
  }

  // Enable selected premium features with Stripe trial
  logger.info(`🔍 Checking premium features for venue ${venue.id}:`, {
    selectedFeatures: selectedFeatures || [],
    featuresCount: selectedFeatures?.length || 0,
    hasPaymentMethod: !!stripePaymentMethodId,
    paymentMethodId: stripePaymentMethodId || 'none',
  })

  if (selectedFeatures && selectedFeatures.length > 0) {
    logger.info(`✅ Enabling ${selectedFeatures.length} premium features for venue ${venue.id}`)
    await enablePremiumFeatures(
      venue.id,
      businessInfo.email || '',
      businessInfo.name,
      selectedFeatures,
      stripePaymentMethodId,
      venue.name, // venueName
      venue.slug, // venueSlug
    )
  } else {
    logger.warn(`⚠️ No premium features to enable for venue ${venue.id} (selectedFeatures is empty or null)`)
  }

  return result
}

/**
 * Generates a unique slug for a venue
 *
 * @param baseSlug - Base slug to start from
 * @returns Unique slug
 */
async function generateUniqueSlug(baseSlug: string): Promise<string> {
  let slug = baseSlug
  let counter = 1

  // Check if slug exists
  while (await slugExists(slug)) {
    slug = `${baseSlug}-${counter}`
    counter++
  }

  return slug
}

/**
 * Checks if a slug already exists
 *
 * @param slug - Slug to check
 * @returns true if exists, false otherwise
 */
async function slugExists(slug: string): Promise<boolean> {
  const existing = await prisma.venue.findUnique({
    where: { slug },
  })
  return existing !== null
}

/**
 * Creates menu (categories + products) from onboarding data
 *
 * @param venueId - Venue ID
 * @param menuData - Menu data from onboarding
 * @returns Number of categories and products created
 */
async function createMenuFromOnboarding(
  venueId: string,
  menuData: NonNullable<CreateVenueInput['menuData']>,
): Promise<{ categoriesCreated: number; productsCreated: number }> {
  const { categories = [], products = [] } = menuData

  // Create categories first
  const categoryMap = new Map<string, string>() // slug -> id

  for (const category of categories) {
    const created = await prisma.menuCategory.create({
      data: {
        venueId,
        name: category.name,
        slug: category.slug,
        description: category.description,
        active: true,
      },
    })
    categoryMap.set(category.slug, created.id)
  }

  // Create products
  for (const product of products) {
    const categoryId = categoryMap.get(product.categorySlug)
    if (!categoryId) {
      logger.warn(`Category ${product.categorySlug} not found for product ${product.name}`)
      continue
    }

    await prisma.product.create({
      data: {
        venueId,
        categoryId,
        name: product.name,
        sku: product.sku,
        description: product.description,
        price: product.price,
        type: (product.type as any) || 'FOOD',
        active: true,
      },
    })
  }

  return {
    categoriesCreated: categories.length,
    productsCreated: products.length,
  }
}

/**
 * Enables premium features for a venue with Stripe trial subscriptions
 *
 * @param venueId - Venue ID
 * @param organizationId - Organization ID
 * @param email - Organization email
 * @param name - Organization name
 * @param featureCodes - Array of feature codes to enable
 * @param paymentMethodId - Optional Stripe payment method ID
 * @param venueName - Venue name for identification
 * @param venueSlug - Venue slug for identification
 */
async function enablePremiumFeatures(
  venueId: string,
  email: string,
  name: string,
  featureCodes: string[],
  paymentMethodId?: string,
  venueName?: string,
  venueSlug?: string,
): Promise<void> {
  try {
    logger.info(`🎯 Enabling premium features for venue ${venueId}: ${featureCodes.join(', ')}`)

    // Step 1: Get or create Stripe customer (with venue info)
    const customerId = await stripeService.getOrCreateStripeCustomer(venueId, email, name, venueName, venueSlug)

    // Step 2: Attach payment method if provided
    if (paymentMethodId) {
      await stripeService.updatePaymentMethod(customerId, paymentMethodId)
      logger.info(`✅ Payment method attached to customer ${customerId}`)
    }

    // Step 3: Ensure features are synced to Stripe
    await stripeService.syncFeaturesToStripe()

    // Step 4: Create trial subscriptions (2 days) with venue info and payment method
    const subscriptionIds = await stripeService.createTrialSubscriptions(
      customerId,
      venueId,
      featureCodes,
      2,
      venueName,
      venueSlug,
      paymentMethodId,
    )

    logger.info(`✅ Created ${subscriptionIds.length} trial subscriptions for venue ${venueId}`)
  } catch (error) {
    logger.error(`❌ Error enabling premium features for venue ${venueId}:`, error)
    // Don't throw - allow venue creation to succeed even if Stripe fails
    // Features will be created but without Stripe subscription
    logger.warn(`⚠️  Falling back to non-Stripe feature creation`)

    // Fallback: Create VenueFeature records without Stripe
    const features = await prisma.feature.findMany({
      where: {
        code: {
          in: featureCodes,
        },
        active: true,
      },
    })

    for (const feature of features) {
      await prisma.venueFeature.create({
        data: {
          venueId,
          featureId: feature.id,
          active: true,
          monthlyPrice: feature.monthlyPrice,
          startDate: new Date(),
          endDate: addDays(new Date(), 5), // 5 day trial
        },
      })
    }
  }
}
