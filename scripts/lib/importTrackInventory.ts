/**
 * Lo que comparten el diagnóstico y la reparación de los productos que dejó dañados la importación por hoja de cálculo
 * del dashboard (`importMenu` con `trackInventory: true`): se creó su fila de Inventory con existencias, pero el producto
 * nunca quedó «por cantidad» (`trackInventory = false` o `inventoryMethod` nulo), así que sus ventas NO descuentan.
 *
 * Sin `prisma` a propósito: cada script elige la base ANTES de cargar el cliente, y le pasa el cliente a estas funciones.
 */
import type { InventoryMethod, Prisma, PrismaClient, ProductType } from '@prisma/client'
import { isNonInventoriable } from '../../src/services/dashboard/quantityInventoryRow'

/** Tope de productos por corrida; si se llega, se avisa (se corre de nuevo por negocio con `--venue`). */
export const TOPE = 20_000
export const ACCION = 'PRODUCT_INVENTORY_TRACKING_REPAIRED'

/**
 * REPARABLE se prende «por cantidad». Los otros se listan y NO se tocan:
 * - TIPO_SIN_EXISTENCIAS: una clase, una cita, algo digital o un donativo no se cuentan.
 * - CON_RECETA: se descuenta por sus insumos; pasarlo a cantidad cambiaría qué descuenta la venta.
 * - APAGADO_TRAS_VENDER: ya descontó ventas alguna vez ⇒ se contó, y alguien lo apagó a mano.
 */
export type Clase = 'REPARABLE' | 'TIPO_SIN_EXISTENCIAS' | 'CON_RECETA' | 'APAGADO_TRAS_VENDER'

export interface Danado {
  productId: string
  venueId: string
  venueName: string
  venueSlug: string
  name: string
  sku: string
  type: ProductType
  trackInventory: boolean
  inventoryMethod: InventoryMethod | null
  archivado: boolean
  conReceta: boolean
  existencias: string
  ventasDescontadas: number
}

export function clasificar(p: Pick<Danado, 'type' | 'trackInventory' | 'inventoryMethod' | 'conReceta' | 'ventasDescontadas'>): Clase {
  if (isNonInventoriable(p.type, true)) return 'TIPO_SIN_EXISTENCIAS'
  if (p.inventoryMethod === 'RECIPE' || p.conReceta) return 'CON_RECETA'
  // ponytail: heurística. Uno que alguien apagó a mano ANTES de su primera venta no se distingue de uno dañado por la
  // importación; por eso la lista la revisa el founder antes de `--aplicar`.
  if (!p.trackInventory && p.ventasDescontadas > 0) return 'APAGADO_TRAS_VENDER'
  return 'REPARABLE'
}

/** Productos con fila de Inventory que no se cuentan «por cantidad». Sólo lee. */
export async function buscarDanados(db: Pick<PrismaClient, 'product'>, venueId?: string): Promise<{ filas: Danado[]; truncado: boolean }> {
  const rows = await db.product.findMany({
    where: { ...(venueId ? { venueId } : {}), inventory: { isNot: null }, OR: [{ trackInventory: false }, { inventoryMethod: null }] },
    select: {
      id: true,
      venueId: true,
      name: true,
      sku: true,
      type: true,
      trackInventory: true,
      inventoryMethod: true,
      deletedAt: true,
      venue: { select: { name: true, slug: true } },
      recipe: { select: { id: true } },
      inventory: { select: { currentStock: true, _count: { select: { movements: { where: { type: 'SALE' } } } } } },
    },
    orderBy: [{ venueId: 'asc' }, { id: 'asc' }],
    take: TOPE + 1,
  })
  const filas = rows.slice(0, TOPE).map(r => ({
    productId: r.id,
    venueId: r.venueId,
    venueName: r.venue.name,
    venueSlug: r.venue.slug,
    name: r.name,
    sku: r.sku,
    type: r.type,
    trackInventory: r.trackInventory,
    inventoryMethod: r.inventoryMethod,
    archivado: r.deletedAt !== null,
    conReceta: r.recipe !== null,
    existencias: r.inventory ? r.inventory.currentStock.toString() : '0',
    ventasDescontadas: r.inventory?._count.movements ?? 0,
  }))
  return { filas, truncado: rows.length > TOPE }
}

/** Cuenta por clase y lista por negocio, con nombre. */
export function imprimir(filas: Danado[], truncado: boolean): void {
  const porClase = new Map<Clase, number>()
  for (const f of filas) porClase.set(clasificar(f), (porClase.get(clasificar(f)) ?? 0) + 1)
  const negocios = new Set(filas.map(f => f.venueId)).size
  console.log(`Productos con fila de Inventory que NO se cuentan «por cantidad»: ${filas.length} en ${negocios} negocio(s)`)
  for (const clase of ['REPARABLE', 'APAGADO_TRAS_VENDER', 'CON_RECETA', 'TIPO_SIN_EXISTENCIAS'] as Clase[])
    console.log(`  ${clase.padEnd(22)} ${porClase.get(clase) ?? 0}`)
  if (truncado) console.log(`⚠️ Se llegó al tope de ${TOPE}: corre de nuevo con --venue <slug> para ver el resto.`)
  let venueActual = ''
  for (const f of filas) {
    if (f.venueId !== venueActual) {
      venueActual = f.venueId
      const n = filas.filter(x => x.venueId === f.venueId)
      const reparables = n.filter(x => clasificar(x) === 'REPARABLE').length
      console.log(`\n${f.venueName} (${f.venueSlug}) — ${n.length} producto(s), ${reparables} reparable(s)`)
    }
    const estado = `trackInventory=${f.trackInventory} método=${f.inventoryMethod ?? 'nulo'}`
    console.log(
      `  ${clasificar(f).padEnd(22)} ${f.name} [${f.sku}] ${f.type} · ${estado} · existencias ${f.existencias} · ventas descontadas ${f.ventasDescontadas}${f.archivado ? ' · archivado' : ''}`,
    )
  }
}

/**
 * Prende «por cantidad» los REPARABLE, en UNA transacción: cada producto se escribe sólo si sigue EXACTAMENTE como se
 * listó (CAS); si uno cambió por debajo, se aborta entera y no se repara nada. Deja bitácora por producto.
 */
export async function reparar(prisma: Pick<PrismaClient, '$transaction'>, filas: Danado[]): Promise<number> {
  const reparables = filas.filter(f => clasificar(f) === 'REPARABLE')
  if (reparables.length === 0) return 0
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // ponytail: un UPDATE por producto (cada uno con su propio estado esperado); por lotes si la lista crece a miles.
      for (const f of reparables) {
        const { count } = await tx.product.updateMany({
          where: {
            id: f.productId,
            venueId: f.venueId,
            trackInventory: f.trackInventory,
            inventoryMethod: f.inventoryMethod,
            type: f.type,
            recipe: { is: null },
            inventory: { isNot: null },
          },
          data: { trackInventory: true, inventoryMethod: 'QUANTITY' },
        })
        if (count !== 1) throw new Error(`«${f.name}» [${f.sku}] cambió desde que se listó: NO se reparó nada. Corre de nuevo.`)
      }
      await tx.activityLog.createMany({
        data: reparables.map(f => ({
          venueId: f.venueId,
          action: ACCION,
          entity: 'Product',
          entityId: f.productId,
          data: {
            antes: { trackInventory: f.trackInventory, inventoryMethod: f.inventoryMethod },
            despues: { trackInventory: true, inventoryMethod: 'QUANTITY' },
            motivo: 'La importación por hoja de cálculo creó su inventario sin prenderlo: sus ventas no descontaban.',
          },
        })),
      })
      return reparables.length
    },
    { timeout: 120_000, maxWait: 30_000 },
  )
}

/** `--base render` cambia DATABASE_URL por RENDER_DATABASE_URL ANTES de cargar el cliente de Prisma. Nunca imprime URLs. */
export function elegirBase(argv: string[]): void {
  const i = argv.indexOf('--base')
  const base = i >= 0 ? argv[i + 1] : undefined
  if (base === undefined || base === 'local') return
  if (base !== 'render') throw new Error(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
  if (!process.env.RENDER_DATABASE_URL) throw new Error('--base render: falta RENDER_DATABASE_URL en el entorno.')
  process.env.DATABASE_URL = process.env.RENDER_DATABASE_URL
}

/** Host y nombre de la base a la que ESTA corrida se conecta (lo que hay que repetir para escribir). */
export function destino(): { host: string; base: string } {
  let url: URL
  try {
    url = new URL(process.env.DATABASE_URL ?? '')
  } catch {
    // El error de `new URL` lleva la cadena completa (con su contraseña): no se propaga.
    throw new Error('DATABASE_URL falta o no es una URL válida (su valor no se imprime).')
  }
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!url.hostname || !base) throw new Error('DATABASE_URL no declara host y base (su valor no se imprime).')
  return { host: url.hostname, base }
}

export function leerValor(argv: string[], bandera: string): string | undefined {
  const i = argv.indexOf(bandera)
  return i >= 0 ? argv[i + 1] : undefined
}
