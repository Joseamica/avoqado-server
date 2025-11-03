// src/controllers/dashboard/googleIntegration.dashboard.controller.ts
import { NextFunction, Request, Response } from 'express'
import { randomBytes } from 'crypto'

import * as googleBusinessProfileService from '../../services/googleBusinessProfile.service'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { AuthContext } from '@/security'

// Extend Request type to include authContext
interface AuthenticatedRequest extends Request {
  authContext?: AuthContext
}

/**
 * Initialize Google OAuth flow
 * POST /api/v1/dashboard/venues/:venueId/integrations/google/init-oauth
 */
export async function initGoogleOAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const userId = req.authContext!.userId

    // Generate random state token for CSRF protection
    // Encode venueId in the state to handle the redirect without URL params
    const stateToken = randomBytes(32).toString('hex')
    const state = `${stateToken}:${venueId}`

    // Store state in database with 15-minute expiration
    await prisma.oAuthState.create({
      data: {
        state: stateToken, // Store only the random token part
        venueId,
        userId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    })

    // Generate OAuth authorization URL
    const authUrl = googleBusinessProfileService.generateAuthUrl(state)

    res.status(200).json({
      success: true,
      authUrl,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Handle Google OAuth callback
 * GET /api/v1/dashboard/integrations/google/callback
 */
export async function handleGoogleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { code, state, error } = req.query

    // Check for OAuth errors
    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/integrations/google?error=${error}`)
    }

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      throw new AppError('Missing authorization code or state', 400)
    }

    // Extract stateToken and venueId from state parameter
    const [stateToken, venueId] = state.split(':')

    if (!stateToken || !venueId) {
      throw new AppError('Invalid state parameter', 400)
    }

    // Verify state token
    const oauthState = await prisma.oAuthState.findUnique({
      where: { state: stateToken },
    })

    if (!oauthState) {
      throw new AppError('Invalid or expired state token', 400)
    }

    // Verify venueId matches
    if (oauthState.venueId !== venueId) {
      await prisma.oAuthState.delete({ where: { id: oauthState.id } })
      throw new AppError('State parameter does not match stored venue', 400)
    }

    // Check if state has expired
    if (oauthState.expiresAt < new Date()) {
      await prisma.oAuthState.delete({ where: { id: oauthState.id } })
      throw new AppError('State token has expired', 400)
    }

    // Exchange code for tokens
    const tokenData = await googleBusinessProfileService.exchangeCodeForTokens(code)

    // Get venue slug for redirect
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { slug: true },
    })

    if (!venue) {
      await prisma.oAuthState.delete({ where: { id: oauthState.id } })
      throw new AppError('Venue not found', 404)
    }

    // Get list of locations
    const locations = await googleBusinessProfileService.listLocations(tokenData.accessToken!)

    if (locations.length === 0) {
      // Delete state and redirect with error
      await prisma.oAuthState.delete({ where: { id: oauthState.id } })
      return res.redirect(`${process.env.FRONTEND_URL}/venues/${venue.slug}/settings/integrations/google?error=no_locations`)
    }

    // Use first location (most businesses have only one)
    const firstLocation = locations[0]

    // Update venue with Google integration data
    await prisma.venue.update({
      where: { id: oauthState.venueId },
      data: {
        googleBusinessProfileConnected: true,
        googleBusinessProfileEmail: tokenData.email!,
        googlePlaceId: firstLocation.name, // Store the resource name
        googleLocationName: firstLocation.title,
        googleAccessToken: tokenData.accessToken!,
        googleRefreshToken: tokenData.refreshToken!,
        googleTokenExpiresAt: tokenData.expiresAt,
        googleLastSyncAt: new Date(),
      },
    })

    // Delete used state
    await prisma.oAuthState.delete({ where: { id: oauthState.id } })

    // Redirect back to dashboard with success
    res.redirect(`${process.env.FRONTEND_URL}/venues/${venue.slug}/settings/integrations/google?success=true`)
  } catch (error) {
    next(error)
  }
}

/**
 * Get Google integration status
 * GET /api/v1/dashboard/venues/:venueId/integrations/google/status
 */
export async function getGoogleIntegrationStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        googleBusinessProfileConnected: true,
        googleBusinessProfileEmail: true,
        googleLocationName: true,
        googlePlaceId: true,
        googleLastSyncAt: true,
      },
    })

    if (!venue) {
      throw new AppError('Venue not found', 404)
    }

    // Get count of Google reviews
    const reviewsCount = venue.googleBusinessProfileConnected
      ? await prisma.review.count({
          where: {
            venueId,
            source: 'GOOGLE',
          },
        })
      : 0

    res.status(200).json({
      connected: venue.googleBusinessProfileConnected,
      email: venue.googleBusinessProfileEmail,
      locationName: venue.googleLocationName,
      placeId: venue.googlePlaceId,
      lastSyncAt: venue.googleLastSyncAt,
      reviewsCount,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Manually trigger Google reviews sync
 * POST /api/v1/dashboard/venues/:venueId/integrations/google/sync
 */
export async function syncGoogleReviews(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    // Import sync service
    const { syncVenueGoogleReviews } = await import('../../services/reviewSync.service')

    const syncedCount = await syncVenueGoogleReviews(venueId)

    res.status(200).json({
      success: true,
      syncedCount,
      message: `Successfully synced ${syncedCount} reviews`,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Disconnect Google Business Profile integration
 * DELETE /api/v1/dashboard/venues/:venueId/integrations/google/disconnect
 */
export async function disconnectGoogleIntegration(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    await prisma.venue.update({
      where: { id: venueId },
      data: {
        googleBusinessProfileConnected: false,
        googleBusinessProfileEmail: null,
        googlePlaceId: null,
        googleLocationName: null,
        googleAccessToken: null,
        googleRefreshToken: null,
        googleTokenExpiresAt: null,
      },
    })

    res.status(200).json({
      success: true,
      message: 'Google Business Profile integration disconnected',
    })
  } catch (error) {
    next(error)
  }
}
