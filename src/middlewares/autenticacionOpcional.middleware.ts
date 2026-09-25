import type { NextFunction, Request, Response } from 'express'
import { authenticateTokenMiddleware, extraerToken } from './authenticateToken.middleware'

/**
 * Identifica a la persona SI trae una sesión válida, sin exigirla.
 *
 * Para rutas públicas que necesitan saber quién pide (aceptar una invitación: una cuenta sin
 * contraseña sólo la acepta su propia sesión). Reusa `authenticateTokenMiddleware` TAL CUAL —firma,
 * revocación, corte de sesión, `sid`, impersonación— en vez de repetir esas reglas: repetirlas es
 * como nacen dos definiciones de «sesión válida» que dejan de coincidir.
 *
 * 🔴 Una sesión ausente o inválida NUNCA es error aquí: se sigue como anónimo, sin `authContext`.
 * Quien decide si eso basta es la ruta. Y nunca responde por su cuenta (ni 401 ni borra la cookie):
 * lo que haga el middleware real con la respuesta se descarta.
 */
export async function autenticacionOpcional(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!extraerToken(req)) return next()

  let paso = false
  const respuestaMuda = {
    status: () => respuestaMuda,
    json: () => respuestaMuda,
    send: () => respuestaMuda,
    clearCookie: () => respuestaMuda,
    cookie: () => respuestaMuda,
    setHeader: () => respuestaMuda,
  } as unknown as Response

  try {
    await authenticateTokenMiddleware(req, respuestaMuda, (err?: unknown) => {
      paso = !err
    })
  } catch {
    paso = false
  }

  if (!paso) delete (req as Request & { authContext?: unknown }).authContext
  next()
}
