/**
 * El pase de Google del POS (hz:6bfcd3a1:D1): audiencia PROPIA (nunca la del panel), nonce de un solo uso
 * (Android) y canje del código con PKCE (escritorio). Las variables se leen de `process.env` en cada llamada.
 */
import { randomBytes } from 'crypto'
import { OAuth2Client } from 'google-auth-library'
import logger from '@/config/logger'
import { ServiceUnavailableError, UnauthorizedError } from '../../../errors/AppError'

export interface UsuarioDeGoogle {
  sub: string
  email: string
  emailVerified: boolean
  hd: string | null
  picture: string | null
}

const VIDA_NONCE_MS = 10 * 60_000
const TOPE_NONCES = 10_000
// ponytail: nonces en memoria, una instancia; tabla con CAS si algún día hay varias instancias.
const nonces = new Map<string, number>() // nonce -> vence (ms); el orden de inserción = el más viejo primero

/** Sólo para pruebas. */
export function vaciarNoncesSoloPruebas(): void {
  nonces.clear()
}

// Sólo `error.message` (string): nunca el objeto de error (su `config` trae `client_secret`), ni token, code o verifier.
// La librería de Google a veces pega el token o el payload decodificado tras el primer ':': sólo va lo anterior.
const resumen = (m: string) => String(m).split(':')[0].trim().slice(0, 80)
const rechazo = (via: 'android' | 'escritorio', motivo: string, e?: unknown) => {
  logger.warn('Pase de Google del POS rechazado', { via, motivo, error: e instanceof Error ? resumen(e.message) : undefined })
  return invalido()
}
const invalido = () => new UnauthorizedError('No pudimos confirmar tu cuenta de Google. Vuelve a intentarlo.', 'GOOGLE_TOKEN_INVALID')
const noDisponible = (code: string) =>
  new ServiceUnavailableError('Entrar con Google no está disponible por ahora. Entra con tu correo y contraseña.', code)

function emitirNonce(): string {
  const ahora = Date.now()
  for (const [n, vence] of nonces) if (vence <= ahora) nonces.delete(n)
  while (nonces.size >= TOPE_NONCES) nonces.delete(nonces.keys().next().value as string)
  const nonce = randomBytes(32).toString('base64url')
  nonces.set(nonce, ahora + VIDA_NONCE_MS)
  return nonce
}

/** null = bueno; si no, el motivo del rechazo. */
function gastarNonce(nonce: unknown): string | null {
  if (typeof nonce !== 'string') return 'nonce-ausente'
  const vence = nonces.get(nonce)
  if (vence === undefined) return 'nonce-desconocido'
  nonces.delete(nonce)
  return vence > Date.now() ? null : 'nonce-vencido'
}

export function configDeGoogleParaElPos() {
  const androidAudience = process.env.GOOGLE_POS_ANDROID_AUDIENCE || null
  const desktopClientId = process.env.GOOGLE_POS_DESKTOP_CLIENT_ID || null
  const windows = !!desktopClientId && !!process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET
  const android = !!androidAudience
  return { androidAudience, nonce: android ? emitirNonce() : null, desktopClientId, android, windows }
}

function aUsuario(payload: any, via: 'android' | 'escritorio'): UsuarioDeGoogle {
  if (!payload?.sub || !payload.email) throw rechazo(via, 'sin-sub-o-email')
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    hd: payload.hd ?? null,
    picture: payload.picture ?? null,
  }
}

export async function leerPaseDeAndroid(idToken: string): Promise<UsuarioDeGoogle> {
  const audience = process.env.GOOGLE_POS_ANDROID_AUDIENCE
  if (!audience) throw noDisponible('GOOGLE_ANDROID_NOT_CONFIGURED')
  let payload: any
  try {
    payload = (await new OAuth2Client().verifyIdToken({ idToken, audience })).getPayload()
  } catch (e) {
    throw rechazo('android', 'verificacion-fallida', e)
  }
  if (!payload) throw rechazo('android', 'sin-payload')
  const motivo = gastarNonce(payload.nonce)
  if (motivo) throw rechazo('android', motivo)
  return aUsuario(payload, 'android')
}

export async function leerPaseDeEscritorio(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<UsuarioDeGoogle> {
  const id = process.env.GOOGLE_POS_DESKTOP_CLIENT_ID
  const secreto = process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET
  if (!id || !secreto) throw noDisponible('GOOGLE_DESKTOP_NOT_CONFIGURED')
  let payload: any
  let idToken: string
  const client = new OAuth2Client(id, secreto)
  try {
    const { tokens } = await client.getToken({ code: p.code, codeVerifier: p.codeVerifier, redirect_uri: p.redirectUri })
    if (!tokens.id_token) throw new Error('sin id_token')
    idToken = tokens.id_token
  } catch (e) {
    throw rechazo('escritorio', 'canje-fallido', e)
  }
  try {
    payload = (await client.verifyIdToken({ idToken, audience: id })).getPayload()
  } catch (e) {
    throw rechazo('escritorio', 'verificacion-fallida', e)
  }
  return aUsuario(payload, 'escritorio')
}
