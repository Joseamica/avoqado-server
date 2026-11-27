import logger from '@/config/logger'
import prisma from '../../utils/prismaClient'
import { AuthenticationError, ConflictError, NotFoundError, UnauthorizedError } from '../../errors/AppError'
import { ligarCuentaConGoogle } from '../auth/google/ligarCuentaConGoogle'
import { leerPaseDeAndroid, leerPaseDeEscritorio } from '../auth/google/paseDeGoogleDelPos'
import { STAFF_DEL_LOGIN_POS, emitirSesionDelPos, pickOperationalVenueForLogin } from './auth.mobile.service'

export type PaseDelPos = { idToken: string } | { code: string; codeVerifier: string; redirectUri: string }

/**
 * Entrar al POS con Google (hz:6bfcd3a1:D1). 🔴 El orden es el contrato de seguridad:
 * nada se escribe antes del paso 6 (ligar). No revisa `lockedUntil` ni contraseña: Google es otra prueba.
 */
export async function entrarAlPosConGoogle(pase: PaseDelPos, rememberMe: boolean | undefined, deviceId: string | undefined) {
  // 1-2. Leer el pase; el correo tiene que estar verificado en Google.
  const google = 'idToken' in pase ? await leerPaseDeAndroid(pase.idToken) : await leerPaseDeEscritorio(pase)
  if (!google.emailVerified) throw new UnauthorizedError('Tu correo no está verificado en Google.', 'GOOGLE_EMAIL_NOT_VERIFIED')

  // 3. La cuenta.
  const email = google.email.toLowerCase()
  const staff = await prisma.staff.findUnique({ where: { email }, select: STAFF_DEL_LOGIN_POS })
  if (!staff) {
    throw new NotFoundError(
      'No encontramos una cuenta de Avoqado con ese correo. Si te invitaron, acepta la invitación desde tu correo; si eres el dueño, crea tu cuenta en dashboard.avoqado.io.',
      'GOOGLE_ACCOUNT_NOT_FOUND',
    )
  }

  // 4. Activa.
  if (!staff.active) throw new AuthenticationError('Tu cuenta está desactivada')

  // 5. ¿De quién es el correo? Ligada: tiene que ser la misma cuenta de Google. Sin ligar: sólo si Google
  // es el dueño del buzón (gmail.com o Workspace); el resto prueba con contraseña.
  if (staff.googleId) {
    if (staff.googleId !== google.sub) {
      // Sin correo, token ni sub en el registro: sólo quién y por qué.
      logger.warn('Google POS: cuenta ligada a otra cuenta de Google', { staffId: staff.id, reason: 'sub-distinto' })
      throw new UnauthorizedError('Esta cuenta está ligada a otra cuenta de Google.', 'GOOGLE_ACCOUNT_MISMATCH')
    }
  } else if (!email.endsWith('@gmail.com') && !google.hd) {
    throw new UnauthorizedError(
      'Esta cuenta todavía no está ligada a Google. Entra con tu correo y contraseña.',
      'GOOGLE_ACCOUNT_NOT_LINKED',
    )
  }
  // Sólo revisa (lanza lo mismo que la contraseña): si no puede entrar, no se liga ni se anula nada.
  const sucursal = pickOperationalVenueForLogin(staff.venues, 'NO_VENUE_ACCESS')

  // 6. Primera escritura, siempre: es el candado (mismo correo, activa, misma contraseña) antes de emitir la sesión.
  const { aplicada } = await ligarCuentaConGoogle(
    staff,
    { sub: google.sub, picture: google.picture },
    sucursal.venue.organizationId ?? null,
    { siempreEscribir: true },
  )
  if (!aplicada) throw new ConflictError('Vuelve a intentarlo.', 'GOOGLE_ACCOUNT_CHANGED')

  // 7. Sesión.
  return emitirSesionDelPos(staff, 'google', rememberMe, deviceId)
}
