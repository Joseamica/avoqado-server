import prisma from '@/utils/prismaClient'
import type { FinancialConnectionStatus } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getFinancialProviderClient } from './registry'
import { encryptGrant, decryptGrant } from './crypto'
import type { Grant, ProviderAccount } from './types'

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
  const r = await client.connect({ email: input.email, password: input.password, deviceIdentifier })

  if (r.kind === 'need_two_factor_auth') {
    await prisma.financialConnection.update({
      where: { id: conn.id },
      data: {
        deviceIdentifier,
        challengeEnc: encryptGrant({ accessToken: r.challenge.accessToken, email: input.email, password: input.password }),
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
  return finishConnected(conn.id, deviceIdentifier, r.grant, r.accounts)
}

export async function validateDevice(connectionId: string, code: string): Promise<ConnectionStepResult> {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { provider: true } })
  if (!conn.challengeEnc || !conn.challengeExpiresAt || conn.challengeExpiresAt < new Date()) {
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
  if (r.kind !== 'connected') throw new BadRequestError('Validación incompleta.')
  // El reto ya se consumió: limpiarlo de inmediato (no dejarlo vivo tras el handshake).
  await prisma.financialConnection.update({ where: { id: connectionId }, data: { challengeEnc: null, challengeExpiresAt: null } })
  return finishConnected(connectionId, conn.deviceIdentifier!, r.grant, r.accounts)
}

export async function validateTwoFactorAuth(connectionId: string, code: string): Promise<ConnectionStepResult> {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { provider: true } })
  if (!conn.challengeEnc || !conn.challengeExpiresAt || conn.challengeExpiresAt < new Date()) {
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
  return finishConnected(connectionId, conn.deviceIdentifier!, r.grant, r.accounts)
}

async function finishConnected(
  connectionId: string,
  deviceIdentifier: string,
  grant: Grant,
  accounts: ProviderAccount[],
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
  const accountOptions = many ? accounts : undefined
  const status: 'PENDING_ACCOUNT_SELECTION' | 'CONNECTED' = many ? 'PENDING_ACCOUNT_SELECTION' : 'CONNECTED'
  return { connectionId, status, accountOptions }
}

export async function selectAccount(connectionId: string, externalId: string, merchantAccountId?: string) {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { accounts: true } })
  // Nunca confiar en un externalId enviado por el cliente: debe estar entre las
  // opciones que el propio servidor ya persistió (desde connect/listAccounts).
  const chosen = conn.accounts.find(a => a.externalId === externalId)
  if (!chosen) throw new BadRequestError(`La cuenta ${externalId} no está entre las opciones guardadas.`)
  if (merchantAccountId) {
    await prisma.merchantAccount.update({ where: { id: merchantAccountId }, data: { financialAccountId: chosen.id } })
  }
  await prisma.financialConnection.update({ where: { id: connectionId }, data: { status: 'CONNECTED' } })
  return { status: 'CONNECTED' as const }
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

  return prisma.$transaction(async tx => {
    // Serializa el refresh entre instancias: solo uno refresca a la vez esta conexión.
    // El refreshToken ROTA en cada uso — dos refrescos concurrentes no deben
    // consumir/persistir ambos contra el mismo token ya obsoleto.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conn.id}))`
    const fresh = await tx.financialConnection.findUniqueOrThrow({ where: { id: conn.id } })
    // Otro proceso pudo haber refrescado mientras esperábamos el lock.
    const recheck = tokenCache.get(conn.id)
    if (recheck && recheck.exp - 60_000 > Date.now()) return recheck.accessToken
    const grant = decryptGrant<Grant>(fresh.grantEnc!)
    const { grant: rotated, ctx } = await client.refresh(grant, conn.deviceIdentifier ?? stableDeviceId(conn.id))
    // CAS: solo persiste si tokenVersion no cambió desde la lectura — evita pisar
    // un refresh concurrente si, por lo que sea, dos procesos llegaron a refrescar.
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
  })
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
    // Invalida el cache para que la próxima llamada no reutilice un access token muerto.
    tokenCache.delete(fa.connection.id)
    // Estos updates son de mejor esfuerzo: si fallan (o el mock/cliente no
    // devuelve una promesa real), NUNCA deben enmascarar el error original ni
    // impedir el retorno del estado ERROR honesto de abajo. try/catch en vez
    // de encadenar .catch() — así funciona aunque la llamada no sea thenable.
    try {
      await prisma.financialConnection.update({
        where: { id: fa.connection.id },
        data: { status: 'NEEDS_REAUTH', lastError: (e as Error).message },
      })
    } catch {
      /* best-effort */
    }
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
    data: { status: 'REVOKED', grantEnc: null, challengeEnc: null, revokedAt: new Date() },
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
