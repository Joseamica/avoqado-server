import { DiscountType } from '@prisma/client'
import { NextFunction, Request, Response } from 'express'
import { RegaloSinPermisoError } from '../errors/AppError'
import prisma from '../utils/prismaClient'
import { checkPermission } from './checkPermission.middleware'

/** D5: en línea el servidor valida el cupón y calcula el monto. En una venta de la cola se ignora: ahí `discount` sí es libre. */
const traeCuponEnLinea = (body: any): boolean => typeof body?.couponCode === 'string' && body.couponCode.trim() !== '' && body.isOfflineReplay !== true

/** Con id de catálogo o cupón, `discount` sólo repite ese importe; sin ellos, el servicio aplica el número positivo como rebaja manual. */
export const traeDescuentoManual = (body: any): boolean =>
  !body?.orderDiscountId && !traeCuponEnLinea(body) && typeof body?.discount === 'number' && body.discount > 0

/** Canjear un cupón en la venta pide lo mismo que validarlo en el POS. Sólo si lo trae: una venta sin cupón no paga nada extra. */
export const checkCuponPermissionIfPresent = (req: Request, res: Response, next: NextFunction) =>
  traeCuponEnLinea(req.body) ? checkPermission('coupons:redeem')(req, res, next) : next()

export const checkDescuentoManualPermissionIfPresent = (req: Request, res: Response, next: NextFunction) =>
  traeDescuentoManual(req.body) ? checkPermission('discounts:apply')(req, res, next) : next()

const cortesiasAutorizadas = new WeakMap<Request, { venueId: string; userId: string; porPin?: string }>()

/** Sólo acredita orders:comp comprobado por este middleware, en este request, negocio y sesión. */
export function tieneCortesiaAutorizada(req: Request): boolean {
  const autorizada = cortesiasAutorizadas.get(req)
  return !!autorizada && autorizada.venueId === req.params.venueId && autorizada.userId === req.authContext?.userId
}

/**
 * D1 (Codex r4 #3): la membresía del gerente cuyo PIN autorizó ESTA cortesía (`orders:comp`). `authContext.overrideAuthorizedBy`
 * es genérico: si el PIN se usó antes para otro permiso del mismo request (p. ej. `discounts:apply`), ese gerente no aprobó la
 * cortesía y no debe quedar como su autorizador.
 */
export function pinDeLaCortesia(req: Request): string | undefined {
  return tieneCortesiaAutorizada(req) ? cortesiasAutorizadas.get(req)?.porPin : undefined
}

/**
 * Candado que depende del BODY, no de la ruta: sólo corre si la venta regala algo. Eso es una línea `items[].isCortesia === true` o,
 * desde Codex servidor r1 #3, un descuento de CATÁLOGO tipo cortesía (`DiscountType.COMP`, regala la base completa) en
 * `orderDiscountId` o en el descuento de un renglón (`discountId` en mobile, `itemDiscountId` en `/tpv`): sin esto, un cajero regalaba
 * la cuenta entera con un descuento COMP sin marcar ningún renglón.
 *
 * Regalar un producto al crear la orden exige `orders:comp`, el mismo permiso que ya pide la cortesía en Mesas (el replay de la cola,
 * `requiredPermissionsForIntent`) y `POST /tpv/.../orders/:id/comp`. En las apps llega por `tpv-orders:comp` (`permissions.ts`), que de
 * fábrica traen MANAGER, ADMIN y OWNER; WAITER y CASHIER no. Decisión del founder, 20-oct-2026 («Cobrar sin red», S9): sin él, el
 * Cobrar de la terminal sería la puerta de atrás de la cortesía.
 *
 * Se monta en TODA puerta en línea que honra `isCortesia`: crear la orden en mobile y en `/tpv/with-items`, y agregar una ronda en
 * `POST /mobile/.../orders/:orderId/items` (si no, se regalaría en dos pasos). El PATCH de `/tpv/.../items` no lo necesita: su esquema
 * Zod quita el campo.
 *
 * Va DESPUÉS de `checkPermission('orders:create')` y, en la ruta de mobile, DESPUÉS de `avisarSiLaVentaDeLaColaFalla`: así el 403 de
 * una venta de la cola con cortesía también avisa al gerente. Pasa por `checkPermission`, o sea que el PIN de gerente
 * (`x-permission-override`) y el `overridable` del 403 funcionan igual que en cualquier otra acción.
 *
 * Sólo el `true` literal activa el candado (como `buildOrderItemsData`, que sólo honra `=== true`); cualquier otro valor lo rechaza el
 * controlador o el esquema. Una venta sin cortesía y sin descuento de catálogo no paga ninguna consulta extra; con descuentos, UNA
 * (sus ids, de este negocio, tipo COMP). Un id ajeno o inexistente no activa el candado: lo rechaza el servicio, como hoy.
 */
export const checkCortesiaPermissionIfPresent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    cortesiasAutorizadas.delete(req)
    const items: any[] = Array.isArray(req.body?.items) ? req.body.items : []
    if (items.some(item => item?.isCortesia === true) || (await traeDescuentoDeCortesia(req.params.venueId, req.body, items))) {
      return exigirCortesia(req, res, next)
    }
    return next()
  } catch (error) {
    return next(error)
  }
}

/**
 * D1 (hz:f34960c5:D1): aplicar un descuento SUELTO a una cuenta abierta que regala — uno del catálogo tipo COMP (`discountId`) o
 * uno manual `type: COMP` — pide `orders:comp`, como la cortesía y el cupón de cortesía (D14). Se monta en
 * `POST /tpv/.../discounts/apply`, `POST /tpv/.../discounts/manual` y `POST /mobile/.../orders/:orderId/discounts`. El servicio
 * vuelve a mirar el tipo bajo el candado de la orden y falla cerrado sin la acreditación (`tieneCortesiaAutorizada`).
 */
export const checkCortesiaEnDescuento = async (req: Request, res: Response, next: NextFunction) => {
  try {
    cortesiasAutorizadas.delete(req)
    const regala =
      req.body?.type === DiscountType.COMP ||
      (await traeDescuentoDeCortesia(req.params.venueId, { orderDiscountId: req.body?.discountId }, []))
    return regala ? exigirCortesia(req, res, next) : next()
  } catch (error) {
    return next(error)
  }
}

/** Pasa por `checkPermission('orders:comp')` (PIN de gerente y `overridable` incluidos) y, si pasa, acredita ESTE request. */
function exigirCortesia(req: Request, res: Response, next: NextFunction) {
  const venueId = req.params.venueId
  const userId = req.authContext?.userId
  const pinAntes = (req as any).authContext?.overrideAuthorizedBy as string | undefined
  return checkPermission('orders:comp')(req, res, error => {
    if (error) return next(error)
    // Sólo cuenta el PIN que consumió ESTE check (el token es de un solo uso: si cambió el autorizador, fue por `orders:comp`).
    const pinDespues = (req as any).authContext?.overrideAuthorizedBy as string | undefined
    const porPin = pinDespues && pinDespues !== pinAntes ? pinDespues : undefined
    if (venueId && userId) cortesiasAutorizadas.set(req, { venueId, userId, ...(porPin ? { porPin } : {}) })
    next()
  })
}

async function traeDescuentoDeCortesia(venueId: string | undefined, body: any, items: any[]): Promise<boolean> {
  const ids = [
    ...new Set(
      [body?.orderDiscountId, ...items.flatMap(item => [item?.discountId, item?.itemDiscountId])].filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64,
      ),
    ),
  ]
  if (!venueId || ids.length === 0) return false
  const comp = await prisma.discount.findFirst({ where: { id: { in: ids }, venueId, type: DiscountType.COMP }, select: { id: true } })
  return comp !== null
}

/** Lo que el controlador le pasa al servicio cuando quien aplica puede regalar: `porPin` = el gerente cuyo PIN lo autorizó. */
export type Cortesia = { porPin?: string }

/**
 * hz:e0b12f00:D1 (founder, 6-nov): un descuento manual que deja en $0 lo que queda de los productos es una cortesía. Sólo el
 * servicio lo sabe (con SU importe, bajo su candado y después de la búsqueda idempotente: Codex r1 #1 y #5), así que la primera
 * vuelta va con la acreditación que ya traiga el request. Si el servicio lanza `RegaloSinPermisoError`, se pide `orders:comp`
 * como en la ruta: `checkPermission` consume el `X-Permission-Override` o contesta el 403 canónico con `overridable`. Si pasa, la
 * operación se ejecuta OTRA VEZ entera con la acreditación (la primera vuelta ya se revirtió). Devuelve `undefined` si ya se
 * respondió el 403.
 */
export async function conCortesiaSiRegala<T>(
  req: Request,
  res: Response,
  operacion: (cortesia: Cortesia | undefined) => Promise<T>,
): Promise<T | undefined> {
  const yaAcreditada = tieneCortesiaAutorizada(req) ? { porPin: pinDeLaCortesia(req) } : undefined
  try {
    return await operacion(yaAcreditada)
  } catch (error) {
    if (!(error instanceof RegaloSinPermisoError) || yaAcreditada) throw error
  }
  let paso = false
  let fallo: unknown
  await exigirCortesia(req, res, (error?: unknown) => {
    if (error) fallo = error
    else paso = true
  })
  if (fallo) throw fallo
  if (!paso || !tieneCortesiaAutorizada(req)) return undefined
  return operacion({ porPin: pinDeLaCortesia(req) })
}
