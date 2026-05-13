/**
 * Payment Link Controller (Dashboard)
 *
 * Handles HTTP requests for payment link management.
 * Thin layer that orchestrates service calls and sends responses.
 *
 * @module controllers/dashboard/paymentLink
 */

import { Request, Response } from 'express'
import * as paymentLinkService from '@/services/dashboard/paymentLink.service'
import * as paymentLinkSettingsService from '@/services/dashboard/paymentLinkSettings.service'
import logger from '@/config/logger'

// ═══════════════════════════════════════════════════════════════════════════
// LIST & GET
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/dashboard/venues/:venueId/payment-links
 */
export async function listPaymentLinks(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { status, search, limit, offset } = req.query

    const result = await paymentLinkService.getPaymentLinks(venueId, {
      status: status as string | undefined,
      search: search as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })

    res.json({
      success: true,
      data: result,
    })
  } catch (error: any) {
    logger.error('Error listing payment links:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al listar ligas de pago',
    })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 */
export async function getPaymentLink(req: Request, res: Response) {
  try {
    const { venueId, linkId } = req.params

    const paymentLink = await paymentLinkService.getPaymentLinkById(venueId, linkId)

    res.json({
      success: true,
      data: paymentLink,
    })
  } catch (error: any) {
    logger.error('Error getting payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al obtener liga de pago',
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/dashboard/venues/:venueId/payment-links
 */
export async function createPaymentLink(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const staffId = authContext.userId

    const paymentLink = await paymentLinkService.createPaymentLink(venueId, req.body, staffId)

    res.status(201).json({
      success: true,
      data: paymentLink,
    })
  } catch (error: any) {
    logger.error('Error creating payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al crear liga de pago',
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PUT /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 */
export async function updatePaymentLink(req: Request, res: Response) {
  try {
    const { venueId, linkId } = req.params

    const paymentLink = await paymentLinkService.updatePaymentLink(venueId, linkId, req.body)

    res.json({
      success: true,
      data: paymentLink,
    })
  } catch (error: any) {
    logger.error('Error updating payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al actualizar liga de pago',
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE (ARCHIVE)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 */
export async function archivePaymentLink(req: Request, res: Response) {
  try {
    const { venueId, linkId } = req.params

    const result = await paymentLinkService.archivePaymentLink(venueId, linkId)

    res.json({
      success: true,
      data: result,
    })
  } catch (error: any) {
    logger.error('Error archiving payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al archivar liga de pago',
    })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/payment-links/branding/config
 */
export async function getPaymentLinkBranding(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const branding = await paymentLinkService.getPaymentLinkBranding(venueId)
    res.json({ success: true, data: branding })
  } catch (error: any) {
    logger.error('Error fetching payment link branding:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al obtener branding' })
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/payment-links/branding/config
 */
export async function updatePaymentLinkBranding(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId
    if (!staffId) {
      res.status(401).json({ success: false, error: 'Autenticación requerida' })
      return
    }
    const branding = await paymentLinkService.updatePaymentLinkBranding(venueId, req.body, staffId)
    res.json({ success: true, data: branding })
  } catch (error: any) {
    logger.error('Error updating payment link branding:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al actualizar branding' })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS — venue-wide defaults + notification preferences
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/dashboard/venues/:venueId/payment-links/settings
 */
export async function getPaymentLinkSettingsHandler(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const settings = await paymentLinkSettingsService.getPaymentLinkSettings(venueId)
    res.json({ success: true, data: settings })
  } catch (error: any) {
    logger.error('Error fetching payment link settings:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al obtener ajustes' })
  }
}

/**
 * PATCH /api/v1/dashboard/venues/:venueId/payment-links/settings
 */
export async function updatePaymentLinkSettingsHandler(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const settings = await paymentLinkSettingsService.upsertPaymentLinkSettings(venueId, req.body)
    res.json({ success: true, data: settings })
  } catch (error: any) {
    logger.error('Error updating payment link settings:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al actualizar ajustes' })
  }
}
