/**
 * La selección del canal al ESCRIBIR (D1, 16-nov-2026): qué productos publica y a qué precio, guardado por PRODUCTO (id).
 *
 * El código de un producto cambia por muchos caminos (Shopify, variantes, importaciones) y uno nuevo puede tomar un código
 * viejo; el id no cambia nunca. Por eso todo lo que escribe la selección guarda `productoIds` y `precios.porProducto`, y
 * rehace la copia por código (`productos`, `precios.overrides`) con los códigos vigentes: la API vieja la sigue leyendo y una
 * vuelta atrás de versión publica lo último guardado, no todo el catálogo. Los precios de extras (`MOD-<id>`, código estable) se
 * quedan en `overrides`, pero sólo si `<id>` es un extra del negocio: el prefijo no lo prueba (Codex impl r1 #2).
 *
 * 🔴 Corre sobre la config YA MEZCLADA (Codex plan r3 #2): así convertir la lista vieja arrastra también sus precios guardados.
 */
import type { Prisma } from '@prisma/client'

import { ValidationError } from '../../../errors/AppError'
import { validarIdsDelCanal, validarProductosDelCanal } from './productosDelCanal'

/** Tope de `productosRevisados` (ids que alguien ya vio y dejó fuera). */
export const MAX_REVISADOS = 10_000
/** Tope de precios fijos enviados en un guardado (productos y extras). */
const MAX_PRECIOS = 10_000

const comoObjeto = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const esPrecio = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * `mezclado` con la lista y los precios guardados por id y su copia por código al día. Sin lista ni precios en juego, la
 * devuelve igual y sin consultar. Lo que llega en `entrante` y no es de este negocio truena con `ValidationError`.
 */
export async function normalizarSeleccion(
  db: Prisma.TransactionClient,
  venueId: string,
  mezclado: Record<string, unknown>,
  entrante: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const enviados = comoObjeto(entrante.precios)
  const precios = comoObjeto(mezclado.precios)
  const overrides = comoObjeto(precios?.overrides) ?? {}
  // `porProducto` enviado manda para productos; un `overrides` enviado sin él REEMPLAZA los precios (Codex plan r4 #1).
  const mandaPorProducto = enviados?.porProducto !== undefined
  const reemplaza = !mandaPorProducto && enviados?.overrides !== undefined

  // La lista: `undefined` = no se tocó.
  let productoIds: string[] | null | undefined
  let codigos: string[] = []
  if (entrante.productoIds !== undefined) {
    validarIdsDelCanal(entrante.productoIds)
    productoIds = entrante.productoIds as string[] | null
  } else if (entrante.productos === null) {
    productoIds = null
  } else if (entrante.productos !== undefined) {
    validarProductosDelCanal(entrante.productos)
    codigos = entrante.productos as string[]
  }
  const guardados = productoIds === undefined && codigos.length === 0 && Array.isArray(mezclado.productoIds)
  if (guardados) productoIds = mezclado.productoIds as string[]
  const conLista = Array.isArray(productoIds) || codigos.length > 0

  // Precios por código guardados en un canal con lista por id: se pasan a `porProducto` (Codex plan r3 #2).
  const convertirGuardados =
    !mandaPorProducto && !reemplaza && precios?.porProducto === undefined && conLista && Object.keys(overrides).length > 0
  const tocaLista = entrante.productoIds !== undefined || entrante.productos !== undefined
  if (!tocaLista && !mandaPorProducto && !reemplaza && !convertirGuardados) return mezclado

  if (mandaPorProducto) {
    const p = comoObjeto(enviados?.porProducto)
    if (!p) throw new ValidationError('`precios.porProducto` debe ser un objeto { id de producto: precio }')
    for (const [id, precio] of Object.entries(p)) {
      if (!esPrecio(precio)) throw new ValidationError(`El precio fijo del producto "${id}" debe ser un número mayor o igual a 0`)
    }
  }
  // Tope de lo enviado: la consulta de abajo busca cada llave (`IN` acotado).
  for (const mapa of [enviados?.porProducto, enviados?.overrides]) {
    if (Object.keys(comoObjeto(mapa) ?? {}).length > MAX_PRECIOS) {
      throw new ValidationError(`El canal admite hasta ${MAX_PRECIOS.toLocaleString('es-MX')} precios fijos`)
    }
  }
  const porProductoBase = mandaPorProducto ? comoObjeto(enviados?.porProducto)! : reemplaza ? {} : (comoObjeto(precios?.porProducto) ?? {})

  // UNA consulta, del negocio y con tope: los ids en juego y los códigos en juego (archivados incluidos).
  const ids = [...new Set([...(Array.isArray(productoIds) ? productoIds : []), ...Object.keys(porProductoBase)])]
  const codigosEnJuego = [...new Set([...codigos, ...Object.keys(overrides)])]
  const filas: Array<{ id: string; sku: string }> =
    ids.length + codigosEnJuego.length === 0
      ? []
      : await db.product.findMany({
          where: { venueId, OR: [{ id: { in: ids } }, { sku: { in: codigosEnJuego } }] },
          select: { id: true, sku: true },
          take: ids.length + codigosEnJuego.length,
        })
  const codigoDe = new Map(filas.map(f => [f.id, f.sku] as const))
  const idDe = new Map(filas.map(f => [f.sku, f.id] as const))

  if (codigos.length > 0) {
    const faltan = [...new Set(codigos.filter(c => !idDe.has(c)))]
    if (faltan.length) throw new ValidationError(`Estos códigos no son de ningún producto de tu negocio: ${faltan.join(', ')}`)
    productoIds = [...new Set(codigos.map(c => idDe.get(c)!))]
  } else if (Array.isArray(productoIds) && !guardados) {
    const ajenos = [...new Set(productoIds.filter(id => !codigoDe.has(id)))]
    if (ajenos.length) throw new ValidationError(`Estos productos no son de tu negocio: ${ajenos.join(', ')}`)
    productoIds = [...new Set(productoIds)]
  }
  if (mandaPorProducto) {
    const ajenos = Object.keys(porProductoBase).filter(id => !codigoDe.has(id))
    if (ajenos.length) throw new ValidationError(`Estos precios fijos no son de productos de tu negocio: ${ajenos.join(', ')}`)
  }

  // Precios por producto: los enviados, los convertidos de `overrides` o los guardados.
  let porProducto: Record<string, unknown> | undefined
  if (mandaPorProducto || (!reemplaza && precios?.porProducto !== undefined)) {
    porProducto = porProductoBase
  } else if (reemplaza || convertirGuardados) {
    porProducto = {}
    for (const [codigo, precio] of Object.entries(overrides)) {
      const id = idDe.get(codigo) // un código de producto gana, aunque empiece con `MOD-`
      if (id) porProducto[id] = precio
    }
  }

  const resultado: Record<string, unknown> = { ...mezclado }
  if (productoIds !== undefined) {
    resultado.productoIds = productoIds
    resultado.productos = productoIds && productoIds.flatMap(id => (codigoDe.has(id) ? [codigoDe.get(id)!] : []))
  }
  if (porProducto !== undefined) {
    // 🔴 Codex impl r1 #2: un `MOD-<id>` que no es código de producto es precio de extra sólo si `<id>` es un extra de ESTE negocio
    // (UNA consulta, por id y con tope). Lo demás no es de nadie: enviado se nombra; guardado se descarta.
    const posibles = [
      ...new Set(Object.keys(overrides).flatMap(c => (c.startsWith('MOD-') && !idDe.has(c) && c.length > 4 ? [c.slice(4)] : []))),
    ]
    const extras = new Set(
      posibles.length === 0
        ? []
        : (
            await db.modifier.findMany({
              where: { id: { in: posibles }, group: { venueId } },
              select: { id: true },
              take: posibles.length,
            })
          ).map(m => `MOD-${m.id}`),
    )
    const sinDueno = Object.keys(comoObjeto(enviados?.overrides) ?? {}).filter(c => !idDe.has(c) && !extras.has(c))
    if (sinDueno.length) {
      throw new ValidationError(`Estos precios fijos no son de ningún producto ni extra de tu negocio: ${sinDueno.join(', ')}`)
    }
    const copia: Record<string, unknown> = Object.fromEntries(Object.entries(overrides).filter(([codigo]) => extras.has(codigo)))
    for (const [id, precio] of Object.entries(porProducto)) if (codigoDe.has(id)) copia[codigoDe.get(id)!] = precio
    const { porProducto: _viejo, ...resto }: Record<string, unknown> = precios ?? {}
    // Un canal con lista por id siempre lleva `porProducto` (aunque vacío): así lo guardado no se vuelve a convertir.
    const conPorProducto = Object.keys(porProducto).length > 0 || Array.isArray(productoIds)
    resultado.precios = { ...resto, ...(conPorProducto && { porProducto }), overrides: copia }
  }
  return resultado
}

/** `productosRevisados` + `nuevos`, sin repetir y sin los que están en `lista`; si pasa del tope, se quedan los últimos. */
export function sumarRevisados(actual: unknown, nuevos: string[], lista: string[] | null): string[] {
  const enLista = new Set(lista ?? [])
  const recien = new Set(nuevos)
  const previos = Array.isArray(actual) ? actual.filter((x): x is string => typeof x === 'string' && !recien.has(x)) : []
  // Un id que se vuelve a marcar pasa al final: es el más reciente.
  return [...new Set([...previos, ...nuevos])].filter(id => !enLista.has(id)).slice(-MAX_REVISADOS)
}
