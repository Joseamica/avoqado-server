import { Request, Response } from 'express'
import { analyticsOverviewQuerySchema } from '@/schemas/analytics/analytics.schema'
import { buildAnalyticsOverview } from '@/services/analytics/overview.analytics.service'
import logger from '@/config/logger'
import { StaffRole } from '@prisma/client'

export const getAnalyticsOverview = async (req: Request, res: Response) => {
  const correlationId = (req as any).correlationId || 'N/A'

  try {
    // validate via schema (middleware also validates but we re-parse to get typed query here if needed)
    const parsed = analyticsOverviewQuerySchema.parse({ query: req.query })
    const query = parsed.query

    const auth = req.authContext
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing auth context' })
    }

    const isExecutive = auth.role === StaffRole.OWNER || auth.role === StaffRole.ADMIN || auth.role === StaffRole.SUPERADMIN
    const maskSensitive = !isExecutive

    // Determine language preference: query.lang overrides Accept-Language header
    const acceptLang = (req.headers['accept-language'] || '').toString()
    const preferredLang = (query as any).lang || (acceptLang.startsWith('es') ? 'es' : 'en')

    const data = await buildAnalyticsOverview({
      ...query,
      orgId: query.orgId || auth.orgId,
      venueId: query.venueId || auth.venueId,
      lang: preferredLang,
      maskSensitive,
      viewerRole: auth.role,
    })

    return res.status(200).json({
      success: true,
      meta: { correlationId, orgId: data.orgId, venueId: data.venueId, refreshedAt: data.refreshedAt, lang: preferredLang },
      overview: data.overview,
    })
  } catch (error) {
    logger.error('Failed to get analytics overview', { error, correlationId })
    return res.status(500).json({ error: 'InternalServerError', message: 'Failed to get analytics overview' })
  }
}
