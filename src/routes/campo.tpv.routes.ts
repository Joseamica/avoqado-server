/**
 * App de campo: lo que sube el celular del promotor. Se monta en `/tpv/campo`. La sucursal va en la dirección
 * (`:venueId`), así que `checkPermission` evalúa el rol en ESA sucursal contra la base, no la del token (plan H4).
 * Bloque 1: las rutas `/venues/:venueId/*` entran SÓLO con la sesión del celular (`autenticarSesionDeCampo`), nunca con un
 * token de PAX, POS o dashboard.
 */
import { NextFunction, Request, Response, Router } from 'express'
import rateLimit from 'express-rate-limit'
import AppError, { ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'
import { autenticarSesionDeCampo } from '@/middlewares/autenticarSesionDeCampo.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { requireVenueMembership } from '@/middlewares/validateVenueAccess.middleware'
import { validateRequest } from '@/middlewares/validation'
import { aceptarCustodia, rechazarCustodia } from '@/controllers/tpv/campo/custodiaDeCampo.controller'
import { createProofOfSale } from '@/controllers/tpv/sale-verification.tpv.controller'
import { listMySims } from '@/controllers/tpv/simCustody.tpv.controller'
import { recordPromoterPingSchema } from '@/schemas/promoterLocation.schema'
import { createProofOfSaleSchema } from '@/schemas/tpv.schema'
import {
  aceptarCustodiaSchema,
  activarCelularSchema,
  desvincularSchema,
  entradaDeCampoSchema,
  entrarConPinSchema,
  graciaSchema,
  latidoSchema,
  rechazarCustodiaSchema,
  renovarSesionSchema,
  salidaDeCampoSchema,
  ventaDeCampoSchema,
} from '@/schemas/tpv/campo.schema'
import { activarCelular } from '@/services/tpv/campo/celular/activarCelular.service'
import { autenticarCelular } from '@/services/tpv/campo/celular/credencial'
import { desvincularCelular } from '@/services/tpv/campo/celular/desvincularCelular.service'
import { entrarConPin, renovarSesionDeCelular } from '@/services/tpv/campo/celular/entrarConPin.service'
import { recibirEnGracia } from '@/services/tpv/campo/celular/graciaDelCelular.service'
import { registrarLatido } from '@/services/tpv/campo/celular/latidoDelCelular.service'
import { registrarEntradaDeCampo, registrarSalidaDeCampo } from '@/services/tpv/campo/checadaDeCampo.service'
import { registrarVentaDeCampo } from '@/services/tpv/campo/ventaDeCampo.service'
import { recordPromoterPing } from '@/services/promoters/promoterLocation.service'
import prisma from '@/utils/prismaClient'

const router = Router()

/**
 * Tope por persona y por ruta, como `/tpv/sim-custody/*` (O10): un celular en bucle no satura al servidor. Va después del
 * token (la llave es la persona) y antes de los permisos (que leen la base). Un 429 es reintentable para el celular.
 */
const porPersona = () =>
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => req.authContext?.userId ?? req.ip,
    message: { error: 'RATE_LIMIT', code: 'RATE_LIMIT', message: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
  })

/** Los datos de un rechazo van al mismo nivel que `code` sólo si son un objeto (un arreglo saldría como «0», «1»…). */
const esObjeto = (d: unknown): d is Record<string, unknown> => !!d && typeof d === 'object' && !Array.isArray(d)

/**
 * POST /tpv/campo/activar — SIN token: el código del supervisor + el PIN dan la credencial del celular y su sesión (bloque 1).
 * 201 nuevo, 200 repetida (el mismo aparato reintenta dentro de 10 min). Los topes van por aparato y por la ruta entera,
 * nunca por IP (los promotores comparten la red del celular). Rechazos con datos (`intentosRestantes`) al nivel de `code`.
 */
const limiteDeActivar = (max: number, keyGenerator: (req: Request) => string) =>
  rateLimit({
    windowMs: 10 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    message: { error: 'RATE_LIMIT', code: 'RATE_LIMIT', message: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' },
  })
router.post(
  '/activar',
  limiteDeActivar(300, () => 'activar'),
  limiteDeActivar(20, req => {
    const aparatoId = req.body?.aparato?.aparatoId
    return typeof aparatoId === 'string' ? `aparato:${aparatoId.slice(0, 100)}` : 'aparato:sin-id'
  }),
  validateRequest(activarCelularSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await activarCelular(req.body)
      res.status(r.status).json(r.body)
    } catch (error) {
      if (error instanceof AppError && esObjeto(error.details)) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, ...error.details })
      }
      next(error)
    }
  },
)

/**
 * Entrar y renovar llevan la credencial del celular (`X-Celular-Credencial`) y UN tope de 30 por minuto por celular
 * (compartido entre las dos), nunca por IP. Va después de la credencial: la llave es el celular.
 */
const limitePorCelular = (max: number) =>
  rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (_req: Request, res: Response) => `celular:${res.locals.celular.id}`,
    message: { error: 'RATE_LIMIT', code: 'RATE_LIMIT', message: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
  })
const porCelular = limitePorCelular(30)

/** Rechazos con datos al nivel de `code`; PIN_BLOQUEADO además dice en `Retry-After` cuántos segundos esperar. */
const conDatos =
  (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await handler(req, res))
    } catch (error) {
      if (error instanceof AppError && esObjeto(error.details)) {
        if (error.code === 'PIN_BLOQUEADO') res.set('Retry-After', String(error.details.reintentaEn))
        return res.status(error.statusCode).json({ code: error.code, message: error.message, ...error.details })
      }
      next(error)
    }
  }

/**
 * POST /tpv/campo/entrar — `{ pin, venueId? }` → 200 `{ sesion, sucursales, horaDelServidor }`. Rechazos: 401
 * CELULAR_DESVINCULADO, 429 PIN_BLOQUEADO (`reintentaEn`), 403 SIN_SUCURSAL y SIN_ACCESO_A_LA_SUCURSAL, 409 ELIGE_SUCURSAL
 * (`sucursales`) y SIN_PIN, 401 PIN_INCORRECTO (`intentosAntesDeEsperar`); reintentable: 409 ENTRADA_EN_PROCESO.
 */
router.post(
  '/entrar',
  autenticarCelular,
  porCelular,
  validateRequest(entrarConPinSchema),
  conDatos((req, res) => entrarConPin(res.locals.celular, req.body)),
)

/**
 * POST /tpv/campo/renovar — `{ refreshToken }` → 200 `{ accessToken, refreshToken, venueId }`. 401 SESION_INVALIDA o
 * SIN_ACCESO_A_LA_SUCURSAL: el celular vuelve a pedir el PIN; 401 CELULAR_DESVINCULADO: pide un código nuevo.
 */
router.post(
  '/renovar',
  autenticarCelular,
  porCelular,
  validateRequest(renovarSesionSchema),
  conDatos((req, res) => renovarSesionDeCelular(res.locals.celular, req.body.refreshToken)),
)

/**
 * POST /tpv/campo/latido — la credencial del celular (cualquier estado) y `{ porSubir, huellas, aparato? }` → 200
 * `{ estado, graciaHasta, persona, sucursales, horaDelServidor }`. Tope propio de 12 por minuto por celular.
 */
router.post(
  '/latido',
  autenticarCelular,
  limitePorCelular(12),
  validateRequest(latidoSchema),
  conDatos((req, res) => registrarLatido(res.locals.celular, req.body)),
)

/**
 * POST /tpv/campo/desvincular — `{ porSubir }` con la credencial del celular. Si el celular aún tiene algo por subir
 * → 409 TIENE_POR_SUBIR («Primero sube lo pendiente»); con 0 se desvincula con motivo CELULAR. Idempotente (`yaEstaba`).
 */
router.post(
  '/desvincular',
  autenticarCelular,
  porCelular,
  validateRequest(desvincularSchema),
  conDatos(async (req, res) => {
    if (req.body.porSubir !== 0) throw new ConflictError('Primero sube lo pendiente.', 'TIENE_POR_SUBIR')
    const c = res.locals.celular
    return desvincularCelular({ celularId: c.id, organizationId: c.organizationId, motivo: 'CELULAR', porStaffId: c.staffId })
  }),
)

/**
 * POST /tpv/campo/gracia — `{ tipo, venueId, cuerpoJson }` con la credencial del celular DESVINCULADO (bloque 1, A5). Lo que
 * traía una huella de su último latido, dentro de 24 h, se aplica a nombre de la persona (el status y el body de la ruta
 * normal, con `aplicadoEnGracia: true`); lo demás se retiene → 202 `{ retenido: true, motivo }`. Un retenido que ya existe
 * contesta su desenlace. 403 OTRA_ORGANIZACION, 400 (CUERPO_INVALIDO: el esquema de su tipo; la evidencia con sus campos
 * de captura), 409 USA_TU_SESION; reintentables: los EN_PROCESO, 409 RETENIDOS_LLENOS (500 por revisar: el celular lo
 * conserva hasta que el supervisor despeje), 429 y 5xx.
 */
router.post(
  '/gracia',
  autenticarCelular,
  limitePorCelular(60),
  validateRequest(graciaSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await recibirEnGracia(res.locals.celular, req.body)
      res.status(r.status).json(r.body)
    } catch (error) {
      if (error instanceof AppError && esObjeto(error.details)) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, ...error.details })
      }
      next(error)
    }
  },
)

/**
 * POST /tpv/campo/venues/:venueId/ventas — la venta de una SIM. 201 nueva, 200 repetida (misma llave).
 * Reintentables: 409 VENTA_EN_PROCESO y cualquier 5xx. Lo demás es definitivo; 422 PRECIO_CAMBIO trae `precioActual`.
 */
router.post(
  '/venues/:venueId/ventas',
  autenticarSesionDeCampo,
  porPersona(),
  checkPermission('serialized-inventory:sell'),
  checkPermission('payments:create'),
  validateRequest(ventaDeCampoSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = req.params
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
      if (!venue) throw new NotFoundError('Sucursal no encontrada')
      const r = await registrarVentaDeCampo(
        { venueId, orgId: venue.organizationId, staffId: req.authContext!.userId, celularId: res.locals.celular.id },
        req.body,
      )
      res.status(r.repetida ? 200 : 201).json(r)
    } catch (error) {
      if (error instanceof AppError && error.code === 'PRECIO_CAMBIO' && esObjeto(error.details)) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, ...error.details })
      }
      next(error)
    }
  },
)

/** Custodia del celular: sin `simCustodyIdempotency`; «ya estaba hecho» (misma persona) es éxito con `repetida: true`. */
router.post(
  '/venues/:venueId/custodia/aceptar',
  autenticarSesionDeCampo,
  porPersona(),
  checkPermission('tpv-sim-custody:accept'),
  validateRequest(aceptarCustodiaSchema),
  aceptarCustodia,
)
router.post(
  '/venues/:venueId/custodia/rechazar',
  autenticarSesionDeCampo,
  porPersona(),
  checkPermission('tpv-sim-custody:reject'),
  validateRequest(rechazarCustodiaSchema),
  rechazarCustodia,
)

/**
 * La checada del celular: la persona sale del token (no hay PIN) y `requireVenueMembership` exige que siga activa y con
 * su rol en la sucursal de la dirección, contra la base. Entrada: 201 nueva, 200 repetida. Salida: 200.
 * Rechazos: 409 YA_TIENE_ENTRADA y ENTRADA_SE_ENCIMA / SALIDA_SE_ENCIMA (con el `timeEntryId`, `venueId` y horas del
 * otro turno al mismo nivel), 400 SALIDA_SIN_ENTRADA, 404, 422 SALIDA_ANTES_DE_ENTRADA, 409 YA_TIENE_SALIDA;
 * reintentable: 409 CHECADA_EN_PROCESO y cualquier 5xx.
 */
const checada =
  (registrar: typeof registrarEntradaDeCampo | typeof registrarSalidaDeCampo, nueva: number) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await registrar({ venueId: req.params.venueId, staffId: req.authContext!.userId }, req.body)
      res.status(r.repetida ? 200 : nueva).json(r)
    } catch (error) {
      // Los rechazos con datos (YA_TIENE_ENTRADA, ENTRADA_SE_ENCIMA, SALIDA_SE_ENCIMA) los llevan al mismo nivel que `code`.
      if (error instanceof AppError && esObjeto(error.details)) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, ...error.details })
      }
      next(error)
    }
  }
router.post(
  '/venues/:venueId/checadas/entrada',
  autenticarSesionDeCampo,
  porPersona(),
  requireVenueMembership,
  validateRequest(entradaDeCampoSchema),
  checada(registrarEntradaDeCampo, 201),
)
router.post(
  '/venues/:venueId/checadas/salida',
  autenticarSesionDeCampo,
  porPersona(),
  requireVenueMembership,
  validateRequest(salidaDeCampoSchema),
  checada(registrarSalidaDeCampo, 200),
)

/**
 * Las dos rutas espejo de la TPV, con sus MISMOS controladores, permisos y esquemas:
 * `POST /venues/:venueId/evidencia` = `POST /tpv/verification/proof-of-sale` y `GET /venues/:venueId/mis-sims` =
 * `GET /tpv/sim-custody/my-sims`. La evidencia tiene un paso propio antes del controlador: su servicio busca el pago en
 * toda la organización (a propósito, para la TPV, R3-1), y el celular sólo puede tocar ventas de la sucursal de su sesión.
 * Un pago (o verificación) que no existe en la organización sigue al controlador, que contesta lo mismo que hoy.
 */
const otraSucursal = () => new ForbiddenError('Esa venta es de otra sucursal.', 'OTRA_SUCURSAL')
async function evidenciaDeEstaSucursal(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const enLaOrganizacion = { venue: { organizationId: req.authContext!.orgId } }
    const { paymentId, verificationId } = req.body
    const pago = await prisma.payment.findFirst({ where: { id: paymentId, ...enLaOrganizacion }, select: { venueId: true } })
    if (pago && pago.venueId !== venueId) throw otraSucursal()
    if (verificationId) {
      const v = await prisma.saleVerification.findFirst({ where: { id: verificationId, ...enLaOrganizacion }, select: { venueId: true } })
      if (v && v.venueId !== venueId) throw otraSucursal()
    }
    next()
  } catch (error) {
    if (error instanceof AppError && error.code === 'OTRA_SUCURSAL') {
      return res.status(error.statusCode).json({ code: error.code, message: error.message })
    }
    next(error)
  }
}
router.post(
  '/venues/:venueId/evidencia',
  autenticarSesionDeCampo,
  porPersona(),
  checkPermission('payments:create'),
  validateRequest(createProofOfSaleSchema),
  evidenciaDeEstaSucursal,
  createProofOfSale,
)
router.get('/venues/:venueId/mis-sims', autenticarSesionDeCampo, porPersona(), listMySims)

/**
 * POST /tpv/campo/venues/:venueId/ubicacion — el GPS del turno del celular (bloque 2), espejo de
 * `POST /tpv/geolocation/promoter-ping` con su MISMO esquema y servicio. La sucursal sale de la dirección (el candado ya
 * exige que sea la de la sesión) y la persona del token; el celular no es una terminal, así que no hay override por terminal.
 */
router.post(
  '/venues/:venueId/ubicacion',
  autenticarSesionDeCampo,
  porPersona(),
  requireVenueMembership,
  validateRequest(recordPromoterPingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { latitude, longitude, accuracy, capturedAt, source } = req.body
      const ping = await recordPromoterPing({
        venueId: req.params.venueId,
        staffId: req.authContext!.userId,
        latitude,
        longitude,
        accuracy: accuracy ?? null,
        capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
        source: source ?? 'PERIODIC',
        terminalId: null,
        terminalTrackOverride: null,
      })
      res.status(201).json({ success: true, data: { id: ping.id } })
    } catch (error) {
      next(error)
    }
  },
)

export default router
