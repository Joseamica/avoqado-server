/**
 * Loyalty Program Controller (Thin HTTP Layer)
 *
 * WHY: Orchestrate HTTP requests/responses without business logic.
 *
 * PATTERN: Thin Controller Architecture
 * - Extract data from req (params, query, body)
 * - Call service method (business logic lives there)
 * - Return HTTP response
 * - NO business logic here (calculations, validations, database queries)
 *
 * RESPONSIBILITIES:
 * ✅ Extract request data
 * ✅ Call service functions
 * ✅ Return HTTP responses
 * ❌ Business logic (belongs in service)
 * ❌ Database queries (belongs in service)
 */

import { Request, Response } from 'express'
import * as loyaltyService from '@/services/dashboard/loyalty.dashboard.service'
import * as cardDesignService from '@/services/wallet/cardDesign.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { redeemStampReward } from '@/services/wallet/redeemStampReward.service'
import { getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { fetchDecodedPng, readPngSize } from '@/services/wallet/remotePng'
import { stampStripPng } from '@/services/wallet/stampStripPng'
import { buildStoragePath, uploadFileToStorage } from '@/services/storage.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

/**
 * Resolve the caller's StaffVenue.id from their Staff.id (authContext.userId) + venue.
 * LoyaltyTransaction.createdById FKs to StaffVenue.id (not Staff.id) — `authContext` has no
 * `staffVenueId` field (see security.ts's AuthContext), so reading it directly always yields
 * `undefined`. Mirrors creditPack.dashboard.controller.ts's getStaffVenueId.
 */
async function getStaffVenueId(venueId: string, userId: string): Promise<string> {
  const prisma = (await import('../../utils/prismaClient')).default
  const sv = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId: userId, venueId } },
    select: { id: true },
  })
  if (!sv) throw new Error('Staff no encontrado en este venue')
  return sv.id
}

/**
 * GET /api/dashboard/venues/:venueId/loyalty/config
 * Get loyalty configuration for venue
 */
export async function getLoyaltyConfig(req: Request, res: Response) {
  const { venueId } = req.params

  const result = await loyaltyService.getLoyaltyConfig(venueId)

  return res.status(200).json(result)
}

/**
 * PUT /api/dashboard/venues/:venueId/loyalty/config
 * Update loyalty configuration
 */
export async function updateLoyaltyConfig(req: Request, res: Response) {
  const { venueId } = req.params
  const data = req.body

  const result = await loyaltyService.updateLoyaltyConfig(venueId, data)

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/loyalty/calculate-points
 * Calculate points for a purchase amount
 */
export async function calculatePoints(req: Request, res: Response) {
  const { venueId } = req.params
  const { amount } = req.body

  const points = await loyaltyService.calculatePointsForAmount(venueId, amount)

  return res.status(200).json({ amount, points })
}

/**
 * POST /api/dashboard/venues/:venueId/loyalty/calculate-discount
 * Calculate discount value from points
 */
export async function calculateDiscount(req: Request, res: Response) {
  const { venueId } = req.params
  const { points, orderTotal } = req.body

  const discount = await loyaltyService.calculateDiscountFromPoints(venueId, points, orderTotal)

  return res.status(200).json({ points, orderTotal, discount })
}

/**
 * GET /api/dashboard/venues/:venueId/customers/:customerId/loyalty/balance
 * Get customer's loyalty points balance
 */
export async function getPointsBalance(req: Request, res: Response) {
  const { venueId, customerId } = req.params

  const balance = await loyaltyService.getCustomerPointsBalance(venueId, customerId)

  return res.status(200).json({ customerId, balance })
}

/**
 * POST /api/dashboard/venues/:venueId/customers/:customerId/loyalty/redeem
 * Redeem points for discount
 */
export async function redeemPoints(req: Request, res: Response) {
  const { venueId, customerId } = req.params
  const { points, orderId } = req.body
  const authContext = (req as any).authContext

  // 🔴 Se pasa el Staff.id CRUDO, no el StaffVenue.id. El canje real vive en
  // `redeemPointsToOrder` y resuelve la fila de StaffVenue por su cuenta;
  // traducirlo aquí — como sí hacen adjustPoints y sus vecinos, que llaman
  // servicios que esperan un StaffVenue.id — le entrega un id que nunca va a
  // encontrar en `staffId_venueId`, y la atribución del canje se pierde SIN error.
  const result = await loyaltyService.redeemPoints(venueId, customerId, points, orderId, authContext?.userId)

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/customers/:customerId/loyalty/adjust
 * Manual point adjustment by staff
 */
export async function adjustPoints(req: Request, res: Response) {
  const { venueId, customerId } = req.params
  const { points, reason } = req.body
  const authContext = (req as any).authContext

  if (!authContext?.userId) {
    return res.status(403).json({ error: 'Staff authentication required for point adjustments' })
  }

  const staffId = await getStaffVenueId(venueId, authContext.userId)

  const result = await loyaltyService.adjustPoints(venueId, customerId, points, reason, staffId)

  return res.status(200).json(result)
}

/**
 * GET /api/dashboard/venues/:venueId/customers/:customerId/loyalty/transactions
 * Get loyalty transaction history for customer
 */
export async function getLoyaltyTransactions(req: Request, res: Response) {
  const { venueId, customerId } = req.params
  const { page, pageSize, type } = req.query

  const result = await loyaltyService.getLoyaltyTransactions(venueId, customerId, {
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
    type: type as any,
  })

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/loyalty/expire-old-points
 * Expire old loyalty points (admin/cron job endpoint)
 */
export async function expireOldPoints(req: Request, res: Response) {
  const { venueId } = req.params

  const result = await loyaltyService.expireOldPoints(venueId)

  return res.status(200).json(result)
}

// ==========================================
// DISEÑO DE LA CREDENCIAL (Apple/Google Wallet)
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/loyalty/card-design
 *
 * Siempre responde 200 con un diseño usable: un negocio que nunca configuró nada
 * recibe los defaults del tema, no un 404. La pantalla de edición necesita valores
 * con los que pintar la vista previa desde el primer momento.
 */
export async function getCardDesignHandler(req: Request, res: Response) {
  const { venueId } = req.params
  const design = await cardDesignService.getCardDesign(venueId)
  return res.status(200).json(design)
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/loyalty/card-design
 *
 * Parcial a propósito: sólo escribe las claves que llegaron. Un PUT que exigiera el
 * objeto completo borraría el logo cada vez que alguien cambia un color desde una
 * pantalla que no cargó ese campo.
 */
export async function updateCardDesignHandler(req: Request, res: Response) {
  const { venueId } = req.params
  const { userId } = (req as any).authContext

  const anterior = await cardDesignService.getCardDesign(venueId)
  const design = await cardDesignService.saveCardDesign(venueId, req.body)

  // 🔴 Se registra QUÉ cambió, no un volcado de los dos objetos completos. Quien
  // abra la bitácora porque "la tarjeta amaneció de otro color" quiere leer
  // `backgroundColor: #1C1C1E → #FF0000`, no dos bloques de doce campos idénticos
  // entre los que tiene que encontrar la diferencia a ojo.
  const cambios: Record<string, string> = {}
  for (const campo of Object.keys(design) as (keyof typeof design)[]) {
    const antes = anterior[campo] ?? null
    const despues = design[campo] ?? null
    if (antes !== despues) cambios[campo] = `${antes ?? '—'} → ${despues ?? '—'}`
  }

  // El diseño es lo que ve TODO cliente del negocio en su teléfono. Fire-and-forget
  // y fuera de cualquier transacción: un fallo de auditoría no puede tumbar el
  // guardado. Un cambio sin diferencias igual se registra — que alguien haya tocado
  // la pantalla y guardado sin cambiar nada también es información.
  void logAction({
    action: 'WALLET_CARD_DESIGN_UPDATED',
    entity: 'WalletCardDesign',
    entityId: venueId,
    staffId: userId,
    venueId,
    data: cambios,
  })

  return res.status(200).json(design)
}

/**
 * POST /api/v1/dashboard/venues/:venueId/loyalty/card-design/image
 *
 * Sube el logo o el icono de la credencial. Campo del formulario: `image`.
 * Query o cuerpo: `kind` = "logo" | "icon".
 *
 * 🔴 Valida el archivo AQUÍ, no al emitir el pase. Apple sólo acepta PNG dentro de
 * un pase y rechaza el resto EN SILENCIO: sin esta puerta, alguien sube un JPG
 * renombrado, ve "listo" en su pantalla, y el defecto aparece semanas después
 * cuando un cliente no puede abrir su tarjeta — sin nada que lo relacione con
 * aquella subida.
 */
export async function uploadCardImageHandler(req: Request, res: Response) {
  const { venueId } = req.params
  const kind = String(req.query.kind ?? req.body?.kind ?? '').toLowerCase()
  const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined

  if (!file) throw new BadRequestError('No llegó ningún archivo. Manda la imagen en el campo "image".')
  if (kind !== 'logo' && kind !== 'icon' && kind !== 'stamp') {
    throw new BadRequestError('Falta indicar qué imagen es: "logo", "icon" o "stamp".')
  }

  // 🔴 Por los BYTES, no por la extensión ni por el tipo que declaró el navegador:
  // los dos se pueden renombrar, el encabezado del archivo no.
  const size = readPngSize(file.buffer)
  if (!size) {
    throw new BadRequestError(
      'El archivo no es un PNG. Apple sólo acepta PNG dentro de una tarjeta — si tienes un JPG, expórtalo como PNG y vuelve a intentar.',
    )
  }

  // Mínimos por debajo de los cuales la imagen se ve borrosa en cualquier pantalla
  // moderna. Se rechaza sólo lo inservible; lo demás se acepta y se comenta.
  const avisos: string[] = []
  if (kind === 'logo') {
    if (size.width < 160)
      throw new BadRequestError(`El logo es muy chico (${size.width}px de ancho). Necesita al menos 160px, idealmente 480×150.`)
    const proporcion = size.width / size.height
    if (proporcion < 1.5)
      avisos.push('Tu logo es casi cuadrado. En la tarjeta se verá pequeño porque el espacio es alargado; uno horizontal luce mejor.')
    if (size.width < 480)
      avisos.push(`Para que se vea nítido en pantallas Retina conviene subirlo a 480×150. El tuyo mide ${size.width}×${size.height}.`)
  } else if (kind === 'icon') {
    if (size.width < 116 || size.height < 116) {
      throw new BadRequestError(`El icono es muy chico (${size.width}×${size.height}). Necesita al menos 116×116, idealmente 512×512.`)
    }
    const desviacion = Math.abs(size.width - size.height) / Math.max(size.width, size.height)
    if (desviacion > 0.1) avisos.push(`El icono debe ser cuadrado. El tuyo mide ${size.width}×${size.height} y se verá deformado.`)
  } else {
    // El sello se dibuja a unos 60 píxeles: 96 es el mínimo con el que aún se ve
    // limpio en una pantalla Retina.
    if (size.width < 96 || size.height < 96) {
      throw new BadRequestError(`El sello es muy chico (${size.width}×${size.height}). Necesita al menos 96×96, idealmente 256×256.`)
    }
    const desviacion = Math.abs(size.width - size.height) / Math.max(size.width, size.height)
    if (desviacion > 0.25) {
      avisos.push(
        `Tu sello es bastante alargado (${size.width}×${size.height}). En la fila se verá más chico que uno cuadrado, porque tiene que caber completo.`,
      )
    }
    // 🔴 El aviso que de verdad evita una tarjeta fea: un sello sin transparencia
    // sale como un cuadro de color macizo sobre la banda.
    avisos.push('Si tu sello tiene fondo transparente se verá mucho mejor: un PNG con fondo blanco sale como un cuadro sobre la banda.')
  }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { slug: true } })
  if (!venue) throw new NotFoundError('Negocio no encontrado')

  // Nombre estable por tipo: subir un logo nuevo REEMPLAZA al anterior en vez de
  // dejar basura acumulándose en el almacenamiento con cada intento de diseño.
  const path = buildStoragePath(`venues/${venue.slug}/wallet/${kind}.png`)
  const subida = await uploadFileToStorage(file.buffer, path, 'image/png')

  // 🔴 Con VERSIÓN en la dirección. El archivo se reemplaza (nombre estable, sin
  // basura acumulada), pero sin esto la dirección quedaba idéntica y el navegador
  // seguía sirviendo la imagen anterior de su caché: el negocio subía la correcta,
  // veía la equivocada, y concluía que la pantalla estaba rota. Bug reportado por el
  // founder usando la pantalla (27-ago).
  const url = cardDesignService.versionedStorageUrl(subida)

  const campo = kind === 'logo' ? 'logoUrl' : kind === 'icon' ? 'iconUrl' : 'stampImageUrl'
  const design = await cardDesignService.saveCardDesign(venueId, { [campo]: url })

  void logAction({
    action: 'WALLET_CARD_IMAGE_UPLOADED',
    entity: 'WalletCardDesign',
    entityId: venueId,
    staffId: (req as any).authContext.userId,
    venueId,
    data: { kind, width: size.width, height: size.height },
  })

  return res.status(200).json({ url, design, avisos, dimensiones: size })
}

/**
 * GET /api/v1/dashboard/venues/:venueId/loyalty/card-design/strip.png
 *
 * La banda de sellos como imagen, con los colores que se le pasen por query.
 *
 * 🔴 Existe para que la vista previa del dashboard use EXACTAMENTE el mismo
 * generador que produce el pase, en vez de reimplementar los iconos y el cálculo de
 * contraste en el navegador. Dos implementaciones del mismo dibujo divergen — es
 * cuestión de tiempo — y una vista previa que diverge es peor que no tenerla: el
 * negocio guarda convencido de haber visto el resultado.
 *
 * Acepta los colores por query (no lee la fila) para poder pintar el borrador que el
 * usuario está tocando, antes de guardarlo.
 */
export async function cardStripPreviewHandler(req: Request, res: Response) {
  const { venueId } = req.params
  const q = req.query as Record<string, string | undefined>

  const guardado = await cardDesignService.getCardDesign(venueId)
  // La vista previa usa el sello guardado: una imagen se sube antes de poder verse,
  // así que no hay borrador que pintar como con los colores.
  const selloPropio = await fetchDecodedPng(guardado.stampImageUrl)
  const hexOrNull = (v: string | undefined) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null)

  const png = stampStripPng({
    // Tamaño @2x, el mismo que va dentro del pase.
    width: 750,
    height: 246,
    earned: Math.max(0, Math.min(30, Number(q.earned) || 0)),
    required: Math.max(1, Math.min(30, Number(q.required) || 10)),
    bgHex: hexOrNull(q.strip) ?? guardado.stripColor,
    filledHex: hexOrNull(q.filled) ?? guardado.stampFilledColor,
    emptyHex: hexOrNull(q.empty) ?? guardado.stampEmptyColor,
    shape: (q.shape as any) ?? guardado.stampShape,
    stampImage: selloPropio,
  })

  // Sin caché: la vista previa cambia con cada ajuste y una respuesta guardada
  // mostraría el color anterior, que es justo lo que confunde.
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Cache-Control', 'no-store')
  res.send(png)
}

/**
 * POST /api/v1/dashboard/venues/:venueId/loyalty/stamp-rewards/:rewardId/redeem
 *
 * Canjea el premio de una cartilla llena sobre una cuenta abierta.
 *
 * 🔴 DINERO: baja lo que el cliente paga. El servicio protege contra el doble canje
 * con un cambio de estado condicional; este controlador sólo traduce HTTP.
 */
export async function redeemStampRewardHandler(req: Request, res: Response) {
  const { venueId, rewardId } = req.params
  const { orderId } = req.body
  const { userId } = (req as any).authContext

  const result = await redeemStampReward(venueId, orderId, rewardId, { staffId: userId })

  return res.status(200).json(result)
}

/**
 * GET /api/v1/dashboard/venues/:venueId/loyalty/customers/:customerId/stamp-card
 *
 * El avance de un cliente y los premios que ya ganó pero no ha cobrado.
 *
 * Siempre responde 200: un cliente sin cartilla recibe ceros, no un 404. La pantalla
 * lo usa para decidir si enseñar el botón de canje, y un error ahí escondería la
 * sección entera en vez de mostrarla vacía.
 */
export async function getStampCardHandler(req: Request, res: Response) {
  const { venueId, customerId } = req.params

  const [estado, pendientes] = await Promise.all([
    getStampCardStatus(venueId, customerId),
    prisma.stampReward.findMany({
      where: { venueId, customerId, status: 'PENDING' },
      select: { id: true, rewardLabel: true, rewardType: true, rewardValue: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  return res.status(200).json({ ...estado, rewardsToClaim: pendientes })
}
