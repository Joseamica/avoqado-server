/**
 * Onboarding Progress Service
 *
 * Manages onboarding progress tracking for new organizations.
 * Stores step-by-step data collection and allows resume capability.
 */

import { OnboardingType, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

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
    role: string
  }>
  step6_selectedFeatures?: string[]
  step7_paymentInfo?: {
    clabe: string
    bankName?: string
    accountHolder?: string
    // KYC Document URLs (uploaded to S3/storage)
    ineUrl?: string // INE/IFE (ID document)
    rfcDocumentUrl?: string // RFC certificate
    comprobanteDomicilioUrl?: string // Address proof
    caratulaBancariaUrl?: string // Bank statement with CLABE
    actaConstitutivaUrl?: string // Acta Constitutiva (Persona Moral only)
    poderLegalUrl?: string // Power of attorney (Persona Moral only)
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
  if (stepData.step7_paymentInfo) {
    updateData.step7_paymentInfo = stepData.step7_paymentInfo as unknown as Prisma.InputJsonValue
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
      currentStep: 7, // Final step
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

  const totalSteps = 7
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
