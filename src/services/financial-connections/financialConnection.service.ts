import prisma from '@/utils/prismaClient'
import type { FinancialConnectionStatus } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getFinancialProviderClient } from './registry'
import { encryptGrant, decryptGrant } from './crypto'
import type { Grant, ProviderAccount, MovementPage, MovementQuery, MovementStats } from './types'

/**
 * Forma única de retorno para connect/validateDevice/select. Deliberadamente UN
 * solo shape (no discriminated union por status) para que `accountOptions` sea
 * siempre accesible de forma opcional, tal como lo describe el contrato de la
 * interfaz (`status: FinancialConnectionStatus; accountOptions?: ProviderAccount[]`).
 */
interface ConnectionStepResult {
  connectionId: string
  status: FinancialConnectionStatus
  accountOptions?: ProviderAccount[]
}

const CHALLENGE_TTL_MS = 5 * 60_000
// Cache en memoria del access token por conexión (fast-path; evita re-login por lectura).
const tokenCache = new Map<string, { accessToken: string; exp: number }>()

function stableDeviceId(connectionId: string) {
  return `avoqado-conn-${connectionId}`
}
function clientFor(code: string) {
  const c = getFinancialProviderClient(code)
  if (!c) throw new BadRequestError(`Proveedor ${code} sin implementación.`)
  return c
}
async function persistAccounts(connectionId: string, accounts: ProviderAccount[]) {
  if (!accounts.length) return
  await prisma.financialAccount.createMany({
    data: accounts.map(a => ({
      connectionId,
      externalId: a.externalId,
      externalCuentaId: a.cuentaId ?? null,
      label: a.label ?? null,
      clabe: a.clabe ?? null,
      active: a.active ?? null,
      lastBalance: a.balance ?? null,
      lastSyncedAt: a.balance != null ? new Date() : null,
      balanceState: a.balance != null ? 'OK' : 'UNKNOWN',
    })),
    skipDuplicates: true,
  })
}

export async function startConnection(input: {
  venueId: string
  providerId: string
  email: string
  password: string
  staffId?: string
}): Promise<ConnectionStepResult> {
  const provider = await prisma.financialProvider.findUniqueOrThrow({ where: { id: input.providerId } })
  const conn = await prisma.financialConnection.create({
    data: {
      venueId: input.venueId,
      providerId: provider.id,
      mode: 'SELF_CONNECT',
      status: 'PENDING_DEVICE_VALIDATION',
      createdByStaffId: input.staffId ?? null,
    },
  })
  const deviceIdentifier = stableDeviceId(conn.id)
  const client = clientFor(provider.code)
  // Todo el cuerpo vive en un solo try (en vez de declarar `let r` afuera y
  // asignarlo adentro) para que la compilación pueda angostar `r.kind` sin
  // cruzar el límite del try/catch — la separación causó un bug real de
  // narrowing en la Tarea 11 (ver scripts/test-external-bank-balance.ts).
  try {
    const r = await client.connect({ email: input.email, password: input.password, deviceIdentifier })

    await logAction({
      staffId: input.staffId ?? null,
      venueId: input.venueId,
      action: 'FINANCIAL_CONNECTION_STARTED',
      entity: 'FinancialConnection',
      entityId: conn.id,
      data: { provider: provider.code, outcome: r.kind },
    })

    if (r.kind === 'need_two_factor_auth') {
      await prisma.financialConnection.update({
        where: { id: conn.id },
        data: {
          deviceIdentifier,
          // A diferencia del reto de dispositivo, validate-two-factor-code NO
          // re-loguea con credenciales — el password no se necesita y por eso
          // NO se guarda (retención mínima; el reto de device sí lo requiere
          // porque el provider obliga a re-login tras el OTP).
          challengeEnc: encryptGrant({ accessToken: r.challenge.accessToken, email: input.email }),
          challengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
          status: 'PENDING_TWO_FACTOR_AUTH',
        },
      })
      return { connectionId: conn.id, status: 'PENDING_TWO_FACTOR_AUTH' as const }
    }
    if (r.kind === 'need_device_validation') {
      await prisma.financialConnection.update({
        where: { id: conn.id },
        data: {
          deviceIdentifier,
          challengeEnc: encryptGrant({ ...r.challenge, email: input.email, password: input.password }),
          challengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
          status: 'PENDING_DEVICE_VALIDATION',
        },
      })
      return { connectionId: conn.id, status: 'PENDING_DEVICE_VALIDATION' as const }
    }
    return await finishConnected(conn.id, deviceIdentifier, r.grant, r.accounts, r.accessToken)
  } catch (e) {
    // Sin esto, un connect() fallido (credenciales incorrectas, red) deja la fila
    // recién creada huérfana en PENDING_DEVICE_VALIDATION para siempre, sin pista
    // de qué pasó. Se marca ERROR con el motivo y se relanza para que el
    // controller siga respondiendo 400 igual que antes.
    // Best-effort (misma convención que la ruta de error de getBalance): si este
    // update también falla, el error original de connect() es el que debe
    // propagarse — nunca enmascararlo, y el logAction de abajo debe correr igual.
    try {
      await prisma.financialConnection.update({
        where: { id: conn.id },
        data: { status: 'ERROR', lastError: (e as Error).message },
      })
    } catch {
      /* best-effort */
    }
    await logAction({
      staffId: input.staffId ?? null,
      venueId: input.venueId,
      action: 'FINANCIAL_CONNECTION_FAILED',
      entity: 'FinancialConnection',
      entityId: conn.id,
      data: { provider: provider.code, step: 'connect', error: (e as Error).message },
    })
    throw e
  }
}

/** Reto vencido = credenciales cifradas que ya no sirven — no dejarlas vivir en la fila. */
async function clearExpiredChallenge(connectionId: string) {
  try {
    await prisma.financialConnection.update({ where: { id: connectionId }, data: { challengeEnc: null, challengeExpiresAt: null } })
  } catch {
    /* best-effort: el throw de expiración de abajo debe salir igual */
  }
}

export async function validateDevice(connectionId: string, code: string, staffId?: string): Promise<ConnectionStepResult> {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { provider: true } })
  try {
    if (!conn.challengeEnc || !conn.challengeExpiresAt || conn.challengeExpiresAt < new Date()) {
      if (conn.challengeEnc) await clearExpiredChallenge(connectionId)
      throw new BadRequestError('El reto de validación expiró; vuelve a iniciar la conexión.')
    }
    const ch = decryptGrant<{ accessToken: string; processId: string; email: string; password: string }>(conn.challengeEnc)
    const client = clientFor(conn.provider.code)
    const r = await client.validateDevice({
      email: ch.email,
      password: ch.password,
      deviceIdentifier: conn.deviceIdentifier!,
      challenge: { accessToken: ch.accessToken, processId: ch.processId },
      code,
    })
    if (r.kind === 'need_two_factor_auth') {
      // El dispositivo quedó validado, pero la cuenta ADEMÁS tiene 2FA: el proveedor
      // pide el segundo factor antes de soltar el refreshToken. Se reemplaza el reto de
      // dispositivo por el de 2FA y se transiciona — el wizard sigue al paso de código 2FA.
      await prisma.financialConnection.update({
        where: { id: connectionId },
        data: {
          challengeEnc: encryptGrant({ accessToken: r.challenge.accessToken, email: ch.email }),
          challengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
          status: 'PENDING_TWO_FACTOR_AUTH',
        },
      })
      await logAction({
        staffId: staffId ?? null,
        venueId: conn.venueId,
        action: 'FINANCIAL_CONNECTION_DEVICE_VALIDATED',
        entity: 'FinancialConnection',
        entityId: connectionId,
        data: { provider: conn.provider.code, next: 'two_factor' },
      })
      return { connectionId, status: 'PENDING_TWO_FACTOR_AUTH' as const }
    }
    if (r.kind !== 'connected') throw new BadRequestError('Validación incompleta.')
    // El reto ya se consumió: limpiarlo de inmediato (no dejarlo vivo tras el handshake).
    await prisma.financialConnection.update({ where: { id: connectionId }, data: { challengeEnc: null, challengeExpiresAt: null } })
    await logAction({
      staffId: staffId ?? null,
      venueId: conn.venueId,
      action: 'FINANCIAL_CONNECTION_DEVICE_VALIDATED',
      entity: 'FinancialConnection',
      entityId: connectionId,
      data: { provider: conn.provider.code },
    })
    return await finishConnected(connectionId, conn.deviceIdentifier!, r.grant, r.accounts, r.accessToken)
  } catch (e) {
    await logAction({
      staffId: staffId ?? null,
      venueId: conn.venueId,
      action: 'FINANCIAL_CONNECTION_FAILED',
      entity: 'FinancialConnection',
      entityId: connectionId,
      data: { provider: conn.provider.code, step: 'validate_device', error: (e as Error).message },
    })
    throw e
  }
}

export async function validateTwoFactorAuth(connectionId: string, code: string, staffId?: string): Promise<ConnectionStepResult> {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { provider: true } })
  try {
    if (!conn.challengeEnc || !conn.challengeExpiresAt || conn.challengeExpiresAt < new Date()) {
      if (conn.challengeEnc) await clearExpiredChallenge(connectionId)
      throw new BadRequestError('El reto de 2FA expiró; vuelve a iniciar la conexión.')
    }
    const ch = decryptGrant<{ accessToken: string; email: string }>(conn.challengeEnc)
    const client = clientFor(conn.provider.code)
    const r = await client.validateTwoFactorCode({
      email: ch.email,
      deviceIdentifier: conn.deviceIdentifier!,
      challenge: { accessToken: ch.accessToken },
      code,
    })
    if (r.kind !== 'connected') throw new BadRequestError('El proveedor pidió otro paso adicional no soportado todavía.')
    // El reto ya se consumió: limpiarlo de inmediato (no dejarlo vivo tras el handshake).
    await prisma.financialConnection.update({ where: { id: connectionId }, data: { challengeEnc: null, challengeExpiresAt: null } })
    await logAction({
      staffId: staffId ?? null,
      venueId: conn.venueId,
      action: 'FINANCIAL_CONNECTION_TWO_FACTOR_VALIDATED',
      entity: 'FinancialConnection',
      entityId: connectionId,
      data: { provider: conn.provider.code },
    })
    return await finishConnected(connectionId, conn.deviceIdentifier!, r.grant, r.accounts, r.accessToken)
  } catch (e) {
    await logAction({
      staffId: staffId ?? null,
      venueId: conn.venueId,
      action: 'FINANCIAL_CONNECTION_FAILED',
      entity: 'FinancialConnection',
      entityId: connectionId,
      data: { provider: conn.provider.code, step: 'validate_2fa', error: (e as Error).message },
    })
    throw e
  }
}

async function finishConnected(
  connectionId: string,
  deviceIdentifier: string,
  grant: Grant,
  accounts: ProviderAccount[],
  accessToken?: string,
): Promise<ConnectionStepResult> {
  await persistAccounts(connectionId, accounts)
  const many = accounts.length > 1
  await prisma.financialConnection.update({
    where: { id: connectionId },
    data: {
      deviceIdentifier,
      grantEnc: encryptGrant(grant),
      expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
      connectedAt: new Date(),
      status: many ? 'PENDING_ACCOUNT_SELECTION' : 'CONNECTED',
    },
  })
  // Cachea el access token recién obtenido: la primera lectura de saldo lo usa
  // directamente en vez de intentar un refresh silencioso (que el proveedor rechaza
  // con 400 en sesiones validadas con 2FA). Ventana = vida del token (o 55 min).
  if (accessToken) {
    const exp = grant.expiresAt ? new Date(grant.expiresAt).getTime() : Date.now() + 55 * 60_000
    tokenCache.set(connectionId, { accessToken, exp })
  }
  const accountOptions = many ? accounts : undefined
  const status: 'PENDING_ACCOUNT_SELECTION' | 'CONNECTED' = many ? 'PENDING_ACCOUNT_SELECTION' : 'CONNECTED'
  return { connectionId, status, accountOptions }
}

export async function selectAccount(connectionId: string, externalId: string, merchantAccountId?: string, staffId?: string) {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { accounts: true } })
  try {
    // Una conexión revocada/errónea no debe poder "revivir" a CONNECTED por esta vía.
    if (conn.status === 'REVOKED' || conn.status === 'ERROR') {
      throw new BadRequestError('La conexión no está activa; vuelve a conectarla.')
    }
    // Nunca confiar en un externalId enviado por el cliente: debe estar entre las
    // opciones que el propio servidor ya persistió (desde connect/listAccounts).
    const chosen = conn.accounts.find(a => a.externalId === externalId)
    if (!chosen) throw new BadRequestError(`La cuenta ${externalId} no está entre las opciones guardadas.`)
    if (merchantAccountId) {
      await prisma.merchantAccount.update({ where: { id: merchantAccountId }, data: { financialAccountId: chosen.id } })
    }
    await prisma.financialConnection.update({ where: { id: connectionId }, data: { status: 'CONNECTED' } })
    await logAction({
      staffId: staffId ?? null,
      venueId: conn.venueId,
      action: 'FINANCIAL_CONNECTION_ACCOUNT_SELECTED',
      entity: 'FinancialConnection',
      entityId: connectionId,
      data: { externalId, merchantAccountId: merchantAccountId ?? null },
    })
    return { status: 'CONNECTED' as const }
  } catch (e) {
    await logAction({
      staffId: staffId ?? null,
      venueId: conn.venueId,
      action: 'FINANCIAL_CONNECTION_FAILED',
      entity: 'FinancialConnection',
      entityId: connectionId,
      data: { step: 'select_account', error: (e as Error).message },
    })
    throw e
  }
}

/** Devuelve un access token válido, refrescando bajo lock si hace falta (el refreshToken rota). */
async function accessTokenFor(conn: {
  id: string
  mode: string
  grantEnc: string | null
  deviceIdentifier: string | null
  provider: { code: string }
}): Promise<string> {
  const cached = tokenCache.get(conn.id)
  if (cached && cached.exp - 60_000 > Date.now()) return cached.accessToken
  if (conn.mode !== 'SELF_CONNECT' || !conn.grantEnc) throw new BadRequestError('Conexión sin grant utilizable.')
  const client = clientFor(conn.provider.code)

  return prisma.$transaction(
    async tx => {
      // Serializa el refresh entre instancias: solo uno refresca a la vez esta conexión.
      // El refreshToken ROTA en cada uso — dos refrescos concurrentes no deben
      // consumir/persistir ambos contra el mismo token ya obsoleto.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conn.id}))`
      const fresh = await tx.financialConnection.findUniqueOrThrow({ where: { id: conn.id } })
      // Estado re-leído BAJO el lock: si un disconnect ganó la carrera (REVOKED,
      // grant borrado), abortar aquí — jamás refrescar/persistir sobre una fila
      // revocada (eso la "resucitaría" a CONNECTED con un grant nuevo).
      if (fresh.status === 'REVOKED' || fresh.status === 'ERROR' || !fresh.grantEnc) {
        throw new BadRequestError('Conexión sin grant utilizable.')
      }
      // Otro proceso pudo haber refrescado mientras esperábamos el lock.
      const recheck = tokenCache.get(conn.id)
      if (recheck && recheck.exp - 60_000 > Date.now()) return recheck.accessToken
      const grant = decryptGrant<Grant>(fresh.grantEnc)
      const { grant: rotated, ctx } = await client.refresh(grant, conn.deviceIdentifier ?? stableDeviceId(conn.id))
      // CAS: solo persiste si tokenVersion no cambió desde la lectura — evita pisar
      // un refresh concurrente si, por lo que sea, dos procesos llegaron a refrescar.
      // disconnect() también incrementa tokenVersion, así que un revoke que aterrice
      // después de nuestra re-lectura hace fallar este update en vez de ser pisado.
      await tx.financialConnection.update({
        where: { id: conn.id, tokenVersion: fresh.tokenVersion },
        data: {
          grantEnc: encryptGrant(rotated),
          tokenVersion: { increment: 1 },
          expiresAt: rotated.expiresAt ? new Date(rotated.expiresAt) : null,
          status: 'CONNECTED',
          lastError: null,
        },
      })
      const exp = rotated.expiresAt ? new Date(rotated.expiresAt).getTime() : Date.now() + 55 * 60_000
      tokenCache.set(conn.id, { accessToken: ctx.accessToken, exp })
      return ctx.accessToken
    },
    // El default de Prisma (timeout 5s / maxWait 2s) NO alcanza: adentro va una
    // llamada HTTP al proveedor (axios timeout 20s) + posible espera del advisory
    // lock. Si la tx aborta DESPUÉS de que el proveedor rotó el refreshToken, el
    // grant guardado queda muerto → NEEDS_REAUTH forzado. 30s cubre el peor caso.
    { timeout: 30_000, maxWait: 10_000 },
  )
}

/**
 * Efecto compartido ante un fallo de token/proveedor en una LECTURA (saldo o
 * movimientos): invalida el access token cacheado (para no reusar uno muerto) y
 * degrada la conexión operante a NEEDS_REAUTH — así la UI muestra "Reconectar" en
 * vez de dejar la conexión como "Conectada" cuando en realidad el refresh silencioso
 * ya no funciona. Best-effort y filtrado por status: nunca pisa REVOKED/ERROR/PENDING_*.
 */
async function markConnectionNeedsReauth(connectionId: string, error: Error) {
  tokenCache.delete(connectionId)
  try {
    await prisma.financialConnection.updateMany({
      where: { id: connectionId, status: { in: ['CONNECTED', 'NEEDS_REAUTH'] } },
      data: { status: 'NEEDS_REAUTH', lastError: error.message },
    })
  } catch {
    /* best-effort: nunca enmascarar el error original */
  }
}

/** Resuelve el idCuenta del provider para una FinancialAccount, backfilleando filas pre-columna. */
async function resolveCuentaId(
  fa: { id: string; externalId: string; externalCuentaId: string | null },
  conn: Parameters<typeof accessTokenFor>[0],
): Promise<{ cuentaId: string; accessToken: string }> {
  const accessToken = await accessTokenFor(conn)
  if (fa.externalCuentaId) return { cuentaId: fa.externalCuentaId, accessToken }
  // Fila creada antes de la columna: pedir las cuentas al provider y backfillear.
  const client = clientFor(conn.provider.code)
  const accounts = await client.listAccounts({ accessToken })
  const match = accounts.find(a => a.externalId === fa.externalId)
  if (!match?.cuentaId) throw new BadRequestError('El proveedor no reporta cuenta de movimientos para este negocio.')
  await prisma.financialAccount.update({ where: { id: fa.id }, data: { externalCuentaId: match.cuentaId } })
  return { cuentaId: match.cuentaId, accessToken }
}

export async function getMovementsForAccount(financialAccountId: string, q: MovementQuery): Promise<MovementPage> {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })
  try {
    const { cuentaId, accessToken } = await resolveCuentaId(fa, fa.connection)
    // idNegocio (fa.externalId) en la ruta + cuentaId como query (ver client.listMovements).
    return await clientFor(fa.connection.provider.code).listMovements({ accessToken }, fa.externalId, cuentaId, q)
  } catch (e) {
    // A diferencia del saldo (que muestra el último valor cacheado), movimientos es
    // siempre una lectura en vivo: si el token murió y el refresh silencioso falla,
    // se degrada la conexión a NEEDS_REAUTH y se responde un 400 honesto ("reconéctate")
    // en vez de un 500 crudo con el AxiosError del proveedor.
    await markConnectionNeedsReauth(fa.connection.id, e as Error)
    throw e instanceof BadRequestError ? e : new BadRequestError('No se pudieron obtener los movimientos; vuelve a conectar la cuenta.')
  }
}

export async function getMovementStatsForAccount(
  financialAccountId: string,
  range: { from?: string; to?: string },
): Promise<MovementStats> {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })
  try {
    const { cuentaId, accessToken } = await resolveCuentaId(fa, fa.connection)
    return await clientFor(fa.connection.provider.code).getMovementStats({ accessToken }, cuentaId, range)
  } catch (e) {
    await markConnectionNeedsReauth(fa.connection.id, e as Error)
    throw e instanceof BadRequestError ? e : new BadRequestError('No se pudieron obtener las estadísticas; vuelve a conectar la cuenta.')
  }
}

export async function getBalanceForConnectionAccount(financialAccountId: string) {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })
  const client = clientFor(fa.connection.provider.code)
  try {
    const token = await accessTokenFor(fa.connection)
    const snap = await client.getBalance({ accessToken: token }, fa.externalId)
    // Contrato de saldo honesto: un saldo null/no-numérico del proveedor NUNCA es OK.
    const state = snap.amount != null ? 'OK' : 'ERROR'
    const now = new Date()
    await prisma.financialAccount.update({
      where: { id: fa.id },
      data: {
        lastBalance: snap.amount ?? null,
        active: snap.active ?? null,
        lastSyncedAt: state === 'OK' ? now : fa.lastSyncedAt,
        balanceState: state,
        lastError: state === 'OK' ? null : 'saldo nulo del proveedor',
      },
    })
    return {
      amount: snap.amount,
      currency: snap.currency,
      syncedAt: (state === 'OK' ? now : fa.lastSyncedAt)?.toISOString() ?? null,
      state: state as 'OK' | 'ERROR',
    }
  } catch (e) {
    // Invalida el cache + degrada la conexión a NEEDS_REAUTH (helper compartido con
    // movimientos). El saldo, además, marca la cuenta en ERROR y devuelve un estado
    // honesto (null, nunca un $0 falso) en vez de propagar el error.
    await markConnectionNeedsReauth(fa.connection.id, e as Error)
    try {
      await prisma.financialAccount.update({ where: { id: fa.id }, data: { balanceState: 'ERROR', lastError: (e as Error).message } })
    } catch {
      /* best-effort */
    }
    return { amount: null, currency: fa.currency, syncedAt: fa.lastSyncedAt?.toISOString() ?? null, state: 'ERROR' as const }
  }
}

export async function getBalanceForMerchant(merchantAccountId: string) {
  const m = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: merchantAccountId }, select: { financialAccountId: true } })
  if (!m.financialAccountId) throw new BadRequestError('Este merchant no tiene una cuenta bancaria conectada.')
  return getBalanceForConnectionAccount(m.financialAccountId)
}

export async function listConnectionsForVenue(venueId: string) {
  return prisma.financialConnection.findMany({
    where: { venueId },
    select: {
      id: true,
      status: true,
      mode: true,
      lastError: true,
      provider: { select: { code: true, name: true } },
      accounts: {
        select: {
          id: true,
          externalId: true,
          label: true,
          clabe: true,
          currency: true,
          lastBalance: true,
          lastSyncedAt: true,
          balanceState: true,
          merchantAccounts: { select: { id: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function disconnect(connectionId: string, staffId?: string) {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { provider: true } })
  if (conn.mode === 'SELF_CONNECT' && conn.grantEnc) {
    try {
      const client = clientFor(conn.provider.code)
      const token = tokenCache.get(conn.id)?.accessToken ?? (await accessTokenFor(conn))
      await client.revoke({ accessToken: token })
    } catch {
      /* best-effort: el revoke en el proveedor nunca bloquea el disconnect local */
    }
  }
  tokenCache.delete(conn.id)
  await prisma.financialConnection.update({
    where: { id: conn.id },
    // tokenVersion++ hace fallar el CAS de cualquier refresh en vuelo que re-leyó
    // ANTES de este revoke — sin esto, ese refresh re-persistiría CONNECTED + un
    // grant fresco sobre la fila recién revocada.
    data: { status: 'REVOKED', grantEnc: null, challengeEnc: null, revokedAt: new Date(), tokenVersion: { increment: 1 } },
  })
  await logAction({
    staffId: staffId ?? null,
    venueId: conn.venueId,
    action: 'FINANCIAL_CONNECTION_DISCONNECTED',
    entity: 'FinancialConnection',
    entityId: conn.id,
    data: { provider: conn.provider.code },
  })
}
