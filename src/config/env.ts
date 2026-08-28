import { z } from 'zod'
import dotenv from 'dotenv'
import logger from './logger'
import { dropEmptyValues } from './envHelpers'

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
  OTP_PEPPER: z.string().min(16), // Server secret peppering WhatsApp/email login OTP hashes

  // Sesiones revocables — Parte A, Task 9: llave AES-256-GCM (hex de 32 bytes) que cifra
  // el sucesor del refresh token durante la ventana de retransmisión de 60 s
  // (`RefreshGrant.successorEnc`). Vive FUERA de Postgres a propósito — ver
  // `src/services/auth/successorCrypto.ts`. OPCIONAL: si falta, ningún entorno se cae al
  // arrancar; simplemente no se guarda sucesor cifrado y un reintento de refresh se trata
  // como reutilización real (el comportamiento de hoy, sin esta tarea).
  // 🔴 [Auditoria Task 9, hallazgo critico] `.length(64, ...)` solo contaba caracteres — un
  // valor de 64 chars con una letra fuera de [0-9a-f] pasaba Zod, el servidor arrancaba
  // normal, y `Buffer.from(hex, 'hex')` trunca en el primer byte invalido produciendo una
  // llave de longitud arbitraria: `crypto.createCipheriv` lanza SIN captura en cada rotacion
  // de refresh de TODA la plataforma, no solo en la retransmision. El `.regex` cierra eso en
  // el arranque, donde Zod ya prometia validar el formato pero no lo hacia.
  SESSION_SUCCESSOR_ENC_KEY: z
    .string()
    .length(64, 'SESSION_SUCCESSOR_ENC_KEY debe ser hex de 32 bytes (64 chars)')
    .regex(/^[0-9a-f]{64}$/i, 'SESSION_SUCCESSOR_ENC_KEY debe ser hex de 32 bytes (64 chars)')
    .optional(),

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
  // Recipient for the weekly "new activated/paid venues" report (see
  // jobs/weekly-new-customers-report.job.ts). Unset = job logs a warning and
  // skips sending — never silently emails nowhere or to a wrong address.
  WEEKLY_NEW_CUSTOMERS_REPORT_EMAIL: z.string().email().optional(),

  // Blumon Payment SDK
  USE_BLUMON_MOCK: z
    .string()
    .transform(val => val === 'true')
    .default('true'),
  BLUMON_MASTER_USERNAME: z.string().optional(),
  BLUMON_MASTER_PASSWORD: z.string().optional(),
  BLUMON_KYC_EMAILS: z.string().optional(), // Comma-separated emails for KYC document delivery

  // External bank balance provider — one shared broker login
  // across all Avoqado sucursales; each sucursal is its own `negocio`.
  // 🔴 El default DEBE ser producción. Antes era 'https://api.qpaydev.xyz' — el entorno DEV del
  // proveedor — así que borrar esta variable en Render mandaba producción a dev EN SILENCIO
  // (cobros contra el ambiente equivocado, sin un solo error). El fallback tiene que fallar
  // hacia el lado seguro. No se hace `required`: un parseo fallido hace `process.exit(1)` y
  // tumbaría TODA la API por una variable de una sola feature. Ver EXTERNAL_BANK_DEV_HOSTS abajo.
  EXTERNAL_BANK_API_BASE: z.string().url().optional().default('https://api.quarkpayments.mx'),
  EXTERNAL_BANK_MG_PLATFORM: z.string().optional().default('MERCHANT'),
  EXTERNAL_BANK_MG_PLATFORM_CLIENT: z.string().optional().default('PWA'),
  EXTERNAL_BANK_EMAIL: z.string().optional(),
  EXTERNAL_BANK_PASSWORD: z.string().optional(),

  // ── Uber Eats Marketplace (integración directa) ────────────────────────────
  // Llave con la que Uber firma los webhooks entrantes (header X-Uber-Signature).
  // 🔴 NO es el client secret de la app: es la "Signing Key" dedicada que se
  // registra en el dashboard al dar de alta el webhook con Basic HMAC.
  // Opcional a propósito: un venue sin Uber no debe impedir que arranque la API
  // (mismo criterio que EXTERNAL_BANK_*). El verificador falla claro si falta.
  UBER_WEBHOOK_SIGNING_KEY: z.string().optional(),

  /// DiDi Food — `app_secret` de la app. Firma los webhooks: `MD5(cuerpo crudo + secreto)`.
  /// Hay uno por app, y las apps de prueba y producción tienen secretos distintos.
  DIDI_APP_SECRET_SANDBOX: z.string().optional(),
  DIDI_APP_SECRET_PRODUCTION: z.string().optional(),
  // Rotación: Uber ofrece Secondary Signing Key nativa. Si está presente, el
  // webhook acepta CUALQUIERA de las dos durante la ventana de rotación.
  UBER_WEBHOOK_SIGNING_KEY_SECONDARY: z.string().optional(),

  // Ambiente de Uber. Decide el PAR de hosts (login↔api), que es INSEPARABLE:
  // SANDBOX ⇒ sandbox-login + test-api · PRODUCTION ⇒ auth + api.
  // Default SANDBOX a propósito: equivocarse hacia producción toca comercios reales.
  UBER_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),

  // Credenciales OAuth de la app (client_credentials). Distintas por ambiente: la
  // app de prueba y la de producción son DOS apps con DOS secrets.
  UBER_CLIENT_ID_SANDBOX: z.string().optional(),
  UBER_CLIENT_SECRET_SANDBOX: z.string().optional(),
  UBER_CLIENT_ID_PRODUCTION: z.string().optional(),
  UBER_CLIENT_SECRET_PRODUCTION: z.string().optional(),

  // 🔴 Candado de escrituras (default-deny). CSV de store_id que ADMITEN escritura.
  // Vacío o ausente ⇒ CERO escrituras. Nació del incidente del 2026-08-17, cuando un
  // token de sandbox modificó el menú EN VIVO de un restaurante real.
  UBER_WRITABLE_STORE_IDS_SANDBOX: z.string().optional(),
  UBER_WRITABLE_STORE_IDS_PRODUCTION: z.string().optional(),

  // ── Rappi (segundo canal directo de reparto) ──────────────────────────────────────
  RAPPI_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
  RAPPI_CLIENT_ID_SANDBOX: z.string().optional(),
  RAPPI_CLIENT_SECRET_SANDBOX: z.string().optional(),
  RAPPI_CLIENT_ID_PRODUCTION: z.string().optional(),
  RAPPI_CLIENT_SECRET_PRODUCTION: z.string().optional(),
  /** País del host de producción (el de México se escribe `services.mxgrability.rappi.com`). */
  RAPPI_COUNTRY: z.string().default('MX'),
  /**
   * JSON `{ "NEW_ORDER": "secreto", "PING": ["viejo","nuevo"], … }` — 🔴 Rappi da UN secreto
   * POR EVENTO (11), no uno por integración, y se rotan por separado. Once variables sueltas
   * se desincronizarían a la primera rotación; ilegible ⇒ cero secretos ⇒ nada se acepta.
   */
  RAPPI_WEBHOOK_SECRETS: z.string().optional(),
  /** Tiendas donde SÍ se puede escribir. Vacía = ninguna (el candado del incidente 2026-08-17). */
  RAPPI_WRITABLE_STORE_IDS_SANDBOX: z.string().optional(),
  RAPPI_WRITABLE_STORE_IDS_PRODUCTION: z.string().optional(),

  // Base pública para la URL de retorno del OAuth de Uber (sin barra final). En local
  // es el túnel de ngrok; en prod, https://api.avoqado.io. Debe coincidir EXACTAMENTE
  // con lo registrado en el dashboard de Uber, y ser la misma al pedir y al canjear.
  // Si falta, se deduce del request — frágil detrás de proxy, por eso se prefiere explícita.
  UBER_OAUTH_REDIRECT_BASE: z.string().optional(),

  // Llave dedicada (hex 32 bytes) para cifrar el refreshToken de conexiones bancarias (AES-256-GCM).
  FINANCIAL_CONNECTION_KEY: z.string().length(64, 'FINANCIAL_CONNECTION_KEY debe ser hex de 32 bytes (64 chars)').optional(),

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
  // When 'true', append ?test_token=true to /oauth/token so MP emits sandbox
  // tokens (TEST-prefix). Required for any e2e validation with MP test_users
  // in MLM; otherwise marketplace OAuth silently emits APP_USR- tokens and
  // payments fail with code 2034. Default unset / false in prod.
  MP_SANDBOX_MODE: z.enum(['true', 'false']).optional(),

  // ==========================================
  // Apple Wallet — credencial de cliente (Plan A)
  // ==========================================
  // 🔴 TODAS opcionales a propósito. Si se declaran requeridas, cualquier entorno
  // sin certificado — CI, la máquina de otro desarrollador, los tests — muere al
  // importar este archivo, porque un parseo fallido hace `process.exit(1)` y se
  // lleva la API entera (pagos, POS, órdenes) por una tarjeta de lealtad.
  // La ausencia se maneja al firmar: `walletSigningAvailable()` lo reporta y el
  // endpoint responde un error entendible en vez de tronar.
  //
  // 🔴 PEM, no .p12: `passkit-generator` pide el certificado y la llave POR
  // SEPARADO. Pasarle un .p12 falla con un error de OpenSSL que no dice cuál de
  // las dos piezas estaba mal. Conversión en el Plan A, Tarea 0.
  APPLE_PASS_TYPE_ID: z.string().optional(), // pass.io.avoqado.loyalty
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_PASS_CERT_PEM_BASE64: z.string().optional(), // pass-cert.pem en base64
  APPLE_PASS_KEY_PEM_BASE64: z.string().optional(), // pass-key.pem en base64
  APPLE_PASS_KEY_PASSWORD: z.string().optional(), // la puesta al exportar la llave
  APPLE_WWDR_PEM_BASE64: z.string().optional(), // wwdr.pem (G4) en base64

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
  // FACTURACIÓN CFDI (facturapi)
  // ─────────────────────────────────────────────────────────────────────────
  /** facturapi account-level User Key (sk_user_…) — provisions organizations (emisores). Prod only. */
  FACTURAPI_USER_KEY: z.string().optional(),
  /** facturapi sandbox/test key (sk_test_…) — used in dev/staging to issue NON-billed test CFDIs. */
  FACTURAPI_TEST_KEY: z.string().optional(),
  /** Override base URL (defaults to facturapi prod in the SDK). Rarely needed. */
  FACTURAPI_BASE_URL: z.string().url().optional(),
  /** 32-byte hex key used to encrypt per-emisor facturapi live keys at rest (FiscalEmisor.providerKeyEnc). */
  FISCAL_PROVIDER_KEY: z.string().length(64, 'FISCAL_PROVIDER_KEY must be a 32-byte hex string (64 chars)').optional(),

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

// An env var that exists but is empty means "somebody created the key and left it blank",
// not "the value is an empty string". Zod would treat `SENTRY_DSN=""` as a present string,
// run `.url()` on it, fail, and hit the `process.exit(1)` below — taking the API down for
// every venue over an optional variable. See envHelpers.ts for the full rationale.
const parsed = envSchema.safeParse(dropEmptyValues(process.env))

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

/**
 * Guardia de ambiente de la integración bancaria (mueve DINERO REAL).
 *
 * Cambiar el default ya cubre el caso "borraron la variable". Falta el otro: que alguien la
 * ponga EXPLÍCITAMENTE a un host que no debe atender producción. Sin esto no hay señal:
 * contra el entorno dev del proveedor las llamadas "funcionan" (responden 200) pero contra
 * datos que no son los del cliente; contra un dominio retirado fallan sin respuesta.
 *
 * Es `logger.error`, NO `process.exit`: apagar TODA la API (pagos, POS, órdenes) por la
 * config de una sola feature es desproporcionado. Un error de arranque sí entra a la alerta
 * de Better Stack, que es justo lo que faltaba — el fallo del 2026-08-02/03 fue silencioso.
 */
const EXTERNAL_BANK_UNSAFE_PROD_HOSTS: Record<string, string> = {
  'qpaydev.xyz': 'entorno DEV del proveedor — no son datos reales del cliente',
  'moneygiver.xyz': 'dominio RETIRADO — redirige 301 a un host que ya no existe en DNS (2026-07)',
}

if (env.NODE_ENV === 'production') {
  const host = new URL(env.EXTERNAL_BANK_API_BASE).hostname
  const match = Object.keys(EXTERNAL_BANK_UNSAFE_PROD_HOSTS).find(d => host === d || host.endsWith(`.${d}`))
  if (match) {
    logger.error(
      `🔴 EXTERNAL_BANK_API_BASE apunta a "${host}" en PRODUCCIÓN: ${EXTERNAL_BANK_UNSAFE_PROD_HOSTS[match]}. ` +
        `Conectar banco / saldos / SPEI van a fallar o a operar contra el ambiente equivocado.`,
    )
  }
}

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
