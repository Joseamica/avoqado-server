// src/controllers/organization/organization.controller.ts

/**
 * Organization Controller
 *
 * Handles HTTP requests for organization-level operations.
 * Thin layer that delegates business logic to the organization service.
 */

import { Request, Response, NextFunction } from 'express'
import * as organizationService from '../../services/organization/organization.service'
import logger from '../../config/logger'

/**
 * GET /organizations/:orgId
 * Get organization basic info
 */
export async function getOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const organization = await organizationService.getOrganizationById(orgId)
    res.json(organization)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /organizations/:orgId/overview
 * Get organization overview with aggregated metrics from all venues
 */
export async function getOrganizationOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const { timeRange, from, to } = req.query

    const filter: organizationService.DateRangeFilter = {
      timeRange: timeRange as '7d' | '30d' | '90d' | 'ytd' | 'all' | undefined,
      from: from ? new Date(from as string) : undefined,
      to: to ? new Date(to as string) : undefined,
    }

    const overview = await organizationService.getOrganizationOverview(orgId, filter)
    res.json(overview)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /organizations/:orgId/venues
 * Get all venues with detailed metrics
 */
export async function getOrganizationVenues(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const { timeRange, from, to } = req.query

    const filter: organizationService.DateRangeFilter = {
      timeRange: timeRange as '7d' | '30d' | '90d' | 'ytd' | 'all' | undefined,
      from: from ? new Date(from as string) : undefined,
      to: to ? new Date(to as string) : undefined,
    }

    const venues = await organizationService.getOrganizationVenues(orgId, filter)
    res.json(venues)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /organizations/:orgId/team
 * Get all team members across all venues
 */
export async function getOrganizationTeam(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const team = await organizationService.getOrganizationTeam(orgId)
    res.json(team)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /organizations/:orgId/stats
 * Get lightweight organization stats (for header/nav)
 */
export async function getOrganizationStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const stats = await organizationService.getOrganizationStats(orgId)
    res.json(stats)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /organizations/:orgId
 * Update organization details
 */
export async function updateOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId } = req.params
    const updateData = req.body

    const updated = await organizationService.updateOrganization(orgId, updateData)
    res.json(updated)
  } catch (error) {
    next(error)
  }
}
