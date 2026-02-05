/**
 * Marketing Campaign Routes (Superadmin)
 *
 * Endpoints for managing email campaigns and templates.
 * All routes require SUPERADMIN authentication (handled by parent router).
 */

import { Router } from 'express'
import * as marketingController from '../../controllers/superadmin/marketing.superadmin.controller'

const router = Router()

// ==========================================
// TEMPLATE ROUTES
// ==========================================

// List all templates
router.get('/templates', marketingController.listTemplates)

// Get a single template
router.get('/templates/:id', marketingController.getTemplate)

// Create a new template
router.post('/templates', marketingController.createTemplate)

// Update a template
router.patch('/templates/:id', marketingController.updateTemplate)

// Delete a template
router.delete('/templates/:id', marketingController.deleteTemplate)

// ==========================================
// CAMPAIGN ROUTES
// ==========================================

// List all campaigns
router.get('/campaigns', marketingController.listCampaigns)

// Bulk delete campaigns (must be before :id route)
router.delete('/campaigns/bulk', marketingController.bulkDeleteCampaigns)

// Get a single campaign
router.get('/campaigns/:id', marketingController.getCampaign)

// Create a new campaign
router.post('/campaigns', marketingController.createCampaign)

// Update a campaign
router.patch('/campaigns/:id', marketingController.updateCampaign)

// Delete a campaign
router.delete('/campaigns/:id', marketingController.deleteCampaign)

// Send a campaign
router.post('/campaigns/:id/send', marketingController.sendCampaign)

// Cancel a sending campaign
router.post('/campaigns/:id/cancel', marketingController.cancelCampaign)

// Get campaign deliveries
router.get('/campaigns/:id/deliveries', marketingController.getCampaignDeliveries)

// ==========================================
// RECIPIENT PREVIEW
// ==========================================

// Preview recipients for campaign targeting
router.post('/recipients/preview', marketingController.previewRecipients)

export default router
