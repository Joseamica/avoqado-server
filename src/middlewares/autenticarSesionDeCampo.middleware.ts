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
import type { IncomingMessage, ServerResponse } from 'http'
import logger from '@/config/logger'
import AppError, { ForbiddenError, UnauthorizedError } from '@/errors/AppError'
import { enrichContext } from '@/observability/executionContext'
import { buildAuthContextFromPayload } from '@/security'
import { isSessionAliveCached } from '@/services/auth/sessionCache'
import type { TipoDeEnvio } from '@/services/tpv/campo/celular/envioDeCampo'
import { reconciliarConLaRutaNormal } from '@/services/tpv/campo/celular/graciaDelCelular.service'
import { sucursalesDeLaPersona } from '@/services/tpv/campo/celular/personasDeCampo'
import { verificarAccesoDeCampo } from '@/services/tpv/campo/celular/tokenDeCampo'
import { motivoDeSesionInvalidada } from '@/utils/passwordChangeGuard'
import prisma from '@/utils/prismaClient'

/**
 * Las rutas del bloque 0 que la gracia también recibe (`/venues/:venueId/<ruta>`), con su tipo de envío. Sin la evidencia: su
 * ruta normal manda `paymentId` y la gracia `ventaLlave`, así que su texto nunca tiene la huella de su retenido (arreglo 9).
 * ponytail: una evidencia retenida y descartada cuya foto sí subió por la ruta normal se queda DESCARTADO hasta que «Aplicar» la
 * relea; no mueve dinero. Para cubrirla, el celular tendría que mandar por la gracia el mismo texto que por su ruta.
 */
const TIPO_POR_RUTA: Record<string, TipoDeEnvio> = {
  ventas: 'VENTA',
  'custodia/aceptar': 'CUSTODIA_ACEPTAR',
  'custodia/rechazar': 'CUSTODIA_RECHAZAR',
  'checadas/entrada': 'ENTRADA',
  'checadas/salida': 'SALIDA',
}

/**
 * Arreglo 9: el `verify` del parser JSON global (`configureCoreMiddlewares`). Guarda el texto EXACTO del cuerpo en
 * `req.rawBody` SÓLO en las rutas del celular de campo (`/api/v1/tpv/campo/venues/…`): el gancho I7 busca el retenido por la
 * huella de ese texto, la misma que el celular reporta en su latido. Cualquier otra URL (PAX, Nexgo, el panel, la gracia) no
 * guarda nada: ni memoria ni comportamiento cambian.
 */
export const RUTAS_CON_CUERPO_CRUDO = '/api/v1/tpv/campo/venues/'
export function guardarCuerpoDelCelular(req: IncomingMessage, _res: ServerResponse, buf: Buffer, encoding: string) {
  const url = (req as Request).originalUrl ?? req.url ?? ''
  // R9-1: sólo UTF-8 (la huella del celular se calcula sobre UTF-8). Otra codificación que el parser sí acepta (UTF-16BE…)
  // no tiene texto que guardar: la ruta sigue normal y el gancho no la encuentra (mismo límite que «texto distinto»).
  if (url.startsWith(RUTAS_CON_CUERPO_CRUDO) && /^utf-?8$/i.test(encoding || 'utf-8')) (req as Request).rawBody = buf.toString('utf8')
}

/**
 * I7 (R5-1): una petición normal admitida antes de desvincular puede terminar después de que su reenvío por la gracia se
 * retuvo, o hasta se descartó. Al contestar 2xx se reconcilian los retenidos de ese celular (el que ya tiene su efecto
 * queda APLICADO). Va después de la respuesta: nunca la frena ni la cambia; un error sólo queda en el log.
 * ponytail: si el proceso muere entre el efecto y este gancho, la fila puede quedar DESCARTADO con el efecto hecho; el dinero
 * queda bien (la venta y su cobro existen) y «Aplicar», la gracia o «Descartar» la corrigen al releer. Sin barrido periódico.
 */
function alTerminarReconciliar(req: Request, res: Response, celularId: string, venueId: string) {
  const tipo = req.method === 'POST' ? TIPO_POR_RUTA[req.path.split('/').slice(3).join('/')] : undefined
  if (!tipo) return
  res.on('finish', () => {
    // Arreglo 9: el texto exacto que mandó el celular (lo guarda `guardarCuerpoDelCelular`); sin él no hay huella que buscar.
    if (res.statusCode < 200 || res.statusCode >= 300 || req.rawBody === undefined) return
    reconciliarConLaRutaNormal(celularId, venueId, tipo, req.rawBody).catch(error =>
      logger.warn('No se pudieron reconciliar los retenidos del celular de campo', { celularId, venueId, tipo, error }),
    )
  })
}

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
    alTerminarReconciliar(req, res, celular.id, t.venueId)
    next()
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500) {
      const datos = error.details && typeof error.details === 'object' ? error.details : {}
      return res.status(error.statusCode).json({ code: error.code, message: error.message, ...datos })
    }
    next(error)
  }
}
