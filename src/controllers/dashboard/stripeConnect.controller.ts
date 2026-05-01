import { Request, Response } from 'express'
import logger from '@/config/logger'
import * as stripeConnectService from '@/services/dashboard/stripeConnect.service'

export async function createOnboardingLink(req: Request, res: Response) {
  try {
    const { venueId, id } = req.params
    const { businessType } = req.body

    const link = await stripeConnectService.createStripeOnboardingLink(venueId, id, businessType)

    res.json({
      success: true,
      data: link,
    })
  } catch (error: any) {
    logger.error('Error creating Stripe Connect onboarding link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to create Stripe onboarding link',
    })
  }
}

export async function getOnboardingStatus(req: Request, res: Response) {
  try {
    const { venueId, id } = req.params

    const status = await stripeConnectService.getStripeOnboardingStatus(venueId, id)

    res.json({
      success: true,
      data: status,
    })
  } catch (error: any) {
    logger.error('Error getting Stripe Connect onboarding status:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to get Stripe onboarding status',
    })
  }
}
