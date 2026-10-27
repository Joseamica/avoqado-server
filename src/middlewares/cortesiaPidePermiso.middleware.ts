import { DiscountType } from '@prisma/client'
import { NextFunction, Request, Response } from 'express'
import prisma from '../utils/prismaClient'
import { checkPermission } from './checkPermission.middleware'

const cortesiasAutorizadas = new WeakMap<Request, { venueId: string; userId: string }>()

/** Sólo acredita orders:comp comprobado por este middleware, en este request, negocio y sesión. */
export function tieneCortesiaAutorizada(req: Request): boolean {
  const autorizada = cortesiasAutorizadas.get(req)
  return !!autorizada && autorizada.venueId === req.params.venueId && autorizada.userId === req.authContext?.userId
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
      const venueId = req.params.venueId
      const userId = req.authContext?.userId
      return checkPermission('orders:comp')(req, res, error => {
        if (error) return next(error)
        if (venueId && userId) cortesiasAutorizadas.set(req, { venueId, userId })
        next()
      })
    }
    return next()
  } catch (error) {
    return next(error)
  }
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
