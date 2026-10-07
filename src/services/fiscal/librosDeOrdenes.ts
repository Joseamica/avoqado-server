/**
 * IVA por producto, bloque B4b (Codex B4b r1 P2 #7; r2 N6, N7; r3 R3-4; r4 R4-4; r5 R5-1, R5-2, R5-3, R5-5): los libros de un LOTE de
 * órdenes del periodo, dentro de la transacción del reporte (recibe `tx`; no abre otra).
 *  - Topes por orden (fallo del controlador, ronda 6): una orden que pasa uno NO se aproxima ni se resume: el reporte se detiene con
 *    REPORT_TOO_LARGE, nombrando la venta. El reparto fiscal nunca depende del tamaño.
 *  - Tope de memoria: sub-lotes de a lo más TOPE_DE_FILAS_POR_LOTE filas (renglones + filas de descuento + destinos de sus repartos +
 *    movimientos + artículos devueltos). Toda orden permitida cabe sola.
 *  - Sólo lecturas que el freno del MCP reconoce: `findMany` y `$queryRaw` de un solo SELECT (`isReadOnlySql`). Nunca `$executeRaw`.
 *  - Fechas crudas con `utcTs`: `createdAt` guarda UTC sin zona y Prisma manda el `Date` como `timestamptz` (sqlDates.ts).
 *  - Del processorData de una devolución, sólo los cuatro campos que usa el libro, por rutas de jsonb.
 *  - El negocio en cada lectura (N7): un cobro de otro negocio ligado a una orden de éste no entra al libro.
 * Llama `alMovimiento` con cada movimiento y su parte, en orden (createdAt, id) dentro de cada orden; quien llama decide qué suma.
 * Devuelve cuántas consultas hizo y cuántas filas leyó: la medición por petición (Tarea 8).
 */
import { OrderStatus, PaymentType, Prisma, TransactionStatus, type PaymentMethod } from '@prisma/client'
import { ValidationError } from '../../errors/AppError'
import { utcTs } from '../../utils/sqlDates'
import { abrirLibro, type Libro, type MovimientoDelLibro, type ParteDelLibro } from './libroDeLaOrden'
import { mezclaDeLaOrden, type CuentaDeMezcla, type RenglonDeMezcla } from './mezclaDeOrden'

export const PAGINA_DE_LIBROS = 1000
/** Fallo del controlador (ronda 6): lo más que puede tener un periodo; con una de más, REPORT_TOO_LARGE («elige un rango más corto»). */
export const MAX_ORDENES_POR_REPORTE = 300_000
/** Cuántas filas se tienen en memoria a la vez: un sub-lote. */
export const TOPE_DE_FILAS_POR_LOTE = 20_000
/**
 * Fallo 1 de la ronda 7 (Codex r6 R6-1): cuántos bytes de repartos PROYECTADOS (`REPARTO_FISCAL`) se tienen a la vez. Un sub-lote se
 * cierra por filas o por bytes, lo que llegue antes; toda orden permitida (≤ `bytesDeRepartos`) cabe sola.
 */
export const TOPE_DE_BYTES_POR_LOTE = 4_194_304
/**
 * Fallo del controlador (ronda 6, Codex r5 R5-1/R5-5): lo más que el reporte lee de UNA orden. Producción, 5-oct: a lo más 62
 * renglones, 2 descuentos y 1 devolución por orden, con 2 artículos por devolución. Renglones + descuentos + destinos + movimientos +
 * artículos suman 18,200 ≤ TOPE_DE_FILAS_POR_LOTE: toda orden permitida cabe sola en un sub-lote, completa.
 */
export const TOPES_POR_ORDEN = {
  renglones: 2_000,
  descuentos: 200,
  /** llaves de `reparto.renglones` de sus descuentos */
  destinos: 4_000,
  /** cobros y devoluciones hasta el cierre */
  movimientos: 2_000,
  /** elementos de `refundedItems`, sumando todas sus devoluciones */
  articulos: 10_000,
  /** elementos de `refundedItems` de UNA devolución */
  articulosPorDevolucion: 500,
  /** el `fiscalByRateCents` más grande (un congelado v2 con siete tratamientos pesa menos de 400 bytes) */
  bytesDelCongelado: 4_096,
  /**
   * Fallo 1 de la ronda 7: los bytes de sus repartos PROYECTADOS, sumados. 4,000 destinos de ~40 bytes y 200 filas de ~120 dan unos
   * 185 KB; el ámbito (`productos`, `categorias`) nunca entra a la cuenta porque nunca sale de la base.
   */
  bytesDeRepartos: 262_144,
} as const
type Tope = keyof typeof TOPES_POR_ORDEN

/** Un movimiento leído en la misma foto que su orden: todo lo que el estado de resultados suma. */
export type MovimientoLeido = MovimientoDelLibro & {
  orderId: string
  createdAt: Date
  tipCents: number
  method: PaymentMethod | null
  /** El interruptor del comercio: `false` lo saca de lo fiscal (no del gerencial). */
  incluirEnContabilidad: boolean | null | undefined
}
/** Cuántas consultas hizo un lote y cuántas filas trajo a Node. */
export type LecturaDelLote = { consultas: number; filas: number }

/** La enumeración del estado de resultados: los ids de las órdenes con cobros del periodo, una vez cada una, en orden. */
export const sqlDeOrdenesDelPeriodo = (venueId: string, from: Date, to: Date, limite: number) => Prisma.sql`
  SELECT p."orderId" AS "orderId"
  FROM "Payment" p
  JOIN "Order" o ON o.id = p."orderId"
  WHERE p."venueId" = ${venueId}
    AND p.status = 'COMPLETED'
    AND p."createdAt" >= ${utcTs(from)}
    AND p."createdAt" <= ${utcTs(to)}
    AND o."venueId" = ${venueId}
    AND o.status <> 'CANCELLED'
  GROUP BY p."orderId"
  ORDER BY p."orderId"
  LIMIT ${limite}`

/**
 * Una lista de textos de jsonb (lo que `leerReparto` exige de `ambito.productos`, `ambito.categorias` y `base`), comprobada en la base.
 * Codex r7 R7-3: `jsonb_array_elements` va dentro de un CASE, así sólo recibe arreglos. PostgreSQL no garantiza el orden de un AND, y
 * un escalar (`base: "a"`, `productos: 3`) haría fallar la consulta según el plan.
 */
const listaDeTextos = (camino: Prisma.Sql) =>
  Prisma.sql`(CASE WHEN jsonb_typeof(${camino}) = 'array' THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${camino}) x WHERE jsonb_typeof(x) <> 'string') ELSE false END)`

/**
 * Fallo 1 de la ronda 7 (Codex r6 R6-1): la representación FISCAL de un reparto (`d.reparto`), proyectada en la base. Lleva lo que la
 * composición usa —`renglones` (destinos e importes) y `espejo`— y lo que `leerReparto` valida, con la MISMA presencia: `v`, `alcance`,
 * `conPromociones`, `tope` y `reduceImpuesto` tal cual (los opcionales, sólo si vienen). `ambito` y `base` NUNCA salen: en su lugar va
 * una marca diminuta con la misma validez (válido ⇒ listas vacías; inválido ⇒ "invalido"; ausente o null ⇒ nada). Las llaves que el
 * contrato no conoce no salen. Así `leerReparto` decide lo mismo que con el reparto completo (lo fija una prueba de paridad de 33
 * formas, verificada en una base desechable: un ámbito de 10,000 productos, 129 KB guardados, sale en 131 bytes) y un descuento
 * conocido nunca se trunca ni se aproxima.
 */
export const REPARTO_FISCAL = Prisma.sql`CASE WHEN jsonb_typeof(d.reparto) = 'object' THEN
    jsonb_build_object('v', d.reparto -> 'v', 'alcance', d.reparto -> 'alcance', 'espejo', d.reparto -> 'espejo', 'renglones', d.reparto -> 'renglones')
    || CASE WHEN d.reparto -> 'conPromociones' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('conPromociones', d.reparto -> 'conPromociones') END
    || CASE WHEN d.reparto -> 'tope' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('tope', d.reparto -> 'tope') END
    || CASE WHEN d.reparto -> 'reduceImpuesto' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reduceImpuesto', d.reparto -> 'reduceImpuesto') END
    || CASE WHEN d.reparto -> 'ambito' IS NULL OR jsonb_typeof(d.reparto -> 'ambito') = 'null' THEN '{}'::jsonb
            WHEN jsonb_typeof(d.reparto -> 'ambito') = 'object'
              AND ${listaDeTextos(Prisma.sql`d.reparto -> 'ambito' -> 'productos'`)}
              AND ${listaDeTextos(Prisma.sql`d.reparto -> 'ambito' -> 'categorias'`)}
              THEN '{"ambito": {"productos": [], "categorias": []}}'::jsonb
            ELSE '{"ambito": "invalido"}'::jsonb END
    || CASE WHEN d.reparto -> 'base' IS NULL OR jsonb_typeof(d.reparto -> 'base') = 'null' THEN '{}'::jsonb
            WHEN ${listaDeTextos(Prisma.sql`d.reparto -> 'base'`)} THEN '{"base": []}'::jsonb
            ELSE '{"base": "invalido"}'::jsonb END
  END`

/**
 * Los descuentos de las órdenes de UN sub-lote, con su reparto proyectado, en UNA consulta ordenada por (orderId, id).
 * Hallazgo T8-A (Tarea 8, 7-oct): sin `LIMIT` y sin llave `d.id > …`. Paginada por llave, la sentencia preparada pasaba al plan
 * GENÉRICO desde su 6.ª ejecución y recorría `OrderDiscount_pkey` filtrando por orderId: la tabla ENTERA (de todos los negocios) en
 * cada lote (10× junio: 35 de 41 s). La lectura sigue acotada de verdad, por el conteo y no por una página: ≤ 200 filas por orden
 * (`TOPES_POR_ORDEN.descuentos`), ≤ TOPE_DE_FILAS_POR_LOTE filas y ≤ TOPE_DE_BYTES_POR_LOTE de repartos proyectados por sub-lote.
 * Sin `set_config` ni ajustes de sesión: el freno del MCP debe seguir viendo un solo SELECT (`isReadOnlySql`).
 */
export const sqlDeLosDescuentos = (orderIds: string[]) => Prisma.sql`
  SELECT d.id, d."orderId", d.amount, ${REPARTO_FISCAL} AS reparto
  FROM "OrderDiscount" d
  WHERE d."orderId" IN (${Prisma.join(orderIds)})
  ORDER BY d."orderId", d.id`

/** Lo que cuenta cada tope, por orden (verificado en una base propia y desechable). */
export const sqlDelConteo = (venueId: string, orderIds: string[], hasta: Date) => Prisma.sql`
  SELECT o.id AS "orderId", o."orderNumber" AS folio,
    (SELECT count(*) FROM "OrderItem" oi WHERE oi."orderId" = o.id)::int AS renglones,
    (SELECT count(*) FROM "OrderDiscount" d WHERE d."orderId" = o.id)::int AS descuentos,
    (SELECT count(*) FROM "OrderDiscount" d,
       LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(d.reparto -> 'renglones') = 'object' THEN d.reparto -> 'renglones' ELSE '{}'::jsonb END) k
     WHERE d."orderId" = o.id)::int AS destinos,
    (SELECT coalesce(sum(octet_length((${REPARTO_FISCAL})::text)), 0) FROM "OrderDiscount" d WHERE d."orderId" = o.id)::int AS "bytesDeRepartos",
    m.movimientos, m.articulos, m."articulosPorDevolucion", m."bytesDelCongelado"
  FROM "Order" o
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS movimientos,
      coalesce(sum(CASE WHEN p.type = 'REFUND' AND jsonb_typeof(p."processorData" -> 'refundedItems') = 'array'
        THEN jsonb_array_length(p."processorData" -> 'refundedItems') ELSE 0 END), 0)::int AS articulos,
      coalesce(max(CASE WHEN p.type = 'REFUND' AND jsonb_typeof(p."processorData" -> 'refundedItems') = 'array'
        THEN jsonb_array_length(p."processorData" -> 'refundedItems') ELSE 0 END), 0)::int AS "articulosPorDevolucion",
      coalesce(max(CASE WHEN p.type = 'REFUND' THEN octet_length((p."processorData" -> 'fiscalByRateCents')::text) END), 0)::int AS "bytesDelCongelado"
    FROM "Payment" p
    WHERE p."orderId" = o.id AND p."venueId" = ${venueId} AND p.status = 'COMPLETED' AND p."createdAt" <= ${utcTs(hasta)}
  ) m
  WHERE o.id IN (${Prisma.join(orderIds)}) AND o."venueId" = ${venueId}
  ORDER BY o.id`

/**
 * De cada devolución, sólo lo que usa el libro, por rutas de jsonb (Codex r5 R5-5): `provenance` y `originalMethod` si son texto,
 * `fiscalByRateCents` (su tamaño ya lo revisó el conteo) y, de cada artículo, `orderItemId` (texto), `quantity`, `amountCents` y
 * `amount` (números), en su orden. Un campo de otro tipo llega como null, que el libro trata igual que hoy.
 */
export const sqlDeLasDevoluciones = (venueId: string, ids: string[]) => Prisma.sql`
  SELECT p.id,
    CASE WHEN jsonb_typeof(p."processorData" -> 'provenance') = 'string' THEN left(p."processorData" ->> 'provenance', 64) END AS provenance,
    CASE WHEN jsonb_typeof(p."processorData" -> 'originalMethod') = 'string' THEN left(p."processorData" ->> 'originalMethod', 64) END AS "originalMethod",
    p."processorData" -> 'fiscalByRateCents' AS "fiscalByRateCents",
    CASE WHEN jsonb_typeof(p."processorData" -> 'refundedItems') = 'array' THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
          'orderItemId', CASE WHEN jsonb_typeof(e.v -> 'orderItemId') = 'string' THEN left(e.v ->> 'orderItemId', 64) END,
          'quantity', CASE WHEN jsonb_typeof(e.v -> 'quantity') = 'number' THEN e.v -> 'quantity' END,
          'amountCents', CASE WHEN jsonb_typeof(e.v -> 'amountCents') = 'number' THEN e.v -> 'amountCents' END,
          'amount', CASE WHEN jsonb_typeof(e.v -> 'amount') = 'number' THEN e.v -> 'amount' END
        ) ORDER BY e.n), '[]'::jsonb)
      FROM jsonb_array_elements(p."processorData" -> 'refundedItems') WITH ORDINALITY AS e(v, n)
    ) END AS "refundedItems"
  FROM "Payment" p
  WHERE p.id IN (${Prisma.join(ids)}) AND p."venueId" = ${venueId} AND p.type = 'REFUND'`

type Tx = Prisma.TransactionClient
type Orden = { id: string; discountAmount: Prisma.Decimal; contratoDePrecio: string | null; originSystem: string | null }
type Conteo = { orderId: string; folio: string } & Record<Tope, number>
const centavos = (d: unknown) => Math.round(Number(d ?? 0) * 100)
const despuesDe = (id: string | undefined) => (id ? { id: { gt: id } } : {})
const cuentaDe = (o: Orden): CuentaDeMezcla => ({
  discountAmount: o.discountAmount,
  contratoDePrecio: o.contratoDePrecio,
  originSystem: o.originSystem,
  orderDiscounts: [],
})
const filasDe = (c: Conteo) => c.renglones + c.descuentos + c.destinos + c.movimientos + c.articulos
const SELECT_RENGLON = {
  id: true,
  orderId: true,
  quantity: true,
  unitPrice: true,
  total: true,
  discountAmount: true,
  orderPromotionId: true,
  isCortesia: true,
  ivaTratamiento: true,
  product: { select: { taxRate: true, ivaTratamiento: true } },
} as const

/** Fallo del controlador (ronda 6): una orden que pasa un tope detiene el reporte, nombrada por su folio; nunca se aproxima. */
function revisarTopes(c: Conteo): void {
  const excede = (Object.keys(TOPES_POR_ORDEN) as Tope[]).filter(k => c[k] > TOPES_POR_ORDEN[k])
  if (excede.length === 0) return
  throw new ValidationError(
    `La venta ${c.folio} tiene demasiados renglones, descuentos o devoluciones para calcular este reporte. Escríbenos a soporte con ese folio.`,
    'REPORT_TOO_LARGE',
    { motivo: 'ORDEN', orderId: c.orderId, folio: c.folio, excede, conteo: c, topes: TOPES_POR_ORDEN },
  )
}

/** Sub-lotes de a lo más TOPE filas y TOPE bytes de repartos, en el orden dado (toda orden permitida cabe sola). */
function enSubLotes(ids: string[], conteo: Map<string, Conteo>): string[][] {
  const lotes: string[][] = []
  let actual: string[] = []
  let filas = 0
  let bytes = 0
  for (const id of ids) {
    const c = conteo.get(id)
    const n = c ? filasDe(c) : 0
    const b = c?.bytesDeRepartos ?? 0
    if (actual.length > 0 && (filas + n > TOPE_DE_FILAS_POR_LOTE || bytes + b > TOPE_DE_BYTES_POR_LOTE)) {
      lotes.push(actual)
      actual = []
      filas = 0
      bytes = 0
    }
    actual.push(id)
    filas += n
    bytes += b
  }
  if (actual.length > 0) lotes.push(actual)
  return lotes
}

/** Cada página de una lectura por id, a quien la pida; no la guarda. */
async function porPaginas<T extends { id: string }>(
  leer: (despues: string | undefined) => Promise<T[]>,
  cadaPagina: (pagina: T[]) => void,
  lectura: LecturaDelLote,
) {
  let ultimo: string | undefined
  for (;;) {
    const pagina = await leer(ultimo)
    lectura.consultas += 1
    lectura.filas += pagina.length
    cadaPagina(pagina)
    if (pagina.length < PAGINA_DE_LIBROS) return
    ultimo = pagina[pagina.length - 1].id
  }
}

/** Los movimientos de estas órdenes, por páginas, por su libro; se sueltan al pasar. */
async function recorrerMovimientos(
  tx: Tx,
  p: { venueId: string; hasta: Date },
  libros: Map<string, Libro>,
  alMovimiento: (m: MovimientoLeido, parte: ParteDelLibro) => void,
  lectura: LecturaDelLote,
): Promise<void> {
  const ids = [...libros.keys()]
  let ultimo: string | undefined
  for (;;) {
    const pagina = await tx.payment.findMany({
      take: PAGINA_DE_LIBROS,
      orderBy: [{ orderId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      ...(ultimo ? { cursor: { id: ultimo }, skip: 1 } : {}),
      where: { orderId: { in: ids }, venueId: p.venueId, status: TransactionStatus.COMPLETED, createdAt: { lte: p.hasta } },
      select: {
        id: true,
        orderId: true,
        createdAt: true,
        type: true,
        amount: true,
        tipAmount: true,
        method: true,
        // Toggle por-merchant: excluir un merchant de los libros fiscales (no del gerencial).
        merchantAccount: { select: { fiscalConfig: { select: { includeInAccounting: true } } } },
        ecommerceMerchant: { select: { fiscalConfig: { select: { includeInAccounting: true } } } },
      },
    })
    lectura.consultas += 1
    lectura.filas += pagina.length
    const devoluciones = pagina.filter(m => m.type === PaymentType.REFUND).map(m => m.id)
    const campos =
      devoluciones.length === 0
        ? []
        : await tx.$queryRaw<Array<{ id: string } & Record<string, unknown>>>(sqlDeLasDevoluciones(p.venueId, devoluciones))
    if (devoluciones.length > 0) lectura.consultas += 1
    lectura.filas += campos.length
    const processorDataDe = new Map<string, unknown>(campos.map(({ id, ...pd }) => [id, pd]))
    for (const m of pagina) {
      if (m.type === PaymentType.TEST) continue // los cobros de prueba no son dinero
      const mov: MovimientoLeido = {
        id: m.id,
        orderId: m.orderId,
        createdAt: m.createdAt,
        type: m.type,
        amountCents: centavos(m.amount),
        tipCents: centavos(m.tipAmount),
        method: m.method,
        processorData: processorDataDe.get(m.id),
        incluirEnContabilidad:
          m.merchantAccount?.fiscalConfig?.includeInAccounting ?? m.ecommerceMerchant?.fiscalConfig?.includeInAccounting,
      }
      alMovimiento(mov, libros.get(m.orderId)!.registrar(mov))
    }
    if (pagina.length < PAGINA_DE_LIBROS) return
    ultimo = pagina[pagina.length - 1].id
  }
}

export async function recorrerLibros(
  tx: Tx,
  p: { venueId: string; orderIds: string[]; hasta: Date },
  alMovimiento: (m: MovimientoLeido, parte: ParteDelLibro) => void,
): Promise<LecturaDelLote> {
  const lectura: LecturaDelLote = { consultas: 0, filas: 0 }
  const pedidas = [...new Set(p.orderIds)]
  if (pedidas.length === 0) return lectura
  // `take` va primero: el candado de findMany busca el tope en los 1200 caracteres que siguen a la llamada.
  const ordenes: Orden[] = await tx.order.findMany({
    take: pedidas.length,
    where: { id: { in: pedidas }, venueId: p.venueId, status: { not: OrderStatus.CANCELLED } },
    select: { id: true, discountAmount: true, contratoDePrecio: true, originSystem: true },
  })
  lectura.consultas += 1
  lectura.filas += ordenes.length
  if (ordenes.length === 0) return lectura
  const porId = new Map(ordenes.map(o => [o.id, o]))
  const conteo = await tx.$queryRaw<Conteo[]>(sqlDelConteo(p.venueId, [...porId.keys()], p.hasta))
  lectura.consultas += 1
  lectura.filas += conteo.length
  for (const c of conteo) revisarTopes(c) // antes de cargar nada: una orden que no cabe no se aproxima

  for (const lote of enSubLotes([...porId.keys()], new Map(conteo.map(c => [c.orderId, c])))) {
    const datos = new Map(lote.map(id => [id, { items: [] as RenglonDeMezcla[], cuenta: cuentaDe(porId.get(id)!) }]))
    await porPaginas(
      despues =>
        tx.orderItem.findMany({
          take: PAGINA_DE_LIBROS,
          orderBy: { id: 'asc' },
          where: { orderId: { in: lote }, ...despuesDe(despues) },
          select: SELECT_RENGLON,
        }),
      pagina => {
        for (const r of pagina) datos.get(r.orderId)!.items.push(r)
      },
      lectura,
    )
    // Fallo 1 de la ronda 7: el reparto, proyectado en la base (`REPARTO_FISCAL`); el ámbito nunca llega a Node.
    // T8-A: UNA consulta por sub-lote, sin página: el conteo ya la acotó (≤ 200 por orden, ≤ 20,000 filas y ≤ 4 MiB por sub-lote).
    const descuentos = await tx.$queryRaw<Array<{ id: string; orderId: string; amount: Prisma.Decimal; reparto: unknown }>>(
      sqlDeLosDescuentos(lote),
    )
    lectura.consultas += 1
    lectura.filas += descuentos.length
    for (const d of descuentos) datos.get(d.orderId)!.cuenta.orderDiscounts!.push(d)
    const libros = new Map<string, Libro>([...datos].map(([id, d]) => [id, abrirLibro(mezclaDeLaOrden(d.items, d.cuenta))]))
    datos.clear()
    await recorrerMovimientos(tx, p, libros, alMovimiento, lectura)
  }
  return lectura
}
