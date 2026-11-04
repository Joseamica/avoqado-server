/**
 * El Gmail del vendedor (spec 2026-10-30 §5.6, fase 2): conectarlo, lo que dice «Mi Gmail» y desconectarlo. Una app OAuth
 * de Google «External» publicada SIN verificar (decisión del founder, 2-nov): Google deja conectar hasta 100 cuentas
 * distintas en toda su vida, por eso se cuentan (`CrmGmailAccountSeen`).
 *
 * Es un servicio propio, forkeado del de Google Calendar (`services/google-calendar/*`, que no se toca).
 *
 * 🔴 Tres reglas que no se negocian:
 *  - El navegador que vuelve de Google debe ser el MISMO que empezó (Codex plan r1 #8): el `state` dice quién pidió la liga
 *    y la vuelta exige la sesión de esa persona. Si no, un vendedor le pasa su liga a otra y se queda con el Gmail de ella.
 *  - La fila de la conexión se cambia bajo su candado (`FOR UPDATE`), el mismo que toma `mandarCorreo` al reservar: un
 *    envío que reserva justo cuando el vendedor cambia de cuenta queda de un lado o del otro, nunca fuera de los dos.
 *  - Toda escritura tardía de quien usó credenciales viejas va con `where: { staffId, version }`: un `invalid_grant` de
 *    las viejas nunca apaga las nuevas.
 *
 * El refresh token sólo existe cifrado (AES-256-GCM con `CRM_GMAIL_TOKEN_KEY`, llave propia) y nunca va a un log.
 */
import crypto from 'crypto'
import { google, type gmail_v1 } from 'googleapis'
import jwt from 'jsonwebtoken'
import logger from '../../../config/logger'
import { ServiceUnavailableError } from '../../../errors/AppError'
import { createTokenCipher } from '../../../lib/token-encryption'
import prisma from '../../../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../../../utils/retry'
import { logAction } from '../../dashboard/activity-log.service'
import { normalizeEmail } from '../../marketing/emailSuppression.service'
import { getCrmAccess } from '../access.service'

const SCOPE_SEND = 'https://www.googleapis.com/auth/gmail.send'
const SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly'
export const GMAIL_SCOPES = ['openid', 'email', SCOPE_SEND, SCOPE_READ]
/** Cuentas de Google distintas que una app sin verificar puede conectar en toda su vida. */
export const TOPE_CUENTAS_GMAIL = 100
const STATE_TTL_SECONDS = 600
const INTENT = 'crm-gmail'

export const NO_CONFIGURADO = 'Falta configurar la app de Google'
export const RECONECTA = 'Reconecta tu Gmail'
/** El pendiente de una cuenta que el vendedor reemplazó: nadie lo busca, la ficha dice «revisa los Enviados de <A>». */
export const ERROR_CUENTA_REEMPLAZADA = 'cuenta reemplazada'

const cipher = createTokenCipher('CRM_GMAIL_TOKEN_KEY')

interface ConfigGmail {
  clientId: string
  clientSecret: string
  redirectUri: string
  stateSecret: string
}

/**
 * La configuración, validada AQUÍ y no en `env.ts` (Ruling 3): una variable mal escrita nunca tumba la API, sólo deja
 * «Mi Gmail» en «Falta configurar». Se lee de `process.env` en cada llamada, como la lista de prueba.
 */
function leerConfig(): ConfigGmail | null {
  const { CRM_GMAIL_CLIENT_ID, CRM_GMAIL_CLIENT_SECRET, CRM_GMAIL_REDIRECT_URI, CRM_GMAIL_TOKEN_KEY, OAUTH_STATE_SECRET } = process.env
  if (!CRM_GMAIL_CLIENT_ID || !CRM_GMAIL_CLIENT_SECRET || !OAUTH_STATE_SECRET) return null
  // La llave: 64 caracteres hex (32 bytes). Una en base64 o con letras fuera de [0-9a-f] la truncaría `Buffer.from(hex)`.
  if (!CRM_GMAIL_TOKEN_KEY || !/^[0-9a-f]{64}$/i.test(CRM_GMAIL_TOKEN_KEY)) return null
  try {
    const { protocol } = new URL(CRM_GMAIL_REDIRECT_URI ?? '')
    if (protocol !== 'https:' && protocol !== 'http:') return null
  } catch {
    return null
  }
  return {
    clientId: CRM_GMAIL_CLIENT_ID,
    clientSecret: CRM_GMAIL_CLIENT_SECRET,
    redirectUri: CRM_GMAIL_REDIRECT_URI!,
    stateSecret: OAUTH_STATE_SECRET,
  }
}

/** Las cuatro `CRM_GMAIL_*` presentes y bien formadas (y el secreto del `state`, que se comparte con Calendar). */
export function gmailConfigurado(): boolean {
  return leerConfig() !== null
}

function configOFalla(): ConfigGmail {
  const cfg = leerConfig()
  if (!cfg) throw new ServiceUnavailableError(NO_CONFIGURADO, 'CRM_GMAIL_NO_CONFIGURADO')
  return cfg
}

const clienteOAuth = (cfg: ConfigGmail) => new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri)

/** «Mi Gmail» en el superadmin, con lo que pasó: `?conectado=1` o `?error=<código>`. */
export function urlDeVuelta(params: Record<string, string>): string {
  const base = (process.env.SUPERADMIN_URL || 'https://superadmin.avoqado.io').replace(/\/$/, '')
  return `${base}/crm/gmail?${new URLSearchParams(params).toString()}`
}
const volver = (error: string) => ({ redirect: urlDeVuelta({ error }) })

// ── Conectar ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** La liga a la pantalla de Google. El `state` (JWT de 10 min) dice quién la pidió; la vuelta exige esa misma sesión. */
export function urlDeConexion(staffId: string): string {
  const cfg = configOFalla()
  const state = jwt.sign({ intent: INTENT, staffId, nonce: crypto.randomBytes(16).toString('hex') }, cfg.stateSecret, {
    algorithm: 'HS256',
    expiresIn: STATE_TTL_SECONDS,
  })
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    // Sin conexión (refresh token) y SIEMPRE la pantalla de consentimiento: si no, Google no vuelve a dar refresh token.
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

/** El dueño de la liga, o lanza si el `state` venció, es de otra intención o no lo firmamos nosotros. */
function leerState(state: string | undefined, cfg: ConfigGmail): string {
  if (!state) throw new Error('state missing')
  const payload = jwt.verify(state, cfg.stateSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload
  if (payload.intent !== INTENT || typeof payload.staffId !== 'string' || !payload.staffId) throw new Error('state intent')
  return payload.staffId
}

/**
 * La vuelta de Google. NUNCA truena: todo termina en una redirección a «Mi Gmail» con `?conectado=1` o `?error=<código>`
 * (`state`, `otra-sesion`, `sin-llave`, `permisos-incompletos`, `sin-refresh`, `correo-no-verificado`, `google`,
 * `no-configurado`).
 *
 * `sesionStaffId` es la sesión del navegador que vuelve (su cookie), leída por la ruta con la misma verificación del
 * token que el resto de la API; null si no hay.
 */
export async function completarConexion(
  code: string | undefined,
  state: string | undefined,
  sesionStaffId: string | null,
): Promise<{ redirect: string }> {
  const cfg = leerConfig()
  if (!cfg) return volver('no-configurado')

  let staffId: string
  try {
    staffId = leerState(state, cfg)
  } catch {
    return volver('state')
  }
  // 🔴 El mismo navegador que empezó. Antes de canjear nada: el Gmail de otra persona nunca llega a nuestras manos.
  if (!sesionStaffId || sesionStaffId !== staffId) return volver('otra-sesion')
  if (!code) return volver('google')

  try {
    // La llave se vuelve a leer: pudo perderse entre pedir la liga y volver.
    const access = await getCrmAccess(staffId)
    if (!access?.contactar) return volver('sin-llave')

    const auth = clienteOAuth(cfg)
    const { tokens } = await auth.getToken(code)
    // 🔴 Los DOS permisos (Codex plan r1 #9): la pantalla de Google deja desmarcar uno, y con uno solo no sirve.
    const concedidos = (tokens.scope ?? '').split(/\s+/)
    if (!concedidos.includes(SCOPE_SEND) || !concedidos.includes(SCOPE_READ)) return volver('permisos-incompletos')
    if (!tokens.refresh_token) return volver('sin-refresh')
    if (!tokens.id_token) return volver('google')

    const ticket = await auth.verifyIdToken({ idToken: tokens.id_token, audience: cfg.clientId })
    const payload = ticket.getPayload()
    if (!payload?.email || !payload.email_verified) return volver('correo-no-verificado')
    const googleEmail = normalizeEmail(payload.email)
    const refreshTokenCiphertext = new Uint8Array(cipher.encrypt(tokens.refresh_token))
    const scopes = concedidos.join(' ')

    await prisma.$transaction(async tx => {
      // El candado de la fila (si ya existe): un envío que está reservando termina antes, o espera y ve la cuenta nueva.
      await tx.$queryRaw`SELECT "id" FROM "CrmGmailConnection" WHERE "staffId" = ${staffId} FOR UPDATE`
      // Los pendientes de OTRA cuenta no se buscan con las credenciales de ésta: quedan «cuenta reemplazada».
      await tx.crmEmailMessage.updateMany({
        where: { staffId, direction: 'SALIDA', status: { in: ['ENVIANDO', 'DESCONOCIDO'] }, fromEmail: { not: googleEmail } },
        data: { status: 'DESCONOCIDO', error: ERROR_CUENTA_REEMPLAZADA },
      })
      const conexion = {
        googleEmail,
        refreshTokenCiphertext,
        scopes,
        status: 'ACTIVA',
        connectedAt: new Date(),
        revokedAt: null,
        lastError: null,
      }
      await tx.crmGmailConnection.upsert({
        where: { staffId },
        create: { staffId, ...conexion },
        // `version` sube: toda escritura tardía de quien usó las credenciales viejas deja de encontrar la fila.
        update: { ...conexion, version: { increment: 1 } },
      })
      await tx.crmGmailAccountSeen.createMany({ data: [{ googleEmail }], skipDuplicates: true })
    })

    void logAction({
      staffId,
      venueId: null,
      action: 'CRM_GMAIL_CONNECTED',
      entity: 'CrmGmailConnection',
      data: { googleEmail },
    })
    return { redirect: urlDeVuelta({ conectado: '1' }) }
  } catch (error) {
    // Sólo el mensaje: el error de Google trae la petición entera (con el client_secret) en `config`.
    logger.error('[CRM] The Gmail connection could not be completed', {
      staffId,
      error: error instanceof Error ? error.message : String(error),
    })
    return volver('google')
  }
}

// ── «Mi Gmail» ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function estadoGmail(staffId: string) {
  const [conexion, cuentasUsadas] = await Promise.all([
    prisma.crmGmailConnection.findUnique({ where: { staffId }, select: { googleEmail: true, status: true } }),
    // El tope es de la APP (todas las personas), no de este vendedor.
    prisma.crmGmailAccountSeen.count(),
  ])
  return {
    configurado: gmailConfigurado(),
    conectado: conexion?.status === 'ACTIVA',
    googleEmail: conexion?.googleEmail,
    status: conexion?.status,
    cuentasUsadas,
    tope: TOPE_CUENTAS_GMAIL,
  }
}

/**
 * Desconectar: destruye las credenciales de NUESTRO lado y la deja REVOCADA. «Mi Gmail» dice: «Para quitar también el
 * permiso en Google, entra a myaccount.google.com/permissions».
 *
 * 🔴 No llama a Google (Codex plan r7 H24): revocar en Google invalida TODO lo concedido a la app, también una reconexión
 * que termina en otra pestaña al mismo tiempo. Y el CAS por `version` no apaga una conexión que se reconectó en medio.
 */
// ponytail: sin revocar en Google; si hace falta, revocar sólo cuando nadie reconectó (lock de la fila alrededor del canje).
export async function desconectar(staffId: string): Promise<{ desconectado: boolean }> {
  const conexion = await prisma.crmGmailConnection.findUnique({ where: { staffId }, select: { version: true, status: true } })
  if (!conexion) return { desconectado: false }
  const { count } = await prisma.crmGmailConnection.updateMany({
    where: { staffId, version: conexion.version },
    data: { status: 'REVOCADA', revokedAt: new Date(), refreshTokenCiphertext: new Uint8Array(0) },
  })
  if (count === 1) {
    void logAction({ staffId, venueId: null, action: 'CRM_GMAIL_DISCONNECTED', entity: 'CrmGmailConnection' })
  }
  return { desconectado: count === 1 }
}

// ── Lo que comparten mandar, reconciliar y leer respuestas ────────────────────────────────────────────────────────────

/** Un cliente de Gmail con las credenciales de UNA conexión (descifradas aquí, en memoria, nunca en un log). */
export function clienteGmail(refreshTokenCiphertext: Uint8Array): gmail_v1.Gmail {
  const auth = clienteOAuth(configOFalla())
  auth.setCredentials({ refresh_token: cipher.decrypt(Buffer.from(refreshTokenCiphertext)) })
  return google.gmail({ version: 'v1', auth })
}

export interface ConexionActiva {
  staffId: string
  googleEmail: string
  refreshTokenCiphertext: Uint8Array
  version: number
}

// ponytail: tope de 200 conexiones por vuelta (hoy son ~10 vendedores); con más, repartirlas por turnos.
const MAX_CONEXIONES = 200

/** Las conexiones ACTIVAS, para el trabajo de cada 5 min. Es su primera lectura: va con el reintento de conexión. */
export async function conexionesActivas(contexto: string): Promise<ConexionActiva[]> {
  return retry(
    () =>
      prisma.crmGmailConnection.findMany({
        where: { status: 'ACTIVA' },
        select: { staffId: true, googleEmail: true, refreshTokenCiphertext: true, version: true },
        orderBy: [{ connectedAt: 'asc' }, { staffId: 'asc' }],
        take: MAX_CONEXIONES,
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: contexto },
  )
}

/** Google dijo que las credenciales ya no sirven (el vendedor quitó el acceso o cambió su contraseña). */
export function esInvalidGrant(error: unknown): boolean {
  const e = error as { response?: { data?: { error?: unknown } }; message?: unknown } | null
  return e?.response?.data?.error === 'invalid_grant' || (typeof e?.message === 'string' && e.message.includes('invalid_grant'))
}

/** El status HTTP con que contestó Google, o undefined si no contestó (timeout, red). */
export function statusHttp(error: unknown): number | undefined {
  const e = error as { response?: { status?: unknown }; status?: unknown } | null
  const status = e?.response?.status ?? e?.status
  return typeof status === 'number' ? status : undefined
}

/** El mensaje de un error, sin nada más del objeto (que trae la petición con sus encabezados). */
export function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `invalid_grant` → REVOCADA, sólo si la fila sigue en la `version` con que se pidió: si el vendedor ya reconectó, las
 * credenciales nuevas no se tocan. La ficha dice «Reconecta tu Gmail».
 */
export async function marcarRevocada(staffId: string, version: number, ahora: Date): Promise<void> {
  const { count } = await prisma.crmGmailConnection.updateMany({
    // ACTIVA: un `invalid_grant` tardío después de «Desconectar» (que no sube la versión) no escribe un aviso falso.
    where: { staffId, version, status: 'ACTIVA' },
    data: { status: 'REVOCADA', revokedAt: ahora, lastError: 'invalid_grant' },
  })
  if (count === 1) {
    logger.warn('[CRM] Google revoked a Gmail connection (invalid_grant)', { staffId })
    void logAction({ staffId, venueId: null, action: 'CRM_GMAIL_REVOKED_BY_GOOGLE', entity: 'CrmGmailConnection' })
  }
}

/** Un error de una conexión que no es `invalid_grant`: se anota en la fila (con su versión) para verlo. */
export async function anotarError(staffId: string, version: number, error: unknown): Promise<void> {
  try {
    await prisma.crmGmailConnection.updateMany({ where: { staffId, version }, data: { lastError: mensajeDe(error).slice(0, 300) } })
  } catch (anotar) {
    logger.warn('[CRM] Could not note a Gmail connection error', { staffId, error: mensajeDe(anotar) })
  }
}
