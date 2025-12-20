import express, { Express, Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import type { StringValue } from 'ms'
import { StaffRole } from '@prisma/client' // Assuming Prisma client is set up

import { NODE_ENV, ACCESS_TOKEN_SECRET } from './config/env'
import logger from './config/logger'
import { configureCoreMiddlewares } from './config/middleware'
import { setupSwaggerUI } from './config/swagger'
import AppError from './errors/AppError'
import mainApiRouter from './routes' // Esto importa el 'router' exportado por defecto de 'src/routes/index.ts'

// Import routes
import publicMenuRoutes from './routes/publicMenu.routes'
import webhookRoutes from './routes/webhook.routes'

// Types (could be moved to a central types file)
import { AvoqadoJwtPayload } from './security' // Assuming this is where the type is defined

const app: Express = express()

// ⚠️ IMPORTANT: Webhook routes MUST be mounted BEFORE configureCoreMiddlewares
// Stripe webhooks require raw body (not JSON parsed) for signature verification
app.use(
  '/api/v1/webhooks',
  express.raw({ type: 'application/json' }), // Raw body parser for Stripe signature verification
  webhookRoutes,
)

// Configure core middlewares (helmet, cors, compression, body-parsers, cookie-parser, session, request-logger)
configureCoreMiddlewares(app)

// Serve static files from public directory (SDK, checkout pages)
app.use(express.static('public'))

// Setup Swagger UI
setupSwaggerUI(app)

// --- Application Routes ---
app.use('/api/v1/venues/:venueId/public-menu', publicMenuRoutes)

// --- Legacy QR Code Redirects ---
// Redirects for obsolete merchandise QR codes (https://api.demo.avoqado.io/v1/demo/generate)
app.get('/v1/demo/generate', (req: ExpressRequest, res: ExpressResponse) => {
  res.redirect(301, 'https://links.avoqado.io/')
})

// Redirect bill generation to deprecated API (old avo-pwa backend)
app.get('/v1/venues/:venueId/bill/generate', (req: ExpressRequest, res: ExpressResponse) => {
  res.redirect(301, `https://api-deprecated.avoqado.io/v1/venues/${req.params.venueId}/bill/generate`)
})

// --- Montaje de Rutas de la API ---
const API_PREFIX = process.env.API_PREFIX || '/api/v1' // Define un prefijo base para tu API
app.use(API_PREFIX, mainApiRouter)

// Health check endpoints
// Lightweight check for load balancers (no DB query)
app.get('/health', (req: ExpressRequest, res: ExpressResponse) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Deep health check with database connectivity verification
app.get('/api/public/healthcheck', async (req: ExpressRequest, res: ExpressResponse) => {
  const correlationId = (req as any).correlationId || 'N/A'
  const startTime = Date.now()

  try {
    // Import prisma lazily to avoid circular dependency
    const prisma = (await import('./utils/prismaClient')).default

    // Simple DB connectivity check (SELECT 1)
    await prisma.$queryRaw`SELECT 1`

    const responseTime = Date.now() - startTime
    logger.info('Health check accessed.', { correlationId, responseTime })

    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      correlationId,
      checks: {
        database: 'connected',
        responseTimeMs: responseTime,
      },
    })
  } catch (error) {
    const responseTime = Date.now() - startTime
    logger.error('Health check failed - database unreachable', { correlationId, error })

    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      correlationId,
      checks: {
        database: 'disconnected',
        responseTimeMs: responseTime,
      },
    })
  }
})

// --- Development Only Endpoints ---
if (NODE_ENV === 'development') {
  // Interface for the /api/dev/generate-token request body
  interface GenerateTokenRequestBody {
    sub?: string // userId
    orgId?: string
    venueId?: string
    role: StaffRole
    expiresIn?: StringValue // e.g., '1h', '7d'
  }

  const generateTestToken = (payloadOverride: Partial<AvoqadoJwtPayload>, expiresIn?: StringValue): string => {
    const defaultPayload: AvoqadoJwtPayload = {
      sub: payloadOverride.sub || 'dev-user-id',
      orgId: payloadOverride.orgId || 'dev-org-id',
      venueId: payloadOverride.venueId || 'dev-venue-id',
      role: payloadOverride.role || StaffRole.VIEWER, // Default to a basic role
      // iat, exp will be added by jwt.sign
    }

    const payload: AvoqadoJwtPayload = { ...defaultPayload, ...payloadOverride }
    const signOptions: jwt.SignOptions = {
      expiresIn: expiresIn || '1d', // Default to 1 day for dev tokens
    }

    return jwt.sign(payload, ACCESS_TOKEN_SECRET, signOptions)
  }

  app.post('/api/dev/generate-token', (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      const { sub, orgId, venueId, role, expiresIn } = req.body as GenerateTokenRequestBody
      const correlationId = (req as any).correlationId || 'N/A'
      logger.warn(`Development endpoint /api/dev/generate-token accessed.`, { correlationId })

      if (!role || !Object.values(StaffRole).includes(role)) {
        return res.status(400).json({ message: 'Invalid or missing role.' })
      }

      const token = generateTestToken({ sub, orgId, venueId, role }, expiresIn)
      logger.info(`Generated test token for role: ${role}`, { correlationId })
      return res.status(200).json({ token })
    } catch (error) {
      next(error)
    }
  })
  logger.warn('Development endpoint /api/dev/generate-token is ENABLED.')
}

// --- Global Error Handling Middleware ---
// This must be the last middleware added to the app.
app.use((err: Error, req: ExpressRequest, res: ExpressResponse, _next: NextFunction) => {
  const correlationId = (req as any).correlationId || 'N/A'

  if (err instanceof AppError) {
    logger.error(`AppError: ${err.message}, StatusCode: ${err.statusCode}, CorrelationID: ${correlationId}`, {
      name: err.name,
      statusCode: err.statusCode,
      isOperational: err.isOperational,
      stack: NODE_ENV === 'development' ? err.stack : undefined, // Only send stack in dev
      correlationId,
      request: {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
      },
    })
    return res.status(err.statusCode).json({
      message: err.message,
      ...(err.code && { code: err.code }), // Include error code if present (Stripe/GitHub pattern)
      ...(NODE_ENV === 'development' && { errorName: err.name }),
    })
  }

  // For non-operational errors or built-in errors
  logger.error(`Unexpected Error: ${err.message}, CorrelationID: ${correlationId}`, {
    name: err.name,
    message: err.message,
    stack: err.stack, // Log stack for all unexpected errors
    correlationId,
    isOperational: false,
    request: {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
    },
  })

  if (NODE_ENV === 'development') {
    return res.status(500).json({
      message: err.message,
      errorName: err.name,
      stack: err.stack,
    })
  }

  return res.status(500).json({
    message: 'Ocurrió un error inesperado en el servidor.',
  })
})

export default app
