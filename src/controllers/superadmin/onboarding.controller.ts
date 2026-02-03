/**
 * Superadmin Onboarding Controller
 *
 * Orchestrates the full venue creation wizard. Accepts all wizard data
 * in a single request and executes each step sequentially.
 *
 * Org + Venue creation are wrapped in a $transaction.
 * Remaining steps (pricing, terminal, settlement, invitations, features)
 * run individually — partial failures don't roll back the venue.
 */

import { Request, Response, NextFunction } from 'express'
import { Prisma, VenueStatus, AccountType, StaffRole, OrgRole, InvitationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { generateSlug, validateSlug } from '@/utils/slugify'
import { bulkCreateSettlementConfigurations } from '@/services/superadmin/settlementConfiguration.service'
import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'
import { moduleService } from '@/services/modules/module.service'
import emailService from '@/services/email.service'
import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import { addDays } from 'date-fns'
import crypto from 'crypto'

// ─── Types ───────────────────────────────────────────────────────────

interface StepResult {
  step: string
  status: 'success' | 'skipped' | 'error'
  message?: string
  data?: Record<string, unknown>
}

interface WizardPayload {
  // Step 1: Organization & Venue
  organization: {
    mode: 'existing' | 'new'
    id?: string // when mode === 'existing'
    name?: string
    email?: string
    phone?: string
  }
  venue: {
    name: string
    slug?: string // auto-generated if omitted
    venueType: string
    timezone?: string
    currency?: string
    address?: string
    city?: string
    state?: string
    zipCode?: string
    latitude?: number
    longitude?: number
    phone?: string
    email?: string
    website?: string
    entityType?: 'PERSONA_FISICA' | 'PERSONA_MORAL'
    rfc?: string
    legalName?: string
    zoneId?: string
  }

  // Step 2: Payment Configuration
  pricing?: {
    debitRate: number
    creditRate: number
    amexRate: number
    internationalRate: number
    fixedFeePerTransaction?: number
    monthlyServiceFee?: number
    useOrgConfig?: boolean
    // Merchant account to link to venue (when not using org config)
    merchantAccountId?: string
    // Create org-level config if it doesn't exist yet
    createOrgConfig?: {
      primaryAccountId: string
      secondaryAccountId?: string
      tertiaryAccountId?: string
      preferredProcessor?: string
    }
  }

  // Step 3: Terminal & Merchant (optional)
  terminal?: {
    serialNumber: string
    brand: string
    model: string
    name?: string
    environment: 'SANDBOX' | 'PRODUCTION'
  }

  // Step 4: Settlement
  settlement?: {
    debitDays?: number
    creditDays?: number
    amexDays?: number
    internationalDays?: number
    otherDays?: number
    dayType?: 'BUSINESS_DAYS' | 'CALENDAR_DAYS'
    cutoffTime?: string
    cutoffTimezone?: string
  }

  // Step 5: Team & Features
  team?: {
    owner: { email: string; firstName: string; lastName: string; role?: string }
    additionalStaff?: Array<{ email: string; firstName: string; lastName: string; role: string }>
  }
  features?: string[] // Feature codes
  modules?: Array<{ code: string; config?: Record<string, unknown>; preset?: string }>
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function generateUniqueSlug(base: string): Promise<string> {
  const slug = base
  let suffix = 0
  while (true) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix}`
    const existing = await prisma.venue.findUnique({ where: { slug: candidate }, select: { id: true } })
    if (!existing) return candidate
    suffix++
  }
}

// ─── Main Handler ────────────────────────────────────────────────────

/**
 * POST /api/v1/superadmin/onboarding/venue
 *
 * Creates a fully-configured venue from the wizard payload.
 */
export async function createVenueWizard(req: Request, res: Response, next: NextFunction) {
  try {
    const payload = req.body as WizardPayload
    const { userId } = (req as any).authContext
    const steps: StepResult[] = []

    // ─── Validate required fields ──────────────────────────────
    if (!payload.organization) throw new BadRequestError('organization is required')
    if (!payload.venue?.name) throw new BadRequestError('venue.name is required')
    if (!payload.venue?.venueType) throw new BadRequestError('venue.venueType is required')

    if (payload.organization.mode === 'existing' && !payload.organization.id) {
      throw new BadRequestError('organization.id is required when mode is "existing"')
    }
    if (payload.organization.mode === 'new') {
      if (!payload.organization.name) throw new BadRequestError('organization.name is required for new org')
      if (!payload.organization.email) throw new BadRequestError('organization.email is required for new org')
      if (!payload.organization.phone) throw new BadRequestError('organization.phone is required for new org')
    }

    // ─── Step 1: Organization + Venue (transactional) ──────────
    let organizationId: string
    let venueId: string
    let venueSlug: string

    try {
      const result = await prisma.$transaction(async tx => {
        // Organization
        let orgId: string
        if (payload.organization.mode === 'new') {
          const orgSlug = generateSlug(payload.organization.name!)
          const org = await tx.organization.create({
            data: {
              name: payload.organization.name!,
              slug: orgSlug,
              email: payload.organization.email!,
              phone: payload.organization.phone!,
            },
          })
          orgId = org.id
        } else {
          orgId = payload.organization.id!
          // Verify org exists
          const existing = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } })
          if (!existing) throw new BadRequestError(`Organization ${orgId} not found`)
        }

        // Venue
        const baseSlug = payload.venue.slug || generateSlug(payload.venue.name)
        const slugValidation = validateSlug(baseSlug)
        if (!slugValidation.isValid) throw new BadRequestError(`Invalid slug: ${slugValidation.error}`)

        // For unique slug we need to check outside tx, but slug collision is rare
        // If it collides, the unique constraint will catch it
        const slug = await generateUniqueSlug(baseSlug)

        const venue = await tx.venue.create({
          data: {
            organizationId: orgId,
            name: payload.venue.name,
            slug,
            type: payload.venue.venueType as any,
            timezone: payload.venue.timezone || 'America/Mexico_City',
            currency: payload.venue.currency || 'MXN',
            country: 'MX',
            address: payload.venue.address,
            city: payload.venue.city,
            state: payload.venue.state,
            zipCode: payload.venue.zipCode,
            latitude: payload.venue.latitude ? new Prisma.Decimal(payload.venue.latitude) : null,
            longitude: payload.venue.longitude ? new Prisma.Decimal(payload.venue.longitude) : null,
            phone: payload.venue.phone,
            email: payload.venue.email,
            website: payload.venue.website,
            entityType: payload.venue.entityType as any,
            rfc: payload.venue.rfc,
            legalName: payload.venue.legalName,
            zoneId: payload.venue.zoneId || null,
            status: VenueStatus.ONBOARDING,
            statusChangedAt: new Date(),
            active: false,
          },
        })

        // Create VenueSettings
        await tx.venueSettings.create({
          data: { venueId: venue.id },
        })

        return { orgId, venueId: venue.id, venueSlug: slug }
      })

      organizationId = result.orgId
      venueId = result.venueId
      venueSlug = result.venueSlug

      steps.push({
        step: 'organization',
        status: 'success',
        data: {
          organizationId,
          isNew: payload.organization.mode === 'new',
        },
      })
      steps.push({
        step: 'venue',
        status: 'success',
        data: { venueId, venueSlug },
      })
    } catch (error: any) {
      logger.error('Onboarding wizard: org+venue creation failed', { error: error.message })
      throw error // Can't continue without org+venue
    }

    // ─── Step 2: Pricing ───────────────────────────────────────
    if (payload.pricing?.useOrgConfig) {
      // Use org-level config. Create OrganizationPaymentConfig + OrganizationPricingStructure if needed.
      try {
        const existingOrgConfig = await prisma.organizationPaymentConfig.findUnique({
          where: { organizationId },
        })

        if (!existingOrgConfig && payload.pricing.createOrgConfig?.primaryAccountId) {
          // Create OrganizationPaymentConfig
          await prisma.organizationPaymentConfig.create({
            data: {
              organizationId,
              primaryAccountId: payload.pricing.createOrgConfig.primaryAccountId,
              secondaryAccountId: payload.pricing.createOrgConfig.secondaryAccountId || null,
              tertiaryAccountId: payload.pricing.createOrgConfig.tertiaryAccountId || null,
              preferredProcessor: (payload.pricing.createOrgConfig.preferredProcessor as any) || 'AUTO',
            },
          })

          // Create OrganizationPricingStructure with the rates from the form
          await prisma.organizationPricingStructure.create({
            data: {
              organizationId,
              accountType: AccountType.PRIMARY,
              debitRate: new Prisma.Decimal(payload.pricing.debitRate),
              creditRate: new Prisma.Decimal(payload.pricing.creditRate),
              amexRate: new Prisma.Decimal(payload.pricing.amexRate),
              internationalRate: new Prisma.Decimal(payload.pricing.internationalRate),
              fixedFeePerTransaction: payload.pricing.fixedFeePerTransaction
                ? new Prisma.Decimal(payload.pricing.fixedFeePerTransaction)
                : null,
              monthlyServiceFee: payload.pricing.monthlyServiceFee ? new Prisma.Decimal(payload.pricing.monthlyServiceFee) : null,
              effectiveFrom: new Date(),
              active: true,
            },
          })

          steps.push({ step: 'pricing', status: 'success', message: 'Organization payment config + pricing created' })
        } else if (existingOrgConfig) {
          steps.push({ step: 'pricing', status: 'success', message: 'Using existing organization config' })
        } else {
          steps.push({
            step: 'pricing',
            status: 'skipped',
            message: 'useOrgConfig set but no primaryAccountId provided and org has no config',
          })
        }
      } catch (error: any) {
        logger.error('Onboarding wizard: org pricing creation failed', { error: error.message, organizationId })
        steps.push({ step: 'pricing', status: 'error', message: error.message })
      }
    } else if (payload.pricing) {
      // Create venue-level pricing + VenuePaymentConfig
      try {
        await prisma.venuePricingStructure.create({
          data: {
            venueId,
            accountType: AccountType.PRIMARY,
            debitRate: new Prisma.Decimal(payload.pricing.debitRate),
            creditRate: new Prisma.Decimal(payload.pricing.creditRate),
            amexRate: new Prisma.Decimal(payload.pricing.amexRate),
            internationalRate: new Prisma.Decimal(payload.pricing.internationalRate),
            fixedFeePerTransaction: payload.pricing.fixedFeePerTransaction
              ? new Prisma.Decimal(payload.pricing.fixedFeePerTransaction)
              : null,
            monthlyServiceFee: payload.pricing.monthlyServiceFee ? new Prisma.Decimal(payload.pricing.monthlyServiceFee) : null,
            effectiveFrom: new Date(),
          },
        })

        // Create VenuePaymentConfig if a merchant account was selected
        if (payload.pricing.merchantAccountId) {
          await prisma.venuePaymentConfig.create({
            data: {
              venueId,
              primaryAccountId: payload.pricing.merchantAccountId,
            },
          })
        }

        steps.push({ step: 'pricing', status: 'success' })
      } catch (error: any) {
        logger.error('Onboarding wizard: venue pricing creation failed', { error: error.message, venueId })
        steps.push({ step: 'pricing', status: 'error', message: error.message })
      }
    } else {
      steps.push({ step: 'pricing', status: 'skipped' })
    }

    // ─── Step 3: Terminal (optional) ───────────────────────────
    // Creates a Terminal record for the venue. Blumon auto-fetch (which creates
    // MerchantAccount + credentials) should be called from the frontend BEFORE
    // submitting the wizard, or separately after. If auto-fetch was done, the
    // merchantAccountId is passed in pricing.merchantAccountId and linked above.
    if (payload.terminal?.serialNumber) {
      try {
        const terminal = await prisma.terminal.create({
          data: {
            venueId,
            serialNumber: payload.terminal.serialNumber,
            brand: payload.terminal.brand || 'PAX',
            model: payload.terminal.model || '',
            name: payload.terminal.name || `Terminal ${payload.terminal.serialNumber}`,
            type: 'TPV_ANDROID',
            status: 'ACTIVE',
            // If a merchant account was linked, attach it to the terminal
            ...(payload.pricing?.merchantAccountId ? { assignedMerchantIds: [payload.pricing.merchantAccountId] } : {}),
          },
        })
        steps.push({
          step: 'terminal',
          status: 'success',
          data: { terminalId: terminal.id },
        })
      } catch (error: any) {
        logger.error('Onboarding wizard: terminal creation failed', { error: error.message, venueId })
        steps.push({ step: 'terminal', status: 'error', message: error.message })
      }
    } else {
      steps.push({ step: 'terminal', status: 'skipped' })
    }

    // ─── Step 4: Settlement ────────────────────────────────────
    // Settlement configs require a merchantAccountId. Resolve via inheritance
    // (VenuePaymentConfig → OrganizationPaymentConfig). If no config found, skip.
    if (payload.settlement) {
      // Use effective payment config (supports org-level inheritance)
      const effectiveConfig = await getEffectivePaymentConfig(venueId)
      const merchantAccountId = effectiveConfig?.config?.primaryAccountId || null
      const merchantAccount = merchantAccountId ? { id: merchantAccountId } : null

      if (merchantAccount) {
        try {
          const cardTypes = ['DEBIT', 'CREDIT', 'AMEX', 'INTERNATIONAL', 'OTHER'] as const
          const dayMapping = {
            DEBIT: payload.settlement.debitDays ?? 1,
            CREDIT: payload.settlement.creditDays ?? 3,
            AMEX: payload.settlement.amexDays ?? 5,
            INTERNATIONAL: payload.settlement.internationalDays ?? 5,
            OTHER: payload.settlement.otherDays ?? 3,
          }

          await bulkCreateSettlementConfigurations(
            merchantAccount.id,
            cardTypes.map(cardType => ({
              cardType: cardType as any,
              settlementDays: dayMapping[cardType],
              settlementDayType: (payload.settlement!.dayType || 'BUSINESS_DAYS') as any,
              cutoffTime: payload.settlement!.cutoffTime || '23:00',
              cutoffTimezone: payload.settlement!.cutoffTimezone || 'America/Mexico_City',
            })),
            new Date(),
            userId,
          )
          steps.push({ step: 'settlement', status: 'success' })
        } catch (error: any) {
          logger.error('Onboarding wizard: settlement config failed', { error: error.message, venueId })
          steps.push({ step: 'settlement', status: 'error', message: error.message })
        }
      } else {
        steps.push({
          step: 'settlement',
          status: 'skipped',
          message: 'No merchant account found. Create terminal first, then configure settlement.',
        })
      }
    } else {
      steps.push({ step: 'settlement', status: 'skipped' })
    }

    // ─── Step 5a: Team Invitations ─────────────────────────────
    if (payload.team?.owner) {
      try {
        const allInvites = [{ ...payload.team.owner, role: payload.team.owner.role || 'OWNER' }, ...(payload.team.additionalStaff || [])]

        const org = await prisma.organization.findUnique({
          where: { id: organizationId },
          select: { name: true },
        })
        const venue = await prisma.venue.findUnique({
          where: { id: venueId },
          select: { name: true },
        })

        for (const invite of allInvites) {
          const token = crypto.randomBytes(32).toString('hex')
          const expiresAt = addDays(new Date(), 7)

          // Create or find staff record
          let staff = await prisma.staff.findUnique({ where: { email: invite.email } })
          if (!staff) {
            staff = await prisma.staff.create({
              data: {
                email: invite.email,
                firstName: invite.firstName,
                lastName: invite.lastName,
              },
            })
          }

          // Ensure StaffOrganization exists
          const existingStaffOrg = await prisma.staffOrganization.findUnique({
            where: {
              staffId_organizationId: { staffId: staff.id, organizationId },
            },
          })
          if (!existingStaffOrg) {
            await prisma.staffOrganization.create({
              data: {
                staffId: staff.id,
                organizationId,
                role: invite.role === 'OWNER' ? OrgRole.OWNER : OrgRole.MEMBER,
                isPrimary: true,
              },
            })
          }

          // Create invitation
          await prisma.invitation.create({
            data: {
              email: invite.email,
              token,
              type: invite.role === 'OWNER' || invite.role === 'ADMIN' ? 'VENUE_ADMIN' : 'VENUE_STAFF',
              status: InvitationStatus.PENDING,
              role: invite.role as StaffRole,
              venueId,
              organizationId,
              invitedById: userId,
              expiresAt,
            },
          })

          // Send email
          const inviteLink = `${process.env.DASHBOARD_URL || 'https://dashboard.avoqado.io'}/invitations/${token}`
          try {
            await emailService.sendTeamInvitation(invite.email, {
              inviterName: 'Superadmin',
              venueName: venue?.name || payload.venue.name,
              organizationName: org?.name || 'Avoqado',
              role: invite.role,
              inviteLink,
            })
          } catch (emailErr: any) {
            logger.warn('Onboarding wizard: invitation email failed', { email: invite.email, error: emailErr.message })
          }
        }

        steps.push({
          step: 'invitations',
          status: 'success',
          data: { count: allInvites.length },
        })
      } catch (error: any) {
        logger.error('Onboarding wizard: invitation step failed', { error: error.message, venueId })
        steps.push({ step: 'invitations', status: 'error', message: error.message })
      }
    } else {
      steps.push({ step: 'invitations', status: 'skipped' })
    }

    // ─── Step 5b: Features ─────────────────────────────────────
    if (payload.features && payload.features.length > 0) {
      try {
        const features = await prisma.feature.findMany({
          where: { code: { in: payload.features }, active: true },
        })

        for (const feature of features) {
          await prisma.venueFeature.create({
            data: {
              venueId,
              featureId: feature.id,
              active: true,
              monthlyPrice: feature.monthlyPrice,
              startDate: new Date(),
            },
          })
        }

        steps.push({
          step: 'features',
          status: 'success',
          data: { enabled: features.map(f => f.code) },
        })
      } catch (error: any) {
        logger.error('Onboarding wizard: features step failed', { error: error.message, venueId })
        steps.push({ step: 'features', status: 'error', message: error.message })
      }
    } else {
      steps.push({ step: 'features', status: 'skipped' })
    }

    // ─── Step 5c: Modules ──────────────────────────────────────
    if (payload.modules && payload.modules.length > 0) {
      try {
        for (const mod of payload.modules) {
          await moduleService.enableModule(venueId, mod.code as any, userId, mod.config, mod.preset)
        }
        steps.push({
          step: 'modules',
          status: 'success',
          data: { enabled: payload.modules.map(m => m.code) },
        })
      } catch (error: any) {
        logger.error('Onboarding wizard: modules step failed', { error: error.message, venueId })
        steps.push({ step: 'modules', status: 'error', message: error.message })
      }
    } else {
      steps.push({ step: 'modules', status: 'skipped' })
    }

    // ─── Response ──────────────────────────────────────────────
    logger.info('Onboarding wizard completed', {
      venueId,
      venueSlug,
      organizationId,
      steps: steps.map(s => `${s.step}:${s.status}`).join(', '),
    })

    res.status(201).json({
      success: true,
      venueId,
      venueSlug,
      organizationId,
      steps,
    })
  } catch (error) {
    next(error)
  }
}

// ─── Helper Endpoints ────────────────────────────────────────

/**
 * GET /api/v1/superadmin/onboarding/org-payment-status/:orgId
 *
 * Returns whether the org has an OrganizationPaymentConfig and its pricing.
 */
export async function getOrgPaymentStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params

    const config = await prisma.organizationPaymentConfig.findUnique({
      where: { organizationId: orgId },
      include: {
        primaryAccount: { include: { provider: true } },
        secondaryAccount: { include: { provider: true } },
        tertiaryAccount: { include: { provider: true } },
      },
    })

    const pricing = await prisma.organizationPricingStructure.findMany({
      where: { organizationId: orgId, active: true },
      orderBy: { effectiveFrom: 'desc' },
    })

    res.json({
      hasConfig: !!config,
      config,
      pricing,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/onboarding/merchant-accounts
 *
 * Returns active merchant accounts for the org config selector dropdown.
 */
/**
 * GET /api/v1/superadmin/onboarding/organizations
 *
 * Returns organizations with venue count and payment config status for the wizard selector.
 */
export async function getOrganizationsForSelector(req: Request, res: Response, next: NextFunction) {
  try {
    const organizations = await prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        email: true,
        _count: { select: { venues: true } },
      },
      orderBy: { name: 'asc' },
    })

    // Check payment config existence in bulk
    const orgIds = organizations.map(o => o.id)
    const paymentConfigs = await prisma.organizationPaymentConfig.findMany({
      where: { organizationId: { in: orgIds } },
      select: { organizationId: true },
    })
    const configSet = new Set(paymentConfigs.map(c => c.organizationId))

    const data = organizations.map(org => ({
      ...org,
      hasPaymentConfig: configSet.has(org.id),
    }))

    res.json({ data })
  } catch (error) {
    next(error)
  }
}

export async function getMerchantAccountsForSelector(req: Request, res: Response, next: NextFunction) {
  try {
    const accounts = await prisma.merchantAccount.findMany({
      where: { active: true },
      select: {
        id: true,
        displayName: true,
        alias: true,
        externalMerchantId: true,
        provider: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ data: accounts })
  } catch (error) {
    next(error)
  }
}
