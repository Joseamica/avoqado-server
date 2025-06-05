import { CorsOptions } from 'cors'

export type Environment = 'development' | 'staging' | 'production'

// Environment-specific CORS configuration
export const getCorsConfig = (env: Environment): CorsOptions => {
  // Define allowed origins based on environment
  const dashboardOrigins = {
    development: ['http://localhost:3000', 'http://localhost:8080'],
    staging: ['https://staging-dashboard.avoqado.com'],
    production: ['https://dashboard.avoqado.com'],
  }

  // Mobile apps use capacitor/webview origins on dev
  const mobileOrigins = {
    development: ['capacitor://localhost', 'http://localhost'],
    staging: ['https://staging-app.avoqado.com'],
    production: ['https://app.avoqado.com'],
  }

  // TPV/POS client is Kotlin-based, no CORS required but listed for completeness
  const posOrigins = {
    development: ['http://localhost:7000'],
    staging: ['https://staging-pos.avoqado.com'],
    production: ['https://pos.avoqado.com'],
  }

  // Combine all allowed origins for this environment
  const allowedOrigins = [...(dashboardOrigins[env] || []), ...(mobileOrigins[env] || []), ...(posOrigins[env] || [])]

  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, postman)
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true)
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`))
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-client-type', 'x-client-id'],
    exposedHeaders: ['X-Client-Id'],
    credentials: true,
    optionsSuccessStatus: 200,
    maxAge: 86400, // Cache preflight results for 24 hours
  }
}
