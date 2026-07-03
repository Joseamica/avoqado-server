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
  AccountKind,
} from './types'

const base = () => env.EXTERNAL_BANK_API_BASE
function platformForKind(kind: AccountKind = 'MERCHANT'): string {
  return kind === 'CLIENT' ? env.EXTERNAL_BANK_MG_PLATFORM_CLIENT : env.EXTERNAL_BANK_MG_PLATFORM
}
const headers = (token?: string, kind: AccountKind = 'MERCHANT') => ({
  'Content-Type': 'application/json',
  mgPlatform: platformForKind(kind),
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
function idMoneyGiverOf(data: unknown): string | null {
  // Verificado EN VIVO (2026-07-03, cuenta cliente real): el sign-in del cliente anida el id
  // en `user.idMoneyGiver` — NO en `userData` como asumía el spec. Se conservan los 3 paths
  // por si el provider varía entre endpoints (validate-two-factor-code, refresh, etc.).
  return (
    pick<string>(pick(data, 'userData'), 'idMoneyGiver') ??
    pick<string>(pick(data, 'user'), 'idMoneyGiver') ??
    pick<string>(data, 'idMoneyGiver') ??
    null
  )
}
function normalizeClientAccounts(payload: unknown): ProviderAccount[] {
  // Lector tolerante a los anidamientos típicos de este proveedor: { cuentas }, { data: { cuentas } },
  // { data: [...] } o el array pelón. El shape exacto se pinna tras la verificación en vivo.
  const cuentas =
    pick<unknown[]>(payload, 'cuentas') ??
    pick<unknown[]>(pick(payload, 'data'), 'cuentas') ??
    (Array.isArray(pick(payload, 'data')) ? (pick(payload, 'data') as unknown[]) : undefined) ??
    (Array.isArray(payload) ? (payload as unknown[]) : undefined)
  if (!Array.isArray(cuentas)) return []
  return cuentas
    .map((c): ProviderAccount | null => {
      const idCuenta = pick<string>(c, 'idCuenta')
      if (!idCuenta) return null
      const saldo = pick(c, 'saldo')
      const altIdRaw = pick(c, 'idCuentaAlt')
      return {
        externalId: idCuenta,
        cuentaId: idCuenta,
        altId: typeof altIdRaw === 'number' ? altIdRaw : null,
        label: pick<string>(c, 'nombre') ?? null,
        clabe: pick<string>(c, 'cuentaClabe') ?? null,
        active: typeof pick(c, 'activo') === 'boolean' ? (pick<boolean>(c, 'activo') as boolean) : null,
        balance: typeof saldo === 'number' ? (saldo as number) : null,
      }
    })
    .filter((a): a is ProviderAccount => a !== null)
}
/**
 * El canal del cliente (PWA) CIFRA la respuesta: `{ payload: "base64(iv)|base64(ciphertext)", timestamp }`.
 * Esquema extraído del bundle Flutter de app.moneygiver.xyz (2026-07-03): AES-128-CBC/PKCS7 con
 * key = utf8(idDispositivo[0:16]) — el idDispositivo que el proveedor devuelve en el login. El
 * `timestamp` es anti-replay, no entra al cripto. Devuelve el JSON descifrado (o null si no aplica).
 */
function decryptClientEnvelope(data: unknown, idDispositivo: string | null): unknown {
  const payload = pick<string>(data, 'payload')
  if (typeof payload !== 'string' || !payload.includes('|')) return null // no cifrado → passthrough
  if (!idDispositivo || idDispositivo.length < 16) throw new BadRequestError('Falta idDispositivo para descifrar la respuesta del cliente.')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const [ivB64, ctB64] = payload.split('|')
  const key = Buffer.from(idDispositivo.slice(0, 16), 'utf8') // 16 bytes → AES-128 (idDispositivo es UUID ASCII)
  if (key.length !== 16) throw new BadRequestError('idDispositivo con longitud de llave inesperada para descifrar.')
  const iv = Buffer.from(ivB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
  const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  return JSON.parse(plain)
}
function idDispositivoOf(data: unknown): string | null {
  return pick<string>(data, 'idDispositivo') ?? pick<string>(pick(data, 'user'), 'idDispositivo') ?? null
}
async function getClientAccounts(accessToken: string, idMoneyGiver: string, idDispositivo: string | null): Promise<ProviderAccount[]> {
  const { data } = await axios.get(`${base()}/api/clients/get-wallet-clientAccounts/v3r2.1`, {
    headers: headers(accessToken, 'CLIENT'),
    params: { idMoneyGiver },
    timeout: 20_000,
  })
  probeLogRaw(`getClientAccounts (idMg=${idMoneyGiver}, idDisp=${idDispositivo})`, data) // TEMP-DEBUG-PROBE (ciphertext completo)
  const decrypted = decryptClientEnvelope(data, idDispositivo)
  return normalizeClientAccounts(decrypted ?? data)
}
async function accountsForKind(
  accessToken: string,
  kind: AccountKind,
  data: unknown,
  fallbackClientId?: string | null, // externalClientId capturado del sign-in inicial (viaja en el challenge)
): Promise<{ accounts: ProviderAccount[]; externalClientId?: string; externalDeviceId?: string }> {
  if (kind === 'CLIENT') {
    // La respuesta del 2FA quizá no repite idMoneyGiver — el fallback viene del sign-in inicial (1A).
    const idMg = idMoneyGiverOf(data) ?? fallbackClientId ?? null
    if (!idMg) throw new BadRequestError('El proveedor no devolvió idMoneyGiver del cliente.')
    // idDispositivo (de la respuesta de auth) = llave para descifrar el envelope del cliente.
    const idDisp = idDispositivoOf(data)
    const accounts = await getClientAccounts(accessToken, idMg, idDisp)
    // 0 cuentas → error honesto AHORA, no una conexión CONNECTED vacía (zombie) que confunde (C4).
    if (!accounts.length) throw new BadRequestError('El proveedor no devolvió cuentas para este usuario; verifica el tipo de cuenta elegido.')
    return { accounts, externalClientId: idMg, externalDeviceId: idDisp ?? undefined }
  }
  return { accounts: normalizeAccounts(await fetchMe(accessToken)) }
}
async function signIn(email: string, password: string, deviceIdentifier: string, kind: AccountKind): Promise<unknown> {
  const path = kind === 'CLIENT' ? '/api/auth/sign-in' : '/api/auth/sign-in/merchant'
  // El body merchant queda IDÉNTICO byte a byte al verificado en vivo (decisión 4A) — `user`
  // solo va en el login del cliente (no sabemos cuál de los dos campos lee ese endpoint).
  const body =
    kind === 'CLIENT'
      ? { email, user: email, password, dispositivo: dispositivo(deviceIdentifier) }
      : { email, password, dispositivo: dispositivo(deviceIdentifier) }
  try {
    const { data } = await axios.post(`${base()}${path}`, body, {
      headers: { ...headers(undefined, kind), twoFactorEnabled: 'true' },
      timeout: 20_000,
    })
    return data
  } catch (e) {
    if (axios.isAxiosError(e))
      throw new BadRequestError(pick<string>(e.response?.data, 'message') || `sign-in falló (status ${e.response?.status})`)
    throw e
  }
}

// ─── TEMP-DEBUG-PROBE (BORRAR antes de commit) ────────────────────────────────
// Task 1.5 en vivo: captura SHAPES redactados de las respuestas del proveedor para
// el flujo CLIENT en /tmp/avoqado-fc-probe.log. Tokens/passwords: solo longitud.
/* eslint-disable @typescript-eslint/no-explicit-any */
function probeRedact(v: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '<deep>'
  if (v === null || v === undefined) return v
  if (typeof v === 'string') {
    if (/token|password|contrasena|jwt|secret/i.test(key)) return `<string len ${v.length}>`
    if (/clabe|nombre|apellido|email|correo|telefono|phone/i.test(key)) return v.length <= 4 ? '****' : `…${v.slice(-4)}`
    return v.length > 60 ? `<string len ${v.length}: ${v.slice(0, 12)}…>` : v
  }
  if (typeof v !== 'object') return v
  if (Array.isArray(v)) return { '<len>': v.length, '<item0>': v.length ? probeRedact(v[0], key, depth + 1) : undefined }
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = probeRedact(val, k, depth + 1)
  return out
}
function probeLog(label: string, data: unknown): void {
  try {
    // require dinámico para no tocar los imports del archivo (se borra completo).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    fs.appendFileSync('/tmp/avoqado-fc-probe.log', JSON.stringify({ ts: new Date().toISOString(), label, shape: probeRedact(data) }) + '\n')
  } catch {
    /* jamás romper el flujo por el probe */
  }
}
// Captura SIN redactar (red de seguridad para reversar el cripto si el descifrado falla).
// Va a un archivo aparte; se borra junto con el probe antes de commit.
function probeLogRaw(label: string, data: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    fs.appendFileSync('/tmp/avoqado-fc-raw.log', JSON.stringify({ ts: new Date().toISOString(), label, data }) + '\n')
  } catch {
    /* nunca romper el flujo */
  }
}
// ─── fin TEMP-DEBUG-PROBE ─────────────────────────────────────────────────────

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
  async connect({ email, password, deviceIdentifier, accountKind = 'MERCHANT' }: ConnectInput): Promise<ConnectResult> {
    const data = await signIn(email, password, deviceIdentifier, accountKind)
    if (accountKind === 'CLIENT') probeLog('connect:signIn(CLIENT)', data) // TEMP-DEBUG-PROBE
    if (pick<boolean>(data, 'needTwoFactorAuth')) {
      const accessToken = accessTokenOf(data)
      return {
        kind: 'need_two_factor_auth',
        challenge: { accessToken, externalClientId: idMoneyGiverOf(data), externalDeviceId: idDispositivoOf(data) },
      }
    }
    if (pick<boolean>(data, 'needDeviceValidation')) {
      const accessToken = accessTokenOf(data)
      const { data: started } = await axios.post(
        `${base()}/api/identity/start/web`,
        { identificadorDispositivo: deviceIdentifier },
        { headers: headers(accessToken, accountKind), timeout: 20_000 },
      )
      if (accountKind === 'CLIENT') probeLog('connect:identity/start(CLIENT)', started) // TEMP-DEBUG-PROBE
      const processId = pick<string>(started, 'proccessId')
      if (!processId) throw new BadRequestError('identity/start no devolvió proccessId.')
      return {
        kind: 'need_device_validation',
        challenge: { accessToken, processId, externalClientId: idMoneyGiverOf(data), externalDeviceId: idDispositivoOf(data) },
      }
    }
    const at = accessTokenOf(data)
    const grant = toGrant(data)
    const { accounts, externalClientId, externalDeviceId } = await accountsForKind(at, accountKind, data)
    return { kind: 'connected', grant, accounts, accessToken: at, externalClientId, externalDeviceId }
  },

  async validateDevice({ email, password, deviceIdentifier, challenge, code, accountKind }): Promise<ConnectResult> {
    const { data: v } = await axios.post(
      `${base()}/api/identity/validate-otp-code/web`,
      { proccessId: challenge.processId, code },
      { headers: headers(challenge.accessToken, accountKind), timeout: 20_000 },
    )
    if (accountKind === 'CLIENT') probeLog('validateDevice:validate-otp(CLIENT)', v) // TEMP-DEBUG-PROBE
    if (!pick<boolean>(v, 'isValid')) throw new BadRequestError('Código OTP inválido o expirado.')
    // Dispositivo ya confiable → re-login. Pero si la cuenta ADEMÁS tiene 2FA, el
    // re-login tras validar el dispositivo NO devuelve refreshToken todavía: pide el
    // segundo factor. Encadenar al paso 2FA (idéntico a lo que hace connect()).
    const data = await signIn(email, password, deviceIdentifier, accountKind)
    if (accountKind === 'CLIENT') probeLog('validateDevice:relogin(CLIENT)', data) // TEMP-DEBUG-PROBE
    if (pick<boolean>(data, 'needTwoFactorAuth')) {
      // Verificado EN VIVO (2026-07-03, PWA): el re-login tras validar dispositivo devuelve
      // needTwoFactorAuth:true con token:null — a diferencia de merchant, NO emite token
      // temporal nuevo. Se reusa el del challenge original (sigue vigente ~5 min y ya
      // autenticó identity/start + validate-otp).
      const accessToken = pick<string>(data, 'token') ?? challenge.accessToken
      return {
        kind: 'need_two_factor_auth',
        challenge: {
          accessToken,
          externalClientId: idMoneyGiverOf(data) ?? challenge.externalClientId,
          externalDeviceId: idDispositivoOf(data) ?? challenge.externalDeviceId,
        },
      }
    }
    const at = accessTokenOf(data)
    const grant = toGrant(data)
    const { accounts, externalClientId, externalDeviceId } = await accountsForKind(at, accountKind, data, challenge.externalClientId)
    return { kind: 'connected', grant, accounts, accessToken: at, externalClientId, externalDeviceId }
  },

  async validateTwoFactorCode({ email, deviceIdentifier, challenge, code, accountKind }): Promise<ConnectResult> {
    let v: unknown
    try {
      ;({ data: v } = await axios.post(
        `${base()}/api/auth/validate-two-factor-code`,
        { code, user: email, dispositivo: dispositivo(deviceIdentifier) },
        { headers: headers(challenge.accessToken, accountKind), timeout: 20_000 },
      ))
    } catch (e) {
      if (axios.isAxiosError(e)) throw new BadRequestError(pick<string>(e.response?.data, 'message') || 'Código 2FA inválido o expirado.')
      throw e
    }
    if (accountKind === 'CLIENT') probeLog('validate2FA:response(CLIENT)', v) // TEMP-DEBUG-PROBE
    if (!pick<boolean>(v, 'success') && !pick<boolean>(v, 'isLoggedIn')) {
      throw new BadRequestError(pick<string>(v, 'message') || 'Código 2FA inválido o expirado.')
    }
    const at = accessTokenOf(v)
    const grant = toGrant(v)
    const { accounts, externalClientId, externalDeviceId } = await accountsForKind(at, accountKind, v, challenge.externalClientId)
    return { kind: 'connected', grant, accounts, accessToken: at, externalClientId, externalDeviceId }
  },

  async refresh(grant: Grant, _deviceIdentifier: string, kind: AccountKind): Promise<{ grant: Grant; ctx: ConnectionContext }> {
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
      { headers: headers(undefined, kind), timeout: 20_000 },
    )
    if (kind === 'CLIENT') probeLog('refresh:response(CLIENT)', data) // TEMP-DEBUG-PROBE
    // Si el refresh trae idDispositivo, se propaga → el service puede backfillear conexiones que
    // no lo tenían (auto-sanado de conexiones previas a la persistencia de la llave).
    return { grant: toGrant(data), ctx: { accessToken: accessTokenOf(data), kind, idDispositivo: idDispositivoOf(data) } }
  },

  async revoke(ctx: ConnectionContext): Promise<void> {
    try {
      await axios.post(`${base()}/api/auth/Log-Out`, {}, { headers: headers(ctx.accessToken, ctx.kind), timeout: 10_000 })
    } catch {
      /* best-effort; no bloquear la desconexión local */
    }
  },

  async listAccounts(ctx: ConnectionContext): Promise<ProviderAccount[]> {
    if (ctx.kind === 'CLIENT') {
      if (!ctx.externalClientId) throw new BadRequestError('Falta externalClientId para listar cuentas del cliente.')
      // La respuesta del cliente viene CIFRADA con key=idDispositivo. ctx.idDispositivo se
      // persiste en FinancialConnection.externalDeviceId (capturado en connect-time) y se
      // hidrata vía ctxFor — ver financialConnection.service.ts.
      return getClientAccounts(ctx.accessToken, ctx.externalClientId, ctx.idDispositivo ?? null)
    }
    return normalizeAccounts(await fetchMe(ctx.accessToken))
  },

  async getBalance(ctx: ConnectionContext, externalId: string): Promise<BalanceSnapshot> {
    const acc = (await this.listAccounts(ctx)).find(a => a.externalId === externalId)
    if (!acc) throw new NotFoundError(`No se encontró la cuenta ${externalId}.`)
    return { amount: acc.balance, currency: 'MXN', active: acc.active, providerAccountLabel: acc.label }
  },

  async listMovements(ctx: ConnectionContext, idNegocio: string, cuentaId: string, query: MovementQuery): Promise<MovementPage> {
    const isClient = ctx.kind === 'CLIENT'
    // `idCuenta` SIEMPRE como query param → es lo que ACOTA la respuesta a la cuenta real. Sin él el
    // proveedor devuelve un pool global de ~5.16M movimientos ajenos (verificado en vivo 2026-07-03,
    // ambos kinds). Lo que cambia entre kinds es SOLO la ruta: MERCHANT usa idNegocio, CLIENT usa
    // idCuenta (que además va repetido en el query, tal cual lo hace la PWA de app.moneygiver.xyz).
    const params: Record<string, unknown> = {
      'Pagination.Page': query.page,
      'Pagination.Size': query.size,
      idCuenta: cuentaId,
    }
    // Estado de cuenta = más reciente primero. Sin esto QPay devuelve su orden interno (NO por
    // fechaCreacion), lo que con paginación deja la página 1 barajada en vez de los 10 más nuevos.
    // La PWA manda 'DESC' (mayúsculas); el .NET ignora un valor no reconocido, así que es fix en el
    // mejor caso y no-op en el peor.
    params.SortByFecha = 'DESC'
    if (query.from) params.FechaInicio = query.from
    if (query.to) params.FechaFinal = query.to
    const path = isClient ? `/api/clients/movimientos/${cuentaId}` : `/api/clients/movimientos/${idNegocio}`
    const { data: rawData } = await axios.get(`${base()}${path}`, { headers: headers(ctx.accessToken, ctx.kind), params, timeout: 20_000 })
    // El canal cliente (PWA) cifra respuestas por endpoint. decryptClientEnvelope es no-op si viene
    // en claro (sin "|"), así que aplicarlo es seguro para ambos kinds. Sin esto, un movimientos
    // CLIENT cifrado devolvería lista VACÍA en silencio (peor que un error).
    const data = isClient ? (decryptClientEnvelope(rawData, ctx.idDispositivo ?? null) ?? rawData) : rawData
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
    const { data: rawData } = await axios.get(`${base()}/api/clients/movimientos/Estadisticas/${cuentaId}`, {
      headers: headers(ctx.accessToken, ctx.kind),
      params,
      timeout: 20_000,
    })
    // Igual que listMovements: descifrar si el canal cliente enveló la respuesta (no-op en claro).
    const data = ctx.kind === 'CLIENT' ? (decryptClientEnvelope(rawData, ctx.idDispositivo ?? null) ?? rawData) : rawData
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
        headers: headers(ctx.accessToken, ctx.kind),
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
        { headers: headers(ctx.accessToken, ctx.kind), timeout: 30_000 },
      )
      const ok = pick<boolean>(data, 'success') === true
      return {
        ok,
        movementId: pick<string>(data, 'idMovimiento') ?? pick<string>(data, 'idOperacion') ?? null,
        message: pick<string>(data, 'message') ?? null,
      }
    } catch (e) {
      if (axios.isAxiosError(e)) {
        return {
          ok: false,
          movementId: null,
          message: pick<string>(e.response?.data, 'message') || `traspaso falló (status ${e.response?.status})`,
        }
      }
      throw e
    }
  },
}
