import { Prisma } from '@prisma/client'
import { negocioCambioDeOrganizacionError } from './exclusionContable'

export async function tomarAdmisionCompartida(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('iva-emision:' || ${organizationId}, 0))`
}

/**
 * Plan 6b (spec D10, §5.2): el encendido toma la MISMA llave en EXCLUSIVA, antes que cualquier otro candado: espera a toda emisión,
 * cancelación, conciliación o sincronización del POS en curso de la organización, y ninguna empieza mientras enciende.
 */
export async function tomarAdmisionExclusiva(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('iva-emision:' || ${organizationId}, 0))`
}

/**
 * Plan 6b (spec D10, §5.3): admisión → orden → productos, el orden único de toda la facturación. La organización se lee SIN candado
 * para saber qué admisión tomar y se confirma al bloquear la orden: si el negocio cambió de organización en medio, 409 y se reintenta.
 */
export async function bloquearOrdenParaFacturar(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ venueId: string; organizationId: string } | null> {
  const [antes] = await tx.$queryRaw<Array<{ organizationId: string }>>`
    SELECT v."organizationId" FROM "Order" o JOIN "Venue" v ON v.id = o."venueId" WHERE o.id = ${orderId}`
  if (!antes) return null
  await tomarAdmisionCompartida(tx, antes.organizationId)
  const rows = await tx.$queryRaw<Array<{ venueId: string; organizationId: string }>>`
    SELECT o."venueId", v."organizationId" FROM "Order" o
    JOIN "Venue" v ON v.id = o."venueId" WHERE o.id = ${orderId} FOR UPDATE OF o
  `
  if (!rows[0]) return null
  if (rows[0].organizationId !== antes.organizationId) throw negocioCambioDeOrganizacionError()
  // Plan 4b (Ruling 4b-R13): en orden de id, como la conciliación de Uber, que los toma FOR NO KEY UPDATE: sin orden, dos productos
  // en común tomados cruzados darían 40P01.
  await tx.$queryRaw`SELECT p.id FROM "Product" p JOIN "OrderItem" oi ON oi."productId" = p.id
    WHERE oi."orderId" = ${orderId} ORDER BY p.id FOR SHARE OF p`
  return rows[0]
}

/**
 * Recibe IDs únicos. Plan 6b (D10): primero la admisión de cada organización involucrada (en orden), luego TODAS las órdenes y
 * al final los productos en UNA pasada ascendente. Sin `venueId` (la cancelación) las órdenes se toman por id: sus ids salen del
 * manifiesto de UNA factura, y una orden que después se movió de negocio sigue siendo de ella (Ruling 4b-R13).
 * `productosExtra`: productos que el llamador va a escribir (el encendido: el producto que se edita) dentro de la misma pasada.
 * `paraEscribir`: `FOR NO KEY UPDATE` (el candado del UPDATE del producto y de la conciliación de delivery) en vez de `FOR SHARE`.
 * Codex código r1 #1 (Ruling CX-1), para órdenes que hoy viven en otra organización que su factura:
 * `organizacionesExtra`: las que el llamador necesita aunque no salgan de las órdenes (la cancelación y la anulación de la global: la del
 *   negocio de la FACTURA). Se unen a las de las órdenes y TODAS se piden en orden ascendente antes de la primera fila: nunca se omite la
 *   de la factura ni se pide una después de filas.
 * `soloOrganizacion`: la única admitida (el encendido, que ya tiene la suya en EXCLUSIVA). Si una orden vive en otra, 409 ANTES de pedir
 *   ninguna admisión: así el encendido de A nunca espera la de B mientras el de B espera la de A.
 */
export async function bloquearOrdenesParaFacturar(
  tx: Prisma.TransactionClient,
  ids: string[],
  venueId?: string,
  opts: { productosExtra?: string[]; paraEscribir?: boolean; organizacionesExtra?: string[]; soloOrganizacion?: string } = {},
): Promise<void> {
  const organizaciones = async () =>
    venueId === undefined
      ? tx.$queryRaw<Array<{ organizationId: string }>>`
          SELECT DISTINCT v."organizationId" FROM "Order" o JOIN "Venue" v ON v.id = o."venueId"
          WHERE o.id = ANY(${ids}::text[]) ORDER BY 1`
      : tx.$queryRaw<Array<{ organizationId: string }>>`SELECT "organizationId" FROM "Venue" WHERE id = ${venueId}`
  const antes = (await organizaciones()).map(o => o.organizationId)
  if (opts.soloOrganizacion !== undefined && antes.some(o => o !== opts.soloOrganizacion)) throw negocioCambioDeOrganizacionError()
  // Un solo orden para todos los que piden varias: ascendente (el de JS; sólo este helper toma más de una).
  const admisiones = [...new Set([...antes, ...(opts.organizacionesExtra ?? [])])].sort()
  for (const organizationId of admisiones) await tomarAdmisionCompartida(tx, organizationId)
  if (ids.length) {
    const donde =
      venueId === undefined ? Prisma.sql`id = ANY(${ids}::text[])` : Prisma.sql`"venueId" = ${venueId} AND id = ANY(${ids}::text[])`
    // R5: un solo orden global (también entre las antiguas páginas); COUNT evita devolver todo el manifiesto a Node.
    await tx.$queryRaw`SELECT COUNT(*) FROM (
      SELECT id FROM "Order" WHERE ${donde} ORDER BY "createdAt" DESC, id DESC FOR UPDATE
    ) AS locked_orders`
  }
  // Un negocio movido de organización entre la lectura y los candados: su admisión no la tenemos ⇒ 409 y se reintenta.
  if ((await organizaciones()).map(o => o.organizationId).join() !== antes.join()) throw negocioCambioDeOrganizacionError()
  const extra = opts.productosExtra ?? []
  const modo = opts.paraEscribir ? Prisma.sql`FOR NO KEY UPDATE` : Prisma.sql`FOR SHARE`
  // Products only after ALL orders, in ONE ascending pass (plan 4b, Ruling 4b-R13; plan 6b: también los extra del encendido).
  // Un solo `IN (… UNION …)` y no `IN (…) OR id = ANY(extra)`: bajo un `OR` el `IN` no se vuelve semi-join y el planificador recorre TODO
  // `Product` filtrando con un SubPlan; con el `UNION` busca cada producto por su llave (ruling T1-a, EXPLAIN en el reporte de la Tarea 1).
  // `Prisma.sql` aplana el fragmento `modo` dentro del texto (un tagged template lo dejaría como valor).
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Product" WHERE id IN (SELECT "productId" FROM "OrderItem" WHERE "orderId" = ANY(${ids}::text[])
    UNION SELECT unnest(${extra}::text[])) ORDER BY id ASC ${modo}`)
}
