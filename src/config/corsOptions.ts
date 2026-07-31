import { CorsOptions } from 'cors'

export type Environment = 'development' | 'staging' | 'production'

/**
 * Cloudflare Pages preview deployments for the dashboard: `<branch>.<project>.pages.dev`.
 *
 * ANCHORED ON PURPOSE. The previous pattern was
 * `/\.(?:demo-)?avoqado-web-dashboard.*\.pages\.dev$/` — unanchored at the start
 * with a free `.*` before the suffix, which made the project name a PREFIX match
 * rather than an exact one. Anyone can create a Cloudflare Pages project, and
 * `<project>.pages.dev` is globally unique only for the exact name — so a project
 * called `avoqado-web-dashboard-attacker` was enough: its branch previews
 * (`https://x.avoqado-web-dashboard-attacker.pages.dev`) satisfied the old regex
 * and were handed a CORS grant. Combined with `credentials: true` and auth cookies
 * issued `sameSite: 'none'` + `secure` with no `domain`, an attacker page could
 * make authenticated calls to the API and READ the responses.
 *
 * 🔴 `avoqado-web-dashboard-4wx` is NOT a typo — don't "fix" it back. The
 * Cloudflare Pages project genuinely IS named `avoqado-web-dashboard`
 * (wrangler.toml, CI `--project-name`), but `<project>.pages.dev` is a GLOBAL
 * namespace — that exact name was already taken by someone else, so Cloudflare
 * silently serves the real project at the `-4wx`-suffixed domain instead.
 * `demo-avoqado-web-dashboard` didn't collide, so it kept its exact name with
 * no suffix — the two projects are independent literal alternatives below,
 * NOT derived from one shared prefix, because only one of them carries a
 * suffix. Verified 2026-07-31: `dig avoqado-web-dashboard.pages.dev` → NXDOMAIN,
 * `dig avoqado-web-dashboard-4wx.pages.dev` → resolves (and is exactly what
 * `dashboard.avoqado.io` CNAMEs to). The first cut of this anchor fix used the
 * project name instead of the real domain and silently broke every preview's
 * access to the API — reproduced live: logging in from
 * `develop.avoqado-web-dashboard-4wx.pages.dev` failed with "Server
 * Unavailable" because the origin didn't match. Before touching this regex
 * again, re-verify BOTH domains with dig/curl — never assume the configured
 * project name and its public pages.dev domain are the same string.
 *
 * The subdomain label is restricted to what Cloudflare actually generates
 * (lowercase alphanumerics and hyphens). This branch applies in ALL
 * environments, production included, which is exactly why it has to be exact.
 */
const CLOUDFLARE_PAGES_PREVIEW = /^https:\/\/[a-z0-9-]+\.(?:avoqado-web-dashboard-4wx|demo-avoqado-web-dashboard)\.pages\.dev$/

// Environment-specific CORS configuration
export const getCorsConfig = (env: Environment): CorsOptions => {
  // Define allowed origins based on environment
  const dashboardOrigins = {
    development: [
      'http://localhost:5173',
      'http://localhost:8080',
      'http://localhost:3000',
      'http://localhost:5177',
      'http://10.55.2.212:5173', // LAN IP — dashboard dev server accessed from another device on the network
    ], // ← Dashboard (5173), Backend for SDK (3000)
    staging: [
      'https://develop.avoqado-web-dashboard.pages.dev',
      'https://demo-avoqado-web-dashboard.pages.dev',
      'https://demo.dashboard.avoqado.io',
      'https://staging.dashboard.avoqado.io',
    ],
    production: [
      'https://dashboard.avoqado.io',
      'https://dashboardv2.avoqado.io',
      'https://demo.dashboard.avoqado.io',
      'https://superadmin.avoqado.io',
    ],
  }

  // Mobile apps use capacitor/webview origins on dev
  const mobileOrigins = {
    development: ['capacitor://localhost', 'http://localhost'],
    staging: [''],
    production: [''],
  }

  // TPV/POS client is Kotlin-based, no CORS required but listed for completeness
  const posOrigins = {
    development: ['http://localhost:7000'],
    staging: ['https://staging-pos.avoqado.io'],
    production: ['https://pos.avoqado.io'],
  }

  // Swagger/OpenAPI documentation origins
  const swaggerOrigins = {
    development: ['http://localhost:57777', 'http://127.0.0.1:57777'],
    staging: [],
    production: [],
  }

  // Public customer-facing sites (bills, payments, booking, etc.)
  const publicSiteOrigins = {
    development: ['http://localhost:3001', 'http://localhost:5174'], // Local bills dev + checkout dev
    staging: ['https://pay.staging.avoqado.io', 'https://book.staging.avoqado.io'],
    production: [
      'https://bills.avoqado.io',
      'https://avoqado.io',
      'https://pay.avoqado.io',
      // Public booking subdomain — proxies to the dashboard SPA's /book/<slug> routes.
      // Customers browse classes/appointments and submit reservations via /api/v1/public/* endpoints.
      'https://book.avoqado.io',
    ],
  }

  // SDK/Checkout origins (payment form iframe served from API domain needs to POST back to itself)
  const sdkOrigins = {
    development: ['http://localhost:3000'],
    staging: [],
    production: ['https://api.avoqado.io'],
  }

  // Combine all allowed origins for this environment
  const allowedOrigins = [
    // SECURITY: 'null' origin only in development for Swagger UI
    // In production, 'null' can be exploited via local HTML files or data: URLs
    ...(env === 'development' ? ['null'] : []),
    ...(dashboardOrigins[env] || []),
    ...(mobileOrigins[env] || []),
    ...(posOrigins[env] || []),
    ...(swaggerOrigins[env] || []),
    ...(publicSiteOrigins[env] || []),
    ...(sdkOrigins[env] || []),
  ]

  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, postman)
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true)
      } else if (env === 'development' && origin && /^https?:\/\/[^/]+\.trycloudflare\.com(?::\d+)?$/i.test(origin)) {
        // Allow Cloudflare quick tunnels in local development
        callback(null, true)
      } else if (env === 'development' && origin && /^https?:\/\/[^/]+\.ngrok-free\.dev(?::\d+)?$/i.test(origin)) {
        // Allow ngrok tunnels in local development
        callback(null, true)
      } else if (origin && CLOUDFLARE_PAGES_PREVIEW.test(origin)) {
        // Allow Cloudflare Pages preview deployments (all environments)
        callback(null, true)
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`))
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-api-key',
      'x-client-type',
      'x-client-id',
      'x-venue-id',
      // Idempotency-Key: bulk endpoints (sim-custody) deduplicate retries by
      // this header. Browser blocks the real request in preflight if not
      // whitelisted here.
      'Idempotency-Key',
      // TPV/Android sends X-App-Version-Code for staged-rollout gating (plan §1.5).
      'X-App-Version-Code',
      // Correlation ID for request tracing (used across sim-custody logs + others).
      'X-Correlation-Id',
      'Origin',
      'X-Requested-With',
      'Accept',
      'Access-Control-Allow-Headers',
      'Access-Control-Request-Method',
      'Access-Control-Request-Headers',
    ],
    exposedHeaders: ['X-Client-Id', 'X-Total-Labels'],
    credentials: true,
    optionsSuccessStatus: 200,
    maxAge: 86400, // Cache preflight results for 24 hours
  }
}
