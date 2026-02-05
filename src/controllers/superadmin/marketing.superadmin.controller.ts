/**
 * Marketing Campaigns Controller (Superadmin)
 *
 * Handles HTTP requests for email campaigns and templates.
 */

import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import * as marketingService from '../../services/superadmin/marketing.superadmin.service'
import logger from '@/config/logger'
import { CampaignStatus, DeliveryStatus } from '@prisma/client'

// ==========================================
// VALIDATION SCHEMAS
// ==========================================

const createTemplateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  subject: z.string().min(1, 'Subject is required').max(200),
  bodyHtml: z.string().min(1, 'HTML body is required'),
  bodyText: z.string().min(1, 'Text body is required'),
})

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  subject: z.string().min(1).max(200).optional(),
  bodyHtml: z.string().min(1).optional(),
  bodyText: z.string().min(1).optional(),
})

const createCampaignSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  subject: z.string().min(1, 'Subject is required').max(200),
  bodyHtml: z.string().min(1, 'HTML body is required'),
  bodyText: z.string().min(1, 'Text body is required'),
  templateId: z.string().optional(),
  targetAllVenues: z.boolean().default(true),
  targetVenueIds: z.array(z.string()).default([]),
  includeStaff: z.boolean().default(false),
  targetStaffRoles: z.array(z.string()).default([]),
})

const updateCampaignSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  subject: z.string().min(1).max(200).optional(),
  bodyHtml: z.string().min(1).optional(),
  bodyText: z.string().min(1).optional(),
  targetAllVenues: z.boolean().optional(),
  targetVenueIds: z.array(z.string()).optional(),
  includeStaff: z.boolean().optional(),
  targetStaffRoles: z.array(z.string()).optional(),
})

const bulkDeleteSchema = z.object({
  ids: z.array(z.string()).optional(),
  status: z.array(z.nativeEnum(CampaignStatus)).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
})

const previewRecipientsSchema = z.object({
  targetAllVenues: z.boolean().default(true),
  targetVenueIds: z.array(z.string()).default([]),
  includeStaff: z.boolean().default(false),
  targetStaffRoles: z.array(z.string()).default([]),
})

// ==========================================
// TEMPLATE ENDPOINTS
// ==========================================

/**
 * List all templates
 * GET /api/v1/dashboard/superadmin/marketing/templates
 */
export async function listTemplates(req: Request, res: Response, next: NextFunction) {
  try {
    const { search, limit, offset } = req.query

    const result = await marketingService.listTemplates({
      search: search as string,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    })

    return res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error listing templates:', error)
    next(error)
  }
}

/**
 * Get a single template
 * GET /api/v1/dashboard/superadmin/marketing/templates/:id
 */
export async function getTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const template = await marketingService.getTemplate(id)

    if (!template) {
      return res.status(404).json({
        success: false,
        error: 'Template not found',
      })
    }

    return res.status(200).json({
      success: true,
      template,
    })
  } catch (error) {
    logger.error('Error getting template:', error)
    next(error)
  }
}

/**
 * Create a new template
 * POST /api/v1/dashboard/superadmin/marketing/templates
 */
export async function createTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const validation = createTemplateSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const authContext = (req as any).authContext
    const template = await marketingService.createTemplate({
      ...validation.data,
      createdBy: authContext.userId,
    })

    return res.status(201).json({
      success: true,
      template,
    })
  } catch (error) {
    logger.error('Error creating template:', error)
    next(error)
  }
}

/**
 * Update a template
 * PATCH /api/v1/dashboard/superadmin/marketing/templates/:id
 */
export async function updateTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const validation = updateTemplateSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const template = await marketingService.updateTemplate(id, validation.data)

    return res.status(200).json({
      success: true,
      template,
    })
  } catch (error) {
    logger.error('Error updating template:', error)
    next(error)
  }
}

/**
 * Delete a template
 * DELETE /api/v1/dashboard/superadmin/marketing/templates/:id
 */
export async function deleteTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await marketingService.deleteTemplate(id)

    return res.status(200).json({
      success: true,
      message: 'Template deleted',
    })
  } catch (error) {
    logger.error('Error deleting template:', error)
    next(error)
  }
}

// ==========================================
// CAMPAIGN ENDPOINTS
// ==========================================

/**
 * List all campaigns
 * GET /api/v1/dashboard/superadmin/marketing/campaigns
 */
export async function listCampaigns(req: Request, res: Response, next: NextFunction) {
  try {
    const { search, status, limit, offset } = req.query

    const statusArray = status
      ? ((Array.isArray(status) ? status : [status])
          .map(s => s as string)
          .filter(s => Object.values(CampaignStatus).includes(s as CampaignStatus)) as CampaignStatus[])
      : undefined

    const result = await marketingService.listCampaigns({
      search: search as string,
      status: statusArray,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    })

    return res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error listing campaigns:', error)
    next(error)
  }
}

/**
 * Get a single campaign
 * GET /api/v1/dashboard/superadmin/marketing/campaigns/:id
 */
export async function getCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const campaign = await marketingService.getCampaign(id)

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      })
    }

    return res.status(200).json({
      success: true,
      campaign,
    })
  } catch (error) {
    logger.error('Error getting campaign:', error)
    next(error)
  }
}

/**
 * Create a new campaign
 * POST /api/v1/dashboard/superadmin/marketing/campaigns
 */
export async function createCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const validation = createCampaignSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const authContext = (req as any).authContext
    const campaign = await marketingService.createCampaign({
      ...validation.data,
      createdBy: authContext.userId,
    })

    return res.status(201).json({
      success: true,
      campaign,
    })
  } catch (error) {
    logger.error('Error creating campaign:', error)
    next(error)
  }
}

/**
 * Update a campaign
 * PATCH /api/v1/dashboard/superadmin/marketing/campaigns/:id
 */
export async function updateCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const validation = updateCampaignSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const campaign = await marketingService.updateCampaign(id, validation.data)

    return res.status(200).json({
      success: true,
      campaign,
    })
  } catch (error: any) {
    if (error.message === 'Campaign not found') {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      })
    }
    if (error.message === 'Cannot update campaign that is not in DRAFT status') {
      return res.status(400).json({
        success: false,
        error: error.message,
      })
    }
    logger.error('Error updating campaign:', error)
    next(error)
  }
}

/**
 * Delete a campaign
 * DELETE /api/v1/dashboard/superadmin/marketing/campaigns/:id
 */
export async function deleteCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await marketingService.deleteCampaign(id)

    return res.status(200).json({
      success: true,
      message: 'Campaign deleted',
    })
  } catch (error: any) {
    if (error.message === 'Campaign not found') {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      })
    }
    logger.error('Error deleting campaign:', error)
    next(error)
  }
}

/**
 * Bulk delete campaigns
 * DELETE /api/v1/dashboard/superadmin/marketing/campaigns/bulk
 */
export async function bulkDeleteCampaigns(req: Request, res: Response, next: NextFunction) {
  try {
    const validation = bulkDeleteSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const { ids, status, createdAfter, createdBefore } = validation.data

    const result = await marketingService.bulkDeleteCampaigns({
      ids,
      status,
      createdAfter: createdAfter ? new Date(createdAfter) : undefined,
      createdBefore: createdBefore ? new Date(createdBefore) : undefined,
    })

    return res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error bulk deleting campaigns:', error)
    next(error)
  }
}

/**
 * Send a campaign
 * POST /api/v1/dashboard/superadmin/marketing/campaigns/:id/send
 */
export async function sendCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const result = await marketingService.startCampaign(id)

    return res.status(200).json({
      success: true,
      message: `Campaign started with ${result.totalRecipients} recipients`,
      ...result,
    })
  } catch (error: any) {
    if (error.message === 'Campaign not found') {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      })
    }
    if (error.message === 'Campaign is not in DRAFT status' || error.message === 'No recipients found for this campaign') {
      return res.status(400).json({
        success: false,
        error: error.message,
      })
    }
    logger.error('Error sending campaign:', error)
    next(error)
  }
}

/**
 * Cancel a campaign
 * POST /api/v1/dashboard/superadmin/marketing/campaigns/:id/cancel
 */
export async function cancelCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await marketingService.cancelCampaign(id)

    return res.status(200).json({
      success: true,
      message: 'Campaign cancelled',
    })
  } catch (error: any) {
    if (error.message === 'Campaign not found') {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      })
    }
    if (error.message === 'Campaign is not currently sending') {
      return res.status(400).json({
        success: false,
        error: error.message,
      })
    }
    logger.error('Error cancelling campaign:', error)
    next(error)
  }
}

/**
 * Get campaign deliveries
 * GET /api/v1/dashboard/superadmin/marketing/campaigns/:id/deliveries
 */
export async function getCampaignDeliveries(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { status, search, limit, offset } = req.query

    const statusArray = status
      ? ((Array.isArray(status) ? status : [status])
          .map(s => s as string)
          .filter(s => Object.values(DeliveryStatus).includes(s as DeliveryStatus)) as DeliveryStatus[])
      : undefined

    const result = await marketingService.getCampaignDeliveries(id, {
      status: statusArray,
      search: search as string,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    })

    return res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error getting campaign deliveries:', error)
    next(error)
  }
}

// ==========================================
// RECIPIENT PREVIEW
// ==========================================

/**
 * Preview recipients for a campaign
 * POST /api/v1/dashboard/superadmin/marketing/recipients/preview
 */
export async function previewRecipients(req: Request, res: Response, next: NextFunction) {
  try {
    const validation = previewRecipientsSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const result = await marketingService.previewRecipients(validation.data)

    return res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error previewing recipients:', error)
    next(error)
  }
}
