/**
 * Onboarding Progress Service
 *
 * Manages onboarding progress tracking for new organizations.
 * Stores step-by-step data collection and allows resume capability.
 */

import { OnboardingType, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { uploadFileToStorage, buildStoragePath } from '@/services/storage.service'
import logger from '@/config/logger'

// Types
export interface OnboardingStepData {
  step1_userInfo?: {
    email: string
    firstName: string
    lastName: string
    phone?: string
  }
  step2_onboardingType?: OnboardingType
  step3_businessInfo?: {
    name: string
    type: string
    venueType: string
    entityType?: 'PERSONA_FISICA' | 'PERSONA_MORAL' // Legal entity type
    timezone: string
    address?: string
    city?: string
    state?: string
    country?: string
    phone?: string
    email?: string
  }
  step4_menuData?: {
    method: 'manual' | 'csv'
    categories?: Array<{ name: string; slug: string }>
    products?: Array<{
      name: string
      sku: string
      price: number
      categorySlug: string
    }>
  }
  step5_teamInvites?: Array<{
    email: string
    firstName: string
    lastName: string
    role: string
  }>
  step6_selectedFeatures?: string[]
  step7_kycDocuments?: {
    entityType: 'PERSONA_FISICA' | 'PERSONA_MORAL'
    documents: {
      ineUrl?: string // INE/IFE (ID document)
      rfcDocumentUrl?: string // RFC certificate
      comprobanteDomicilioUrl?: string // Address proof
      caratulaBancariaUrl?: string // Bank statement with CLABE
      actaDocumentUrl?: string // Acta Constitutiva (Persona Moral only)
      poderLegalUrl?: string // Power of attorney (Persona Moral only)
    }
  }
  step8_paymentInfo?: {
    clabe: string
    bankName?: string
    accountHolder: string
  }
}

export interface V2Step8Data {
  mpMerchantId: string | null
  stripeMerchantId: string | null
  skipped: boolean
  lastUpdatedAt: string | null
}

/**
 * Read the V2 wizard's step 8 (payment providers) sub-tree. Returns null
 * when step 8 has never been saved, so callers can short-circuit.
 *
 * The wizard saves `onNext({ paymentProviders: { ... } })`, which means the
 * payload is stored nested as `step8.paymentProviders`. We accept both shapes
 * for forward-compat: the nested form (current frontend) and a flat form
 * (in case a future code path writes the fields directly under `step8`).
 */
export function parseV2Step8(v2SetupData: unknown): V2Step8Data | null {
  if (!v2SetupData || typeof v2SetupData !== 'object') return null
  const step8 = (v2SetupData as Record<string, any>).step8
  if (!step8 || typeof step8 !== 'object') return null
  // Prefer the nested `paymentProviders` shape (matches `SetupData` on the
  // frontend); fall back to the flat shape if older data exists.
  const node = step8.paymentProviders && typeof step8.paymentProviders === 'object' ? step8.paymentProviders : step8
  return {
    mpMerchantId: typeof node.mpMerchantId === 'string' ? node.mpMerchantId : null,
    stripeMerchantId: typeof node.stripeMerchantId === 'string' ? node.stripeMerchantId : null,
    skipped: node.skipped === true,
    lastUpdatedAt: typeof node.lastUpdatedAt === 'string' ? node.lastUpdatedAt : null,
  }
}

export interface V2Step9Data {
  tpvOrderId: string | null
  skipped: boolean
  lastUpdatedAt: string | null
}

/**
 * Read the V2 wizard's step 9 (optional TPV purchase) sub-tree. Returns null
 * when step 9 has never been saved, so callers can short-circuit.
 *
 * The wizard saves `onNext({ tpvPurchase: { ... } })`, which means the payload
 * is stored nested as `step9.tpvPurchase`. We accept both shapes for the same
 * forward-compat reason as step8: the nested form (current frontend) and a
 * flat form (in case a future code path writes the fields directly under
 * `step9`).
 *
 * Spec: docs/superpowers/specs/2026-05-29-onboarding-tpv-purchase-design.md
 */
export function parseV2Step9(v2SetupData: unknown): V2Step9Data | null {
  if (!v2SetupData || typeof v2SetupData !== 'object') return null
  const step9 = (v2SetupData as Record<string, any>).step9
  if (!step9 || typeof step9 !== 'object') return null
  const node = step9.tpvPurchase && typeof step9.tpvPurchase === 'object' ? step9.tpvPurchase : step9
  return {
    tpvOrderId: typeof node.tpvOrderId === 'string' ? node.tpvOrderId : null,
    skipped: node.skipped === true,
    lastUpdatedAt: typeof node.lastUpdatedAt === 'string' ? node.lastUpdatedAt : null,
  }
}

export interface V2PlanData {
  /**
   * Tier selected in the wizard's 4-tier plan step. Defaults to 'PRO' for payloads
   * saved before the tier field existed (the step used to be a single Pro offer).
   * 'FREE' completes onboarding without a payment method (no base subscription).
   */
  tier: 'FREE' | 'PRO' | 'PREMIUM'
  paymentMethodId: string | null
  interval: 'monthly' | 'annual'
  payNow: boolean
  acceptedAt: string | null
}

/**
 * Resolves the plan step's saved data from v2SetupData. The wizard persists it via the
 * generic per-step endpoint, which nests the payload under the (flag-dependent) positional
 * key, e.g. `step10.plan`. Because the plan step's number shifts with which optional steps
 * (paymentProviders, buyTpv) are enabled, resolve `plan` by checking a top-level `plan`
 * first, then any `stepN.plan`. Returns null when the plan step hasn't been saved.
 */
export function parseV2Plan(v2SetupData: unknown): V2PlanData | null {
  if (!v2SetupData || typeof v2SetupData !== 'object') return null
  const root = v2SetupData as Record<string, any>
  let plan: Record<string, any> | null = root.plan && typeof root.plan === 'object' ? root.plan : null
  if (!plan) {
    for (const value of Object.values(root)) {
      if (value && typeof value === 'object' && typeof (value as Record<string, any>).plan === 'object') {
        plan = (value as Record<string, any>).plan
        break
      }
    }
  }
  if (!plan || typeof plan !== 'object') return null
  return {
    tier: plan.tier === 'FREE' || plan.tier === 'PREMIUM' ? plan.tier : 'PRO',
    paymentMethodId: typeof plan.paymentMethodId === 'string' ? plan.paymentMethodId : null,
    interval: plan.interval === 'annual' ? 'annual' : 'monthly',
    payNow: plan.payNow === true,
    acceptedAt: typeof plan.acceptedAt === 'string' ? plan.acceptedAt : null,
  }
}

export interface ResolvedTpvPurchase {
  tpvOrderId: string | null
  skipped: boolean
}

/**
 * DB-backed hydration of step9 (TPV purchase) for the onboarding progress
 * endpoint. Resolution order:
 *
 *   1. If onboarding progress doesn't exist → return nulls.
 *   2. If step9 has a `tpvOrderId` → return it. The frontend fetches the
 *      full order (with paymentStatus + fulfillmentStatus) via the existing
 *      tpvOrderService.getOrder endpoint. Keeps this payload light and avoids
 *      state denormalization that could drift while the user is in the wizard.
 *   3. If step9.skipped === true → return nulls + skipped. Honor the user's
 *      choice and DO NOT fall back to recent orders (they'd see View B for a
 *      purchase they explicitly skipped, which is confusing).
 *   4. Otherwise → fallback to the most-recent TerminalOrder for any venue in
 *      this organization. Covers the "tab closed mid-Stripe, returned days
 *      later" case where step9 was never saved but an order exists.
 *
 * Spec: docs/superpowers/specs/2026-05-29-onboarding-tpv-purchase-design.md
 */
export async function resolveTpvPurchaseForOnboarding(organizationId: string): Promise<ResolvedTpvPurchase> {
  const progress = await prisma.onboardingProgress.findUnique({
    where: { organizationId },
  })
  if (!progress) return { tpvOrderId: null, skipped: false }

  const step9 = parseV2Step9(progress.v2SetupData)

  if (step9?.tpvOrderId) {
    return { tpvOrderId: step9.tpvOrderId, skipped: step9.skipped }
  }

  if (step9?.skipped) {
    return { tpvOrderId: null, skipped: true }
  }

  // Fallback: most-recent order for the org's first venue. We pick the first
  // venue by creation order so a multi-venue org doesn't surface an order
  // from a branch the merchant didn't expect.
  const venue = await prisma.venue.findFirst({
    where: { organizationId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!venue) return { tpvOrderId: null, skipped: false }

  const recent = await prisma.terminalOrder.findFirst({
    where: { venueId: venue.id },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  })

  return {
    tpvOrderId: recent?.id ?? null,
    skipped: false,
  }
}

/**
 * Creates or retrieves onboarding progress for an organization
 *
 * @param organizationId - Organization ID
 * @returns Onboarding progress record
 */
export async function getOrCreateOnboardingProgress(organizationId: string) {
  // Use upsert to handle race conditions (React StrictMode calls effects twice)
  try {
    const progress = await prisma.onboardingProgress.upsert({
      where: { organizationId },
      update: {}, // Don't update if exists, just return it
      create: {
        organizationId,
        currentStep: 0,
        completedSteps: [],
      },
    })
    return progress
  } catch (error: any) {
    // If upsert failed due to race condition, fetch the existing record
    if (error.code === 'P2002') {
      const existing = await prisma.onboardingProgress.findUnique({
        where: { organizationId },
      })
      if (existing) {
        return existing
      }
    }
    // Re-throw if it's a different error
    throw error
  }
}

/**
 * Updates onboarding progress for a specific step
 *
 * @param organizationId - Organization ID
 * @param stepNumber - Step number (1-7)
 * @param stepData - Data collected in this step
 * @returns Updated progress record
 */
export async function updateOnboardingStep(organizationId: string, stepNumber: number, stepData: Partial<OnboardingStepData>) {
  // Get current progress
  const progress = await getOrCreateOnboardingProgress(organizationId)

  // Parse completed steps (stored as JSON array)
  const completedSteps = Array.isArray(progress.completedSteps) ? (progress.completedSteps as number[]) : []

  // Add step to completed if not already there
  if (!completedSteps.includes(stepNumber)) {
    completedSteps.push(stepNumber)
  }

  // Determine next step
  const nextStep = stepNumber + 1

  // Build update data
  const updateData: Prisma.OnboardingProgressUpdateInput = {
    currentStep: nextStep,
    completedSteps: completedSteps as unknown as Prisma.InputJsonValue,
    updatedAt: new Date(),
  }

  // Add step-specific data
  if (stepData.step1_userInfo) {
    updateData.step1_userInfo = stepData.step1_userInfo as unknown as Prisma.InputJsonValue
  }
  if (stepData.step2_onboardingType) {
    updateData.step2_onboardingType = stepData.step2_onboardingType
  }
  if (stepData.step3_businessInfo) {
    updateData.step3_businessInfo = stepData.step3_businessInfo as unknown as Prisma.InputJsonValue
  }
  if (stepData.step4_menuData) {
    updateData.step4_menuData = stepData.step4_menuData as unknown as Prisma.InputJsonValue
  }
  if (stepData.step5_teamInvites) {
    updateData.step5_teamInvites = stepData.step5_teamInvites as any
  }
  if (stepData.step6_selectedFeatures) {
    updateData.step6_selectedFeatures = stepData.step6_selectedFeatures
  }
  if (stepData.step7_kycDocuments) {
    updateData.step7_kycDocuments = stepData.step7_kycDocuments as unknown as Prisma.InputJsonValue
  }
  if (stepData.step8_paymentInfo) {
    updateData.step8_paymentInfo = stepData.step8_paymentInfo as unknown as Prisma.InputJsonValue
  }

  // Update progress
  const updatedProgress = await prisma.onboardingProgress.update({
    where: { organizationId },
    data: updateData,
  })

  return updatedProgress
}

/**
 * Marks onboarding as complete
 *
 * @param organizationId - Organization ID
 * @returns Updated progress record
 */
export async function completeOnboarding(organizationId: string) {
  const progress = await prisma.onboardingProgress.update({
    where: { organizationId },
    data: {
      completedAt: new Date(),
      currentStep: 8, // Final step (8 steps total)
    },
  })

  // Also update organization
  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      onboardingCompletedAt: new Date(),
    },
  })

  return progress
}

/**
 * Gets current onboarding progress
 *
 * @param organizationId - Organization ID
 * @returns Progress record or null
 */
export async function getOnboardingProgress(organizationId: string) {
  return prisma.onboardingProgress.findUnique({
    where: { organizationId },
  })
}

/**
 * Checks if organization has completed onboarding
 *
 * @param organizationId - Organization ID
 * @returns true if onboarding complete, false otherwise
 */
export async function hasCompletedOnboarding(organizationId: string): Promise<boolean> {
  const progress = await getOnboardingProgress(organizationId)
  return progress?.completedAt !== null
}

/**
 * Gets onboarding completion percentage
 *
 * @param organizationId - Organization ID
 * @returns Completion percentage (0-100)
 */
export async function getOnboardingCompletionPercentage(organizationId: string): Promise<number> {
  const progress = await getOnboardingProgress(organizationId)

  if (!progress) {
    return 0
  }

  if (progress.completedAt) {
    return 100
  }

  const totalSteps = 8
  const completedSteps = Array.isArray(progress.completedSteps) ? (progress.completedSteps as number[]).length : 0

  return Math.round((completedSteps / totalSteps) * 100)
}

/**
 * Deletes onboarding progress (for cleanup/reset)
 *
 * @param organizationId - Organization ID
 */
export async function deleteOnboardingProgress(organizationId: string) {
  await prisma.onboardingProgress.delete({
    where: { organizationId },
  })
}

// Document key to clean file name mapping
const DOCUMENT_KEY_TO_NAME: Record<string, string> = {
  ine: 'INE',
  rfcDocument: 'RFC',
  comprobanteDomicilio: 'Comprobante_Domicilio',
  caratulaBancaria: 'Caratula_Bancaria',
  actaDocument: 'Acta_Constitutiva',
  poderLegal: 'Poder_Legal',
}

// Document key to URL field mapping
const DOCUMENT_KEY_TO_URL_FIELD: Record<string, string> = {
  ine: 'ineUrl',
  rfcDocument: 'rfcDocumentUrl',
  comprobanteDomicilio: 'comprobanteDomicilioUrl',
  caratulaBancaria: 'caratulaBancariaUrl',
  actaDocument: 'actaDocumentUrl',
  poderLegal: 'poderLegalUrl',
}

interface UploadedFile {
  buffer: Buffer
  originalname: string
  mimetype: string
}

/**
 * Uploads a KYC document during onboarding
 *
 * @param organizationId - Organization ID
 * @param documentKey - Document key (ine, rfcDocument, etc.)
 * @param file - Uploaded file from multer
 * @returns Document key and URL
 */
export async function uploadKycDocument(
  organizationId: string,
  documentKey: string,
  file: UploadedFile,
): Promise<{ documentKey: string; url: string }> {
  // Get or create onboarding progress
  const progress = await getOrCreateOnboardingProgress(organizationId)

  // Determine file extension
  const extension = file.originalname.split('.').pop()?.toLowerCase() || 'pdf'
  const cleanName = DOCUMENT_KEY_TO_NAME[documentKey] || documentKey

  // Upload to Firebase Storage (path: {env}/onboarding/{organizationId}/kyc/{documentName}.{ext})
  const filePath = buildStoragePath(`onboarding/${organizationId}/kyc/${cleanName}.${extension}`)
  const downloadUrl = await uploadFileToStorage(file.buffer, filePath, file.mimetype)

  logger.info(`📄 Uploaded KYC document for onboarding: ${organizationId} - ${documentKey}`)

  // Get current KYC documents from progress (or initialize empty object)
  const currentKycDocs = (progress.step7_kycDocuments as any) || { entityType: null, documents: {} }
  const urlField = DOCUMENT_KEY_TO_URL_FIELD[documentKey]

  // Update documents object with new URL
  const updatedDocuments = {
    ...currentKycDocs.documents,
    [urlField]: downloadUrl,
  }

  // Update onboarding progress with new document URL
  await prisma.onboardingProgress.update({
    where: { organizationId },
    data: {
      step7_kycDocuments: {
        entityType: currentKycDocs.entityType,
        documents: updatedDocuments,
      } as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  })

  logger.info(`  ✅ Saved document URL to onboarding progress: ${urlField}`)

  return {
    documentKey,
    url: downloadUrl,
  }
}

// =============================================
// V2 Setup Wizard Functions
// =============================================

/**
 * Saves a V2 setup wizard step data
 * Stores all step data in the v2SetupData JSON field
 */
export async function saveV2StepData(organizationId: string, stepNumber: number, stepData: Record<string, any>) {
  const progress = await getOrCreateOnboardingProgress(organizationId)

  // Merge new step data into existing v2SetupData
  const currentData = (progress.v2SetupData as Record<string, any>) || {}
  const updatedData = {
    ...currentData,
    [`step${stepNumber}`]: stepData,
  }

  // Parse completed steps
  const completedSteps = Array.isArray(progress.completedSteps) ? (progress.completedSteps as number[]) : []
  if (!completedSteps.includes(stepNumber)) {
    completedSteps.push(stepNumber)
  }

  const updated = await prisma.onboardingProgress.update({
    where: { organizationId },
    data: {
      wizardVersion: 2,
      v2SetupData: updatedData as any,
      currentStep: stepNumber + 1,
      completedSteps: completedSteps as any,
      updatedAt: new Date(),
    },
  })

  // Side effects: update org name from step 2 (business info)
  if (stepNumber === 2 && stepData.businessName) {
    await prisma.organization.update({
      where: { id: organizationId },
      data: { name: stepData.businessName },
    })
  }

  // Side effects: update staff names from step 5 (identity)
  if (stepNumber === 5 && (stepData.legalFirstName || stepData.legalLastName)) {
    // Find the OWNER of this organization
    const staffOrg = await prisma.staffOrganization.findFirst({
      where: { organizationId, role: 'OWNER' },
    })
    if (staffOrg) {
      await prisma.staff.update({
        where: { id: staffOrg.staffId },
        data: {
          ...(stepData.legalFirstName && { firstName: stepData.legalFirstName }),
          ...(stepData.legalLastName && { lastName: stepData.legalLastName }),
        },
      })
    }
  }

  return updated
}

/**
 * Records terms and privacy acceptance
 */
export async function acceptV2Terms(organizationId: string, termsVersion: string, ipAddress: string) {
  const now = new Date()

  const progress = await getOrCreateOnboardingProgress(organizationId)

  // Mark terms (step 6) as completed and advance pointer to bank account (step 7).
  const completedSteps = Array.isArray(progress.completedSteps) ? (progress.completedSteps as number[]) : []
  if (!completedSteps.includes(6)) {
    completedSteps.push(6)
  }

  const updated = await prisma.onboardingProgress.update({
    where: { organizationId },
    data: {
      wizardVersion: 2,
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
      termsVersion,
      termsIpAddress: ipAddress,
      currentStep: 7,
      completedSteps: completedSteps as any,
      updatedAt: new Date(),
    },
  })

  return updated
}

/**
 * Extracts V2 setup data and builds venue creation input.
 * Does NOT create the venue — the controller handles that with optimistic locking.
 *
 * Note: businessInfo.email is left empty here on purpose — the V2 wizard does
 * not collect a business contact email. venueCreation.service falls back to
 * the signup Staff.email so the venue is never persisted with `email: NULL`.
 */
export async function getV2SetupDataForCompletion(organizationId: string) {
  const progress = await getOnboardingProgress(organizationId)

  if (!progress) {
    throw new Error('No se encontro el progreso de onboarding')
  }

  if (progress.wizardVersion !== 2) {
    throw new Error('Este endpoint es solo para el wizard V2')
  }

  const v2Data = (progress.v2SetupData as Record<string, any>) || {}

  // Extract data from v2 steps (step numbers match frontend: 2=business, 3=type, 4=entity, 5=identity, 7=bank)
  const businessInfo = v2Data.step2 || {}
  const businessType = v2Data.step3 || {}
  const entityInfo = v2Data.step4 || {}
  const identityInfo = v2Data.step5 || {}
  const bankInfo = v2Data.step7 || {}

  // Build business info for venue creation (compatible with v1 format)
  // businessType.businessType = VenueType enum value (e.g. RESTAURANT, BAR)
  // businessType.businessCategory = category string (e.g. FOOD_SERVICE, RETAIL)
  // entityInfo.entityType = sub-type (e.g. PERSONA_FISICA_ACTIVIDAD_EMPRESARIAL)
  // entityInfo.entitySubType = parent Prisma EntityType enum (e.g. PERSONA_FISICA)
  // We must use the parent type for the Prisma EntityType enum
  const resolvedEntityType = entityInfo.entitySubType || entityInfo.entityType || undefined
  // Validate it's a valid Prisma EntityType enum value, fallback to undefined
  const validEntityTypes = ['PERSONA_FISICA', 'PERSONA_MORAL']
  const venueBusinessInfo = {
    name: businessInfo.businessName || 'Mi Negocio',
    type: businessType.businessType || '',
    venueType: businessType.businessType || '',
    entityType: validEntityTypes.includes(resolvedEntityType) ? resolvedEntityType : undefined,
    timezone: 'America/Mexico_City',
    address: businessInfo.address || '',
    city: businessInfo.city || '',
    state: businessInfo.state || '',
    country: businessInfo.country || 'MX',
    zipCode: businessInfo.zipCode || '',
    phone: entityInfo.phone || '',
    email: businessInfo.email || '', // Fallback to Staff.email is applied in venueCreation.service
  }

  return {
    progress,
    businessInfo: venueBusinessInfo,
    bankInfo,
    identityInfo,
    entityInfo,
  }
}
