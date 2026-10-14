/**
 * La pantalla del cliente, desde el dashboard (spec §5.5). DOS routers, montados en dashboard.routes.ts con
 * `authenticateToken` aplicado EN EL MONTAJE:
 *
 * - el de UNA terminal: `/venues/:venueId/terminals/:terminalId/customer-display`;
 * - el del NEGOCIO: `/venues/:venueId/customer-display` (la lista de dispositivos).
 *
 * Orden de siempre: checkPermission → validateRequest → controlador. La subida es la excepción y sigue el orden del
 * spec §5.4 (ver `router.post('/assets', …)`).
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import AppError from '../../errors/AppError'
import logger from '../../config/logger'
import { preserveContext } from '../../observability/preserveContext'
import { checkPermission, resolveUserRoleForVenue } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as activos from '../../services/customer-display/customerDisplayAsset.service'
import { MAX_ASSET_BYTES } from '../../services/customer-display/customerDisplayDesign.validation'
import * as controller from '../../controllers/dashboard/customerDisplay.dashboard.controller'
import * as schemas from '../../schemas/dashboard/customerDisplay.schema'

/**
 * @openapi
 * components:
 *   parameters:
 *     CustomerDisplayVenueId:
 *       in: path
 *       name: venueId
 *       required: true
 *       schema: { type: string }
 *       description: El negocio. Sale SIEMPRE de la URL, nunca del cuerpo.
 *     CustomerDisplayTerminalId:
 *       in: path
 *       name: terminalId
 *       required: true
 *       schema: { type: string }
 *       description: El dispositivo (POS_ANDROID) del negocio.
 *   schemas:
 *     CustomerDisplayDesignDraft:
 *       type: object
 *       additionalProperties: false
 *       description: Borrador ESTRICTO del diseño; una llave que no esté aquí es un 400.
 *       properties:
 *         theme: { type: string, enum: [LIGHT, DARK] }
 *         accentColor: { type: string, nullable: true, example: '#1A73E8' }
 *         logoAssetId: { type: string, nullable: true }
 *         welcomeText: { type: string, nullable: true }
 *         thanksText: { type: string, nullable: true }
 *         slides:
 *           type: array
 *           maxItems: 4
 *           description: Promociones en reposo (plan PRO — FEATURE_REQUIRES_PRO sin él).
 *           items:
 *             type: object
 *             properties:
 *               assetId: { type: string }
 *         slideSeconds: { type: integer }
 *         showPromotions: { type: boolean }
 *   responses:
 *     CustomerDisplayUnauthorized:
 *       description: Sin sesión válida.
 *     CustomerDisplayForbidden:
 *       description: Sin el permiso de la ruta, o sin acceso a este negocio.
 *     CustomerDisplayNotFound:
 *       description: >
 *         Dispositivo no encontrado. El MISMO 404 para uno que no existe, uno de otro negocio y uno que se mudó a otro
 *         negocio mientras se guardaba: distinguirlos confirmaría que el id existe en otra parte.
 *     CustomerDisplayNotSupported:
 *       description: CUSTOMER_DISPLAY_NOT_SUPPORTED — el dispositivo es de este negocio pero no tiene pantalla del cliente.
 *     CustomerDisplayConflict:
 *       description: >
 *         CUSTOMER_DISPLAY_CONFLICT — alguien más guardó el diseño (el `editToken` ya no es el vigente; en la copia,
 *         `details.source` o `details.conflicts` dicen cuál). CUSTOMER_DISPLAY_BUSY — otro cambio retiene el dispositivo
 *         (otra edición, o un traslado de la terminal, que por su lado contesta TERMINAL_BUSY); se puede reintentar
 *         con el mismo token.
 */

// ─── Router de UNA terminal: /venues/:venueId/terminals/:terminalId/customer-display ───
const router = Router({ mergeParams: true })

// El MISMO tope que revisa el servicio por dentro: un solo número, en el módulo puro de validación (hallazgo menor 3).
// 🔴 `+ 1` a propósito: busboy marca como truncado un archivo que LLEGA al límite (`fileSize === fileSizeLimit`), no sólo
// uno que lo pasa. Con el límite pelón, una imagen de exactamente 5 MB —que el servicio acepta— la cortaba la ruta. Medido
// con la prueba del límite en `customer-display.api.test.ts`.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ASSET_BYTES + 1, files: 1 } })
const leerArchivo = preserveContext(upload.single('file'))
/**
 * 🔴 CUALQUIER error al leer el archivo es un 422, no sólo los de multer (hallazgo menor 5). Un multipart ROTO —sin
 * `boundary`, o cortado a la mitad («Unexpected end of form»)— no es un `MulterError` sino un error de busboy, y caía al
 * manejador global como 500: una entrada mal formada del cliente contada como falla nuestra. Aquí no hay nada del servidor
 * que pueda fallar (el almacenamiento es en memoria), así que todo lo que salga de este paso es del archivo que mandaron.
 */
const subirActivo = (req: Request, res: Response, next: NextFunction) => {
  leerArchivo(req, res, (error?: unknown) => {
    if (!error) return next()
    const detalles = error instanceof multer.MulterError ? { multerCode: error.code } : undefined
    // M4: cuando NO es un `MulterError` (un multipart roto de busboy, por ejemplo) el 422 no lleva `multerCode` y el
    // error original se perdía por completo — nadie podía saber POR QUÉ falló esta subida en particular. Se registra
    // ANTES de responder; el cliente sigue viendo sólo el 422 genérico, nunca el error crudo.
    if (!detalles) {
      const err = error as { name?: unknown; message?: unknown }
      logger.warn('customerDisplay.routes: la subida falló al leer el archivo (CUSTOMER_DISPLAY_UPLOAD_INVALID)', {
        errorName: typeof err?.name === 'string' ? err.name : undefined,
        errorMessage: typeof err?.message === 'string' ? err.message : String(error),
      })
    }
    return next(new AppError('La imagen no se pudo leer', 422, true, 'CUSTOMER_DISPLAY_UPLOAD_INVALID', detalles))
  })
}

const permisoDeEscritura = checkPermission('customer-display:update')

/**
 * 🔴 Que quien sube TRABAJE en este negocio, ANTES de amarrar la terminal. Sin esto, amarrar primero (spec §5.4) le
 * daría a un extraño un oráculo: 404 si la terminal no está en ese negocio y 403 si sí. Quien no pertenece recibe
 * exactamente lo que contesta `checkPermission` en cualquier otra ruta —su 403 y su bitácora de cruce de negocio—, y
 * un SUPERADMIN pasa como en todas partes. El rol queda memorizado en el `req`: el permiso de más abajo no vuelve a
 * consultarlo.
 */
const exigirQueTrabajeEnElNegocio = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authContext = (req as any).authContext
    if (authContext?.userId) {
      const { role } = await resolveUserRoleForVenue({
        userId: authContext.userId,
        targetVenueId: req.params.venueId,
        tokenVenueId: authContext.venueId,
        tokenRole: authContext.role,
        req,
      })
      if (role) return next()
    }
    return permisoDeEscritura(req, res, next)
  } catch (error) {
    return next(error)
  }
}

/** Amarra la terminal al negocio de la URL: 404 ajena o inexistente, 422 sin pantalla del cliente. */
const amarrarTerminal = (req: Request, _res: Response, next: NextFunction) => {
  activos.authorizeAssetTerminal({ venueId: req.params.venueId, terminalId: req.params.terminalId }).then(() => next(), next)
}

/** Sólo para slides, el plan (403 FEATURE_REQUIRES_PRO). El `kind` pasa por la MISMA traducción que usa el controlador. */
const revisarPlan = (req: Request, _res: Response, next: NextFunction) => {
  let kind: activos.AssetKind
  try {
    kind = schemas.assetKindFromQuery(req.query.kind)
  } catch (error) {
    return next(error)
  }
  activos.authorizeAssetPlan({ venueId: req.params.venueId, kind }).then(() => next(), next)
}

// Rutas estáticas ANTES de las de raíz (Express empareja en orden).

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/terminals/{terminalId}/customer-display/preview:
 *   post:
 *     tags: [CustomerDisplay]
 *     summary: Vista previa de un borrador del diseño, sin guardar
 *     description: Devuelve la ficha que vería la tablet con ese borrador. Valida la propiedad de las imágenes.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CustomerDisplayVenueId'
 *       - $ref: '#/components/parameters/CustomerDisplayTerminalId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [design, previewSeq]
 *             properties:
 *               design: { $ref: '#/components/schemas/CustomerDisplayDesignDraft' }
 *               previewSeq:
 *                 type: integer
 *                 minimum: 0
 *                 description: Número de la petición; vuelve tal cual para descartar respuestas viejas.
 *     responses:
 *       200:
 *         description: "`{ data: { ficha, assetRejected, previewSeq } }`"
 *       400:
 *         description: Forma inválida o una imagen que no es de este negocio.
 *       401: { $ref: '#/components/responses/CustomerDisplayUnauthorized' }
 *       403:
 *         description: Sin `customer-display:read`, o FEATURE_REQUIRES_PRO (imágenes sin el plan).
 *       404: { $ref: '#/components/responses/CustomerDisplayNotFound' }
 *       422: { $ref: '#/components/responses/CustomerDisplayNotSupported' }
 */
router.post('/preview', checkPermission('customer-display:read'), validateRequest(schemas.previewCustomerDisplaySchema), controller.preview)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/terminals/{terminalId}/customer-display/copy:
 *   post:
 *     tags: [CustomerDisplay]
 *     summary: Copiar el diseño de este dispositivo a otros del mismo negocio (todo o nada)
 *     description: >
 *       Entre 1 y 20 destinos, cada uno con su `editToken`. Sin el plan PRO se copian marca, textos y logo; las
 *       imágenes y el interruptor de promociones de cada destino no se tocan, y la respuesta lo dice (`promosOmitted`).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CustomerDisplayVenueId'
 *       - $ref: '#/components/parameters/CustomerDisplayTerminalId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source, targets]
 *             properties:
 *               source:
 *                 type: object
 *                 description: Tiene que ser el dispositivo de la ruta (si no, 400 SOURCE_MISMATCH).
 *                 properties:
 *                   terminalId: { type: string }
 *                   editToken: { type: string }
 *               targets:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   properties:
 *                     terminalId: { type: string }
 *                     editToken: { type: string }
 *     responses:
 *       200:
 *         description: "`{ data: { copied: string[], promosOmitted: boolean } }`"
 *       400:
 *         description: Forma inválida, SOURCE_MISMATCH, destino repetido, el origen entre los destinos, o una imagen inválida para un destino (`details.terminalId`).
 *       401: { $ref: '#/components/responses/CustomerDisplayUnauthorized' }
 *       403: { $ref: '#/components/responses/CustomerDisplayForbidden' }
 *       404: { $ref: '#/components/responses/CustomerDisplayNotFound' }
 *       409: { $ref: '#/components/responses/CustomerDisplayConflict' }
 *       422: { $ref: '#/components/responses/CustomerDisplayNotSupported' }
 */
router.post('/copy', permisoDeEscritura, validateRequest(schemas.copyCustomerDisplaySchema), controller.copy)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/terminals/{terminalId}/customer-display/reset:
 *   post:
 *     tags: [CustomerDisplay]
 *     summary: Restablecer el diseño de fábrica
 *     description: Se puede siempre, con plan o sin él. No borra la fila; sube la revisión para que un token viejo no pase.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CustomerDisplayVenueId'
 *       - $ref: '#/components/parameters/CustomerDisplayTerminalId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [expectedEditToken]
 *             properties:
 *               expectedEditToken: { type: string }
 *     responses:
 *       200:
 *         description: "`{ data: { editToken, design, ficha } }`"
 *       400:
 *         description: Falta el token de edición.
 *       401: { $ref: '#/components/responses/CustomerDisplayUnauthorized' }
 *       403: { $ref: '#/components/responses/CustomerDisplayForbidden' }
 *       404: { $ref: '#/components/responses/CustomerDisplayNotFound' }
 *       409: { $ref: '#/components/responses/CustomerDisplayConflict' }
 *       422: { $ref: '#/components/responses/CustomerDisplayNotSupported' }
 */
router.post('/reset', permisoDeEscritura, validateRequest(schemas.resetCustomerDisplaySchema), controller.reset)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/terminals/{terminalId}/customer-display/assets:
 *   post:
 *     tags: [CustomerDisplay]
 *     summary: Subir una imagen (logo o promoción en reposo)
 *     description: >
 *       Todo se decide ANTES de leer el archivo (spec §5.4): pertenecer al negocio → amarrar la terminal (404/422) →
 *       permiso (403) → forma (400) → plan, sólo para `slide` (403 FEATURE_REQUIRES_PRO) → recién entonces se lee.
 *       PNG, JPG o WebP reconocidos por sus bytes, hasta 5 MB y de 400 a 4096 px por lado. El nombre original se descarta.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CustomerDisplayVenueId'
 *       - $ref: '#/components/parameters/CustomerDisplayTerminalId'
 *       - in: query
 *         name: kind
 *         required: true
 *         schema: { type: string, enum: [slide, logo] }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: "`{ data: { assetId, url, sha256, width, height } }`"
 *       400:
 *         description: "`kind` inválido, ASSET_MISSING, ASSET_NOT_AN_IMAGE, ASSET_BAD_DIMENSIONS o ASSET_TOO_LARGE."
 *       401: { $ref: '#/components/responses/CustomerDisplayUnauthorized' }
 *       403:
 *         description: Sin acceso a este negocio, sin `customer-display:update`, o FEATURE_REQUIRES_PRO (una slide sin el plan).
 *       404: { $ref: '#/components/responses/CustomerDisplayNotFound' }
 *       422:
 *         description: CUSTOMER_DISPLAY_NOT_SUPPORTED, o CUSTOMER_DISPLAY_UPLOAD_INVALID (el archivo no se pudo leer; p. ej., pasa de 5 MB).
 */
router.post(
  '/assets',
  exigirQueTrabajeEnElNegocio, // quien no trabaja aquí: 403, sin consultar la terminal
  amarrarTerminal, // 404 / 422 — R6: la terminal va ANTES del permiso (spec §5.4)
  permisoDeEscritura, // 403
  validateRequest(schemas.uploadAssetSchema), // 400 — `kind` sólo slide o logo
  revisarPlan, // 403 FEATURE_REQUIRES_PRO, sólo slides
  subirActivo, // 🔴 el ÚNICO paso que lee el archivo va AL FINAL
  controller.uploadAsset,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/terminals/{terminalId}/customer-display:
 *   get:
 *     tags: [CustomerDisplay]
 *     summary: El diseño de la pantalla del cliente de un dispositivo
 *     description: >
 *       El diseño y su `editToken`, la ficha efectiva, `entitlements`, `assetRejected` y el estado del aparato
 *       (presencia efectiva con la regla de 7 días, `designVersion`, ack, `capabilitiesObservedAt`, `lastHeartbeat`).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CustomerDisplayVenueId'
 *       - $ref: '#/components/parameters/CustomerDisplayTerminalId'
 *     responses:
 *       200:
 *         description: "`{ data: { terminal, editToken, design, ficha, entitlements, assetRejected, device } }`"
 *       401: { $ref: '#/components/responses/CustomerDisplayUnauthorized' }
 *       403: { $ref: '#/components/responses/CustomerDisplayForbidden' }
 *       404: { $ref: '#/components/responses/CustomerDisplayNotFound' }
 *       422: { $ref: '#/components/responses/CustomerDisplayNotSupported' }
 *   put:
 *     tags: [CustomerDisplay]
 *     summary: Guardar el diseño (CAS sobre el editToken)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CustomerDisplayVenueId'
 *       - $ref: '#/components/parameters/CustomerDisplayTerminalId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [expectedEditToken, design]
 *             properties:
 *               expectedEditToken:
 *                 type: string
 *                 description: El `editToken` que se leyó (`factory` si nunca se ha guardado).
 *               design: { $ref: '#/components/schemas/CustomerDisplayDesignDraft' }
 *     responses:
 *       200:
 *         description: "`{ data: { editToken, design, ficha, assetRejected } }`"
 *       400:
 *         description: Forma inválida, una llave desconocida en el borrador, un texto o color inválido, o una imagen que no es de este negocio.
 *       401: { $ref: '#/components/responses/CustomerDisplayUnauthorized' }
 *       403:
 *         description: Sin `customer-display:update`, o FEATURE_REQUIRES_PRO (prender imágenes o promociones sin el plan).
 *       404: { $ref: '#/components/responses/CustomerDisplayNotFound' }
 *       409: { $ref: '#/components/responses/CustomerDisplayConflict' }
 *       422: { $ref: '#/components/responses/CustomerDisplayNotSupported' }
 */
router.get('/', checkPermission('customer-display:read'), validateRequest(schemas.getCustomerDisplaySchema), controller.get)
router.put('/', permisoDeEscritura, validateRequest(schemas.putCustomerDisplaySchema), controller.put)

export default router

// ─── Router del NEGOCIO: /venues/:venueId/customer-display ───
export const customerDisplayDevicesRoutes = Router({ mergeParams: true })

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-display/devices:
 *   get:
 *     tags: [CustomerDisplay]
 *     summary: Los dispositivos del negocio con pantalla del cliente, paginados
 *     description: >
 *       Orden estable (nombre, id) y paginación por cursor. El servidor TOPA `take` en 50 (no lo rechaza) y devuelve
 *       `total` y `nextCursor` para llegar a todos. La presencia es la EFECTIVA (una vieja sale desconocida).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/CustomerDisplayVenueId'
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: El `nextCursor` de la página anterior. Uno que no sea de este negocio es 400 INVALID_CURSOR.
 *       - in: query
 *         name: take
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 25 }
 *         description: Cuántos por página; lo que pase de 50 se topa en 50.
 *     responses:
 *       200:
 *         description: >
 *           `{ data: { total, nextCursor, devices: [{ id, name, editToken, designVersion, presence, stale,
 *           capabilitiesObservedAt, lastHeartbeat }] } }`
 *       400:
 *         description: "`take` inválido o INVALID_CURSOR."
 *       401: { $ref: '#/components/responses/CustomerDisplayUnauthorized' }
 *       403: { $ref: '#/components/responses/CustomerDisplayForbidden' }
 */
customerDisplayDevicesRoutes.get(
  '/devices',
  checkPermission('customer-display:read'),
  validateRequest(schemas.listDevicesSchema),
  controller.listDevices,
)
