/**
 * Venue Creation Service (Onboarding)
 *
 * Handles creation of venues during onboarding flow.
 * Supports both demo venues (pre-populated) and real business venues.
 */

import {
  BusinessType,
  EntityType,
  OnboardingType,
  VenueType,
  InvitationType,
  InvitationStatus,
  StaffRole,
  VenueStatus,
  OrgRole,
} from '@prisma/client'
import { addDays } from 'date-fns'
import prisma from '@/utils/prismaClient'
import { generateSlug as slugify, validateSlug } from '@/utils/slugify'
import { seedDemoVenue } from './demoSeed.service'
import * as stripeService from '@/services/stripe.service'
import * as kycReviewService from '@/services/superadmin/kycReview.service'
import emailService from '@/services/email.service'
import * as resendService from '@/services/resend.service'
import logger from '@/config/logger'
import { OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import { logAction } from '../dashboard/activity-log.service'

// Types
export interface CreateVenueInput {
  organizationId: string
  userId: string // User to assign as venue owner
  onboardingType: OnboardingType
  businessInfo: {
    name: string
    type?: BusinessType
    venueType?: VenueType
    entityType?: 'PERSONA_FISICA' | 'PERSONA_MORAL' // Legal entity type
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
  kycDocuments?: {
    entityType: 'PERSONA_FISICA' | 'PERSONA_MORAL'
    documents: {
      ineUrl?: string
      rfcDocumentUrl?: string
      comprobanteDomicilioUrl?: string
      caratulaBancariaUrl?: string
      actaDocumentUrl?: string
      poderLegalUrl?: string
    }
  }
  paymentInfo?: {
    clabe: string
    bankName?: string
    accountHolder: string
  }
  selectedFeatures?: string[]
  stripePaymentMethodId?: string // Payment method collected via Stripe Elements
  teamInvites?: Array<{
    email: string
    firstName: string
    lastName: string
    role: string
  }>
}

export interface CreateVenueResult {
  venue: {
    id: string
    slug: string
    name: string
    status: VenueStatus // Single source of truth for venue lifecycle
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
  const {
    organizationId,
    userId,
    onboardingType,
    businessInfo,
    menuData,
    kycDocuments,
    paymentInfo,
    selectedFeatures,
    stripePaymentMethodId,
    teamInvites,
  } = input

  // Generate unique slug
  const baseSlug = slugify(businessInfo.name)

  // Validate the base slug is not a reserved word
  const slugValidation = validateSlug(baseSlug)
  if (!slugValidation.isValid) {
    throw new Error(slugValidation.error)
  }

  const slug = await generateUniqueSlug(baseSlug)

  // Determine if onboarding demo
  const isOnboardingDemo = onboardingType === 'DEMO'

  // Check if any KYC documents were provided (for real venues)
  const hasKycDocuments =
    kycDocuments?.documents?.ineUrl ||
    kycDocuments?.documents?.rfcDocumentUrl ||
    kycDocuments?.documents?.comprobanteDomicilioUrl ||
    kycDocuments?.documents?.caratulaBancariaUrl ||
    kycDocuments?.documents?.actaDocumentUrl ||
    kycDocuments?.documents?.poderLegalUrl

  // Determine KYC status:
  // - DEMO venues (status: TRIAL): NOT_SUBMITTED (KYC not required for demos)
  // - REAL venues with documents: PENDING_REVIEW (awaiting admin review)
  // - REAL venues without documents: NOT_SUBMITTED (needs to upload documents first)
  const kycStatus = hasKycDocuments ? 'PENDING_REVIEW' : 'NOT_SUBMITTED'

  // Determine venue operational status:
  // - DEMO venues: TRIAL (30-day demo trial)
  // - REAL venues with KYC submitted: PENDING_ACTIVATION (awaiting KYC approval)
  // - REAL venues without KYC: ONBOARDING (needs to complete setup)
  const venueStatus: VenueStatus = isOnboardingDemo
    ? VenueStatus.TRIAL
    : hasKycDocuments
      ? VenueStatus.PENDING_ACTIVATION
      : VenueStatus.ONBOARDING

  // Lookup the signup Staff so we can:
  //   1. Fall back to their email if the wizard did not collect a business email
  //      (V2 wizard does not currently expose this field).
  //   2. Include their contact in the admin digest email below.
  const ownerStaff = await prisma.staff.findUnique({
    where: { id: userId },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  })

  // Final venue email: explicit business email > owner signup email > null
  const resolvedVenueEmail = businessInfo.email?.trim() || ownerStaff?.email || null

  // Create venue
  const venue = await prisma.venue.create({
    data: {
      organizationId,
      name: businessInfo.name,
      slug,
      type:
        businessInfo.venueType && Object.values(VenueType).includes(businessInfo.venueType) ? businessInfo.venueType : VenueType.RESTAURANT,
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
      email: resolvedVenueEmail,

      // Legal Entity Type (from KYC documents step or business info)
      // Validate against Prisma EntityType enum to prevent PrismaClientValidationError
      entityType: (() => {
        const raw = kycDocuments?.entityType || businessInfo.entityType
        return raw && Object.values(EntityType).includes(raw as EntityType) ? (raw as EntityType) : undefined
      })(),

      // KYC Documents (from step 7)
      idDocumentUrl: kycDocuments?.documents?.ineUrl, // INE/IFE
      rfcDocumentUrl: kycDocuments?.documents?.rfcDocumentUrl,
      comprobanteDomicilioUrl: kycDocuments?.documents?.comprobanteDomicilioUrl,
      caratulaBancariaUrl: kycDocuments?.documents?.caratulaBancariaUrl,
      actaDocumentUrl: kycDocuments?.documents?.actaDocumentUrl, // Acta Constitutiva
      poderLegalUrl: kycDocuments?.documents?.poderLegalUrl,

      // Note: CLABE/payment info stored in OnboardingProgress.step8_paymentInfo
      // Will be used when creating MerchantAccount after KYC approval

      // KYC Status based on onboarding type and documents
      kycStatus,

      // ✅ Venue operational status - single source of truth
      // Use status (TRIAL, ONBOARDING, PENDING_ACTIVATION, etc.) to determine venue state
      status: venueStatus,
      statusChangedAt: new Date(),
      demoExpiresAt: venueStatus === VenueStatus.TRIAL ? addDays(new Date(), 30) : null, // 30 days trial
      onboardingCompletedAt: new Date(),

      // Active by default (backwards compatibility - computed from status)
      active: OPERATIONAL_VENUE_STATUSES.includes(venueStatus),
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
      // Bad review notification settings (enabled by default)
      notifyBadReviews: true,
      badReviewThreshold: 3, // Notify for ratings <= 3 (1, 2, 3)
      badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER'],
    },
  })

  const result: CreateVenueResult = {
    venue: {
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      status: venueStatus, // Single source of truth
    },
  }

  // Handle onboarding demo venue
  if (isOnboardingDemo) {
    const seedResult = await seedDemoVenue(venue.id)
    result.demoDataSeeded = true
    result.categoriesCreated = seedResult.categoriesCreated
    result.productsCreated = seedResult.productsCreated
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

  // Admin notifications for REAL onboarding (demos generate noise — skip).
  if (!isOnboardingDemo) {
    // 1) Always send a full-context digest to onboarding@avoqado.io so the team can
    //    follow up even when the wizard skipped KYC docs. Fire-and-forget;
    //    failure here must NOT block onboarding completion.
    void resendService
      .sendNewVenueOnboardingDigest({
        venueId: venue.id,
        venueName: venue.name,
        venueSlug: venue.slug,
        venueStatus,
        kycStatus,
        hasKycDocuments: Boolean(hasKycDocuments),
        businessInfo: {
          phone: businessInfo.phone || null,
          email: resolvedVenueEmail,
          address: businessInfo.address || null,
          city: businessInfo.city || null,
          state: businessInfo.state || null,
          country: businessInfo.country || null,
          zipCode: businessInfo.zipCode || null,
          entityType: kycDocuments?.entityType || businessInfo.entityType || null,
        },
        owner: ownerStaff
          ? {
              firstName: ownerStaff.firstName || '',
              lastName: ownerStaff.lastName || '',
              email: ownerStaff.email,
              phone: ownerStaff.phone || null,
            }
          : null,
        paymentInfo: paymentInfo
          ? {
              clabe: paymentInfo.clabe,
              bankName: paymentInfo.bankName || null,
              accountHolder: paymentInfo.accountHolder,
            }
          : null,
      })
      .catch(err => {
        logger.error(`Failed to send new-venue digest for ${venue.id}:`, err)
      })

    // 2) Welcome the owner so they know we received their data and what's
    //    next. Without this, completing onboarding lands them on a dashboard
    //    with no confirmation that anything happened on our side.
    //    Fire-and-forget; failure must NOT block onboarding.
    if (ownerStaff?.email) {
      void resendService
        .sendOnboardingWelcomeEmail({
          ownerEmail: ownerStaff.email,
          ownerFirstName: ownerStaff.firstName || '',
          venueName: venue.name,
          venueSlug: venue.slug,
          hasKycDocuments: Boolean(hasKycDocuments),
        })
        .catch(err => {
          logger.error(`Failed to send onboarding welcome for ${venue.id}:`, err)
        })
    }

    // 3) If KYC docs were uploaded, also fire the existing in-app + email
    //    superadmin notification so the review queue picks it up.
    if (hasKycDocuments) {
      logger.info(`📤 Notifying superadmins about new KYC submission from ${venue.name}`)
      await kycReviewService.notifySuperadminsNewKycSubmission(venue.id, venue.name)
    }
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

  // Process team invitations (create invitations and send emails)
  if (teamInvites && teamInvites.length > 0) {
    // Get organization info for email
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    })

    if (organization) {
      await processTeamInvites(venue.id, organizationId, userId, teamInvites, venue.name, organization.name)
    } else {
      logger.warn(`⚠️  Organization ${organizationId} not found, skipping team invites`)
    }
  }

  logAction({
    staffId: userId,
    venueId: venue.id,
    action: 'VENUE_CREATED_FROM_ONBOARDING',
    entity: 'Venue',
    entityId: venue.id,
    data: { venueSlug: venue.slug, venueName: venue.name, onboardingType, venueStatus },
  })

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

/**
 * Processes team invites from onboarding by creating invitation records and sending emails
 *
 * @param venueId - Venue ID
 * @param organizationId - Organization ID
 * @param inviterStaffId - Staff ID of the user who created the venue (owner)
 * @param teamInvites - Array of team member invitations
 * @param venueName - Venue name for email
 * @param organizationName - Organization name for email
 */
async function processTeamInvites(
  venueId: string,
  organizationId: string,
  inviterStaffId: string,
  teamInvites: Array<{ email: string; firstName: string; lastName: string; role: string }>,
  venueName: string,
  organizationName: string,
): Promise<void> {
  if (!teamInvites || teamInvites.length === 0) {
    logger.info(`No team invites to process for venue ${venueId}`)
    return
  }

  logger.info(`📧 Processing ${teamInvites.length} team invites for venue ${venueId}`)

  // Get inviter info for email personalization
  const inviter = await prisma.staff.findUnique({
    where: { id: inviterStaffId },
    select: {
      firstName: true,
      lastName: true,
    },
  })

  if (!inviter) {
    logger.error(`❌ Inviter ${inviterStaffId} not found, cannot process team invites`)
    return
  }

  const inviterName = `${inviter.firstName} ${inviter.lastName}`

  for (const invite of teamInvites) {
    try {
      // Normalize email to lowercase for consistent lookups
      const normalizedEmail = invite.email.toLowerCase()

      // Validate role
      if (!Object.values(StaffRole).includes(invite.role as StaffRole)) {
        logger.warn(`⚠️  Invalid role ${invite.role} for ${normalizedEmail}, skipping`)
        continue
      }

      // Check if user already exists
      let staff = await prisma.staff.findUnique({
        where: { email: normalizedEmail },
      })

      // Check if already assigned to this venue
      if (staff) {
        const existingStaffVenue = await prisma.staffVenue.findUnique({
          where: {
            staffId_venueId: {
              staffId: staff.id,
              venueId,
            },
          },
        })

        if (existingStaffVenue && existingStaffVenue.active) {
          logger.warn(`⚠️  ${normalizedEmail} is already a team member of venue ${venueId}, skipping`)
          continue
        }
      }

      // Check for existing pending invitations
      const existingInvitation = await prisma.invitation.findFirst({
        where: {
          email: normalizedEmail,
          venueId,
          status: InvitationStatus.PENDING,
          expiresAt: {
            gt: new Date(),
          },
        },
      })

      if (existingInvitation) {
        logger.warn(`⚠️  Pending invitation already exists for ${normalizedEmail} to venue ${venueId}, skipping`)
        continue
      }

      // Create invitation
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 7) // 7 days expiry

      const invitation = await prisma.invitation.create({
        data: {
          email: normalizedEmail,
          role: invite.role as StaffRole,
          type: InvitationType.VENUE_STAFF,
          organizationId,
          venueId,
          expiresAt,
          invitedById: inviterStaffId,
        },
      })

      // If user doesn't exist, create them with org membership
      if (!staff) {
        staff = await prisma.staff.create({
          data: {
            email: normalizedEmail,
            firstName: invite.firstName,
            lastName: invite.lastName,
            active: false, // Will be activated when they accept invitation
            emailVerified: false,
            organizations: {
              create: {
                organizationId,
                role: OrgRole.MEMBER,
                isPrimary: true,
                isActive: true,
                joinedById: inviterStaffId,
              },
            },
          },
        })
      } else {
        // Existing staff — ensure they have StaffOrganization for this org
        await prisma.staffOrganization.upsert({
          where: {
            staffId_organizationId: {
              staffId: staff.id,
              organizationId,
            },
          },
          update: { isActive: true, leftAt: null },
          create: {
            staffId: staff.id,
            organizationId,
            role: OrgRole.MEMBER,
            isPrimary: false,
            isActive: true,
            joinedById: inviterStaffId,
          },
        })
      }

      // Send invitation email
      const inviteLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/invite/${invitation.token}`

      const emailSent = await emailService.sendTeamInvitation(invite.email, {
        inviterName,
        organizationName,
        venueName,
        role: invite.role as StaffRole,
        inviteLink,
      })

      if (emailSent) {
        logger.info(`✅ Team invitation sent to ${invite.email} for venue ${venueId}`)
      } else {
        logger.warn(`⚠️  Team invitation created but email not sent to ${invite.email}`)
      }
    } catch (error) {
      logger.error(`❌ Failed to process team invite for ${invite.email}:`, error)
      // Continue processing other invites even if one fails
    }
  }

  logger.info(`✅ Finished processing team invites for venue ${venueId}`)
}
