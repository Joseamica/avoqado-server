/**
 * C2 A-R1/A-R3/A-R4 (decisión A del founder, 9-oct): el ÚNICO cargador de «lo que cobró cada renglón» de UNA orden. Lo usan el escritor
 * de devoluciones (`issueRefund`, dentro de su transacción y después del candado del cobro) y los dos detalles que alimentan las
 * pantallas (POS móvil y dashboard), para que lo que la pantalla ofrece y lo que el servidor devuelve nunca difieran.
 * Lecturas acotadas: la cabecera por id, los renglones y los descuentos de la orden con los topes del libro (`TOPES_POR_ORDEN`), uno de
 * más para saber si los pasa. El reparto de cada descuento llega PROYECTADO (`REPARTO_FISCAL`): el ámbito nunca sale de la base.
 */
import { Prisma } from '@prisma/client'
import { SELECT_RENGLON, TOPES_POR_ORDEN, sqlDeLosDescuentos } from './librosDeOrdenes'
import { cobradoPorRenglon } from './mezclaDeOrden'

type Db = Pick<Prisma.TransactionClient, 'order' | 'orderItem' | '$queryRaw'>

/** Por qué no se puede devolver por artículos (C2 A-1 ronda 1, M1): el 400 dice la causa real y manda a devolver por importe. */
export const NO_SE_PUEDE_POR_ARTICULOS = {
  DESCUENTOS: 'Esta venta tiene descuentos que no se pueden repartir por artículo; haz la devolución por importe.',
  TOPE: 'Esta venta tiene demasiados artículos, descuentos o devoluciones para devolverla por artículo; haz la devolución por importe.',
  SIN_ORDEN: 'No se encontró la venta de este cobro; haz la devolución por importe.',
  SIN_ARTICULO: 'No se pudo leer lo que cobró este artículo; haz la devolución por importe.',
} as const

export type CobradoDeLaOrden = {
  /** A-R3: false ⇒ no se puede decir cuánto cobró cada renglón; la devolución por artículos se rechaza y `chargedTotal` se omite. */
  atribuible: boolean
  /** El texto del 400 cuando no es atribuible; null si lo es. */
  motivo: string | null
  /** Los renglones leídos (la regla de promociones del escritor los usa). */
  renglones: Array<Prisma.OrderItemGetPayload<{ select: typeof SELECT_RENGLON }>>
  /** Centavos que cobró cada renglón COMPLETO, por id; vacío si no es atribuible. */
  cobradoCents: Map<string, number>
}

export async function leerCobradoDeLaOrden(db: Db, orderId: string): Promise<CobradoDeLaOrden> {
  const orden = await db.order.findUnique({
    where: { id: orderId },
    select: { discountAmount: true, contratoDePrecio: true, originSystem: true },
  })
  // `take` va primero: el candado de findMany busca el tope en los caracteres que siguen a la llamada.
  const renglones = await db.orderItem.findMany({
    take: TOPES_POR_ORDEN.renglones + 1,
    where: { orderId },
    orderBy: { id: 'asc' },
    select: SELECT_RENGLON,
  })
  const descuentos = await db.$queryRaw<Array<{ amount: Prisma.Decimal; reparto: unknown }>>(
    Prisma.sql`${sqlDeLosDescuentos([orderId])} LIMIT ${TOPES_POR_ORDEN.descuentos + 1}`,
  )
  // Una orden que pasa un tope no se aproxima: no es atribuible (en producción, 5-oct: a lo más 62 renglones y 2 descuentos).
  const cabe = orden !== null && renglones.length <= TOPES_POR_ORDEN.renglones && descuentos.length <= TOPES_POR_ORDEN.descuentos
  const c = cabe ? cobradoPorRenglon(renglones, { ...orden, orderDiscounts: descuentos }) : null
  return {
    atribuible: c?.atribuible ?? false,
    motivo:
      orden === null
        ? NO_SE_PUEDE_POR_ARTICULOS.SIN_ORDEN
        : !cabe
          ? NO_SE_PUEDE_POR_ARTICULOS.TOPE
          : c?.atribuible
            ? null
            : NO_SE_PUEDE_POR_ARTICULOS.DESCUENTOS,
    renglones,
    cobradoCents: new Map(c?.atribuible ? c.renglones.map(r => [r.llave, r.cents] as const) : []),
  }
}

/** A-R4: lo que cobró el renglón completo, en pesos; `undefined` (el campo se omite) si la orden no es atribuible. */
export function chargedTotalDe(c: CobradoDeLaOrden | null, orderItemId: string): number | undefined {
  const cents = c?.cobradoCents.get(orderItemId)
  return cents === undefined ? undefined : cents / 100
}
