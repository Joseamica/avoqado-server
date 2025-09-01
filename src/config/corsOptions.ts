import { CorsOptions } from 'cors'

export type Environment = 'development' | 'staging' | 'production'

// Environment-specific CORS configuration
export const getCorsConfig = (env: Environment): CorsOptions => {
  // Define allowed origins based on environment
  const dashboardOrigins = {
    development: ['http://localhost:3000', 'http://localhost:8080'],
    staging: ['https://develop.avoqado-web-dashboard.pages.dev'],
    production: ['https://dashboard.avoqado.io', 'https://dashboardv2.avoqado.io'],
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

  // Combine all allowed origins for this environment
  const allowedOrigins = [
    // Add null origin to support login form in Swagger UI auth page
    'null',
    ...(dashboardOrigins[env] || []),
    ...(mobileOrigins[env] || []),
    ...(posOrigins[env] || []),
    ...(swaggerOrigins[env] || []),
  ]

  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, postman)
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
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
