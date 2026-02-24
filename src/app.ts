import express, { Express, Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import type { StringValue } from 'ms'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { monitorEventLoopDelay } from 'perf_hooks'
import { StaffRole } from '@prisma/client' // Assuming Prisma client is set up

import { NODE_ENV, ACCESS_TOKEN_SECRET } from './config/env'
import logger from './config/logger'
import { configureCoreMiddlewares } from './config/middleware'
import { setupSwaggerUI } from './config/swagger'
import AppError from './errors/AppError'
import mainApiRouter from './routes' // Esto importa el 'router' exportado por defecto de 'src/routes/index.ts'
import { getCorsConfig, Environment } from './config/corsOptions'

// Import routes
import publicMenuRoutes from './routes/publicMenu.routes'
import webhookRoutes from './routes/webhook.routes'
import publicRoutes from './routes/public.routes'
import appUpdateRoutes from './routes/superadmin/appUpdate.routes'
import { authenticateTokenMiddleware } from './middlewares/authenticateToken.middleware'
import { authorizeRole } from './middlewares/authorizeRole.middleware'

// Types (could be moved to a central types file)
import { AvoqadoJwtPayload } from './security' // Assuming this is where the type is defined
import { CONTAINER_CPU_LIMIT, CONTAINER_MEMORY_LIMIT_MB } from './utils/containerLimits'

const app: Express = express()

// --- Container-aware CPU + Event Loop monitoring (module-level) ---
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 })
eventLoopHistogram.enable()

let lastCpuUsage = process.cpuUsage()
let lastCpuTime = Date.now()
let cpuPercent = 0

setInterval(() => {
  const now = Date.now()
  const elapsedMicros = (now - lastCpuTime) * 1000 // ms → μs
  const current = process.cpuUsage()
  const userDelta = current.user - lastCpuUsage.user
  const sysDelta = current.system - lastCpuUsage.system
  // Scale by container CPU limit: 0.5 cores means only 50% of elapsed wall-time is available
  const availableMicros = CONTAINER_CPU_LIMIT * elapsedMicros
  cpuPercent = availableMicros > 0 ? Math.min(100, ((userDelta + sysDelta) / availableMicros) * 100) : 0
  lastCpuUsage = current
  lastCpuTime = now
}, 5_000).unref()

// Active HTTP connection counter (middleware-based, accurate)
let activeConnections = 0
app.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
  activeConnections++
  const onDone = () => {
    activeConnections = Math.max(0, activeConnections - 1)
  }
  res.once('finish', onDone)
  res.once('close', onDone)
  next()
})

// Getters for the metrics service to read live values
export function getAppCpuPercent() {
  return cpuPercent
}
export function getAppActiveConnections() {
  return activeConnections
}
export function getAppEventLoopHistogram() {
  return eventLoopHistogram
}

// ⚠️ IMPORTANT: Webhook routes MUST be mounted BEFORE configureCoreMiddlewares
// Stripe webhooks require raw body (not JSON parsed) for signature verification
app.use(
  '/api/v1/webhooks',
  express.raw({ type: 'application/json' }), // Raw body parser for Stripe signature verification
  webhookRoutes,
)

// ⚠️ IMPORTANT: App update routes need larger body limit for base64-encoded APKs (up to 100MB)
// Must be mounted BEFORE configureCoreMiddlewares to avoid the default 1MB limit
// Needs CORS + cookieParser since it's mounted before global middlewares
app.use(
  '/api/v1/superadmin/app-updates',
  cors(getCorsConfig(NODE_ENV as Environment)),
  cookieParser(),
  express.json({ limit: '100mb' }),
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.SUPERADMIN]),
  appUpdateRoutes,
)

// ⚠️ Public booking/receipt routes — mounted BEFORE global CORS so wildcard origin works for widget embedding
// These are unauthenticated endpoints (no credentials needed), safe to allow any origin
app.use('/api/v1/public', express.json(), cookieParser(), publicRoutes)

// Configure core middlewares (helmet, cors, compression, body-parsers, cookie-parser, session, request-logger)
configureCoreMiddlewares(app)

// Serve static files from public directory (SDK, checkout pages)
app.use(express.static('public'))

// Apple App Site Association (AASA) for Passkeys/WebAuthn
// Required for iOS passkey authentication to verify domain ownership
app.get('/.well-known/apple-app-site-association', (req: ExpressRequest, res: ExpressResponse) => {
  res.setHeader('Content-Type', 'application/json')
  res.json({
    webcredentials: {
      apps: ['ZPSQA32NDL.com.avoqado.avoqado-ios'],
    },
  })
})

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

// Public server metrics endpoint (no auth required, container-aware)
app.get('/api/public/metrics', (req: ExpressRequest, res: ExpressResponse) => {
  const mem = process.memoryUsage()

  res.status(200).json({
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: mem.rss,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      rssPercent: parseFloat(((mem.rss / (CONTAINER_MEMORY_LIMIT_MB * 1024 * 1024)) * 100).toFixed(1)),
      limitMb: CONTAINER_MEMORY_LIMIT_MB,
    },
    cpu: {
      percent: parseFloat(cpuPercent.toFixed(1)),
      limitCores: CONTAINER_CPU_LIMIT,
      raw: process.cpuUsage(),
    },
    eventLoop: {
      lagMs: parseFloat((eventLoopHistogram.mean / 1e6).toFixed(2)),
      lagP99Ms: parseFloat((eventLoopHistogram.percentile(99) / 1e6).toFixed(2)),
      lagMaxMs: parseFloat((eventLoopHistogram.max / 1e6).toFixed(2)),
    },
    connections: {
      active: activeConnections,
    },
  })
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
