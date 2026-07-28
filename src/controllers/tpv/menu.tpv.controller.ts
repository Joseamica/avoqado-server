import { NextFunction, Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import * as menuCategoryService from '../../services/dashboard/menu.dashboard.service'

/**
 * Menú, productos y categorías bajo `/tpv` (Plan B Task 5, 2026-07-27).
 *
 * La TPV llamaba `dashboard/venues/{venueId}/products` y `dashboard/venues/{venueId}/categories`
 * directamente (`ApiService.kt:505,555` en avoqado-tpv) — el módulo Mesas hereda esas dos
 * llamadas fuera de `/tpv` si no se cierran aquí. Ver task-5-brief.md para el hallazgo completo.
 */

/**
 * GET /tpv/venues/:venueId/products
 *
 * Re-export VERBATIM del controller de dashboard: hay un shape PREVIO que el cliente ya
 * parsea con éxito hoy (`ProductsResponse` / `ProductDto` en avoqado-tpv, ProductDto.kt) desde
 * `dashboard/venues/{venueId}/products` — `{ message, data, correlationId }`. Re-exportar (en vez
 * de reimplementar) garantiza paridad byte-a-byte para siempre y evita duplicar la query de
 * `productService.getProducts` (mismo patrón que `syncIntents` en sync.tpv.controller.ts). El
 * cliente solo cambia el prefijo de la URL, no sus parsers.
 */
export { getProductsHandler as getProducts } from '../dashboard/product.dashboard.controller'

/**
 * GET /tpv/venues/:venueId/categories
 *
 * `dashboard/venues/{venueId}/categories` — la ruta que la TPV llama hoy — NO EXISTE (verificado
 * exhaustivamente, ver task-5-brief.md): 404ea en silencio dentro de un `.fold(...)` en
 * `CheckoutViewModel.kt` / `HomeViewModel.kt`. No hay shape previo que preservar.
 *
 * El Retrofit `@GET` del cliente (`ApiService.kt`) declara `Response<List<CategoryDto>>` —
 * un ARRAY plano, NO el sobre `{ success, data }` que usa `/mobile`. Por eso este handler no
 * puede re-exportar `/mobile`'s `listCategories` tal cual (además de que esa ruta está congelada
 * y no tiene un service separado que importar — la query vive inline en
 * `category.mobile.controller.ts:42-45`). Se replica esa MISMA query (mismo `where`, mismo
 * `orderBy`) y se reacomoda el sobre de respuesta a lo que el cliente ya espera parsear
 * (`CategoryDto`: id, name, venueId, displayOrder, color, active — ProductDto.kt:128).
 */
export async function getCategories(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    const categories = await prisma.menuCategory.findMany({
      where: { venueId, active: true },
      orderBy: { displayOrder: 'asc' },
    })

    res.status(200).json(categories)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /tpv/venues/:venueId/menus
 *
 * Sin llamada previa en la TPV (no aparece en ApiService.kt hoy) — es net-new, para que el
 * módulo Mesas no tenga que inventar otro shape más adelante. Delega en el MISMO servicio que
 * usa `dashboard/venues/{venueId}/menus` (`menuCategoryService.getMenus`) y replica su shape
 * exacto (array plano, sin sobre) para que un futuro cliente solo cambie el prefijo.
 *
 * A propósito NO se re-exporta `getMenusHandler` del controller de dashboard: ese controller
 * hace un `checkVenueAccess(orgId, venueId, role)` adicional (¿el venue pertenece a MI org?)
 * pensado para un token de dashboard que navega entre varios venues. `validateVenueAccess`
 * (Task 1) ya aplica un check MÁS estricto para la TPV (igualdad exacta contra
 * `authContext.venueId`, no "cualquier venue de mi org") — repetir el check de dashboard aquí
 * solo agregaría una consulta redundante.
 */
export async function getMenus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    const menus = await menuCategoryService.getMenus(venueId)

    res.status(200).json(menus)
  } catch (error) {
    next(error)
  }
}
