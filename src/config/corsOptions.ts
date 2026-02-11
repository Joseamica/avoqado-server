import { CorsOptions } from 'cors'

export type Environment = 'development' | 'staging' | 'production'

// Environment-specific CORS configuration
export const getCorsConfig = (env: Environment): CorsOptions => {
  // Define allowed origins based on environment
  const dashboardOrigins = {
    development: ['http://localhost:5173', 'http://localhost:8080', 'http://localhost:3000'], // ← Dashboard (5173), Backend for SDK (3000)
    staging: [
      'https://develop.avoqado-web-dashboard.pages.dev',
      'https://demo-avoqado-web-dashboard.pages.dev',
      'https://demo.dashboard.avoqado.io',
      'https://staging.dashboard.avoqado.io',
    ],
    production: ['https://dashboard.avoqado.io', 'https://dashboardv2.avoqado.io', 'https://demo.dashboard.avoqado.io'],
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

  // Public customer-facing sites (bills, payments, etc.)
  const publicSiteOrigins = {
    development: ['http://localhost:3001'], // Local bills dev
    staging: [],
    production: ['https://bills.avoqado.io', 'https://avoqado.io'],
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
      } else if (origin && /\.(?:demo-)?avoqado-web-dashboard.*\.pages\.dev$/.test(origin)) {
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
      'Origin',
      'X-Requested-With',
      'Accept',
      'Access-Control-Allow-Headers',
      'Access-Control-Request-Method',
      'Access-Control-Request-Headers',
    ],
    exposedHeaders: ['X-Client-Id'],
    credentials: true,
    optionsSuccessStatus: 200,
    maxAge: 86400, // Cache preflight results for 24 hours
  }
}
