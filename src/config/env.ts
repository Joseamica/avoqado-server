import dotenv from 'dotenv'
import logger from './logger' // Assuming logger is already in src/config

dotenv.config() // Load .env file at the very beginning

export const NODE_ENV = process.env.NODE_ENV || 'development'
export const PORT = process.env.PORT || 12344

// Critical environment variables check
const requiredEnvVars: string[] = [
  'ACCESS_TOKEN_SECRET',
  'SESSION_SECRET',
  'COOKIE_SECRET',
  'DATABASE_URL', // Assuming DATABASE_URL is primary for pgPool and Prisma
]

let missingVars = false
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    logger.error(`FATAL ERROR: Environment variable ${varName} is not defined.`)
    missingVars = true
  }
})

if (missingVars) {
  process.exit(1)
}

// Export other environment variables as needed, or access them via process.env directly
export const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET!
export const SESSION_SECRET = process.env.SESSION_SECRET!
export const COOKIE_SECRET = process.env.COOKIE_SECRET!
export const DATABASE_URL = process.env.DATABASE_URL!

export const BODY_JSON_LIMIT = process.env.BODY_JSON_LIMIT || '1mb'
export const BODY_URLENCODED_LIMIT = process.env.BODY_URLENCODED_LIMIT || '5mb'
export const SESSION_TABLE_NAME = process.env.SESSION_TABLE_NAME || 'user_sessions'
export const SESSION_MAX_AGE_MS = process.env.SESSION_MAX_AGE_MS ? parseInt(process.env.SESSION_MAX_AGE_MS, 10) : 24 * 60 * 60 * 1000 // Default: 1 day
export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'avoqado.sid'
export const RABBITMQ_URL = process.env.RABBITMQ_URL!

// Menta API credentials (optional with fallbacks)
export const MENTA_USERNAME = process.env.MENTA_USERNAME
export const MENTA_PASSWORD = process.env.MENTA_PASSWORD
export const MENTA_MERCHANT_API_KEY = process.env.MENTA_MERCHANT_API_KEY

logger.info('Environment variables loaded and checked.')
