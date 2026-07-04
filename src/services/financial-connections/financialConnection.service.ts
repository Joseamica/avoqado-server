import prisma from '@/utils/prismaClient'
import type { FinancialConnectionStatus, FinancialConnectionAccountKind } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { isValidClabe } from '@/utils/clabe'
import { getFinancialProviderClient } from './registry'
import { encryptGrant, decryptGrant } from './crypto'
import type {
  Grant,
  ProviderAccount,
  MovementPage,
  MovementQuery,
  MovementStats,
  InternalTransferResult,
  SpeiOutResult,
  SpeiBank,
  AccountKind,
  ConnectionContext,
} from './types'

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
// Ventana de dedup por contenido para traspasos internos (mismo destino + mismo monto). Corta a
// propósito: cubre el reintento tras un timeout sin bloquear por mucho un 2º traspaso legítimo.
const INTERNAL_TRANSFER_DEDUP_WINDOW_MS = 5 * 60_000
// Misma ventana para SPEI externo. Es defensa en profundidad: el proveedor SÍ es idempotente
// (idempotencyKey del FRONTEND, una por intento — los retries HTTP reenvían la misma), pero un
// intento NUEVO del usuario (F5 / segunda pestaña) llega con key distinta — esta dedup lo ataja.
const SPEI_OUT_DEDUP_WINDOW_MS = 5 * 60_000
// UUID (cualquier versión) — formato exigido para la idempotencyKey que manda el frontend.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
/**
 * Contexto de sesión para el client a partir de la fila de conexión: el kind (MERCHANT/CLIENT)
 * y el externalClientId (id de usuario del proveedor) viven en la fila — única fuente de verdad (decisión 3A).
 */
function ctxFor(
  conn: { accountKind: FinancialConnectionAccountKind; externalClientId: string | null; externalDeviceId: string | null },
  accessToken: string,
): ConnectionContext {
  return { accessToken, kind: conn.accountKind, externalClientId: conn.externalClientId, idDispositivo: conn.externalDeviceId }
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
  accountKind?: AccountKind
}): Promise<ConnectionStepResult> {
  const provider = await prisma.financialProvider.findUniqueOrThrow({ where: { id: input.providerId } })
  const accountKind: AccountKind = input.accountKind ?? 'MERCHANT'
  const conn = await prisma.financialConnection.create({
    data: {
      venueId: input.venueId,
      providerId: provider.id,
      mode: 'SELF_CONNECT',
      status: 'PENDING_DEVICE_VALIDATION',
      createdByStaffId: input.staffId ?? null,
      // El kind se persiste al NACER la fila (antes de cualquier reto): validateDevice/2FA
      // lo leen de aquí, jamás del challenge cifrado — única fuente de verdad (decisión 3A).
      accountKind,
    },
  })
  const deviceIdentifier = stableDeviceId(conn.id)
  const client = clientFor(provider.code)
  // Todo el cuerpo vive en un solo try (en vez de declarar `let r` afuera y
  // asignarlo adentro) para que la compilación pueda angostar `r.kind` sin
  // cruzar el límite del try/catch — la separación causó un bug real de
  // narrowing en la Tarea 11 (ver scripts/test-external-bank-balance.ts).
  try {
    const r = await client.connect({ email: input.email, password: input.password, deviceIdentifier, accountKind })

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
          // externalClientId (id de usuario del proveedor, solo CLIENT): la respuesta del 2FA puede no
          // repetirlo, así que el del sign-in inicial viaja en el challenge cifrado.
          // externalDeviceId (idDispositivo, solo CLIENT): idéntica razón — necesario para
          // descifrar el envelope del cliente una vez conectado.
          // El accountKind NO se duplica aquí — se lee de conn.accountKind (3A).
          challengeEnc: encryptGrant({
            accessToken: r.challenge.accessToken,
            email: input.email,
            externalClientId: r.challenge.externalClientId ?? null,
            externalDeviceId: r.challenge.externalDeviceId ?? null,
          }),
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
          challengeEnc: encryptGrant({
            ...r.challenge,
            email: input.email,
            password: input.password,
            externalClientId: r.challenge.externalClientId ?? null,
            externalDeviceId: r.challenge.externalDeviceId ?? null,
          }),
          challengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
          status: 'PENDING_DEVICE_VALIDATION',
        },
      })
      return { connectionId: conn.id, status: 'PENDING_DEVICE_VALIDATION' as const }
    }
    return await finishConnected(conn.id, deviceIdentifier, r.grant, r.accounts, r.accessToken, r.externalClientId, r.externalDeviceId)
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
    const ch = decryptGrant<{
      accessToken: string
      processId: string
      email: string
      password: string
      externalClientId?: string | null
      externalDeviceId?: string | null
    }>(conn.challengeEnc)
    const client = clientFor(conn.provider.code)
    // El kind se lee SIEMPRE de la fila (conn.accountKind), no del challenge (decisión 3A).
    const r = await client.validateDevice({
      email: ch.email,
      password: ch.password,
      deviceIdentifier: conn.deviceIdentifier!,
      challenge: {
        accessToken: ch.accessToken,
        processId: ch.processId,
        externalClientId: ch.externalClientId ?? null,
        externalDeviceId: ch.externalDeviceId ?? null,
      },
      code,
      accountKind: conn.accountKind,
    })
    if (r.kind === 'need_two_factor_auth') {
      // El dispositivo quedó validado, pero la cuenta ADEMÁS tiene 2FA: el proveedor
      // pide el segundo factor antes de soltar el refreshToken. Se reemplaza el reto de
      // dispositivo por el de 2FA y se transiciona — el wizard sigue al paso de código 2FA.
      await prisma.financialConnection.update({
        where: { id: connectionId },
        data: {
          challengeEnc: encryptGrant({
            accessToken: r.challenge.accessToken,
            email: ch.email,
            externalClientId: r.challenge.externalClientId ?? null,
            externalDeviceId: r.challenge.externalDeviceId ?? null,
          }),
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
    return await finishConnected(
      connectionId,
      conn.deviceIdentifier!,
      r.grant,
      r.accounts,
      r.accessToken,
      r.externalClientId,
      r.externalDeviceId,
    )
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
    const ch = decryptGrant<{ accessToken: string; email: string; externalClientId?: string | null; externalDeviceId?: string | null }>(
      conn.challengeEnc,
    )
    const client = clientFor(conn.provider.code)
    // El kind se lee SIEMPRE de la fila (conn.accountKind), no del challenge (decisión 3A).
    const r = await client.validateTwoFactorCode({
      email: ch.email,
      deviceIdentifier: conn.deviceIdentifier!,
      challenge: {
        accessToken: ch.accessToken,
        externalClientId: ch.externalClientId ?? null,
        externalDeviceId: ch.externalDeviceId ?? null,
      },
      code,
      accountKind: conn.accountKind,
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
    return await finishConnected(
      connectionId,
      conn.deviceIdentifier!,
      r.grant,
      r.accounts,
      r.accessToken,
      r.externalClientId,
      r.externalDeviceId,
    )
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
  externalClientId?: string,
  externalDeviceId?: string,
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
      // id de usuario del proveedor (solo CLIENT) — el client de kind CLIENT lo necesita
      // para listar cuentas. undefined = no tocar la columna (MERCHANT no lo trae).
      externalClientId: externalClientId ?? undefined,
      // idDispositivo (solo CLIENT) — llave para descifrar el envelope cifrado del
      // cliente en lecturas post-connect (balance refresh, movimientos, listAccounts).
      externalDeviceId: externalDeviceId ?? undefined,
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
  accountKind: FinancialConnectionAccountKind
  externalClientId: string | null
  externalDeviceId: string | null
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
      const { grant: rotated, ctx } = await client.refresh(grant, conn.deviceIdentifier ?? stableDeviceId(conn.id), conn.accountKind)
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
          // Backfill de la llave de descifrado si el refresh la trae y no estaba (auto-sana
          // conexiones creadas antes de que se persistiera externalDeviceId). Solo escribe si viene.
          ...(ctx.idDispositivo ? { externalDeviceId: ctx.idDispositivo } : {}),
        },
      })
      // Refleja el backfill en el objeto en memoria para que el ctxFor de ESTA misma petición
      // (que se construye con la misma referencia `conn`) ya use la llave — sin esto haría falta
      // un segundo request para que la lectura descifre.
      if (ctx.idDispositivo) conn.externalDeviceId = ctx.idDispositivo
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
  const accounts = await client.listAccounts(ctxFor(conn, accessToken))
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
    return await clientFor(fa.connection.provider.code).listMovements(ctxFor(fa.connection, accessToken), fa.externalId, cuentaId, q)
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
    return await clientFor(fa.connection.provider.code).getMovementStats(ctxFor(fa.connection, accessToken), cuentaId, range)
  } catch (e) {
    await markConnectionNeedsReauth(fa.connection.id, e as Error)
    throw e instanceof BadRequestError ? e : new BadRequestError('No se pudieron obtener las estadísticas; vuelve a conectar la cuenta.')
  }
}

/**
 * Resuelve una cuenta destino (número interno 4-6 dígitos) a su NOMBRE de beneficiario, para
 * mostrarlo en la confirmación del traspaso ANTES de enviar — el usuario confirma un nombre, no
 * solo un número (un dígito mal tecleado se cacha a simple vista). Read-only: no mueve dinero.
 * Devuelve null si la cuenta no existe (→ 404 en el controller). NO expone el altId (PK interno
 * del proveedor) — solo lo que el usuario necesita para verificar.
 */
export async function resolveTransferDestination(
  financialAccountId: string,
  accountNumber: string,
): Promise<{ name: string | null; accountType: string | null } | null> {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })
  // Transferencias solo para cuentas de NEGOCIO. El flujo de transfer con sesión CLIENT (PWA)
  // jamás se ha probado contra el proveedor — el spec lo declara fuera de alcance y este guard
  // lo hace cumplir (el botón de la UI también se oculta, pero el backend es la fuente de verdad).
  if (fa.connection.accountKind === 'CLIENT') {
    throw new BadRequestError('Las transferencias no están disponibles para cuentas personales.')
  }
  try {
    const accessToken = await accessTokenFor(fa.connection)
    const dest = await clientFor(fa.connection.provider.code).resolveAltAccount(ctxFor(fa.connection, accessToken), accountNumber.trim())
    if (!dest) return null
    return { name: dest.name, accountType: dest.accountType }
  } catch (e) {
    // Misma política honesta que las otras lecturas en vivo: si el token murió y el refresh
    // silencioso falla, degrada la conexión a NEEDS_REAUTH y responde 400 ("reconéctate"), no 500.
    await markConnectionNeedsReauth(fa.connection.id, e as Error)
    throw e instanceof BadRequestError ? e : new BadRequestError('No se pudo verificar la cuenta destino; vuelve a conectar la cuenta.')
  }
}

/**
 * Traspaso interno entre cuentas del proveedor desde la cuenta conectada `financialAccountId` a la cuenta destino
 * (número interno). MUEVE DINERO — siempre se audita en ActivityLog (a diferencia de las lecturas).
 * Origen = idCuentaAlt de la cuenta conectada (del payload del proveedor); destino se resuelve
 * por su número. El proveedor NO es idempotente, así que ANTES de enviar se hace una dedup por
 * contenido (misma cuenta destino + mismo monto en una ventana corta) apoyada en la auditoría:
 * un reintento tras un timeout NO vuelve a cobrar. La UI además deshabilita el botón (doble-click)
 * y el endpoint va rate-limited.
 */
export async function sendInternalTransfer(
  financialAccountId: string,
  input: { destAccountNumber: string; amount: number; concept: string; staffId?: string },
): Promise<InternalTransferResult> {
  if (!(input.amount > 0)) throw new BadRequestError('El monto debe ser mayor a 0.')
  const destAccount = input.destAccountNumber.trim()
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })

  // Transferencias solo para cuentas de NEGOCIO. El flujo de transfer con sesión CLIENT (PWA)
  // jamás se ha probado contra el proveedor — el spec lo declara fuera de alcance y este guard
  // lo hace cumplir (el botón de la UI también se oculta, pero el backend es la fuente de verdad).
  if (fa.connection.accountKind === 'CLIENT') {
    throw new BadRequestError('Las transferencias no están disponibles para cuentas personales.')
  }

  // Dedup por contenido ANTES de mover dinero. Como el proveedor no acepta clave de idempotencia,
  // si un traspaso idéntico (misma cuenta destino + mismo monto) desde esta cuenta se registró en
  // los últimos minutos, NO se reenvía: se devuelve el resultado previo. Ataja el caso peligroso
  // del review — el primer envío se debitó pero la respuesta se perdió (timeout) y el usuario
  // reintenta. Se apoya en la auditoría que ya escribimos (destAccount + amount + ok); ventana
  // corta para no bloquear por mucho un 2º traspaso legítimo. (Residual: si el logAction del
  // intento previo no llegó a persistir —es best-effort— la dedup no lo verá; misma garantía
  // que la propia auditoría.)
  const recent = await prisma.activityLog.findMany({
    where: {
      action: 'FINANCIAL_INTERNAL_TRANSFER',
      entityId: fa.id,
      createdAt: { gte: new Date(Date.now() - INTERNAL_TRANSFER_DEDUP_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { data: true },
  })
  const prior = recent
    .map(r => r.data as { destAccount?: unknown; amount?: unknown; ok?: unknown; movementId?: unknown } | null)
    .find(d => d != null && d.destAccount === destAccount && d.amount === input.amount)
  if (prior) {
    return {
      ok: prior.ok === true,
      movementId: (prior.movementId as string | null) ?? null,
      message: 'Se detectó un traspaso idéntico muy reciente; no se reenvió. Verifica tus movimientos.',
    }
  }

  const accessToken = await accessTokenFor(fa.connection)
  const client = clientFor(fa.connection.provider.code)
  const ctx = ctxFor(fa.connection, accessToken)

  // Origen: el idCuentaAlt de la cuenta conectada, tal como lo reporta el proveedor.
  const source = (await client.listAccounts(ctx)).find(a => a.externalId === fa.externalId)
  if (source?.altId == null) throw new BadRequestError('La cuenta origen no tiene id de traspaso disponible.')

  // Destino: resolver el número interno (4-6 dígitos) a su idCuentaAlt real.
  const dest = await client.resolveAltAccount(ctx, destAccount)
  if (!dest) throw new BadRequestError(`No se encontró la cuenta destino ${destAccount}.`)
  if (dest.altId === source.altId) throw new BadRequestError('El origen y el destino son la misma cuenta.')

  const result = await client.internalTransfer(ctx, {
    sourceAltId: source.altId,
    destAltId: dest.altId,
    amount: input.amount,
    concept: input.concept,
  })

  // Auditoría obligatoria de movimiento de dinero: quién, cuánto, a dónde, resultado.
  // destAccount va normalizado (trim) — es también la clave de la dedup de arriba.
  await logAction({
    staffId: input.staffId ?? null,
    venueId: fa.connection.venueId,
    action: 'FINANCIAL_INTERNAL_TRANSFER',
    entity: 'FinancialAccount',
    entityId: fa.id,
    data: {
      destAccount,
      destName: dest.name,
      amount: input.amount,
      ok: result.ok,
      movementId: result.movementId,
      message: result.message,
    },
  })
  return result
}

/**
 * Catálogo de bancos destino para SPEI externo. Solo lectura (paridad con /balance: sin
 * rate limit, sin auditoría). Reusa el token cacheado de la conexión de esta cuenta.
 */
export async function getSpeiBanks(financialAccountId: string): Promise<SpeiBank[]> {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })
  // Solo un refresh muerto degrada la conexión. Un error del ENDPOINT del catálogo (p.ej. 401
  // por autorización específica de /api/external/* para este tipo de token) NO toca el estado:
  // el mismo token sigue sirviendo para saldo/movimientos — degradar aquí tumbaría una conexión
  // sana por una lectura auxiliar (nos pasó en vivo 2026-07-03 con el token CLIENT).
  let accessToken: string
  try {
    accessToken = await accessTokenFor(fa.connection)
  } catch (e) {
    await markConnectionNeedsReauth(fa.connection.id, e as Error)
    throw e instanceof BadRequestError ? e : new BadRequestError('No se pudo autenticar con el banco; vuelve a conectar la cuenta.')
  }
  try {
    return await clientFor(fa.connection.provider.code).listSpeiBanks(ctxFor(fa.connection, accessToken))
  } catch {
    throw new BadRequestError('No se pudo cargar el catálogo de bancos. Intenta de nuevo en un momento.')
  }
}

/**
 * SPEI saliente a CUALQUIER banco (vía CLABE). MUEVE DINERO fuera del ecosistema del proveedor —
 * el candado es doble: idempotencyKey del proveedor (generada por el FRONTEND, una por intento de
 * envío, y pasada aquí — así el retry automático de POST del cliente HTTP reenvía la MISMA key y
 * la idempotencia real del proveedor lo absorbe) + dedup por contenido en ActivityLog (misma
 * CLABE + mismo monto en ventana corta) que ataja el reintento manual del usuario tras un timeout.
 * Residual declarado (mismo que sendInternalTransfer, aceptado): dos INTENTOS DISTINTOS
 * concurrentes (p.ej. dos pestañas) con misma CLABE+monto pueden pasar ambos el dedup antes de
 * que el primero escriba su log — cada uno lleva key propia y el proveedor los trata como envíos
 * separados. Lo acotan el disabled de la UI, el rate limit y la ventana de milisegundos.
 * Siempre se audita (éxito o falla). La UI además confirma en dos pasos.
 */
export async function sendSpeiOut(
  financialAccountId: string,
  input: {
    destinationClabe: string
    beneficiaryName: string
    idBanco: number
    amount: number
    concept: string
    idempotencyKey: string
    staffId?: string
  },
): Promise<SpeiOutResult> {
  // Normalizar el monto a centavos UNA sola vez: el número que se valida, envía, deduplica y
  // audita es EL MISMO. Sin esto, 150.505 se auditaría como 150.505 pero viajaría como 150.5 —
  // en dinero saliente el registro debe decir exactamente lo que se envió.
  const amount = Math.round(input.amount * 100) / 100
  if (!(amount > 0)) throw new BadRequestError('El monto debe ser mayor a 0.')
  const destinationClabe = input.destinationClabe.trim()
  // Validar el dígito verificador ANTES de tocar al proveedor: una CLABE con un dígito trocado
  // es dinero depositado a un desconocido — se rechaza aquí, no se "intenta a ver si pasa".
  if (!isValidClabe(destinationClabe)) throw new BadRequestError('La CLABE destino no es válida. Revisa los 18 dígitos.')
  const beneficiaryName = input.beneficiaryName.trim()
  if (!beneficiaryName) throw new BadRequestError('El nombre del beneficiario es obligatorio.')
  if (!Number.isInteger(input.idBanco) || input.idBanco <= 0) throw new BadRequestError('Selecciona el banco destino.')
  const idempotencyKey = input.idempotencyKey.trim()
  if (!UUID_PATTERN.test(idempotencyKey)) throw new BadRequestError('idempotencyKey debe ser un UUID.')

  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })

  // SPEI saliente solo para cuentas de NEGOCIO — mismo guard que traspasos internos: el flujo de
  // dinero saliente con sesión CLIENT (PWA) jamás se ha probado contra el proveedor.
  if (fa.connection.accountKind === 'CLIENT') {
    throw new BadRequestError('El envío SPEI no está disponible para cuentas personales.')
  }

  // El endpoint External del proveedor debita por la identidad del USUARIO, no por la
  // cuenta seleccionada — con varias cuentas (negocios) en una misma conexión, el dinero podría
  // salir de una cuenta DISTINTA a la que el usuario eligió y la auditoría mentiría. Hasta
  // confirmar con el proveedor de cuál cuenta debita en ese caso, solo se permite el envío en
  // conexiones de UNA cuenta (el caso normal de Avoqado: una sucursal = un negocio).
  const accountsInConnection = await prisma.financialAccount.count({ where: { connectionId: fa.connection.id } })
  if (accountsInConnection > 1) {
    throw new BadRequestError('Por ahora el envío SPEI solo está disponible para conexiones con una sola cuenta.')
  }

  // Dedup por contenido ANTES de mover dinero (ver comentario de SPEI_OUT_DEDUP_WINDOW_MS).
  // Los intentos previos con ok:false TAMBIÉN bloquean: un "fallo" con forma de timeout pudo
  // haberse enviado de verdad — reintentarlo a ciegas en la ventana corta es el caso peligroso.
  const recent = await prisma.activityLog.findMany({
    where: {
      action: 'FINANCIAL_SPEI_OUT',
      entityId: fa.id,
      createdAt: { gte: new Date(Date.now() - SPEI_OUT_DEDUP_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { data: true },
  })
  const prior = recent
    .map(r => r.data as { destClabe?: unknown; amount?: unknown; ok?: unknown; operationId?: unknown; idempotencyKey?: unknown } | null)
    .find(d => d != null && d.destClabe === destinationClabe && d.amount === amount)
  if (prior) {
    // Mismo intento (misma key) → devolver el resultado original tal cual; intento distinto con
    // mismo contenido → bloquear con el aviso de verificación.
    return {
      ok: prior.ok === true,
      operationId: (prior.operationId as string | null) ?? null,
      transferId: null,
      message:
        prior.idempotencyKey === idempotencyKey
          ? 'Este envío ya se procesó.'
          : 'Se detectó un envío idéntico muy reciente; no se reenvió. Verifica tus movimientos.',
    }
  }

  // Token muerto → misma política honesta que el resto del módulo: NEEDS_REAUTH + 400, no 500.
  let accessToken: string
  try {
    accessToken = await accessTokenFor(fa.connection)
  } catch (e) {
    await markConnectionNeedsReauth(fa.connection.id, e as Error)
    throw e instanceof BadRequestError ? e : new BadRequestError('No se pudo autenticar con el banco; vuelve a conectar la cuenta.')
  }
  const client = clientFor(fa.connection.provider.code)
  const ctx = ctxFor(fa.connection, accessToken)

  // Origen: identificador de usuario del proveedor (externalClientId). Capturado en connect-time
  // desde 2026-07-03; conexiones previas se backfillean aquí (mismo patrón que externalCuentaId).
  let externalUserId = fa.connection.externalClientId
  if (!externalUserId) {
    try {
      externalUserId = await client.getExternalUserId(ctx)
    } catch {
      throw new BadRequestError('No se pudo obtener el identificador de la cuenta origen. Intenta de nuevo en un momento.')
    }
    if (!externalUserId) throw new BadRequestError('El proveedor no reporta el identificador de la cuenta origen.')
    await prisma.financialConnection.update({ where: { id: fa.connection.id }, data: { externalClientId: externalUserId } })
  }

  const result = await client.sendSpeiOut(ctx, {
    externalUserId,
    idempotencyKey,
    destinationClabe,
    beneficiaryName,
    amount,
    concept: input.concept,
    idBanco: input.idBanco,
  })

  // Auditoría obligatoria de dinero saliente: quién, cuánto, a qué CLABE/banco, resultado.
  // destClabe normalizada (trim) y amount redondeado — son también la clave de la dedup de arriba.
  await logAction({
    staffId: input.staffId ?? null,
    venueId: fa.connection.venueId,
    action: 'FINANCIAL_SPEI_OUT',
    entity: 'FinancialAccount',
    entityId: fa.id,
    data: {
      destClabe: destinationClabe,
      destName: beneficiaryName,
      idBanco: input.idBanco,
      amount,
      idempotencyKey,
      ok: result.ok,
      operationId: result.operationId,
      transferId: result.transferId,
      message: result.message,
    },
  })
  return result
}

export async function getBalanceForConnectionAccount(financialAccountId: string) {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })
  const client = clientFor(fa.connection.provider.code)
  try {
    const token = await accessTokenFor(fa.connection)
    const snap = await client.getBalance(ctxFor(fa.connection, token), fa.externalId)
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
      // La UI etiqueta conexiones personales (CLIENT) y les oculta el botón de transferir (C1).
      accountKind: true,
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
        // Orden ESTABLE: sin esto Prisma devuelve las cuentas en orden no determinístico y la UI
        // las "baraja" en cada refetch de saldo. createdAt asc = orden de alta, consistente.
        orderBy: { createdAt: 'asc' },
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
      await client.revoke(ctxFor(conn, token))
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
