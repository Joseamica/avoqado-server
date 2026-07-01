/**
 * External Banking Provider — Authentication Service (concrete: QPay)
 *
 * Single shared broker login across ALL of Avoqado's sucursales — each
 * sucursal is its own `negocio` (idNegocio) under this one account. Unlike
 * Blumon (per-merchant OAuth, credentials supplied at call time), this is a
 * server-to-server background lookup: ONE login, cached, auto-renewed.
 *
 * **Flow**: POST /api/auth/sign-in/merchant (email + password + dispositivo)
 * → token (+ expiresIn as an absolute ISO date-time, NOT a duration like
 * Blumon's). NOTE: the generic `/api/auth/sign-in` endpoint exists too but
 * rejects merchant accounts outright ("Este usuario no tiene una cuenta.",
 * confirmed empirically against production) — the `/merchant` suffix is
 * required. `signedIn` is the authoritative success flag (NOT `isLoggedIn`,
 * despite what the generic endpoint's docs say) — a 200 can still mean "not
 * logged in yet" if a need* flag requires another step first.
 *
 * **Device trust (one-time, done manually 2026-06-30)**: this DEVICE_INFO's
 * `identificador` had to be validated once via the Identity flow
 * (POST /api/identity/start/web → human reads a Google Authenticator TOTP
 * code from the account owner's phone → POST /api/identity/validate-otp-code/web).
 * The provider now trusts this exact identificador going forward —
 * `needDeviceValidation` should stay false on subsequent logins. If it ever
 * flips back to true (e.g. trust gets revoked, or someone changes
 * DEVICE_INFO.identificador), that one-time human-in-the-loop flow has to be
 * redone; this service intentionally does NOT automate it.
 * ⚠️ DO NOT change `DEVICE_INFO.identificador` — it's already registered and
 * trusted in production under this exact string. Changing it forces the
 * account owner to redo the Google Authenticator handshake.
 *
 * **2FA (`needTwoFactorAuth`) is NOT a blocker** — confirmed empirically:
 * the broker account has Google Authenticator 2FA enabled, yet a token issued
 * with `needTwoFactorAuth: true` still successfully calls `GET /api/auth`
 * (the only thing this service does). 2FA appears to gate sensitive
 * write/transaction operations, not read-only balance lookups, so this
 * service deliberately does NOT implement the TOTP validate step.
 *
 * @module services/externalBank/externalBankAuth
 */

import axios, { AxiosInstance } from 'axios'
import { env } from '@/config/env'
import logger from '@/config/logger'
import { BadRequestError, InternalServerError } from '@/errors/AppError'
import { pick } from './pick'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface ExternalBankAuthResult {
  token: string
  expiresAt: Date
}

// Stable device fingerprint — the provider only asks for device validation
// (OTP) the FIRST time a given `identificador` logs in, then trusts it.
// Keeping this constant means it only ever needs to be cleared once,
// manually. DO NOT change this string (see module doc above).
const DEVICE_INFO = {
  marca: 'avoqado-server',
  sistemaOperativo: `node-${process.version}`,
  identificador: 'avoqado-server-moneygiver-balance-lookup',
  latitud: '0',
  longitud: '0',
}

// Treat the cached token as expired this many minutes before its real expiry,
// so an in-flight balance request never races against expiration.
const EXPIRY_BUFFER_MINUTES = 5
// Fallback when the API doesn't return `expiresIn` for some reason.
const FALLBACK_TTL_MS = 55 * 60 * 1000

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ExternalBankAuthService {
  private client: AxiosInstance
  private cached: ExternalBankAuthResult | null = null
  // Single-flight: concurrent balance lookups during a cold cache share one
  // sign-in call instead of each triggering their own.
  private authenticating: Promise<ExternalBankAuthResult> | null = null

  constructor() {
    this.client = axios.create({
      baseURL: env.EXTERNAL_BANK_API_BASE,
      timeout: 20_000,
      headers: {
        'Content-Type': 'application/json',
        mgPlatform: env.EXTERNAL_BANK_MG_PLATFORM,
      },
    })

    this.client.interceptors.request.use(req => {
      logger.debug('[External Bank Auth] Request', { method: req.method?.toUpperCase(), url: req.url })
      return req
    })
    this.client.interceptors.response.use(
      res => res,
      error => {
        logger.error('[External Bank Auth] Response error', {
          status: error.response?.status,
          message: pick<string>(error.response?.data, 'message') || error.message,
        })
        return Promise.reject(error)
      },
    )
  }

  /** Returns a valid Bearer token, re-authenticating if the cache is cold/expired. */
  async getValidToken(): Promise<string> {
    if (this.cached && !this.isExpired(this.cached.expiresAt)) {
      return this.cached.token
    }

    this.authenticating ??= this.authenticate().finally(() => {
      this.authenticating = null
    })
    const result = await this.authenticating
    this.cached = result
    return result.token
  }

  /** Drops the cached token, forcing the next call to re-authenticate. Use after a 401. */
  invalidate(): void {
    this.cached = null
  }

  /** Header bundle every request to the external bank provider needs (mgPlatform + Bearer). */
  async authHeaders(): Promise<{ mgPlatform: string; Authorization: string }> {
    const token = await this.getValidToken()
    return { mgPlatform: env.EXTERNAL_BANK_MG_PLATFORM, Authorization: `Bearer ${token}` }
  }

  get baseURL(): string {
    return env.EXTERNAL_BANK_API_BASE
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private isExpired(expiresAt: Date, bufferMinutes = EXPIRY_BUFFER_MINUTES): boolean {
    return Date.now() >= expiresAt.getTime() - bufferMinutes * 60 * 1000
  }

  private async authenticate(): Promise<ExternalBankAuthResult> {
    const { EXTERNAL_BANK_EMAIL: email, EXTERNAL_BANK_PASSWORD: password } = env
    if (!email || !password) {
      throw new InternalServerError(
        'External bank provider: faltan EXTERNAL_BANK_EMAIL / EXTERNAL_BANK_PASSWORD en las variables de entorno',
      )
    }

    logger.info('[External Bank Auth] Authenticating', { email })

    let data: unknown
    try {
      ;({ data } = await this.client.post(
        '/api/auth/sign-in/merchant',
        { email, password, dispositivo: DEVICE_INFO },
        { headers: { twoFactorEnabled: 'true' } },
      ))
    } catch (error) {
      // A hard non-2xx (e.g. 400 "Este usuario no tiene una cuenta.") never
      // reaches the need*/isLoggedIn checks below — axios rejects before that.
      // Surface the API's own message instead of axios's generic "Request
      // failed with status code 400".
      if (axios.isAxiosError(error)) {
        throw new BadRequestError(
          pick<string>(error.response?.data, 'message') ||
            `External bank provider: sign-in falló con status ${error.response?.status ?? '(sin respuesta)'}`,
        )
      }
      throw error
    }

    // `needTwoFactorAuth` is NOT a blocker here, confirmed empirically against
    // production: a token issued with this flag still set is fully sufficient
    // for the one thing this service does, GET /api/auth (read-only balance
    // lookup) — 2FA appears to gate sensitive write operations, not reads.
    // Logged (not thrown) so it's visible without breaking the lookup.
    if (pick<boolean>(data, 'needTwoFactorAuth') || pick<boolean>(data, 'needSetupTwoFactorAuth')) {
      logger.info('[External Bank Auth] Account has 2FA pending — proceeding anyway (read-only use is unaffected)')
    }
    if (pick<boolean>(data, 'needDeviceValidation')) {
      throw new BadRequestError(
        'External bank provider: el dispositivo de este servidor perdió su validación de identidad (¿identificador ' +
          'cambiado, o se revocó la confianza?). Hay que repetir manualmente el flujo de Identity una vez más: POST ' +
          '/api/identity/start/web → un humano lee el código de Google Authenticator de la cuenta → POST ' +
          '/api/identity/validate-otp-code/web. No automatizado a propósito.',
      )
    }
    if (pick<boolean>(data, 'needPasswordReset')) {
      throw new BadRequestError('External bank provider: la cuenta requiere restablecer la contraseña antes de poder usarse aquí.')
    }

    const token = pick<string>(data, 'token')
    // `signedIn` is what /sign-in/merchant actually returns; `isLoggedIn` kept
    // as a fallback in case a future response shape reverts to the generic
    // endpoint's naming.
    const signedIn = pick<boolean>(data, 'signedIn') ?? pick<boolean>(data, 'isLoggedIn')
    if (!signedIn || !token) {
      throw new BadRequestError(
        pick<string>(data, 'message') || 'External bank provider: no se pudo iniciar sesión (respuesta inesperada del API)',
      )
    }

    const expiresInRaw = pick<string>(data, 'expiresIn')
    const expiresAt = expiresInRaw ? new Date(expiresInRaw) : new Date(Date.now() + FALLBACK_TTL_MS)
    if (Number.isNaN(expiresAt.getTime())) {
      throw new InternalServerError(`External bank provider: expiresIn inválido en la respuesta de sign-in: ${expiresInRaw}`)
    }

    logger.info('[External Bank Auth] Authenticated', { expiresAt: expiresAt.toISOString() })
    return { token, expiresAt }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════════════

export const externalBankAuthService = new ExternalBankAuthService()
