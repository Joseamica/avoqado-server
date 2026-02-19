import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { generateValidatedSlug } from '../../utils/slugify'
import { Prisma, VenueType, FeeType, TerminalType, EntityType, AccountType, TransactionCardType, SettlementDayType } from '@prisma/client'

// ── Types ────────────────────────────────────────────────────────────

interface VenueSettingsInput {
  paymentTiming?: 'PAY_BEFORE' | 'PAY_AFTER'
  inventoryDeduction?: 'ON_ORDER_CREATE' | 'ON_PAYMENT'
  trackInventory?: boolean
  enableShifts?: boolean
  acceptCash?: boolean
  acceptCard?: boolean
  acceptDigitalWallet?: boolean
}

interface TerminalInput {
  serialNumber: string
  name: string
  type: TerminalType
  brand?: string
  model?: string
}

interface PricingInput {
  debitRate: number
  creditRate: number
  amexRate: number
  internationalRate: number
  fixedFeePerTransaction?: number
  monthlyServiceFee?: number
}

interface SettlementInput {
  debitDays: number
  creditDays: number
  amexDays: number
  internationalDays: number
  otherDays: number
  dayType: SettlementDayType
  cutoffTime?: string
  cutoffTimezone?: string
}

interface VenueInput {
  name: string
  type?: VenueType
  address?: string
  city?: string
  state?: string
  country?: string
  zipCode?: string
  phone?: string
  email?: string
  timezone?: string
  currency?: string
  feeType?: FeeType
  feeValue?: number
  latitude?: number
  longitude?: number
  entityType?: EntityType
  rfc?: string
  legalName?: string
  website?: string
  settings?: VenueSettingsInput
  terminals?: TerminalInput[]
  merchantAccountId?: string
  pricing?: PricingInput
  settlement?: SettlementInput
}

interface DefaultsInput {
  type?: VenueType
  timezone?: string
  currency?: string
  country?: string
  feeType?: FeeType
  feeValue?: number
  entityType?: EntityType
  settings?: VenueSettingsInput
}

export interface BulkCreateVenuesInput {
  organizationId?: string
  organizationSlug?: string
  defaults?: DefaultsInput
  defaultMerchantAccountId?: string
  defaultPricing?: PricingInput
  defaultSettlement?: SettlementInput
  venues: VenueInput[]
}

interface TerminalResult {
  id: string
  serialNumber: string | null
  status: string
}

interface VenueResult {
  index: number
  name: string
  venueId: string
  slug: string
  status: string
  terminals: TerminalResult[]
  paymentConfigured: boolean
  pricingConfigured: boolean
  settlementConfigured: boolean
}

interface ErrorResult {
  index: number
  field: string
  error: string
}

export interface BulkCreateVenuesOutput {
  success: boolean
  summary: {
    venuesCreated: number
    venuesFailed: number
    terminalsCreated: number
    terminalsFailed: number
    paymentConfigsCreated: number
    pricingStructuresCreated: number
    settlementConfigsCreated: number
  }
  venues: VenueResult[]
  errors: ErrorResult[]
}

// ── Service ──────────────────────────────────────────────────────────

export async function bulkCreateVenues(data: BulkCreateVenuesInput): Promise<BulkCreateVenuesOutput> {
  const { defaults, venues } = data

  // 1. Resolve organization
  const organization = await resolveOrganization(data)

  // 2. Pre-validate serial numbers against DB
  const allSerials = venues.flatMap((v, i) =>
    (v.terminals || []).map((t, ti) => ({ serial: t.serialNumber, venueIndex: i, terminalIndex: ti })),
  )

  if (allSerials.length > 0) {
    // Check for duplicates within the batch
    const serialSet = new Set<string>()
    for (const { serial, venueIndex, terminalIndex } of allSerials) {
      if (serialSet.has(serial)) {
        throw new ValidationError(`Número de serie duplicado en el lote: ${serial}`, venueIndex, `terminals[${terminalIndex}].serialNumber`)
      }
      serialSet.add(serial)
    }

    // Check against existing DB serials
    const existingTerminals = await prisma.terminal.findMany({
      where: { serialNumber: { in: allSerials.map(s => s.serial) } },
      select: { serialNumber: true },
    })

    if (existingTerminals.length > 0) {
      const existingSet = new Set(existingTerminals.map(t => t.serialNumber))
      const conflict = allSerials.find(s => existingSet.has(s.serial))!
      throw new ValidationError(
        `El número de serie ya existe: ${conflict.serial}`,
        conflict.venueIndex,
        `terminals[${conflict.terminalIndex}].serialNumber`,
      )
    }
  }

  // 3. Pre-validate merchant accounts
  const merchantIds = new Set<string>()
  if (data.defaultMerchantAccountId) merchantIds.add(data.defaultMerchantAccountId)
  for (const v of venues) {
    if (v.merchantAccountId) merchantIds.add(v.merchantAccountId)
  }

  if (merchantIds.size > 0) {
    const existingMerchants = await prisma.merchantAccount.findMany({
      where: { id: { in: [...merchantIds] } },
      select: { id: true, active: true },
    })

    const foundIds = new Set(existingMerchants.map(m => m.id))
    for (const mid of merchantIds) {
      if (!foundIds.has(mid)) {
        throw new ValidationError(`Cuenta de comerciante no encontrada: ${mid}`, -1, 'merchantAccountId')
      }
    }

    const inactiveMerchant = existingMerchants.find(m => !m.active)
    if (inactiveMerchant) {
      throw new ValidationError(`Cuenta de comerciante no está activa: ${inactiveMerchant.id}`, -1, 'merchantAccountId')
    }
  }

  // 4. Pre-generate slugs (handle batch collisions + DB collisions)
  const slugs = await generateSlugsForBatch(venues)

  // 5. All-or-nothing transaction
  const results = await prisma.$transaction(async tx => {
    const venueResults: VenueResult[] = []
    let totalTerminals = 0
    let totalPaymentConfigs = 0
    let totalPricingStructures = 0
    let totalSettlementConfigs = 0

    for (let i = 0; i < venues.length; i++) {
      const venueInput = venues[i]
      const slug = slugs[i]

      // Merge defaults with per-venue overrides
      const venueType = venueInput.type || defaults?.type || 'RESTAURANT'
      const timezone = venueInput.timezone || defaults?.timezone || 'America/Mexico_City'
      const currency = venueInput.currency || defaults?.currency || 'MXN'
      const country = venueInput.country || defaults?.country || 'MX'
      const feeType = venueInput.feeType || defaults?.feeType || 'PERCENTAGE'
      const feeValue = venueInput.feeValue ?? defaults?.feeValue ?? 0.025
      const entityType = venueInput.entityType || defaults?.entityType || null

      // Create venue
      const venue = await tx.venue.create({
        data: {
          organizationId: organization.id,
          name: venueInput.name,
          slug,
          type: venueType,
          timezone,
          currency,
          country,
          address: venueInput.address || null,
          city: venueInput.city || null,
          state: venueInput.state || null,
          zipCode: venueInput.zipCode || null,
          phone: venueInput.phone || null,
          email: venueInput.email || null,
          website: venueInput.website || null,
          latitude: venueInput.latitude != null ? new Prisma.Decimal(venueInput.latitude) : null,
          longitude: venueInput.longitude != null ? new Prisma.Decimal(venueInput.longitude) : null,
          entityType,
          rfc: venueInput.rfc || null,
          legalName: venueInput.legalName || null,
          status: 'ACTIVE',
          feeType,
          feeValue: new Prisma.Decimal(feeValue),
        },
      })

      // Create venue settings (merge defaults.settings + per-venue settings)
      const mergedSettings = {
        ...(defaults?.settings || {}),
        ...(venueInput.settings || {}),
      }

      await tx.venueSettings.create({
        data: {
          venueId: venue.id,
          ...(mergedSettings.paymentTiming !== undefined && { paymentTiming: mergedSettings.paymentTiming }),
          ...(mergedSettings.inventoryDeduction !== undefined && {
            inventoryDeduction: mergedSettings.inventoryDeduction,
          }),
          ...(mergedSettings.trackInventory !== undefined && { trackInventory: mergedSettings.trackInventory }),
          ...(mergedSettings.enableShifts !== undefined && { enableShifts: mergedSettings.enableShifts }),
          ...(mergedSettings.acceptCash !== undefined && { acceptCash: mergedSettings.acceptCash }),
          ...(mergedSettings.acceptCard !== undefined && { acceptCard: mergedSettings.acceptCard }),
          ...(mergedSettings.acceptDigitalWallet !== undefined && {
            acceptDigitalWallet: mergedSettings.acceptDigitalWallet,
          }),
        },
      })

      // Create terminals
      const terminalResults: TerminalResult[] = []
      if (venueInput.terminals && venueInput.terminals.length > 0) {
        for (const terminalInput of venueInput.terminals) {
          const terminal = await tx.terminal.create({
            data: {
              venueId: venue.id,
              serialNumber: terminalInput.serialNumber,
              name: terminalInput.name,
              type: terminalInput.type,
              brand: terminalInput.brand || null,
              model: terminalInput.model || null,
              status: 'INACTIVE',
            },
          })
          terminalResults.push({
            id: terminal.id,
            serialNumber: terminal.serialNumber,
            status: terminal.status,
          })
          totalTerminals++
        }
      }

      // Create payment config if merchant account specified
      const merchantAccountId = venueInput.merchantAccountId || data.defaultMerchantAccountId
      let paymentConfigured = false

      if (merchantAccountId) {
        await tx.venuePaymentConfig.create({
          data: {
            venueId: venue.id,
            primaryAccountId: merchantAccountId,
          },
        })
        paymentConfigured = true
        totalPaymentConfigs++
      }

      // Create VenuePricingStructure (per-venue override || defaultPricing)
      const mergedPricing = venueInput.pricing || data.defaultPricing
      let pricingConfigured = false

      if (mergedPricing) {
        await tx.venuePricingStructure.create({
          data: {
            venueId: venue.id,
            accountType: AccountType.PRIMARY,
            debitRate: new Prisma.Decimal(mergedPricing.debitRate),
            creditRate: new Prisma.Decimal(mergedPricing.creditRate),
            amexRate: new Prisma.Decimal(mergedPricing.amexRate),
            internationalRate: new Prisma.Decimal(mergedPricing.internationalRate),
            fixedFeePerTransaction:
              mergedPricing.fixedFeePerTransaction != null ? new Prisma.Decimal(mergedPricing.fixedFeePerTransaction) : null,
            monthlyServiceFee: mergedPricing.monthlyServiceFee != null ? new Prisma.Decimal(mergedPricing.monthlyServiceFee) : null,
            effectiveFrom: new Date(),
            active: true,
          },
        })
        pricingConfigured = true
        totalPricingStructures++
      }

      // Create SettlementConfiguration records (per-venue override || defaultSettlement)
      const mergedSettlement = venueInput.settlement || data.defaultSettlement
      let settlementConfigured = false

      if (mergedSettlement && merchantAccountId) {
        const cardTypeMap: { type: TransactionCardType; days: number }[] = [
          { type: TransactionCardType.DEBIT, days: mergedSettlement.debitDays },
          { type: TransactionCardType.CREDIT, days: mergedSettlement.creditDays },
          { type: TransactionCardType.AMEX, days: mergedSettlement.amexDays },
          { type: TransactionCardType.INTERNATIONAL, days: mergedSettlement.internationalDays },
          { type: TransactionCardType.OTHER, days: mergedSettlement.otherDays },
        ]

        const cutoffTime = mergedSettlement.cutoffTime || '23:00'
        const cutoffTimezone = mergedSettlement.cutoffTimezone || 'America/Mexico_City'
        const effectiveFrom = new Date()

        for (const { type, days } of cardTypeMap) {
          await tx.settlementConfiguration.create({
            data: {
              merchantAccountId,
              cardType: type,
              settlementDays: days,
              settlementDayType: mergedSettlement.dayType,
              cutoffTime,
              cutoffTimezone,
              effectiveFrom,
            },
          })
          totalSettlementConfigs++
        }
        settlementConfigured = true
      }

      venueResults.push({
        index: i,
        name: venue.name,
        venueId: venue.id,
        slug: venue.slug,
        status: venue.status,
        terminals: terminalResults,
        paymentConfigured,
        pricingConfigured,
        settlementConfigured,
      })
    }

    return { venueResults, totalTerminals, totalPaymentConfigs, totalPricingStructures, totalSettlementConfigs }
  })

  logger.info(`[BULK_VENUE_CREATION] Created ${results.venueResults.length} venues for org "${organization.name}"`, {
    organizationId: organization.id,
    venuesCreated: results.venueResults.length,
    terminalsCreated: results.totalTerminals,
    paymentConfigsCreated: results.totalPaymentConfigs,
    pricingStructuresCreated: results.totalPricingStructures,
    settlementConfigsCreated: results.totalSettlementConfigs,
  })

  return {
    success: true,
    summary: {
      venuesCreated: results.venueResults.length,
      venuesFailed: 0,
      terminalsCreated: results.totalTerminals,
      terminalsFailed: 0,
      paymentConfigsCreated: results.totalPaymentConfigs,
      pricingStructuresCreated: results.totalPricingStructures,
      settlementConfigsCreated: results.totalSettlementConfigs,
    },
    venues: results.venueResults,
    errors: [],
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function resolveOrganization(data: BulkCreateVenuesInput) {
  const where = data.organizationId ? { id: data.organizationId } : { slug: data.organizationSlug! }

  const organization = await prisma.organization.findUnique({
    where,
    select: { id: true, name: true },
  })

  if (!organization) {
    const identifier = data.organizationId || data.organizationSlug
    throw new ValidationError(`Organización no encontrada: ${identifier}`, -1, 'organizationId')
  }

  return organization
}

async function generateSlugsForBatch(venues: VenueInput[]): Promise<string[]> {
  const slugs: string[] = []
  const usedSlugs = new Set<string>()

  // Pre-fetch all potentially colliding slugs from DB in one query
  const baseSlugCandidates = venues.map(v => generateValidatedSlug(v.name))
  const existingSlugs = await prisma.venue.findMany({
    where: {
      slug: {
        in: baseSlugCandidates,
      },
    },
    select: { slug: true },
  })
  const existingSlugSet = new Set(existingSlugs.map(v => v.slug))

  for (const venue of venues) {
    let slug = generateValidatedSlug(venue.name)

    // Handle collision within batch or with DB
    if (usedSlugs.has(slug) || existingSlugSet.has(slug)) {
      let attempt = 1
      let candidateSlug = `${slug}-${attempt}`
      while (usedSlugs.has(candidateSlug) || existingSlugSet.has(candidateSlug)) {
        attempt++
        candidateSlug = `${slug}-${attempt}`
      }
      slug = candidateSlug
    }

    usedSlugs.add(slug)
    slugs.push(slug)
  }

  return slugs
}

// ── Error class ──────────────────────────────────────────────────────

export class ValidationError extends Error {
  public index: number
  public field: string

  constructor(message: string, index: number, field: string) {
    super(message)
    this.name = 'BulkVenueValidationError'
    this.index = index
    this.field = field
  }
}
