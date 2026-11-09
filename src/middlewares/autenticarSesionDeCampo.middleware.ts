/**
 * El candado de las rutas del celular de campo (`/tpv/campo/venues/:venueId/*`, App de campo, bloque 1). Va EN LUGAR de
 * `authenticateTokenMiddleware`: sólo entra un token del celular (`verificarAccesoDeCampo`; uno de PAX, POS o dashboard
 * no) cuya sesión sigue viva y es la `sesionId` del celular VINCULADO de la persona. En cada petición, no sólo al
 * renovar: una renovación que choca con otra entrada puede devolver tokens de una sesión ya muerta.
 *
 * Deja `req.authContext` con el rol de HOY en la sucursal (no el del token), para que `checkPermission`,
 * `requireVenueMembership` y los controladores de la TPV sigan igual, y `res.locals.celular`.
 */
import { NextFunction, Request, Response } from 'express'
import AppError, { ForbiddenError, UnauthorizedError } from '@/errors/AppError'
import { enrichContext } from '@/observability/executionContext'
import { buildAuthContextFromPayload } from '@/security'
import { isSessionAliveCached } from '@/services/auth/sessionCache'
import { sucursalesDeLaPersona } from '@/services/tpv/campo/celular/personasDeCampo'
import { verificarAccesoDeCampo } from '@/services/tpv/campo/celular/tokenDeCampo'
import { motivoDeSesionInvalidada } from '@/utils/passwordChangeGuard'
import prisma from '@/utils/prismaClient'

const invalida = () => new UnauthorizedError('Tu sesión del celular no es válida. Entra de nuevo con tu PIN.', 'SESION_INVALIDA')

export async function autenticarSesionDeCampo(req: Request, res: Response, next: NextFunction) {
  try {
    const cabecera = req.headers.authorization
    if (!cabecera?.startsWith('Bearer ')) throw invalida()
    const t = verificarAccesoDeCampo(cabecera.slice(7))

    if (!(await isSessionAliveCached(t.sid)) || (await motivoDeSesionInvalidada(t.sub, t.iat))) {
      throw new UnauthorizedError('Tu sesión del celular se cerró. Entra de nuevo con tu PIN.', 'SESION_CERRADA')
    }

    const celular = await prisma.celularDeCampo.findUnique({ where: { staffIdVinculado: t.sub } })
    if (!celular)
      throw new UnauthorizedError('Este celular ya no está vinculado. Pide un código nuevo a tu supervisor.', 'CELULAR_DESVINCULADO')
    if (celular.sesionId !== t.sid) throw invalida()

    if (req.params.venueId !== t.venueId) {
      throw new AppError('Tu sesión es de otra sucursal. Entra de nuevo con tu PIN en esta.', 403, true, 'OTRA_SUCURSAL', {
        venueIdDeLaSesion: t.venueId,
      })
    }
    const sucursales = await sucursalesDeLaPersona(t.sub, t.orgId)
    if (sucursales.length === 0) throw new ForbiddenError('Ya no estás dado de alta en este negocio.', 'PERSONA_DADA_DE_BAJA')
    const hoy = sucursales.find(s => s.venueId === t.venueId)
    if (!hoy) throw new ForbiddenError('Ya no tienes acceso a esta sucursal.', 'SIN_ACCESO_A_LA_SUCURSAL')

    req.authContext = buildAuthContextFromPayload({
      sub: t.sub,
      orgId: t.orgId,
      venueId: t.venueId,
      role: hoy.role,
      sid: t.sid,
      iat: t.iat,
    })
    enrichContext({ venueId: t.venueId, venueName: hoy.nombre, userId: t.sub, role: hoy.role })
    res.locals.celular = celular
    next()
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500) {
      const datos = error.details && typeof error.details === 'object' ? error.details : {}
      return res.status(error.statusCode).json({ code: error.code, message: error.message, ...datos })
    }
    next(error)
  }
}
