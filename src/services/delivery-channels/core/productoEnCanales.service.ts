/**
 * Poner o quitar UN producto en varios canales de delivery (D1, 16-nov-2026): la casilla «Vender en: ☑ Rappi ☐ Uber Eats»
 * del producto y el MCP. Idempotente.
 *
 * Cada canal se cambia con su fila BLOQUEADA (en orden de id, así dos peticiones nunca se bloquean en cruz): leer-cambiar-
 * escribir sin candado perdía el cambio de quien guardara al mismo tiempo desde la pantalla del canal.
 *  · `true`: sin lista (todo el catálogo) ya está dentro; con lista, se agrega si falta y sale de `productosRevisados`.
 *  · `false`: con lista, se quita (nunca la deja vacía) y entra a `productosRevisados`; sin lista, la vuelve explícita: todos
 *    los productos no archivados del negocio (activos o apagados) menos éste. Así se puede «quitar uno» sin publicar de más.
 *  · La lista vieja por código se convierte a ids antes (los códigos que no son de ningún producto se quedan fuera, sin error,
 *    y la bitácora los nombra), y de una lista por id se quitan los ids que ya no son de ningún producto (igual, sin error).
 *    La conversión, la copia por código y los precios los hace `normalizarSeleccion`.
 */
import { DeliveryProvider, Prisma } from '@prisma/client'

import { NotFoundError, ValidationError } from '../../../errors/AppError'
import prisma from '../../../utils/prismaClient'
import { logAction } from '../../dashboard/activity-log.service'
import { deliveryTenderLabel } from './deliveryTenderProvisioning.service'
import { configComoObjeto } from './llavesDelSistema'
import { idsDelCanal, MAX_PRODUCTOS, productosDelCanal } from './productosDelCanal'
import { normalizarSeleccion, sumarRevisados } from './seleccionDelCanal.service'

const LISTA_VACIA = 'Un canal necesita al menos un producto; pausa el canal si no quieres vender ahí'

/** Lee la lista guardada; si está dañada, un error en español que nombra el canal (nunca se lee como «todo el catálogo»). */
function leerLista<T>(leer: () => T, provider: DeliveryProvider): T {
  try {
    return leer()
  } catch (e) {
    throw new ValidationError(
      `La lista de productos del canal ${deliveryTenderLabel(provider)} está dañada (${(e as Error).message}): ábrela en Delivery y vuelve a guardarla`,
    )
  }
}

export async function ponerProductoEnCanales(
  venueId: string,
  productId: string,
  canales: Record<string, boolean>,
  performedBy?: string,
): Promise<Array<{ linkId: string; dentro: boolean }>> {
  const ids = Object.keys(canales).sort()
  if (ids.length === 0) throw new ValidationError('Elige al menos un canal')

  const { resultado, codigosDescartados, idsDescartados } = await prisma.$transaction(async tx => {
    const producto = await tx.product.findFirst({ where: { id: productId, venueId }, select: { deletedAt: true } })
    if (!producto) throw new NotFoundError('Producto no encontrado')
    if (producto.deletedAt) throw new ValidationError('Este producto está archivado; restáuralo para elegir en qué canales se vende')

    const filas = await tx.$queryRaw<Array<{ id: string; provider: DeliveryProvider; config: Prisma.JsonValue }>>`
      SELECT "id", "provider", "config" FROM "DeliveryChannelLink"
      WHERE "venueId" = ${venueId} AND "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`
    if (filas.length < ids.length) throw new NotFoundError('Canal de delivery no encontrado')

    // Todo el catálogo no archivado, una sola vez por petición (sólo si un canal sin lista se desmarca).
    let catalogo: string[] | undefined
    const todoElCatalogo = async () => {
      if (!catalogo) {
        const ps = await tx.product.findMany({ where: { venueId, deletedAt: null }, select: { id: true }, take: MAX_PRODUCTOS + 1 })
        if (ps.length > MAX_PRODUCTOS) {
          const tope = MAX_PRODUCTOS.toLocaleString('es-MX')
          throw new ValidationError(
            `Tu negocio tiene más de ${tope} productos y un canal admite hasta ${tope}: elige cuáles vender desde la pantalla del canal`,
          )
        }
        catalogo = ps.map(p => p.id)
      }
      return catalogo
    }

    const resultado: Array<{ linkId: string; dentro: boolean }> = []
    const codigosDescartados: Record<string, string[]> = {}
    const idsDescartados: Record<string, string[]> = {}
    for (const fila of filas) {
      const dentro = canales[fila.id]
      resultado.push({ linkId: fila.id, dentro })
      const config = configComoObjeto(fila.config)

      let lista = leerLista(() => idsDelCanal(config), fila.provider)
      const viejos = lista === null ? leerLista(() => productosDelCanal(config), fila.provider) : null
      if (viejos) {
        const codigos = [...viejos]
        const deAlguien = await tx.product.findMany({
          where: { venueId, sku: { in: codigos } },
          select: { id: true, sku: true },
          take: codigos.length,
        })
        const idDe = new Map(deAlguien.map(p => [p.sku, p.id] as const))
        lista = [...new Set(codigos.flatMap(c => (idDe.has(c) ? [idDe.get(c)!] : [])))]
        const sinDueno = codigos.filter(c => !idDe.has(c))
        if (sinDueno.length) codigosDescartados[fila.id] = sinDueno
      }

      if (dentro && lista === null) continue // todo el catálogo: ya está dentro

      let final = lista as string[]
      if (dentro && !final.includes(productId)) final = [...final, productId]
      if (!dentro) final = (lista ?? (await todoElCatalogo())).filter(id => id !== productId)
      const cambiaLista = viejos !== null || lista === null || final.length !== lista.length
      // Un id guardado que ya no es de ningún producto (archivados incluidos, ésos sí son) se quita sin error: lo guardado no lo
      // controla quien llama, y `normalizarSeleccion` lo rechazaría. La bitácora lo nombra.
      if (cambiaLista && viejos === null && lista !== null) {
        const vivos = await tx.product.findMany({ where: { venueId, id: { in: lista } }, select: { id: true }, take: lista.length })
        const existen = new Set([productId, ...vivos.map(p => p.id)])
        const muertos = final.filter(id => !existen.has(id))
        if (muertos.length) {
          idsDescartados[fila.id] = muertos
          final = final.filter(id => existen.has(id))
        }
      }
      if (final.length === 0) throw new ValidationError(LISTA_VACIA)
      const revisados = sumarRevisados(config.productosRevisados, dentro ? [] : [productId], final)
      if (!cambiaLista && JSON.stringify(revisados) === JSON.stringify(config.productosRevisados ?? [])) continue

      const nuevo = cambiaLista ? await normalizarSeleccion(tx, venueId, config, { productoIds: final }) : config
      await tx.deliveryChannelLink.updateMany({
        where: { id: fila.id, venueId },
        data: { config: { ...nuevo, productosRevisados: revisados } as Prisma.InputJsonValue },
      })
    }
    return { resultado, codigosDescartados, idsDescartados }
  })

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'DELIVERY_CHANNEL_PRODUCT_SET',
    entity: 'Product',
    entityId: productId,
    data: {
      productId,
      canales,
      ...(Object.keys(codigosDescartados).length > 0 && { codigosDescartados }),
      ...(Object.keys(idsDescartados).length > 0 && { idsDescartados }),
    },
  })

  return resultado
}
