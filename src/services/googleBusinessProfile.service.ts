// src/services/googleBusinessProfile.service.ts
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const GOOGLE_BP_REDIRECT_URI = process.env.GOOGLE_BP_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_BP_REDIRECT_URI) {
  throw new Error('Missing Google OAuth environment variables (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_BP_REDIRECT_URI)')
}

/**
 * Create and configure OAuth2 client
 */
export function createOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_BP_REDIRECT_URI)
}

/**
 * Generate OAuth authorization URL with required scopes
 */
export function generateAuthUrl(state: string): string {
  const oauth2Client = createOAuth2Client()

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/business.manage', // Read/write business info
      'https://www.googleapis.com/auth/userinfo.email', // Get user email
    ],
    state,
  })
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(code: string) {
  const oauth2Client = createOAuth2Client()

  try {
    const { tokens } = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)

    // Get user email
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
    const userInfo = await oauth2.userinfo.get()

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      email: userInfo.data.email,
    }
  } catch (error: any) {
    logger.warn('Error exchanging code for tokens:', error)
    throw new AppError('Failed to exchange authorization code', 400)
  }
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string) {
  const oauth2Client = createOAuth2Client()
  oauth2Client.setCredentials({ refresh_token: refreshToken })

  try {
    const { credentials } = await oauth2Client.refreshAccessToken()

    return {
      accessToken: credentials.access_token,
      expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
    }
  } catch (error: any) {
    logger.warn('Error refreshing access token:', error)
    throw new AppError('Failed to refresh access token', 401)
  }
}

/**
 * Get authenticated OAuth2 client for a venue
 * Automatically refreshes token if expired
 */
export async function getAuthenticatedClient(venueId: string): Promise<OAuth2Client> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      googleAccessToken: true,
      googleRefreshToken: true,
      googleTokenExpiresAt: true,
      googleBusinessProfileConnected: true,
    },
  })

  if (!venue?.googleBusinessProfileConnected || !venue.googleRefreshToken) {
    throw new AppError('Google Business Profile not connected', 400)
  }

  const oauth2Client = createOAuth2Client()

  // Check if token is expired or about to expire (within 5 minutes)
  const needsRefresh = !venue.googleTokenExpiresAt || venue.googleTokenExpiresAt.getTime() - Date.now() < 5 * 60 * 1000

  if (needsRefresh && venue.googleRefreshToken) {
    // Refresh token
    const { accessToken, expiresAt } = await refreshAccessToken(venue.googleRefreshToken)

    // Update venue with new token
    await prisma.venue.update({
      where: { id: venueId },
      data: {
        googleAccessToken: accessToken!,
        googleTokenExpiresAt: expiresAt,
      },
    })

    oauth2Client.setCredentials({
      access_token: accessToken!,
      refresh_token: venue.googleRefreshToken,
    })
  } else {
    oauth2Client.setCredentials({
      access_token: venue.googleAccessToken!,
      refresh_token: venue.googleRefreshToken,
    })
  }

  return oauth2Client
}

// Type for Google Business Profile location
export interface GoogleLocation {
  name: string // Resource name (e.g., "accounts/123/locations/456")
  title: string
  placeId?: string
}

// Type for Google Business Profile review
export interface GoogleReview {
  reviewId: string
  reviewer: {
    displayName: string
    profilePhotoUrl?: string
  }
  starRating: number
  comment: string
  createTime: string
  updateTime: string
  reviewReply: {
    comment: string
    updateTime: string
  } | null
}

/**
 * List Google Business Profile locations for the authenticated user
 *
 * TODO: Implement actual Google Business Profile API call
 * The Google My Business API v4 has been deprecated.
 * Use the Google Business Profile API or Google Places API instead.
 * Documentation: https://developers.google.com/my-business/content/overview
 */
export async function listLocations(accessToken: string): Promise<GoogleLocation[]> {
  try {
    // Step 1: Get list of accounts
    const accountsResponse = await fetch('https://mybusinessbusinessinformation.googleapis.com/v1/accounts', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (!accountsResponse.ok) {
      const errorData = await accountsResponse.json()
      logger.error('Error fetching Google accounts:', errorData)
      throw new AppError(`Google API error: ${errorData.error?.message || 'Unknown error'}`, accountsResponse.status)
    }

    const accountsData: any = await accountsResponse.json()
    const accounts = accountsData.accounts || []

    if (accounts.length === 0) {
      logger.warn('No Google Business Profile accounts found for user')
      return []
    }

    // Step 2: Get locations for the first account (most users have only one)
    const accountName = accounts[0].name // Format: "accounts/{accountId}"

    const locationsResponse = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,metadata`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    )

    if (!locationsResponse.ok) {
      const errorData = await locationsResponse.json()
      logger.error('Error fetching Google locations:', errorData)
      throw new AppError(`Google API error: ${errorData.error?.message || 'Unknown error'}`, locationsResponse.status)
    }

    const locationsData: any = await locationsResponse.json()
    const locations = locationsData.locations || []

    return locations.map((location: any) => ({
      name: location.name, // Resource name (e.g., "accounts/123/locations/456")
      title: location.title || location.locationName || 'Unnamed Location',
      placeId: location.metadata?.placeId,
    }))
  } catch (error: any) {
    if (error instanceof AppError) throw error
    logger.error('Error listing locations:', error)
    throw new AppError('Failed to fetch Google Business locations', 500)
  }
}

/**
 * Fetch reviews for a specific location
 */
export async function fetchReviews(venueId: string): Promise<{ reviews: GoogleReview[] }> {
  const oauth2Client = await getAuthenticatedClient(venueId)
  const credentials = oauth2Client.credentials

  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { googlePlaceId: true },
  })

  if (!venue?.googlePlaceId) {
    throw new AppError('Google Place ID not set for venue', 400)
  }

  if (!credentials.access_token) {
    throw new AppError('No access token available', 401)
  }

  try {
    // Fetch reviews using My Business Account Management API
    // Note: The location name format is "accounts/{accountId}/locations/{locationId}"
    const reviewsResponse = await fetch(`https://mybusinessaccountmanagement.googleapis.com/v1/${venue.googlePlaceId}/reviews`, {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        'Content-Type': 'application/json',
      },
    })

    if (!reviewsResponse.ok) {
      const errorData = await reviewsResponse.json()
      logger.error('Error fetching Google reviews:', errorData)
      throw new AppError(`Google API error: ${errorData.error?.message || 'Unknown error'}`, reviewsResponse.status)
    }

    const reviewsData: any = await reviewsResponse.json()

    return {
      reviews: (reviewsData.reviews || []).map((review: any) => ({
        reviewId: review.name?.split('/').pop() || review.reviewId,
        reviewer: {
          displayName: review.reviewer?.displayName || 'Anonymous',
          profilePhotoUrl: review.reviewer?.profilePhotoUrl,
        },
        starRating: review.starRating || 0,
        comment: review.comment || '',
        createTime: review.createTime,
        updateTime: review.updateTime,
        reviewReply: review.reviewReply
          ? {
              comment: review.reviewReply.comment,
              updateTime: review.reviewReply.updateTime,
            }
          : null,
      })),
    }
  } catch (error: any) {
    if (error instanceof AppError) throw error
    logger.error('Error fetching reviews:', error)
    throw new AppError('Failed to fetch Google reviews', 500)
  }
}

/**
 * Post a review response to Google Business Profile
 *
 * TODO: Implement actual Google Business Profile API call for posting review responses
 * Documentation: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply
 */
export async function postReviewResponse(venueId: string, googleReviewId: string, responseText: string) {
  const oauth2Client = await getAuthenticatedClient(venueId)
  const credentials = oauth2Client.credentials

  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { googlePlaceId: true },
  })

  if (!venue?.googlePlaceId) {
    throw new AppError('Google Place ID not set for venue', 400)
  }

  if (!credentials.access_token) {
    throw new AppError('No access token available', 401)
  }

  try {
    // Update review reply using My Business Account Management API
    // The review name format is "accounts/{accountId}/locations/{locationId}/reviews/{reviewId}"
    const reviewName = `${venue.googlePlaceId}/reviews/${googleReviewId}`

    const replyResponse = await fetch(`https://mybusinessaccountmanagement.googleapis.com/v1/${reviewName}/reply`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        comment: responseText,
      }),
    })

    if (!replyResponse.ok) {
      const errorData = await replyResponse.json()
      logger.error('Error posting review response:', errorData)
      throw new AppError(`Google API error: ${errorData.error?.message || 'Unknown error'}`, replyResponse.status)
    }

    const replyData = await replyResponse.json()

    return {
      success: true,
      reply: replyData,
    }
  } catch (error: any) {
    if (error instanceof AppError) throw error
    logger.error('Error posting review response:', error)
    throw new AppError('Failed to post review response to Google', 500)
  }
}
