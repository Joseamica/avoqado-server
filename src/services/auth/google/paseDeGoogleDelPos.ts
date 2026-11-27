/**
 * El pase de Google del POS (hz:6bfcd3a1:D1).
 * - ANDROID: la persona entra en una pestaña efímera; Google vuelve AL SERVIDOR (`/mobile/auth/google/vuelta`), que guarda
 *   el código por `state` (5 min, un solo uso) y el POS lo canjea con su verificador PKCE y el cliente WEB (con secreto).
 *   Así la cuenta de Google nunca queda en el aparato.
 * - WINDOWS: el POS recibe el código en 127.0.0.1 y lo canjea con su cliente de escritorio.
 * Las variables se leen de `process.env` en cada llamada.
 */
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

type Via = 'android' | 'escritorio'

const VIDA_VUELTA_MS = 5 * 60_000
const TOPE_VUELTAS = 10_000
// ponytail: vueltas en memoria, una instancia; si el SERVIDOR se reinicia entre la vuelta y el POST, 401 y la persona toca
// otra vez. Tabla con CAS si algún día hay varias instancias.
// `code: null` = ya usada: se queda así hasta vencer, para que una vuelta repetida no la reviva.
// El orden de inserción es el de llegada y la vida es fija: los vencidos siempre están al frente.
const vueltas = new Map<string, { code: string | null; vence: number }>()

/** Sólo para pruebas. */
export function vaciarVueltasSoloPruebas(): void {
  vueltas.clear()
}

/** Guarda el código que Google mandó para este `state`. El primero gana; una llave ya usada tampoco se pisa. */
export function guardarVuelta(state: string, code: string): void {
  const ahora = Date.now()
  for (const [s, v] of vueltas) {
    if (v.vence > ahora) break
    vueltas.delete(s)
  }
  if (vueltas.has(state)) return
  if (vueltas.size >= TOPE_VUELTAS) vueltas.delete(vueltas.keys().next().value as string)
  vueltas.set(state, { code, vence: ahora + VIDA_VUELTA_MS })
}

/** El código de este `state`, una sola vez; null si nunca llegó, ya se usó o venció. */
export function tomarCodigo(state: string): string | null {
  const v = vueltas.get(state)
  if (!v || v.code === null || v.vence <= Date.now()) return null
  vueltas.set(state, { code: null, vence: v.vence }) // `set` sobre una llave existente no la mueve de lugar
  return v.code
}

// Sólo `error.message` (string): nunca el objeto de error (su `config` trae `client_secret`), ni token, code, state o verifier.
// La librería de Google a veces pega el token o el payload decodificado tras el primer ':': sólo va lo anterior.
const resumen = (m: string) => String(m).split(':')[0].trim().slice(0, 80)
const rechazo = (via: Via, motivo: string, e?: unknown) => {
  logger.warn('Pase de Google del POS rechazado', { via, motivo, error: e instanceof Error ? resumen(e.message) : undefined })
  return invalido()
}
const invalido = () => new UnauthorizedError('No pudimos confirmar tu cuenta de Google. Vuelve a intentarlo.', 'GOOGLE_TOKEN_INVALID')
const noDisponible = (code: string) =>
  new ServiceUnavailableError('Entrar con Google no está disponible por ahora. Entra con tu correo y contraseña.', code)

/** El cliente WEB del POS: sólo con las tres variables. */
function clienteWebDelPos() {
  const id = process.env.GOOGLE_POS_WEB_CLIENT_ID
  const secreto = process.env.GOOGLE_POS_WEB_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_POS_REDIRECT_URI
  return id && secreto && redirectUri ? { id, secreto, redirectUri } : null
}

export function configDeGoogleParaElPos(): {
  android: boolean
  windows: boolean
  webClientId: string | null
  redirectUri: string | null
  desktopClientId: string | null
} {
  const web = clienteWebDelPos()
  const desktopClientId = process.env.GOOGLE_POS_DESKTOP_CLIENT_ID || null
  const windows = !!desktopClientId && !!process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET
  return {
    android: !!web,
    windows,
    webClientId: web?.id ?? null,
    redirectUri: web?.redirectUri ?? null,
    desktopClientId: windows ? desktopClientId : null,
  }
}

function aUsuario(payload: any, via: Via): UsuarioDeGoogle {
  if (!payload?.sub || !payload.email) throw rechazo(via, 'sin-sub-o-email')
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    hd: payload.hd ?? null,
    picture: payload.picture ?? null,
  }
}

/** Canje con PKCE y revisión del id_token con la audiencia del mismo cliente. */
async function canjear(
  id: string,
  secreto: string,
  p: { code: string; codeVerifier: string; redirectUri: string },
  via: Via,
): Promise<UsuarioDeGoogle> {
  const client = new OAuth2Client(id, secreto)
  let idToken: string
  try {
    const { tokens } = await client.getToken({ code: p.code, codeVerifier: p.codeVerifier, redirect_uri: p.redirectUri })
    if (!tokens.id_token) throw new Error('sin id_token')
    idToken = tokens.id_token
  } catch (e) {
    throw rechazo(via, 'canje-fallido', e)
  }
  let payload: any
  try {
    payload = (await client.verifyIdToken({ idToken, audience: id })).getPayload()
  } catch (e) {
    throw rechazo(via, 'verificacion-fallida', e)
  }
  return aUsuario(payload, via)
}

/** `state` desconocido, vencido o usado ⇒ 401 sin hablar con Google. */
export async function leerPaseDeAndroid(p: { state: string; codeVerifier: string }): Promise<UsuarioDeGoogle> {
  const web = clienteWebDelPos()
  if (!web) throw noDisponible('GOOGLE_ANDROID_NOT_CONFIGURED')
  const code = tomarCodigo(p.state)
  if (!code) throw rechazo('android', 'vuelta-desconocida')
  return canjear(web.id, web.secreto, { code, codeVerifier: p.codeVerifier, redirectUri: web.redirectUri }, 'android')
}

export async function leerPaseDeEscritorio(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<UsuarioDeGoogle> {
  const id = process.env.GOOGLE_POS_DESKTOP_CLIENT_ID
  const secreto = process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET
  if (!id || !secreto) throw noDisponible('GOOGLE_DESKTOP_NOT_CONFIGURED')
  return canjear(id, secreto, p, 'escritorio')
}
