/**
 * La selección del canal al ESCRIBIR (D1, 16-nov-2026): qué productos publica y a qué precio, guardado por id.
 *
 * El código de un producto cambia por muchos caminos (Shopify, variantes, importaciones) y uno nuevo puede tomar un código
 * viejo; el id no cambia nunca. Por eso todo lo que escribe la selección guarda `productoIds`, `precios.porProducto` (por id de
 * producto) y `precios.porExtra` (por id de extra), y rehace la copia por código (`productos`, `precios.overrides`) con los
 * códigos vigentes: la API vieja la sigue leyendo y una vuelta atrás de versión publica lo último guardado, no todo el catálogo.
 *
 * 🔴 Codex impl r2: los precios de extras ya NO viven en la copia por código. Compartir ese mapa con los productos ponía un precio
 * en el artículo equivocado cada vez que un código pasaba de un producto a un extra (o al revés).
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

/** El id del extra si `codigo` tiene la forma `MOD-<id>` (el código que el menú le da a un extra); si no, `null`. */
const idDeExtra = (codigo: string): string | null => (codigo.startsWith('MOD-') && codigo.length > 4 ? codigo.slice(4) : null)

/** El mapa enviado `{ id: precio }`, validado. */
function mapaEnviado(v: unknown, llave: 'porProducto' | 'porExtra'): Record<string, unknown> {
  const que = llave === 'porProducto' ? 'producto' : 'extra'
  const mapa = comoObjeto(v)
  if (!mapa) throw new ValidationError(`\`precios.${llave}\` debe ser un objeto { id de ${que}: precio }`)
  for (const [id, precio] of Object.entries(mapa)) {
    if (!esPrecio(precio)) throw new ValidationError(`El precio fijo del ${que} "${id}" debe ser un número mayor o igual a 0`)
  }
  return mapa
}

/**
 * `mezclado` con la lista y los precios guardados por id y su copia por código al día. Sin lista ni precios en juego, la
 * devuelve igual y sin consultar. Lo que llega en `entrante` y no es de este negocio truena con `ValidationError`.
 *
 * Precios:
 *  · `porProducto` / `porExtra` enviados mandan; la `overrides` enviada junto a ellos se ignora POR COMPLETO: no decide, no
 *    truena (es la copia que devuelve la propia API; Codex impl r2 #3) y no completa el mapa que falte (Codex impl r3 #3).
 *  · `overrides` enviado SIN ellos (la API de antes de D1) reemplaza todos los precios: cada código de producto va a
 *    `porProducto`, cada `MOD-<id>` de un extra del negocio a `porExtra`, y lo demás truena nombrándolo (`{}` borra todo).
 *  · Un canal con lista o con precios por id al que le falta un mapa lo saca UNA vez de la copia por código GUARDADA, la de
 *    `guardado` (la fila leída bajo candado, antes de mezclar; Codex plan r3 #2). Lo que no es de nadie se descarta.
 *  · Si los precios de un canal viejo por código quedan por id, su lista `productos` pasa también a `productoIds`.
 */
export async function normalizarSeleccion(
  db: Prisma.TransactionClient,
  venueId: string,
  mezclado: Record<string, unknown>,
  entrante: Record<string, unknown>,
  guardado: unknown,
): Promise<Record<string, unknown>> {
  const enviados = comoObjeto(entrante.precios)
  const precios = comoObjeto(mezclado.precios)
  const mandaMapas = enviados?.porProducto !== undefined || enviados?.porExtra !== undefined
  const reemplaza = !mandaMapas && enviados?.overrides !== undefined
  // La copia por código de la que se sacan precios: la ENVIADA sólo cuando reemplaza; si no, la GUARDADA antes de este guardado
  // (y ninguna si este guardado borró `precios`).
  const copia = reemplaza
    ? (comoObjeto(precios?.overrides) ?? {})
    : precios
      ? (comoObjeto(comoObjeto(comoObjeto(guardado)?.precios)?.overrides) ?? {})
      : {}

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
  // La lista vieja por código que trae lo guardado (sin `productoIds`): pasa a ids junto con sus precios (abajo).
  const listaVieja =
    productoIds === undefined && codigos.length === 0 && Array.isArray(mezclado.productos)
      ? (mezclado.productos as unknown[]).filter((c): c is string => typeof c === 'string')
      : []

  // Los mapas que ya trae lo mezclado (enviados, o guardados que la mezcla conservó). Con `reemplaza` no cuenta ninguno.
  const ppDado = reemplaza ? undefined : precios?.porProducto
  const peDado = reemplaza ? undefined : precios?.porExtra
  const conMapas = conLista || ppDado !== undefined || peDado !== undefined
  const sacaProductos = reemplaza || (conMapas && ppDado === undefined && Object.keys(copia).length > 0)
  const sacaExtras = reemplaza || (conMapas && peDado === undefined && Object.keys(copia).some(c => idDeExtra(c) !== null))
  const tocaLista = entrante.productoIds !== undefined || entrante.productos !== undefined
  if (!tocaLista && !mandaMapas && !sacaProductos && !sacaExtras) return mezclado

  const ppEnviado = enviados?.porProducto !== undefined ? mapaEnviado(enviados.porProducto, 'porProducto') : undefined
  const peEnviado = enviados?.porExtra !== undefined ? mapaEnviado(enviados.porExtra, 'porExtra') : undefined
  // Tope de lo enviado: las consultas de abajo buscan cada llave (`IN` acotado).
  for (const mapa of [enviados?.porProducto, enviados?.porExtra, enviados?.overrides]) {
    if (Object.keys(comoObjeto(mapa) ?? {}).length > MAX_PRECIOS) {
      throw new ValidationError(`El canal admite hasta ${MAX_PRECIOS.toLocaleString('es-MX')} precios fijos`)
    }
  }
  const sacaDeLaCopia = sacaProductos || sacaExtras

  // UNA consulta, del negocio y con tope: los ids en juego y los códigos en juego (archivados incluidos).
  const ids = [...new Set([...(Array.isArray(productoIds) ? productoIds : []), ...Object.keys(comoObjeto(ppDado) ?? {})])]
  // Los códigos de la lista vieja sólo si este guardado puede dejar precios por id (si no, el canal sigue por código entero).
  const codigosViejos = ppDado !== undefined || peDado !== undefined || Object.keys(copia).length > 0 ? listaVieja : []
  const codigosEnJuego = [...new Set([...codigos, ...codigosViejos, ...(sacaDeLaCopia ? Object.keys(copia) : [])])]
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
  if (ppEnviado) {
    const ajenos = Object.keys(ppEnviado).filter(id => !codigoDe.has(id))
    if (ajenos.length) throw new ValidationError(`Estos precios fijos no son de productos de tu negocio: ${ajenos.join(', ')}`)
  }

  // Los extras en juego: los enviados y los `MOD-<id>` de la copia que no son el código de un producto (un código de producto
  // gana, aunque empiece con `MOD-`). UNA consulta, del negocio, por id y con tope.
  const deLaCopia =
    reemplaza || sacaExtras
      ? Object.keys(copia)
          .filter(c => !idDe.has(c))
          .flatMap(c => idDeExtra(c) ?? [])
      : []
  const candidatos = [...new Set([...Object.keys(peEnviado ?? {}), ...deLaCopia])]
  const extras = new Set(
    candidatos.length === 0
      ? []
      : (
          await db.modifier.findMany({
            where: { id: { in: candidatos }, group: { venueId } },
            select: { id: true },
            take: candidatos.length,
          })
        ).map(m => m.id),
  )
  if (peEnviado) {
    const ajenos = Object.keys(peEnviado).filter(id => !extras.has(id))
    if (ajenos.length) throw new ValidationError(`Estos precios fijos no son de extras de tu negocio: ${ajenos.join(', ')}`)
  }

  // Lo que sale de la copia por código. Los valores se copian tal cual: el mapeador ya ignora un precio que no sirve.
  const deCopia: { porProducto: Record<string, unknown>; porExtra: Record<string, unknown> } = { porProducto: {}, porExtra: {} }
  if (sacaDeLaCopia) {
    const sinDueno: string[] = []
    for (const [codigo, precio] of Object.entries(copia)) {
      const id = idDe.get(codigo)
      const extra = idDeExtra(codigo)
      if (id) deCopia.porProducto[id] = precio
      else if (extra !== null && extras.has(extra)) deCopia.porExtra[extra] = precio
      else sinDueno.push(codigo)
    }
    // Enviado se nombra; guardado no es de nadie y se descarta.
    if (reemplaza && sinDueno.length) {
      throw new ValidationError(`Estos precios fijos no son de ningún producto ni extra de tu negocio: ${sinDueno.join(', ')}`)
    }
  }
  const porProducto = ppDado !== undefined ? (comoObjeto(ppDado) ?? {}) : sacaProductos ? deCopia.porProducto : undefined
  const porExtra = peDado !== undefined ? (comoObjeto(peDado) ?? {}) : sacaExtras ? deCopia.porExtra : undefined

  const resultado: Record<string, unknown> = { ...mezclado }
  if (porProducto !== undefined || porExtra !== undefined) {
    // La copia por código, sólo desde los ids: el `MOD-<id>` de cada extra y el código vigente de cada producto (con un producto
    // que se llame literalmente igual, gana el producto, como al publicar).
    const copiaNueva: Record<string, unknown> = {}
    for (const [id, precio] of Object.entries(porExtra ?? {})) copiaNueva[`MOD-${id}`] = precio
    for (const [id, precio] of Object.entries(porProducto ?? {})) if (codigoDe.has(id)) copiaNueva[codigoDe.get(id)!] = precio
    // `porExtra` se guarda si trae algo, si ya estaba o si la copia lleva un `MOD-…` (de un producto que se llama así): sin él,
    // otro guardado sacaría de la copia ese precio de producto como si fuera del extra (Codex impl r2 #2).
    const guardaExtra =
      Object.keys(porExtra ?? {}).length > 0 || peDado !== undefined || Object.keys(copiaNueva).some(c => idDeExtra(c) !== null)
    // Un canal viejo por código cuyos precios quedan por id pasa también su lista a ids (los códigos de nadie se caen sin error):
    // lista y precios nunca quedan en dos identidades. Si ningún código es de nadie, la lista se queda igual (tampoco publica nada).
    if (productoIds === undefined && (guardaExtra || Object.keys(porProducto ?? {}).length > 0)) {
      const vivos = [...new Set(codigosViejos.flatMap(c => (idDe.has(c) ? [idDe.get(c)!] : [])))]
      if (vivos.length > 0) productoIds = vivos
    }
    // `porProducto` va siempre con `porExtra` y en un canal con lista (aunque vacío): así lo guardado no se vuelve a convertir.
    const guardaProducto = guardaExtra || Array.isArray(productoIds) || Object.keys(porProducto ?? {}).length > 0
    const { porProducto: _pp, porExtra: _pe, ...resto }: Record<string, unknown> = precios ?? {}
    resultado.precios = {
      ...resto,
      ...(guardaProducto && { porProducto: porProducto ?? {} }),
      ...(guardaExtra && { porExtra: porExtra ?? {} }),
      overrides: copiaNueva,
    }
  }
  if (productoIds !== undefined) {
    resultado.productoIds = productoIds
    resultado.productos = productoIds && productoIds.flatMap(id => (codigoDe.has(id) ? [codigoDe.get(id)!] : []))
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
