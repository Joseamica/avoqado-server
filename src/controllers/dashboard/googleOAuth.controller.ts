import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import * as googleOAuthService from '../../services/dashboard/googleOAuth.service'
import { z } from 'zod'
import { ForbiddenError, ValidationError } from '../../errors/AppError'
import { optionalLaunchCampaignCode, utmSchema } from '../../schemas/acquisition.schema'
import { ipDelCliente } from '../../utils/clientIp'

/**
 * El sobre de ALTA que sólo manda `/signup` → «Continuar con Google». Mismas reglas que el alta por
 * correo (`SignupSchema`): un código o unos UTM mal formados se DESCARTAN en silencio —la
 * atribución vale menos que la cuenta— y nunca tumban el alta con un 400.
 */
const signupIntentSchema = z
  .object({
    legalVersion: z.string().trim().max(40).optional(),
    launchCampaignCode: optionalLaunchCampaignCode,
    utm: utmSchema,
  })
  .optional()

/**
 * 🔴 El `state` de Google contra el login CSRF (27-sep). Sin él, un atacante sacaba un `code` de SU cuenta
 * de Google y le mandaba a la víctima `…/auth/google/callback?code=…`: el navegador de la víctima entraba
 * a la cuenta del atacante. Ahora pedir la URL estrena un `state` al azar que viaja en la URL de Google Y
 * en esta cookie HttpOnly; el callback sólo canjea si coinciden. El atacante controla su liga, no la
 * cookie de la víctima.
 *
 * Las mismas `secure`/`sameSite` que las cookies de sesión (el dashboard de vista previa en pages.dev es
 * de otro sitio que la API): la protección no depende de SameSite, sino de que nadie más conoce el valor.
 * ponytail: una sola cookie por navegador — dos inicios con Google a la vez en dos pestañas y el primero
 * falla con el aviso (reintenta y entra). Si llega a importar, una cookie por state.
 */
export const GOOGLE_OAUTH_STATE_COOKIE = 'avq_google_oauth_state'
const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000 // lo que tarda de sobra ir a Google y volver

function opcionesCookieDelState() {
  const segura = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  return {
    httpOnly: true,
    secure: segura,
    sameSite: segura ? ('none' as const) : ('lax' as const),
    // Sólo viaja a las rutas de Google, no en cada petición del dashboard.
    path: '/api/v1/dashboard/auth/google',
  }
}

function stateCoincide(esperado: unknown, recibido: unknown): boolean {
  if (typeof esperado !== 'string' || typeof recibido !== 'string' || !esperado) return false
  const a = Buffer.from(esperado)
  const b = Buffer.from(recibido)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Get Google OAuth authorization URL
 */
export async function getGoogleAuthUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const state = crypto.randomBytes(32).toString('base64url')
    const authUrl = googleOAuthService.getGoogleAuthUrl(state)
    res.cookie(GOOGLE_OAUTH_STATE_COOKIE, state, { ...opcionesCookieDelState(), maxAge: GOOGLE_OAUTH_STATE_TTL_MS })

    res.status(200).json({
      success: true,
      authUrl,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Handle Google OAuth callback
 */
export async function googleOAuthCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Se gasta en el intento, salga bien o mal: un state sirve UNA vez. Y vale también para el camino
    // `token`, que si no sería la puerta trasera de esta misma prueba.
    const esperado = req.cookies?.[GOOGLE_OAUTH_STATE_COOKIE]
    res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, opcionesCookieDelState())
    if (!stateCoincide(esperado, req.body?.state)) {
      throw new ForbiddenError(
        'No pudimos confirmar que este inicio de sesión con Google lo empezaste tú en este navegador. Vuelve a intentarlo.',
        'GOOGLE_OAUTH_STATE_INVALID',
      )
    }

    const { code, token } = req.body

    if (!code && !token) {
      throw new ValidationError('Either authorization code or ID token is required')
    }

    // Un sobre que no es un objeto (o que no valida) se trata como AUSENTE: entonces el callback es
    // un inicio de sesión normal y un correo desconocido recibe el 403 de siempre.
    const sobre = signupIntentSchema.safeParse(req.body?.signup)
    const signup = sobre.success && sobre.data ? { ...sobre.data, ipAddress: ipDelCliente(req) ?? null } : undefined

    const result = await googleOAuthService.loginWithGoogle(
      code || token,
      !!code, // isCode = true if code is provided
      signup,
    )

    // Cookie maxAge must match JWT expiration (24h default for OAuth login)
    const accessTokenMaxAge = 24 * 60 * 60 * 1000 // 24 hours
    const refreshTokenMaxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

    // Set cookies
    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: accessTokenMaxAge,
      path: '/',
    })

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: refreshTokenMaxAge,
      path: '/',
    })

    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Welcome! Account created successfully.' : 'Login successful',
      user: result.staff,
      isNewUser: result.isNewUser,
      // 🔴 Lo que la pantalla usa para contar una ALTA: `isNewUser` también es true al aceptar una
      // invitación, y un empleado invitado no es una conversión del anuncio.
      businessCreated: result.businessCreated === true,
      // El servicio ya las calculaba; sin esto la pantalla nunca llevaba a la invitación pendiente.
      ...(result.pendingInvitations ? { pendingInvitations: result.pendingInvitations } : {}),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Handle Google One Tap login
 */
export async function googleOneTapLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { credential } = req.body

    if (!credential) {
      throw new ValidationError('Google One Tap credential is required')
    }

    const result = await googleOAuthService.loginWithGoogleOneTap(credential)

    // Cookie maxAge must match JWT expiration (24h default for OAuth login)
    const accessTokenMaxAge = 24 * 60 * 60 * 1000 // 24 hours
    const refreshTokenMaxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

    // Set cookies
    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: accessTokenMaxAge,
      path: '/',
    })

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: refreshTokenMaxAge,
      path: '/',
    })

    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Welcome! Account created successfully.' : 'Login successful',
      user: result.staff,
      isNewUser: result.isNewUser,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Check invitation status for an email
 */
export async function checkInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = req.query

    if (!email || typeof email !== 'string') {
      throw new ValidationError('Email is required')
    }

    const invitationStatus = await googleOAuthService.checkInvitationStatus(email)

    res.status(200).json({
      success: true,
      ...invitationStatus,
    })
  } catch (error) {
    next(error)
  }
}
