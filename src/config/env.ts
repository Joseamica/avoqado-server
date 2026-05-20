import { z } from 'zod'
import dotenv from 'dotenv'
import logger from './logger'

// Load .env file FIRST (before any validation)
dotenv.config()

// ============================================================================
// Environment Variable Schema (Zod)
// ============================================================================
// This schema validates ALL environment variables at startup.
// If any required variable is missing or invalid, the app will NOT start.
//
// Pattern: "Fail Fast" - catch configuration errors immediately, not at runtime
// ============================================================================

const envSchema = z.object({
  // ─────────────────────────────────────────────────────────────────────────
  // CORE APPLICATION
  // ─────────────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'staging', 'production', 'demo', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  BASE_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  // ─────────────────────────────────────────────────────────────────────────
  // DATABASE (REQUIRED)
  // ─────────────────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),

  // ─────────────────────────────────────────────────────────────────────────
  // AUTHENTICATION (REQUIRED)
  // ─────────────────────────────────────────────────────────────────────────
  ACCESS_TOKEN_SECRET: z.string().min(16, 'ACCESS_TOKEN_SECRET must be at least 16 characters'),
  REFRESH_TOKEN_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be at least 16 characters'),
  JWT_SECRET: z.string().optional(), // Legacy alias for ACCESS_TOKEN_SECRET

  // ─────────────────────────────────────────────────────────────────────────
  // INFRASTRUCTURE
  // ─────────────────────────────────────────────────────────────────────────
  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required for POS integration'),
  REDIS_URL: z.string().optional(),

  // ─────────────────────────────────────────────────────────────────────────
  // SESSION CONFIGURATION
  // ─────────────────────────────────────────────────────────────────────────
  SESSION_TABLE_NAME: z.string().default('user_sessions'),
  SESSION_COOKIE_NAME: z.string().default('avoqado.sid'),
  SESSION_MAX_AGE_MS: z.coerce.number().default(24 * 60 * 60 * 1000), // 1 day

  // ─────────────────────────────────────────────────────────────────────────
  // REQUEST LIMITS
  // ─────────────────────────────────────────────────────────────────────────
  BODY_JSON_LIMIT: z.string().default('1mb'),
  BODY_URLENCODED_LIMIT: z.string().default('5mb'),

  // ─────────────────────────────────────────────────────────────────────────
  // THIRD-PARTY SERVICES (Optional - validated if present)
  // ─────────────────────────────────────────────────────────────────────────

  // Stripe
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().startsWith('pk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),

  // Resend (Email)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  ORDER_NOTIFICATIONS_EMAIL: z.string().email().optional(),

  // Blumon Payment SDK
  USE_BLUMON_MOCK: z
    .string()
    .transform(val => val === 'true')
    .default('true'),
  BLUMON_MASTER_USERNAME: z.string().optional(),
  BLUMON_MASTER_PASSWORD: z.string().optional(),
  BLUMON_KYC_EMAILS: z.string().optional(), // Comma-separated emails for KYC document delivery

  // Mercado Pago — Marketplace (Split Payments via Checkout Bricks)
  // CLIENT_ID = "Número de aplicación" from MP DevPanel; CLIENT_SECRET lives in
  // Credenciales de producción (applies to both test and prod — same value).
  MP_CLIENT_ID: z.string().min(1, 'MP_CLIENT_ID es requerido').optional(),
  MP_CLIENT_SECRET: z.string().min(1, 'MP_CLIENT_SECRET es requerido').optional(),
  MP_REDIRECT_URI: z.string().url('MP_REDIRECT_URI debe ser una URL válida').optional(),
  MP_WEBHOOK_SECRET: z.string().min(1, 'MP_WEBHOOK_SECRET es requerido').optional(),
  MP_PUBLIC_KEY_TEST: z.string().min(1).optional(),
  MP_PUBLIC_KEY_PROD: z.string().min(1).optional(),
  MP_ACCESS_TOKEN_TEST: z.string().min(1).optional(),
  // 32-byte hex (64 chars) AES-256-GCM key encrypting MP seller refresh+access
  // tokens at rest. ROTATE-SEPARATELY from JWT_SECRET and GOOGLE_CALENDAR_TOKEN_KEY.
  MERCADO_PAGO_TOKEN_KEY: z.string().length(64, 'MERCADO_PAGO_TOKEN_KEY debe ser hex de 32 bytes (64 chars)').optional(),
  MP_API_BASE_URL: z.string().url().default('https://api.mercadopago.com'),
  MP_AUTH_BASE_URL: z.string().url().default('https://auth.mercadopago.com.mx'),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_BP_REDIRECT_URI: z.string().url().optional(),

  // Firebase
  FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_STORAGE_BUCKET: z.string().optional(),

  // Legacy SMTP (deprecated, use Resend)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // ─────────────────────────────────────────────────────────────────────────
  // MONITORING & LOGGING
  // ─────────────────────────────────────────────────────────────────────────
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_DIR: z.string().default('logs/'),
  SIMPLE_LOGGING: z
    .string()
    .transform(val => val === 'true')
    .optional(),
  SENTRY_DSN: z.string().url().optional(),
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().optional(),

  // ─────────────────────────────────────────────────────────────────────────
  // DEVELOPMENT TOOLS
  // ─────────────────────────────────────────────────────────────────────────
  ENABLE_DEV_TOOLS: z
    .string()
    .transform(val => val === 'true')
    .default('false'),
  API_PREFIX: z.string().default('/api/v1'),

  // ─────────────────────────────────────────────────────────────────────────
  // DEPLOYMENT (Auto-set by hosting providers)
  // ─────────────────────────────────────────────────────────────────────────
  FLY_APP_NAME: z.string().optional(),
  FLY_REGION: z.string().optional(),
  RENDER_INSTANCE_ID: z.string().optional(),
  RENDER_SERVICE_NAME: z.string().optional(),
})

// ============================================================================
// Parse and Validate
// ============================================================================

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  logger.error('\n❌ ═══════════════════════════════════════════════════════════')
  logger.error('   INVALID ENVIRONMENT VARIABLES - Application cannot start')
  logger.error('═══════════════════════════════════════════════════════════════\n')

  const errors = parsed.error.flatten().fieldErrors
  for (const [field, messages] of Object.entries(errors)) {
    logger.error(`   • ${field}: ${messages?.join(', ')}`)
  }

  logger.error('\n📋 Check your .env file or environment configuration.')
  logger.error('   See .env.example for required variables.\n')
  process.exit(1)
}

// ============================================================================
// Export validated environment
// ============================================================================

export const env = parsed.data

// Named exports for backward compatibility
export const {
  NODE_ENV,
  PORT,
  BASE_URL,
  FRONTEND_URL,
  DATABASE_URL,
  ACCESS_TOKEN_SECRET,
  SESSION_SECRET,
  COOKIE_SECRET,
  RABBITMQ_URL,
  REDIS_URL,
  SESSION_TABLE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  BODY_JSON_LIMIT,
  BODY_URLENCODED_LIMIT,
  LOG_LEVEL,
  ENABLE_DEV_TOOLS,
} = env

// Log success (only in development to avoid log noise in production)
if (NODE_ENV === 'development') {
  logger.info('✅ Environment variables validated successfully')
}
