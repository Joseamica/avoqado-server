import { NextFunction, Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import * as menuCategoryService from '../../services/dashboard/menu.dashboard.service'
import { buildProductsListResponse, opcionesDelListadoDeProductos } from '../dashboard/product.dashboard.controller'
import { catalogoMovilCacheado, guardarCatalogoMovil, versionDelCatalogoMovil } from '../../services/mobile/catalogoMovil.cache'

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
 * Mismo sobre que el del controller de dashboard — `{ message, data, correlationId }`, el shape que el
 * cliente ya parsea con éxito hoy (`ProductsResponse` / `ProductDto` en avoqado-tpv, ProductDto.kt) —
 * más `catalogAt` en la RAÍZ (Cobrar sin red, S1): la hora del SERVIDOR, tomada ANTES de leer los
 * productos, de la que parte la terminal para reconocer el precio que vio el cliente al vender sin red
 * (si se tomara después, un cambio de precio ocurrido durante la lectura quedaría "antes" del catálogo
 * que la terminal ya trae). Aditivo: `data` queda igual para las versiones viejas, y la respuesta del
 * panel NO cambia (comparten `buildProductsListResponse`, no el handler). Cada producto ya trae `gtin`.
 *
 * D20 (10-nov): armarlo retenía el hilo único 206–699 ms (Better Stack, 8 al 10-nov) y la TPV lo pide aunque no haya
 * cambiado. Igual que el POS (D6): si la versión del catálogo no cambió, se reutiliza el `data` ya armado para esa misma
 * query. La versión se lee ANTES que los productos (un cambio a media lectura queda guardado bajo la versión vieja y la
 * siguiente bajada rearma). `correlationId` y `catalogAt` son de cada petición: nunca se guardan. El panel no tiene caché.
 */
export const getProducts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const catalogAt = new Date().toISOString()
    const { venueId } = req.params
    // Nunca choca con la llave del POS (el venueId suelto).
    const llave = JSON.stringify(['tpv', venueId, opcionesDelListadoDeProductos(req)])
    const version = await versionDelCatalogoMovil(venueId)
    const replacer = req.app?.get('json replacer')
    let dataJson = version ? catalogoMovilCacheado(llave, version) : undefined
    if (dataJson === undefined) {
      const body = await buildProductsListResponse(req)
      if (!version) {
        res.status(200).json({ ...body, catalogAt })
        return
      }
      dataJson = JSON.stringify(body.data, replacer)
      guardarCatalogoMovil(llave, version, dataJson)
    }
    // Lo mismo que escribiría `res.json({ message, data, correlationId, catalogAt })`, sin volver a convertir `data`
    // (el replacer de la app va por llave: da lo mismo aplicarlo por partes). Sin correlationId, la llave no sale.
    const cola = JSON.stringify({ correlationId: (req as any).correlationId, catalogAt }, replacer)
    res
      .status(200)
      .type('json')
      .send(`{"message":${JSON.stringify(`Products for venue ${venueId}`)},"data":${dataJson},${cola.slice(1)}`)
  } catch (error) {
    next(error)
  }
}

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
