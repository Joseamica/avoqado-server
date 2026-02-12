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

  // Mark step 5 as completed
  const completedSteps = Array.isArray(progress.completedSteps) ? (progress.completedSteps as number[]) : []
  if (!completedSteps.includes(5)) {
    completedSteps.push(5)
  }

  const updated = await prisma.onboardingProgress.update({
    where: { organizationId },
    data: {
      wizardVersion: 2,
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
      termsVersion,
      termsIpAddress: ipAddress,
      currentStep: 6,
      completedSteps: completedSteps as any,
      updatedAt: new Date(),
    },
  })

  return updated
}

/**
 * Extracts V2 setup data and builds venue creation input.
 * Does NOT create the venue — the controller handles that with optimistic locking.
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
  const venueBusinessInfo = {
    name: businessInfo.businessName || 'Mi Negocio',
    type: businessType.businessType || '',
    venueType: businessType.businessType || '',
    entityType: entityInfo.entityType || undefined,
    timezone: 'America/Mexico_City',
    address: businessInfo.address || '',
    city: businessInfo.city || '',
    state: businessInfo.state || '',
    country: businessInfo.country || 'MX',
    zipCode: businessInfo.zipCode || '',
    phone: entityInfo.phone || '',
    email: '', // Will be filled from org
  }

  return {
    progress,
    businessInfo: venueBusinessInfo,
    bankInfo,
    identityInfo,
    entityInfo,
  }
}
