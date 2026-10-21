import { Response } from 'express'

/**
 * Cookies de sesión del dashboard tras reemitir tokens (cambio de sucursal, cambio de contraseña, fin del alta).
 * maxAge igual a la vida del JWT (24 h; sin contexto de «recordarme» aquí).
 */
export function ponerCookiesDeSesion(res: Response, accessToken: string, refreshToken: string): void {
  const entornoRemoto = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  const base = {
    httpOnly: true,
    secure: entornoRemoto,
    sameSite: entornoRemoto ? ('none' as const) : ('lax' as const), // 'none' para cross-domain en producción y staging
    path: '/',
    // Sin domain: despliegue cross-domain (Cloudflare + Render)
  }
  res.cookie('accessToken', accessToken, { ...base, maxAge: 24 * 60 * 60 * 1000 })
  res.cookie('refreshToken', refreshToken, { ...base, maxAge: 7 * 24 * 60 * 60 * 1000 })
}
