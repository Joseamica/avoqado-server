// src/routes/organization.routes.ts

/**
 * Organization Routes
 *
 * API endpoints for organization-level operations.
 * Only accessible by OWNER of the organization or SUPERADMIN.
 *
 * Base path: /api/v1/organizations
 */

import express from 'express'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { checkOwnerAccess } from '../middlewares/checkOwnerAccess.middleware'
import * as organizationController from '../controllers/organization/organization.controller'

const router = express.Router()

// All organization routes require authentication
router.use(authenticateTokenMiddleware)

/**
 * GET /organizations/:orgId
 * Get organization basic info
 */
router.get('/:orgId', checkOwnerAccess, organizationController.getOrganization)

/**
 * GET /organizations/:orgId/overview
 * Get organization overview with aggregated metrics from all venues
 * Query params: timeRange (7d|30d|90d|ytd|all), from, to
 */
router.get('/:orgId/overview', checkOwnerAccess, organizationController.getOrganizationOverview)

/**
 * GET /organizations/:orgId/venues
 * Get all venues with detailed metrics
 * Query params: timeRange (7d|30d|90d|ytd|all), from, to
 */
router.get('/:orgId/venues', checkOwnerAccess, organizationController.getOrganizationVenues)

/**
 * GET /organizations/:orgId/team
 * Get all team members across all venues
 */
router.get('/:orgId/team', checkOwnerAccess, organizationController.getOrganizationTeam)

/**
 * GET /organizations/:orgId/stats
 * Get lightweight organization stats (for header/nav)
 */
router.get('/:orgId/stats', checkOwnerAccess, organizationController.getOrganizationStats)

/**
 * PUT /organizations/:orgId
 * Update organization details
 */
router.put('/:orgId', checkOwnerAccess, organizationController.updateOrganization)

// =============================================================================
// Analytics Endpoints
// =============================================================================

/**
 * GET /organizations/:orgId/analytics/enhanced-overview
 * Get enhanced overview with comparisons, period changes, and top venues
 * Query params: timeRange (7d|30d|90d|ytd|all), from, to
 */
router.get('/:orgId/analytics/enhanced-overview', checkOwnerAccess, organizationController.getEnhancedOverview)

/**
 * GET /organizations/:orgId/analytics/revenue-trends
 * Get revenue trends with time series data for charts
 * Query params: timeRange (7d|30d|90d|ytd|all), from, to
 */
router.get('/:orgId/analytics/revenue-trends', checkOwnerAccess, organizationController.getRevenueTrends)

/**
 * GET /organizations/:orgId/analytics/top-items
 * Get top selling items across organization
 * Query params: timeRange (7d|30d|90d|ytd|all), from, to, limit
 */
router.get('/:orgId/analytics/top-items', checkOwnerAccess, organizationController.getTopItems)

/**
 * GET /organizations/:orgId/analytics/venue-benchmarks
 * Get venue benchmarks comparing against organization averages
 * Query params: timeRange (7d|30d|90d|ytd|all), from, to
 */
router.get('/:orgId/analytics/venue-benchmarks', checkOwnerAccess, organizationController.getVenueBenchmarks)

export default router
