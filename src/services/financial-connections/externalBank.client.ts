import axios from 'axios'
import { env } from '@/config/env'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { pick } from '@/services/externalBank/pick'
import type {
  FinancialProviderClient,
  ConnectInput,
  ConnectResult,
  Grant,
  ProviderAccount,
  BalanceSnapshot,
  ConnectionContext,
  ProviderMovement,
  MovementPage,
  MovementCategoryStats,
  MovementStats,
  MovementQuery,
  MgAltAccount,
  InternalTransferResult,
} from './types'

const base = () => env.EXTERNAL_BANK_API_BASE
const headers = (token?: string) => ({
  'Content-Type': 'application/json',
  mgPlatform: env.EXTERNAL_BANK_MG_PLATFORM,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})
const dispositivo = (deviceIdentifier: string) => ({
  marca: 'avoqado-server',
  sistemaOperativo: `node-${process.version}`,
  identificador: deviceIdentifier,
  latitud: '0',
  longitud: '0',
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
      const altIdRaw = pick(cuenta, 'idCuentaAlt')
      return {
        externalId,
        cuentaId: pick<string>(cuenta, 'idCuenta') ?? null,
        altId: typeof altIdRaw === 'number' ? altIdRaw : null,
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
    const { data } = await axios.post(
      `${base()}/api/auth/sign-in/merchant`,
      { email, password, dispositivo: dispositivo(deviceIdentifier) },
      { headers: { ...headers(), twoFactorEnabled: 'true' }, timeout: 20_000 },
    )
    return data
  } catch (e) {
    if (axios.isAxiosError(e))
      throw new BadRequestError(pick<string>(e.response?.data, 'message') || `sign-in falló (status ${e.response?.status})`)
    throw e
  }
}

/** Números del provider que llegan como string ("1500.75") — u honestamente null. */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function normalizeMovement(m: unknown): ProviderMovement {
  return {
    id: pick<string>(m, 'idOperacion') ?? null,
    type: pick<string>(m, 'tipoMovimiento') ?? null,
    operationType: pick<string>(m, 'tipoOperacion') ?? null,
    concept: pick<string>(m, 'concepto') ?? null,
    date: pick<string>(m, 'fechaCreacion') ?? null,
    amount: toNum(pick(m, 'monto')),
    status: pick<string>(m, 'estatus') ?? null,
    statusId: toNum(pick(m, 'idEstatus')),
    beneficiary: pick<string>(m, 'nombreBeneficiario') ?? null,
    originator: pick<string>(m, 'nombreOrdenante') ?? null,
    reference: pick<string>(m, 'referencia') ?? null,
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
      const { data: started } = await axios.post(
        `${base()}/api/identity/start/web`,
        { identificadorDispositivo: deviceIdentifier },
        { headers: headers(accessToken), timeout: 20_000 },
      )
      const processId = pick<string>(started, 'proccessId')
      if (!processId) throw new BadRequestError('identity/start no devolvió proccessId.')
      return { kind: 'need_device_validation', challenge: { accessToken, processId } }
    }
    const at = accessTokenOf(data)
    const grant = toGrant(data)
    const accounts = normalizeAccounts(await fetchMe(at))
    return { kind: 'connected', grant, accounts, accessToken: at }
  },

  async validateDevice({ email, password, deviceIdentifier, challenge, code }): Promise<ConnectResult> {
    const { data: v } = await axios.post(
      `${base()}/api/identity/validate-otp-code/web`,
      { proccessId: challenge.processId, code },
      { headers: headers(challenge.accessToken), timeout: 20_000 },
    )
    if (!pick<boolean>(v, 'isValid')) throw new BadRequestError('Código OTP inválido o expirado.')
    // Dispositivo ya confiable → re-login. Pero si la cuenta ADEMÁS tiene 2FA, el
    // re-login tras validar el dispositivo NO devuelve refreshToken todavía: pide el
    // segundo factor. Encadenar al paso 2FA (idéntico a lo que hace connect()).
    const data = await signIn(email, password, deviceIdentifier)
    if (pick<boolean>(data, 'needTwoFactorAuth')) {
      const accessToken = accessTokenOf(data)
      return { kind: 'need_two_factor_auth', challenge: { accessToken } }
    }
    const at = accessTokenOf(data)
    const grant = toGrant(data)
    const accounts = normalizeAccounts(await fetchMe(at))
    return { kind: 'connected', grant, accounts, accessToken: at }
  },

  async validateTwoFactorCode({ email, deviceIdentifier, challenge, code }): Promise<ConnectResult> {
    let v: unknown
    try {
      ;({ data: v } = await axios.post(
        `${base()}/api/auth/validate-two-factor-code`,
        { code, user: email, dispositivo: dispositivo(deviceIdentifier) },
        { headers: headers(challenge.accessToken), timeout: 20_000 },
      ))
    } catch (e) {
      if (axios.isAxiosError(e)) throw new BadRequestError(pick<string>(e.response?.data, 'message') || 'Código 2FA inválido o expirado.')
      throw e
    }
    if (!pick<boolean>(v, 'success') && !pick<boolean>(v, 'isLoggedIn')) {
      throw new BadRequestError(pick<string>(v, 'message') || 'Código 2FA inválido o expirado.')
    }
    const at = accessTokenOf(v)
    const grant = toGrant(v)
    const accounts = normalizeAccounts(await fetchMe(at))
    return { kind: 'connected', grant, accounts, accessToken: at }
  },

  async refresh(grant: Grant): Promise<{ grant: Grant; ctx: ConnectionContext }> {
    // Renovación silenciosa vía /api/auth/refresh-token (renovación PURA del access token)
    // — NO /api/auth/sign-in/token. Ese último "además valida dispositivo" y hace login
    // completo → re-chequea 2FA y truena con 400 "Object reference not set..." para
    // refreshTokens obtenidos por el flujo validate-two-factor-code. Confirmado EN VIVO con
    // un token 2FA real: sign-in/token→400, refresh-token→200. Esto permite "conectar una
    // vez, refrescar para siempre" sin re-pedir el TOTP. El `token` puede ir vacío: el
    // endpoint identifica la sesión por el refreshToken (verificado en vivo).
    const { data } = await axios.post(
      `${base()}/api/auth/refresh-token`,
      { token: '', refreshToken: grant.refreshToken, expiresIn: grant.expiresAt ?? new Date().toISOString() },
      { headers: headers(), timeout: 20_000 },
    )
    return { grant: toGrant(data), ctx: { accessToken: accessTokenOf(data) } }
  },

  async revoke(ctx: ConnectionContext): Promise<void> {
    try {
      await axios.post(`${base()}/api/auth/Log-Out`, {}, { headers: headers(ctx.accessToken), timeout: 10_000 })
    } catch {
      /* best-effort; no bloquear la desconexión local */
    }
  },

  async listAccounts(ctx: ConnectionContext): Promise<ProviderAccount[]> {
    return normalizeAccounts(await fetchMe(ctx.accessToken))
  },

  async getBalance(ctx: ConnectionContext, externalId: string): Promise<BalanceSnapshot> {
    const acc = normalizeAccounts(await fetchMe(ctx.accessToken)).find(a => a.externalId === externalId)
    if (!acc) throw new NotFoundError(`No se encontró el negocio ${externalId} en la cuenta.`)
    return { amount: acc.balance, currency: 'MXN', active: acc.active, providerAccountLabel: acc.label }
  },

  async listMovements(ctx: ConnectionContext, idNegocio: string, cuentaId: string, query: MovementQuery): Promise<MovementPage> {
    // Ruta = idNegocio, `idCuenta` como query param → acota a la cuenta real del negocio.
    // (Confirmado en vivo: con cuentaId en la ruta el proveedor ignora el filtro y devuelve
    //  un pool global de ~5.1M movimientos ajenos; con idNegocio+query idCuenta da los reales.)
    const params: Record<string, unknown> = { 'Pagination.Page': query.page, 'Pagination.Size': query.size, idCuenta: cuentaId }
    // Estado de cuenta = más reciente primero. Sin esto QPay devuelve su orden interno (NO por
    // fechaCreacion), lo que con paginación deja la página 1 barajada en vez de los 10 más nuevos.
    // El orden debe pedirse server-side: ordenar en el cliente solo reordenaría los 10 de la página
    // actual, no el conjunto. El valor de SortByFecha no está documentado; en el API .NET un valor
    // de query no reconocido se ignora (no truena), así que 'desc' es fix en el mejor caso y no-op
    // en el peor — a validar contra el estado de cuenta real.
    params.SortByFecha = 'desc'
    if (query.from) params.FechaInicio = query.from
    if (query.to) params.FechaFinal = query.to
    const { data } = await axios.get(`${base()}/api/clients/movimientos/${idNegocio}`, {
      headers: headers(ctx.accessToken),
      params,
      timeout: 20_000,
    })
    const raw = pick<unknown[]>(data, 'data')
    return {
      movements: Array.isArray(raw) ? raw.map(normalizeMovement) : [],
      total: toNum(pick(data, 'total')) ?? 0,
    }
  },

  async getMovementStats(ctx: ConnectionContext, cuentaId: string, range: { from?: string; to?: string }): Promise<MovementStats> {
    const params: Record<string, unknown> = {}
    if (range.from) params.FechaInicio = range.from
    if (range.to) params.FechaFinal = range.to
    const { data } = await axios.get(`${base()}/api/clients/movimientos/Estadisticas/${cuentaId}`, {
      headers: headers(ctx.accessToken),
      params,
      timeout: 20_000,
    })
    const cat = (suffix: string): MovementCategoryStats => ({
      amount: toNum(pick(data, `montoTransaccionado${suffix}`)),
      fee: toNum(pick(data, `comisionCobrada${suffix}`)),
      count: toNum(pick(data, `numeroOperaciones${suffix}`)),
    })
    return {
      accountName: pick<string>(data, 'nombre') ?? null,
      clabe: pick<string>(data, 'cuentaClabe') ?? null,
      speiIn: cat('SpeiIn'),
      speiOut: cat('SpeiOut'),
      internalTransfers: cat('TransferenciaInterna'),
      dispersions: cat('Dispersion'),
    }
  },

  async resolveMgAlt(ctx: ConnectionContext, accountNumber: string): Promise<MgAltAccount | null> {
    try {
      const { data } = await axios.get(`${base()}/api/transferencia/get-MoneyGiverAlt`, {
        headers: headers(ctx.accessToken),
        params: { idClienteWalletAlt: accountNumber },
        timeout: 20_000,
      })
      const altRaw = pick(data, 'idCuentaAlt')
      // El proveedor devuelve idCuentaAlt como string; add-transferenciaMG lo exige como entero.
      const altId = typeof altRaw === 'number' ? altRaw : typeof altRaw === 'string' && altRaw.trim() !== '' ? Number(altRaw) : NaN
      if (!Number.isFinite(altId)) return null
      return { altId, name: pick<string>(data, 'nombre') ?? null, accountType: pick<string>(data, 'tipoCuenta') ?? null }
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 404) return null
      throw e
    }
  },

  async internalTransfer(
    ctx: ConnectionContext,
    input: { sourceAltId: number; destAltId: number; amount: number; concept: string },
  ): Promise<InternalTransferResult> {
    // Espejo de la petición probada del dashboard de producción de Q-Pay (features/spei/api.ts):
    // idTipo:1 = TRANSFERENCIA. Se omite idCatTipoAutenticacion cuando no se usa 2FA (traspaso simple).
    // El proveedor NO acepta clave de idempotencia; la dedup por contenido (mismo destino + monto,
    // ventana corta) vive en el service (sendInternalTransfer) para atajar el doble-cobro por reintento.
    try {
      const { data } = await axios.post(
        `${base()}/api/transferencia/add-transferenciaMG`,
        {
          idCuentaAltSalida: input.sourceAltId,
          idCuentaAltRecibe: input.destAltId,
          idTipo: 1,
          monto: Math.round(input.amount * 100) / 100,
          concepto: input.concept.trim() || 'Sin concepto',
          latitud: '0',
          longitud: '0',
        },
        { headers: headers(ctx.accessToken), timeout: 30_000 },
      )
      const ok = pick<boolean>(data, 'success') === true
      return {
        ok,
        movementId: pick<string>(data, 'idMovimiento') ?? pick<string>(data, 'idOperacion') ?? null,
        message: pick<string>(data, 'message') ?? null,
      }
    } catch (e) {
      if (axios.isAxiosError(e)) {
        return { ok: false, movementId: null, message: pick<string>(e.response?.data, 'message') || `traspaso falló (status ${e.response?.status})` }
      }
      throw e
    }
  },
}
