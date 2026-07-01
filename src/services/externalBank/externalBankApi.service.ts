/**
 * External Banking Provider — API Service (concrete: QPay)
 *
 * Read-only balance lookups. `GET /api/auth` returns the FULL negocios[] list
 * for the logged-in broker account in one call — each item carries its own
 * `idNegocio` + `cuentaDispersion.saldo`. We fetch that once (briefly cached,
 * since it covers every sucursal) and pick out whichever `idNegocio` was asked
 * for, instead of one API call per venue.
 *
 * The provider mixes casing across endpoints (confirmed empirically: sign-in
 * failures come back PascalCase) — every field is read through `pick()`
 * rather than trusted as literal camelCase, so a `Negocios`/`IdNegocio`/
 * `Saldo` response doesn't silently normalize to an empty list.
 *
 * @module services/externalBank/externalBankApi
 */

import axios from 'axios'
import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'
import { externalBankAuthService } from './externalBankAuth.service'
import { pick } from './pick'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface CuentaDto {
  idCuenta: string | null
  cuentaClabe: string | null
  saldo: number | null
  idEstatus: number | null
  activo: boolean | null
}

interface NegocioDto {
  idNegocio: string
  nombre: string | null
  claveAfiliacion: string | null
  cuentaDispersion: CuentaDto | null
}

interface MeResponse {
  idMoneyGiver: string | null
  negocios: NegocioDto[]
}

export interface ExternalBankBalance {
  idNegocio: string
  nombre: string | null
  cuentaClabe: string | null
  saldo: number | null
  activo: boolean | null
  fetchedAt: string
}

// ─── Normalization (tolerant of mixed casing) ─────────────────────────────

function normalizeCuenta(raw: unknown): CuentaDto | null {
  if (!raw || typeof raw !== 'object') return null
  return {
    idCuenta: pick<string>(raw, 'idCuenta') ?? null,
    cuentaClabe: pick<string>(raw, 'cuentaClabe') ?? null,
    saldo: typeof pick(raw, 'saldo') === 'number' ? (pick<number>(raw, 'saldo') as number) : null,
    idEstatus: pick<number>(raw, 'idEstatus') ?? null,
    activo: typeof pick(raw, 'activo') === 'boolean' ? (pick<boolean>(raw, 'activo') as boolean) : null,
  }
}

function normalizeNegocio(raw: unknown): NegocioDto | null {
  const idNegocio = pick<string>(raw, 'idNegocio')
  if (!idNegocio) return null
  return {
    idNegocio,
    nombre: pick<string>(raw, 'nombre') ?? null,
    claveAfiliacion: pick<string>(raw, 'claveAfiliacion') ?? null,
    cuentaDispersion: normalizeCuenta(pick(raw, 'cuentaDispersion')),
  }
}

function normalizeMe(raw: unknown): MeResponse {
  const rawNegocios = pick<unknown[]>(raw, 'negocios')
  return {
    idMoneyGiver: pick<string>(raw, 'idMoneyGiver') ?? null,
    negocios: Array.isArray(rawNegocios) ? rawNegocios.map(normalizeNegocio).filter((n): n is NegocioDto => n !== null) : [],
  }
}

// `GET /api/auth` returns every negocio at once — cache briefly so a burst of
// balance lookups (e.g. the Aggregator detail sheet loading N merchant rows)
// doesn't fire N redundant requests.
const ME_CACHE_TTL_MS = 20_000

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ExternalBankApiService {
  private meCache: { data: MeResponse; fetchedAt: number } | null = null
  private meInFlight: Promise<MeResponse> | null = null

  /** All negocios (sucursales) the broker account can see, with their saldo. */
  async getMe(opts: { forceRefresh?: boolean } = {}): Promise<MeResponse> {
    if (!opts.forceRefresh && this.meCache && Date.now() - this.meCache.fetchedAt < ME_CACHE_TTL_MS) {
      return this.meCache.data
    }

    // Single-flight: concurrent callers during a cold cache share one request.
    this.meInFlight ??= this.fetchMe().finally(() => {
      this.meInFlight = null
    })
    const data = await this.meInFlight
    this.meCache = { data, fetchedAt: Date.now() }
    return data
  }

  /** Balance for a single negocio (sucursal). Throws NotFoundError if the broker account can't see it. */
  async getBalanceByIdNegocio(idNegocio: string, opts: { forceRefresh?: boolean } = {}): Promise<ExternalBankBalance> {
    const me = await this.getMe(opts)
    const negocio = (me.negocios ?? []).find(n => n.idNegocio === idNegocio)

    if (!negocio) {
      throw new NotFoundError(
        `External bank provider: no se encontró el negocio ${idNegocio} entre los negocios visibles para la cuenta ` +
          'configurada (EXTERNAL_BANK_EMAIL). Verifica el balanceProviderAccountId del MerchantAccount o que la cuenta ' +
          'tenga acceso a esa sucursal.',
      )
    }

    const cuenta = negocio.cuentaDispersion
    return {
      idNegocio: negocio.idNegocio,
      nombre: negocio.nombre ?? null,
      cuentaClabe: cuenta?.cuentaClabe ?? null,
      saldo: typeof cuenta?.saldo === 'number' ? cuenta.saldo : null,
      activo: typeof cuenta?.activo === 'boolean' ? cuenta.activo : null,
      fetchedAt: new Date().toISOString(),
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private async fetchMe(): Promise<MeResponse> {
    const headers = await externalBankAuthService.authHeaders()

    try {
      const { data } = await axios.get<unknown>(`${externalBankAuthService.baseURL}/api/auth`, {
        headers,
        timeout: 20_000,
      })
      return normalizeMe(data)
    } catch (error) {
      // The cached token can go stale server-side even before our client-side
      // expiry buffer trips (revoked session, clock drift). Retry exactly once
      // with a forced re-login before giving up.
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        logger.warn('[External Bank API] GET /api/auth returned 401 — re-authenticating once and retrying')
        externalBankAuthService.invalidate()
        const freshHeaders = await externalBankAuthService.authHeaders()
        const { data } = await axios.get<unknown>(`${externalBankAuthService.baseURL}/api/auth`, {
          headers: freshHeaders,
          timeout: 20_000,
        })
        return normalizeMe(data)
      }
      throw error
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════════════

export const externalBankApiService = new ExternalBankApiService()
