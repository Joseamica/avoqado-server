/**
 * Calculadora del cambio de talla o de producto (spec §5.2 y §6.2; índice §2). Pura, en centavos enteros y con redondeo
 * half-up al centavo. ANDROID e iOS espejan la misma regla: los vectores V1–V9 de su prueba son la tabla común.
 */
import { parteDeUnidades } from '../shared/parteDeUnidades'

/** Una pieza que regresa: lo que realmente se cobró por ella y la lista de HOY de su variante (null si ya no tiene). */
export interface ReturnedPiece {
  orderItemId: string
  productGroupId: string | null
  paidCents: number
  listCents: number | null
}

/** Un renglón que se lleva. `listCents` es la lista de HOY de su variante. */
export interface TakenLine {
  productId: string
  productGroupId: string | null
  listCents: number
  quantity: number
  /** Renglón de la venta original cuya rebaja hereda; sólo cuenta si es de la misma familia. */
  inheritsFromOrderItemId: string | null
  /** Precio de una pieza NO heredada, con las reglas de una venta («el más bajo» del que vio la clienta). Sin él, la lista. */
  unitPriceCents?: number
}

export interface TakenPiecePrice {
  lineIndex: number
  priceCents: number
  listCents: number
  inheritedFrom: { orderItemId: string; paidCents: number } | null
}

export interface ExchangeCalculation {
  returnedCents: number
  takenCents: number
  differenceCents: number
  kind: 'EVEN' | 'COLLECT' | 'PAYOUT'
  takenPieces: TakenPiecePrice[]
}

type RefundRowItem = { orderItemId: string; quantity: number; amountCents: number }

/**
 * Lo pagado por la pieza que regresa × (lista nueva ÷ lista de la que regresa), half-up al centavo. Si la que regresa ya no
 * tiene lista (archivada), vale lo pagado. En BigInt para que el producto no pierda exactitud pasado 2^53.
 */
export function inheritedPriceCents(paidCents: number, returnedListCents: number | null, newListCents: number): number {
  if (returnedListCents === null || returnedListCents <= 0) return paidCents
  const list = BigInt(returnedListCents)
  return Number((2n * BigInt(paidCents) * BigInt(newListCents) + list) / (2n * list))
}

/**
 * Cada pieza que se lleva hereda, 1:1 y en el orden en que se agregó, de la siguiente pieza del renglón que señala
 * `inheritsFromOrderItemId`, si es de su misma familia. Lo demás va a `unitPriceCents` (o a la lista), y una pieza de otra
 * familia no se gasta: queda para otro renglón.
 */
export function calculateExchange(returned: ReturnedPiece[], taken: TakenLine[]): ExchangeCalculation {
  const pool = new Map<string, { pieces: ReturnedPiece[]; next: number }>()
  for (const piece of returned) {
    const queue = pool.get(piece.orderItemId) ?? { pieces: [], next: 0 }
    queue.pieces.push(piece)
    pool.set(piece.orderItemId, queue)
  }
  const takenPieces: TakenPiecePrice[] = []
  taken.forEach((line, lineIndex) => {
    const queue = pool.get(line.inheritsFromOrderItemId ?? '') ?? { pieces: [], next: 0 }
    for (let i = 0; i < line.quantity; i++) {
      const piece: ReturnedPiece | undefined = queue.pieces[queue.next]
      if (piece !== undefined && piece.productGroupId !== null && piece.productGroupId === line.productGroupId) {
        queue.next++
        takenPieces.push({
          lineIndex,
          priceCents: inheritedPriceCents(piece.paidCents, piece.listCents, line.listCents),
          listCents: line.listCents,
          inheritedFrom: { orderItemId: piece.orderItemId, paidCents: piece.paidCents },
        })
      } else {
        takenPieces.push({ lineIndex, priceCents: line.unitPriceCents ?? line.listCents, listCents: line.listCents, inheritedFrom: null })
      }
    }
  })
  const returnedCents = returned.reduce((sum, piece) => sum + piece.paidCents, 0)
  const takenCents = takenPieces.reduce((sum, piece) => sum + piece.priceCents, 0)
  const differenceCents = takenCents - returnedCents
  const kind = differenceCents === 0 ? 'EVEN' : differenceCents > 0 ? 'COLLECT' : 'PAYOUT'
  return { returnedCents, takenCents, differenceCents, kind, takenPieces }
}

/**
 * Lo que vale cada una de las siguientes `count` piezas de un renglón: la misma cuenta del reembolso por artículos
 * (`parteDeUnidades` sobre lo que el renglón COBRÓ). El renglón viaja como cuatro números (índice §1.4), así que cuesta
 * O(count), nunca O(cantidad del renglón). Nunca da más de lo que le queda al renglón: si otra devolución ya se llevó más que
 * su parte, se recorta desde la última pieza. Ni negativo: es el tope `max(0, min(parte, cobrado − devuelto))` del escritor de
 * devoluciones, pieza por pieza.
 */
export function pieceValuesCents(
  lineChargedCents: number,
  lineQuantity: number,
  alreadyReturnedQty: number,
  alreadyReturnedCents: number,
  count: number,
): number[] {
  const values = Array.from({ length: count }, (_, j) =>
    Math.max(0, parteDeUnidades(lineChargedCents, lineQuantity, alreadyReturnedQty + j, 1)),
  )
  let excess = values.reduce((sum, value) => sum + value, 0) - Math.max(0, lineChargedCents - alreadyReturnedCents)
  for (let j = count - 1; j >= 0 && excess > 0; j--) {
    const cut = Math.min(values[j], excess)
    values[j] -= cut
    excess -= cut
  }
  return values
}

/**
 * Reparte las piezas que regresan sobre las filas REFUND del cambio, en su orden (primero las de la diferencia, luego las de
 * crédito). Cada pieza vacía sus centavos en la fila en curso, como al mezclar dos listas, y su cantidad 1 queda en la fila
 * que recibe su primer centavo; las demás llevan 0. Una pieza de valor cero no recibe centavos: su cantidad va a la PRIMERA
 * fila, para que cuente devuelta y vuelva al inventario una sola vez (spec §7.1). Por eso se admite la fila de $0 que ancla
 * un cambio donde nada de lo que regresa costó. Se agrupa por (fila, orderItemId): en cada fila Σ amountCents = sus centavos.
 */
export function splitItemsAcrossRefundRows(
  pieces: Array<{ orderItemId: string; cents: number }>,
  rows: Array<{ key: string; cents: number }>,
): Map<string, RefundRowItem[]> {
  const total = (xs: Array<{ cents: number }>) => xs.reduce((sum, x) => sum + x.cents, 0)
  if (total(pieces) !== total(rows) || [...pieces, ...rows].some(x => x.cents < 0) || (pieces.length > 0 && rows.length === 0)) {
    throw new Error(`EXCHANGE_SPLIT_MISMATCH: las piezas suman ${total(pieces)} centavos y las filas ${total(rows)}`)
  }
  const byRow = new Map<string, Map<string, RefundRowItem>>()
  for (const row of rows) byRow.set(row.key, new Map())
  const add = (key: string, orderItemId: string, quantity: number, amountCents: number) => {
    const items = byRow.get(key)!
    const item = items.get(orderItemId) ?? { orderItemId, quantity: 0, amountCents: 0 }
    item.quantity += quantity
    item.amountCents += amountCents
    items.set(orderItemId, item)
  }
  let row = -1
  let left = 0
  for (const piece of pieces) {
    if (piece.cents === 0) {
      add(rows[0].key, piece.orderItemId, 1, 0)
      continue
    }
    let cents = piece.cents
    let quantity = 1
    while (cents > 0) {
      while (left === 0) left = rows[++row].cents
      const take = Math.min(cents, left)
      add(rows[row].key, piece.orderItemId, quantity, take)
      quantity = 0
      cents -= take
      left -= take
    }
  }
  const out = new Map<string, RefundRowItem[]>()
  for (const [key, items] of byRow) out.set(key, [...items.values()])
  return out
}
