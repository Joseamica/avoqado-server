/**
 * Organization Payment Config Superadmin Controller
 *
 * Manages organization-level payment configuration (merchant accounts + pricing)
 * that is inherited by all venues without their own config.
 *
 * Base path: /api/v1/dashboard/superadmin/organizations/:organizationId/payment-config
 */

import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getOrganizationPaymentConfig, getOrganizationPricing, getVenueConfigSources } from '@/services/organization-payment-config.service'

/**
 * GET /:orgId/payment-config
 * Get org payment config + pricing + venue inheritance summary.
 */
export async function getPaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params

    const [config, pricing, venues] = await Promise.all([
      getOrganizationPaymentConfig(organizationId),
      getOrganizationPricing(organizationId),
      getVenueConfigSources(organizationId),
    ])

    return res.json({
      paymentConfig: config,
      pricingStructures: pricing,
      venueInheritance: venues,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /:orgId/payment-config
 * Set/update org payment config (merchant accounts).
 */
export async function setPaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const { primaryAccountId, secondaryAccountId, tertiaryAccountId, routingRules, preferredProcessor } = req.body

    // Verify organization exists
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    })
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' })
    }

    // Verify primary account exists and is active
    const primaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: primaryAccountId },
    })
    if (!primaryAccount || !primaryAccount.active) {
      return res.status(400).json({ error: 'Primary account not found or inactive' })
    }

    // Verify secondary/tertiary if provided
    if (secondaryAccountId) {
      const acc = await prisma.merchantAccount.findUnique({ where: { id: secondaryAccountId } })
      if (!acc || !acc.active) {
        return res.status(400).json({ error: 'Secondary account not found or inactive' })
      }
    }
    if (tertiaryAccountId) {
      const acc = await prisma.merchantAccount.findUnique({ where: { id: tertiaryAccountId } })
      if (!acc || !acc.active) {
        return res.status(400).json({ error: 'Tertiary account not found or inactive' })
      }
    }

    const config = await prisma.organizationPaymentConfig.upsert({
      where: { organizationId },
      create: {
        organizationId,
        primaryAccountId,
        secondaryAccountId: secondaryAccountId || null,
        tertiaryAccountId: tertiaryAccountId || null,
        routingRules: routingRules || null,
        preferredProcessor: preferredProcessor || 'AUTO',
      },
      update: {
        primaryAccountId,
        secondaryAccountId: secondaryAccountId || null,
        tertiaryAccountId: tertiaryAccountId || null,
        routingRules: routingRules || null,
        preferredProcessor: preferredProcessor || 'AUTO',
      },
      include: {
        primaryAccount: { include: { provider: true } },
        secondaryAccount: { include: { provider: true } },
        tertiaryAccount: { include: { provider: true } },
      },
    })

    logger.info(`Organization payment config set for org ${organizationId}`)
    return res.json(config)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /:orgId/payment-config
 * Remove org payment config.
 */
export async function deletePaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params

    const existing = await prisma.organizationPaymentConfig.findUnique({
      where: { organizationId },
    })
    if (!existing) {
      return res.status(404).json({ error: 'Organization payment config not found' })
    }

    await prisma.organizationPaymentConfig.delete({
      where: { organizationId },
    })

    logger.info(`Organization payment config deleted for org ${organizationId}`)
    return res.json({ success: true })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /:orgId/payment-config/pricing
 * Set/update org pricing structure.
 */
export async function setPricing(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const {
      accountType,
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedFeePerTransaction,
      monthlyServiceFee,
      minimumMonthlyVolume,
      volumePenalty,
      effectiveFrom,
      effectiveTo,
      contractReference,
      notes,
    } = req.body

    // Verify organization exists
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    })
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' })
    }

    const effectiveDate = new Date(effectiveFrom)

    // Deactivate previous pricing for same accountType
    await prisma.organizationPricingStructure.updateMany({
      where: { organizationId, accountType, active: true },
      data: { active: false, effectiveTo: effectiveDate },
    })

    const pricing = await prisma.organizationPricingStructure.create({
      data: {
        organizationId,
        accountType,
        debitRate,
        creditRate,
        amexRate,
        internationalRate,
        fixedFeePerTransaction: fixedFeePerTransaction || null,
        monthlyServiceFee: monthlyServiceFee || null,
        minimumMonthlyVolume: minimumMonthlyVolume || null,
        volumePenalty: volumePenalty || null,
        effectiveFrom: effectiveDate,
        effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
        contractReference: contractReference || null,
        notes: notes || null,
        active: true,
      },
    })

    logger.info(`Organization pricing set for org ${organizationId}, accountType ${accountType}`)
    return res.json(pricing)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /:orgId/payment-config/pricing/:pricingId
 * Remove (deactivate) a pricing structure.
 */
export async function deletePricing(req: Request, res: Response, next: NextFunction) {
  try {
    const { pricingId } = req.params

    const existing = await prisma.organizationPricingStructure.findUnique({
      where: { id: pricingId },
    })
    if (!existing) {
      return res.status(404).json({ error: 'Pricing structure not found' })
    }

    await prisma.organizationPricingStructure.update({
      where: { id: pricingId },
      data: { active: false, effectiveTo: new Date() },
    })

    logger.info(`Organization pricing ${pricingId} deactivated`)
    return res.json({ success: true })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /:orgId/payment-config/venues
 * Venue inheritance status list.
 */
export async function getVenueInheritance(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const sources = await getVenueConfigSources(organizationId)
    return res.json(sources)
  } catch (error) {
    next(error)
  }
}
