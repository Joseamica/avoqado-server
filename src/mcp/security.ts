import type { Express, RequestHandler } from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { createHash } from 'node:crypto'
import { getCorsConfig, type Environment } from '@/config/corsOptions'
import { MCP_ISSUER_URL } from './oauth/config'
import { MCP_LOGIN_SCRIPT } from './oauth/loginPage'

/** These routes finish before the application's shared helmet/CORS middleware. */
export function mountMcpSecurity(app: Express): void {
  const loginScriptHash = createHash('sha256').update(MCP_LOGIN_SCRIPT).digest('base64')
  const headers: RequestHandler = (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${loginScriptHash}'; frame-ancestors 'self' https://chatgpt.com https://claude.ai`,
    })
    next()
  }
  app.use(['/mcp', '/authorize', '/mcp-oauth', '/token', '/revoke', '/register'], headers)

  const env = (['production', 'staging'].includes(process.env.NODE_ENV ?? '') ? process.env.NODE_ENV : 'development') as Environment
  const baseCors = getCorsConfig(env)
  const allowedOrigin = (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (origin === 'null') return callback(null, false)
    if (!origin || [MCP_ISSUER_URL.origin, 'https://chatgpt.com', 'https://claude.ai'].includes(origin)) return callback(null, true)
    if (typeof baseCors.origin === 'function')
      return baseCors.origin(origin, (error, allowed) => callback(null, !error && allowed === true))
    callback(null, false)
  }
  app.use(
    '/mcp',
    (req, res, next) =>
      allowedOrigin(req.get('Origin'), (_error, allowed) => {
        if (allowed) return next()
        res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin no autorizado para Avoqado MCP.' } })
      }),
    cors({
      origin: allowedOrigin,
      credentials: false,
      methods: ['POST', 'GET', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID'],
      exposedHeaders: ['WWW-Authenticate', 'Retry-After', 'Mcp-Session-Id'],
    }),
  )
  // ponytail: per-process ceiling; use a shared store if deployment scales to multiple instances.
  app.post(
    '/mcp-oauth/approve',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiados intentos de conexión. Espera unos minutos y vuelve a intentarlo.' },
    }),
  )
}
