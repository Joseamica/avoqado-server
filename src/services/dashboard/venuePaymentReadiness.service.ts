/**
 * Venue Payment Readiness Service
 *
 * Provides a checklist to determine if a venue is ready to process payments.
 * Used by superadmins to track the configuration progress of new venues.
 *
 * Checklist items:
 * 1. KYC Approved - Venue has passed KYC review
 * 2. Terminal Registered - Physical terminal with real serial number
 * 3. Merchant Account Created - Blumon account with real credentials
 * 4. Terminal ↔ Merchant Linked - Terminal has assignedMerchantIds
 * 5. Venue Payment Config - Primary account assigned
 * 6. Pricing Structure Set - VenuePricingStructure exists
 * 7. Provider Cost Structure Set - ProviderCostStructure exists
 * 8. CLABE Provided - Bank account for settlements
 */

import prisma from '@/utils/prismaClient'
import { VerificationStatus, VenueType, AccountType } from '@prisma/client'
import logger from '@/config/logger'
import { getEffectivePaymentConfig, getEffectivePricing } from '@/services/organization-payment-config.service'

// Status types for checklist items
type CheckStatus = 'ok' | 'pending' | 'missing' | 'default' | 'inherited'

interface ChecklistItem {
  status: CheckStatus
  details?: string
}

interface TerminalInfo {
  id: string
  serialNumber: string | null
  name: string
  brand: string | null
  model: string | null
  assignedMerchantIds: string[]
}

interface MerchantAccountInfo {
  id: string
  displayName: string | null
  providerId: string
  blumonSerialNumber: string | null
  clabeNumber: string | null
}

export interface PaymentReadinessResponse {
  ready: boolean
  venueId: string
  venueSlug: string
  venueName: string
  venueType: VenueType

  checklist: {
    kycApproved: ChecklistItem
    terminalRegistered: ChecklistItem & { terminals?: TerminalInfo[] }
    merchantAccountCreated: ChecklistItem & { account?: MerchantAccountInfo }
    terminalMerchantLinked: ChecklistItem
    venuePaymentConfigured: ChecklistItem
    pricingStructureSet: ChecklistItem & { isDefault?: boolean }
    providerCostStructureSet: ChecklistItem
    clabeProvided: ChecklistItem & { masked?: string }
  }

  blockingItems: string[]
  nextAction: string
  canProcessPayments: boolean
}

/**
 * Get payment readiness status for a venue
 *
 * @param venueId - Venue ID to check
 * @returns PaymentReadinessResponse with full checklist
 */
export async function getPaymentReadiness(venueId: string): Promise<PaymentReadinessResponse> {
  logger.info(`Checking payment readiness for venue: ${venueId}`)

  // Fetch venue with all related payment data
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      terminals: {
        select: {
          id: true,
          serialNumber: true,
          name: true,
          brand: true,
          model: true,
          assignedMerchantIds: true,
          status: true,
        },
      },
      paymentConfig: {
        include: {
          primaryAccount: {
            select: {
              id: true,
              displayName: true,
              providerId: true,
              blumonSerialNumber: true,
              clabeNumber: true,
              externalMerchantId: true,
            },
          },
          secondaryAccount: {
            select: {
              id: true,
              displayName: true,
              providerId: true,
              blumonSerialNumber: true,
              clabeNumber: true,
            },
          },
        },
      },
      pricingStructures: {
        where: { active: true },
        select: {
          id: true,
          accountType: true,
          debitRate: true,
          notes: true,
          contractReference: true,
        },
      },
    },
  })

  if (!venue) {
    throw new Error(`Venue not found: ${venueId}`)
  }

  const blockingItems: string[] = []
  let nextAction = ''

  // Resolve effective payment config early (needed by steps 3, 5, 7, 8)
  const effectiveConfig = await getEffectivePaymentConfig(venueId)

  // 1. KYC Approved
  const kycApproved: ChecklistItem = {
    status: venue.kycStatus === VerificationStatus.VERIFIED ? 'ok' : 'pending',
    details: venue.kycStatus === VerificationStatus.VERIFIED ? 'KYC aprobado' : `KYC status: ${venue.kycStatus}`,
  }
  if (kycApproved.status !== 'ok') {
    blockingItems.push('kycApproved')
    if (!nextAction) nextAction = 'Aprobar documentos KYC del venue'
  }

  // 2. Terminal Registered (with real serial, not fake UUID)
  const realTerminals = venue.terminals.filter(t => t.serialNumber && (t.serialNumber.startsWith('AVQD-') || /^\d+$/.test(t.serialNumber)))
  const terminalRegistered: ChecklistItem & { terminals?: TerminalInfo[] } = {
    status: realTerminals.length > 0 ? 'ok' : 'missing',
    details:
      realTerminals.length > 0 ? `${realTerminals.length} terminal(es) registrada(s)` : 'No hay terminales con serial real registradas',
    terminals: realTerminals.map(t => ({
      id: t.id,
      serialNumber: t.serialNumber,
      name: t.name,
      brand: t.brand,
      model: t.model,
      assignedMerchantIds: t.assignedMerchantIds,
    })),
  }
  if (terminalRegistered.status !== 'ok') {
    blockingItems.push('terminalRegistered')
    if (!nextAction) nextAction = 'Registrar terminal física con número de serie'
  }

  // 3. Merchant Account Created (non-demo)
  // Check: primaryAccount from effective config (venue or org) OR merchant accounts linked via terminals
  const primaryAccount = effectiveConfig?.config?.primaryAccount ?? venue.paymentConfig?.primaryAccount

  // Also check if any terminal has a merchant account assigned (even if VenuePaymentConfig not set)
  const terminalMerchantIds = realTerminals.flatMap(t => t.assignedMerchantIds)
  const uniqueMerchantIds = [...new Set(terminalMerchantIds)]

  // Fetch merchant accounts linked to terminals if no primaryAccount
  let terminalLinkedAccount: typeof primaryAccount | null = null
  if (!primaryAccount && uniqueMerchantIds.length > 0) {
    terminalLinkedAccount = await prisma.merchantAccount.findFirst({
      where: {
        id: { in: uniqueMerchantIds },
        active: true,
        NOT: { externalMerchantId: { contains: 'demo', mode: 'insensitive' } },
      },
      select: {
        id: true,
        displayName: true,
        providerId: true,
        blumonSerialNumber: true,
        clabeNumber: true,
        externalMerchantId: true,
      },
    })
  }

  const effectiveAccount = primaryAccount || terminalLinkedAccount
  const isRealMerchant = effectiveAccount && !effectiveAccount.externalMerchantId?.toLowerCase().includes('demo')

  const merchantAccountCreated: ChecklistItem & { account?: MerchantAccountInfo } = {
    status: isRealMerchant ? 'ok' : 'missing',
    details: isRealMerchant ? `Cuenta: ${effectiveAccount.displayName}` : 'No hay cuenta merchant con credenciales reales',
    account: isRealMerchant
      ? {
          id: effectiveAccount.id,
          displayName: effectiveAccount.displayName,
          providerId: effectiveAccount.providerId,
          blumonSerialNumber: effectiveAccount.blumonSerialNumber,
          clabeNumber: effectiveAccount.clabeNumber,
        }
      : undefined,
  }
  if (merchantAccountCreated.status !== 'ok') {
    blockingItems.push('merchantAccountCreated')
    if (!nextAction) nextAction = 'Obtener credenciales Blumon (Auto-Fetch)'
  }

  // 4. Terminal ↔ Merchant Linked
  const linkedTerminals = realTerminals.filter(t => t.assignedMerchantIds.length > 0)
  const terminalMerchantLinked: ChecklistItem = {
    status: linkedTerminals.length > 0 ? 'ok' : 'missing',
    details:
      linkedTerminals.length > 0
        ? `${linkedTerminals.length} terminal(es) vinculada(s) a merchant`
        : 'Ninguna terminal tiene merchant asignado',
  }
  if (terminalMerchantLinked.status !== 'ok' && terminalRegistered.status === 'ok') {
    blockingItems.push('terminalMerchantLinked')
    if (!nextAction) nextAction = 'Vincular terminal con cuenta merchant'
  }

  // 5. Venue Payment Config (with org-level inheritance)
  const configSource = effectiveConfig?.source
  const hasPaymentConfig = !!effectiveConfig?.config?.primaryAccountId

  const venuePaymentConfigured: ChecklistItem = {
    status: hasPaymentConfig ? (configSource === 'organization' ? 'inherited' : 'ok') : 'missing',
    details: hasPaymentConfig
      ? configSource === 'organization'
        ? 'Heredado de organizacion'
        : 'Configuracion de pago activa'
      : 'No hay VenuePaymentConfig',
  }
  if (!hasPaymentConfig) {
    blockingItems.push('venuePaymentConfigured')
    if (!nextAction) nextAction = 'Configurar cuenta primaria de pagos'
  }

  // 6. Pricing Structure Set (with org-level inheritance)
  const effectivePricingResult = await getEffectivePricing(venueId, AccountType.PRIMARY)
  const pricingSource = effectivePricingResult?.source
  const primaryPricing = effectivePricingResult?.pricing?.[0]
  const isDefaultPricing =
    primaryPricing && 'contractReference' in primaryPricing ? (primaryPricing as any).contractReference?.startsWith('AUTO-') : false
  const pricingStructureSet: ChecklistItem & { isDefault?: boolean } = {
    status: primaryPricing ? (pricingSource === 'organization' ? 'inherited' : isDefaultPricing ? 'default' : 'ok') : 'missing',
    details: primaryPricing
      ? pricingSource === 'organization'
        ? `Heredado de organizacion (${Number(primaryPricing.debitRate) * 100}%)`
        : isDefaultPricing
          ? `Pricing por defecto (${Number(primaryPricing.debitRate) * 100}%)`
          : `Pricing personalizado (${Number(primaryPricing.debitRate) * 100}%)`
      : 'No hay estructura de precios configurada',
    isDefault: isDefaultPricing,
  }
  // Pricing is not blocking if using defaults or inherited

  // 7. Provider Cost Structure
  const merchantAccountId = primaryAccount?.id
  let providerCostExists = false
  if (merchantAccountId) {
    const providerCost = await prisma.providerCostStructure.findFirst({
      where: { merchantAccountId, active: true },
    })
    providerCostExists = !!providerCost
  }
  const providerCostStructureSet: ChecklistItem = {
    status: providerCostExists ? 'ok' : 'missing',
    details: providerCostExists ? 'Costos del proveedor configurados' : 'No hay ProviderCostStructure para la cuenta merchant',
  }
  // Provider cost is created with merchant, so if merchant exists, this should too

  // 8. CLABE Provided
  const clabeNumber = primaryAccount?.clabeNumber
  const clabeProvided: ChecklistItem & { masked?: string } = {
    status: clabeNumber ? 'ok' : 'missing',
    details: clabeNumber ? 'CLABE configurada' : 'No hay CLABE bancaria configurada',
    masked: clabeNumber ? `****${clabeNumber.slice(-4)}` : undefined,
  }
  // CLABE is important but not blocking for initial setup

  // Determine if venue can process payments
  // Blocking: KYC, Terminal, Merchant, Terminal-Merchant Link, VenuePaymentConfig
  // 'inherited' counts as configured (org-level config is valid)
  const configReady = venuePaymentConfigured.status === 'ok' || venuePaymentConfigured.status === 'inherited'
  const canProcessPayments =
    kycApproved.status === 'ok' &&
    terminalRegistered.status === 'ok' &&
    merchantAccountCreated.status === 'ok' &&
    terminalMerchantLinked.status === 'ok' &&
    configReady

  // Default next action if all blocking items are done
  if (!nextAction && !canProcessPayments) {
    nextAction = 'Completar configuración de pagos'
  } else if (canProcessPayments) {
    nextAction = 'Venue listo para procesar pagos'
  }

  const response: PaymentReadinessResponse = {
    ready: canProcessPayments,
    venueId: venue.id,
    venueSlug: venue.slug,
    venueName: venue.name,
    venueType: venue.type,

    checklist: {
      kycApproved,
      terminalRegistered,
      merchantAccountCreated,
      terminalMerchantLinked,
      venuePaymentConfigured,
      pricingStructureSet,
      providerCostStructureSet,
      clabeProvided,
    },

    blockingItems,
    nextAction,
    canProcessPayments,
  }

  logger.info(`Payment readiness for ${venue.name}: ${canProcessPayments ? 'READY' : 'NOT READY'}`)
  return response
}

/**
 * Get payment readiness for multiple venues (for superadmin dashboard)
 *
 * @param venueIds - Optional array of venue IDs. If not provided, returns all non-ready venues
 * @returns Array of PaymentReadinessResponse
 */
export async function getVenuesPaymentReadiness(venueIds?: string[]): Promise<PaymentReadinessResponse[]> {
  let venues: { id: string }[]

  if (venueIds && venueIds.length > 0) {
    venues = await prisma.venue.findMany({
      where: { id: { in: venueIds } },
      select: { id: true },
    })
  } else {
    // Get all venues that might need configuration
    // Exclude TRIAL venues with demo config, focus on PENDING_ACTIVATION and ACTIVE
    venues = await prisma.venue.findMany({
      where: {
        OR: [{ kycStatus: { in: [VerificationStatus.PENDING_REVIEW, VerificationStatus.IN_REVIEW] } }, { paymentConfig: null }],
      },
      select: { id: true },
      take: 50, // Limit to avoid performance issues
    })
  }

  const results = await Promise.all(venues.map(v => getPaymentReadiness(v.id)))
  return results
}
