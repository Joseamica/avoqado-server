import axios from 'axios'
import { env } from '@/config/env'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { pick } from '@/services/externalBank/pick'
import type {
  FinancialProviderClient, ConnectInput, ConnectResult, Grant, ProviderAccount,
  BalanceSnapshot, ConnectionContext,
} from './types'

const base = () => env.EXTERNAL_BANK_API_BASE
const headers = (token?: string) => ({
  'Content-Type': 'application/json',
  mgPlatform: env.EXTERNAL_BANK_MG_PLATFORM,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})
const dispositivo = (deviceIdentifier: string) => ({
  marca: 'avoqado-server', sistemaOperativo: `node-${process.version}`,
  identificador: deviceIdentifier, latitud: '0', longitud: '0',
})

function toGrant(data: unknown): Grant {
  const refreshToken = pick<string>(data, 'refreshToken')
  if (!refreshToken) throw new BadRequestError('El proveedor no devolvió refreshToken.')
  return { refreshToken, expiresAt: pick<string>(data, 'expiresIn') ?? null }
}
function accessTokenOf(data: unknown): string {
  const t = pick<string>(data, 'token')
  if (!t) throw new BadRequestError('El proveedor no devolvió token de acceso.')
  return t
}
function normalizeAccounts(me: unknown): ProviderAccount[] {
  const negocios = pick<unknown[]>(me, 'negocios')
  if (!Array.isArray(negocios)) return []
  return negocios
    .map((n): ProviderAccount | null => {
      const externalId = pick<string>(n, 'idNegocio')
      if (!externalId) return null
      const cuenta = pick(n, 'cuentaDispersion')
      const saldo = pick(cuenta, 'saldo')
      return {
        externalId,
        label: pick<string>(n, 'nombre') ?? null,
        clabe: pick<string>(cuenta, 'cuentaClabe') ?? null,
        active: typeof pick(cuenta, 'activo') === 'boolean' ? (pick<boolean>(cuenta, 'activo') as boolean) : null,
        balance: typeof saldo === 'number' ? (saldo as number) : null,
      }
    })
    .filter((a): a is ProviderAccount => a !== null)
}
async function fetchMe(token: string): Promise<unknown> {
  const { data } = await axios.get(`${base()}/api/auth`, { headers: headers(token), timeout: 20_000 })
  return data
}
async function signIn(email: string, password: string, deviceIdentifier: string): Promise<unknown> {
  try {
    const { data } = await axios.post(`${base()}/api/auth/sign-in/merchant`,
      { email, password, dispositivo: dispositivo(deviceIdentifier) },
      { headers: { ...headers(), twoFactorEnabled: 'true' }, timeout: 20_000 })
    return data
  } catch (e) {
    if (axios.isAxiosError(e)) throw new BadRequestError(pick<string>(e.response?.data, 'message') || `sign-in falló (status ${e.response?.status})`)
    throw e
  }
}

export const externalBankClient: FinancialProviderClient = {
  async connect({ email, password, deviceIdentifier }: ConnectInput): Promise<ConnectResult> {
    const data = await signIn(email, password, deviceIdentifier)
    if (pick<boolean>(data, 'needTwoFactorAuth')) {
      const accessToken = accessTokenOf(data)
      return { kind: 'need_two_factor_auth', challenge: { accessToken } }
    }
    if (pick<boolean>(data, 'needDeviceValidation')) {
      const accessToken = accessTokenOf(data)
      const { data: started } = await axios.post(`${base()}/api/identity/start/web`,
        { identificadorDispositivo: deviceIdentifier }, { headers: headers(accessToken), timeout: 20_000 })
      const processId = pick<string>(started, 'proccessId')
      if (!processId) throw new BadRequestError('identity/start no devolvió proccessId.')
      return { kind: 'need_device_validation', challenge: { accessToken, processId } }
    }
    const grant = toGrant(data)
    const accounts = normalizeAccounts(await fetchMe(accessTokenOf(data)))
    return { kind: 'connected', grant, accounts }
  },

  async validateDevice({ email, password, deviceIdentifier, challenge, code }): Promise<ConnectResult> {
    const { data: v } = await axios.post(`${base()}/api/identity/validate-otp-code/web`,
      { proccessId: challenge.processId, code }, { headers: headers(challenge.accessToken), timeout: 20_000 })
    if (!pick<boolean>(v, 'isValid')) throw new BadRequestError('Código OTP inválido o expirado.')
    // Dispositivo ya confiable → re-login para obtener refreshToken definitivo.
    const data = await signIn(email, password, deviceIdentifier)
    const grant = toGrant(data)
    const accounts = normalizeAccounts(await fetchMe(accessTokenOf(data)))
    return { kind: 'connected', grant, accounts }
  },

  async validateTwoFactorCode({ email, deviceIdentifier, challenge, code }): Promise<ConnectResult> {
    let v: unknown
    try {
      ;({ data: v } = await axios.post(`${base()}/api/auth/validate-two-factor-code`,
        { code, user: email, dispositivo: dispositivo(deviceIdentifier) },
        { headers: headers(challenge.accessToken), timeout: 20_000 }))
    } catch (e) {
      if (axios.isAxiosError(e)) throw new BadRequestError(pick<string>(e.response?.data, 'message') || 'Código 2FA inválido o expirado.')
      throw e
    }
    if (!pick<boolean>(v, 'success') && !pick<boolean>(v, 'isLoggedIn')) {
      throw new BadRequestError(pick<string>(v, 'message') || 'Código 2FA inválido o expirado.')
    }
    const grant = toGrant(v)
    const accounts = normalizeAccounts(await fetchMe(accessTokenOf(v)))
    return { kind: 'connected', grant, accounts }
  },

  async refresh(grant: Grant, deviceIdentifier: string): Promise<{ grant: Grant; ctx: ConnectionContext }> {
    const { data } = await axios.post(`${base()}/api/auth/sign-in/token`,
      { refreshToken: grant.refreshToken, dispositivo: dispositivo(deviceIdentifier) },
      { headers: headers(), timeout: 20_000 })
    return { grant: toGrant(data), ctx: { accessToken: accessTokenOf(data) } }
  },

  async revoke(ctx: ConnectionContext): Promise<void> {
    try { await axios.post(`${base()}/api/auth/Log-Out`, {}, { headers: headers(ctx.accessToken), timeout: 10_000 }) }
    catch { /* best-effort; no bloquear la desconexión local */ }
  },

  async listAccounts(ctx: ConnectionContext): Promise<ProviderAccount[]> {
    return normalizeAccounts(await fetchMe(ctx.accessToken))
  },

  async getBalance(ctx: ConnectionContext, externalId: string): Promise<BalanceSnapshot> {
    const acc = normalizeAccounts(await fetchMe(ctx.accessToken)).find(a => a.externalId === externalId)
    if (!acc) throw new NotFoundError(`No se encontró el negocio ${externalId} en la cuenta.`)
    return { amount: acc.balance, currency: 'MXN', active: acc.active, providerAccountLabel: acc.label }
  },
}
