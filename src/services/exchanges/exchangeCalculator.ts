/**
 * Calculadora del cambio de talla o de producto (spec `docs/superpowers/specs/2026-10-20-cambio-de-producto-design.md` §5.2 y
 * §6.2). Pura, en centavos enteros y con redondeo half-up al centavo. ANDROID e iOS espejan la misma regla: los vectores V1–V9
 * de su prueba son la tabla común.
 */
import { parteDeUnidades } from '../shared/parteDeUnidades'

/** Una pieza que regresa: lo que realmente se cobró por ella y la lista de HOY de su variante (null si ya no tiene). */
export interface ReturnedPiece {
  orderItemId: string
  /** Sin familia, el producto es su propia familia (spec §5.2). */
  productId: string | null
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
  /** Renglón de la venta original que la cajera emparejó a mano; sólo cuenta si es de la misma familia. */
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

/** Un importe en centavos es un entero seguro y no negativo; otra cosa es un error de quien llama, no un caso de negocio. */
function assertCents(what: string, cents: number): void {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`EXCHANGE_INVALID_CENTS: ${what} debe ser un entero de centavos ≥ 0 (llegó ${cents})`)
  }
}

/** La familia de una pieza: su `productGroupId` o, si no tiene, su propio producto (spec §5.2). */
function familyOf(x: { productGroupId: string | null; productId: string | null }): string | null {
  return x.productGroupId ?? (x.productId === null ? null : `producto:${x.productId}`)
}

/**
 * Lo pagado por la pieza que regresa × (lista nueva ÷ lista de la que regresa), half-up al centavo. Si la que regresa ya no
 * tiene lista (archivada: null o 0), vale lo pagado. En BigInt para que el producto no pierda exactitud pasado 2^53.
 */
export function inheritedPriceCents(paidCents: number, returnedListCents: number | null, newListCents: number): number {
  assertCents('paidCents', paidCents)
  assertCents('newListCents', newListCents)
  if (returnedListCents !== null) assertCents('returnedListCents', returnedListCents)
  if (returnedListCents === null || returnedListCents === 0) return paidCents
  const list = BigInt(returnedListCents)
  return Number((2n * BigInt(paidCents) * BigInt(newListCents) + list) / (2n * list))
}

/**
 * Empareja 1:1 cada pieza que se lleva con una que regresa de su misma familia (spec §5.2). Primero lo que la cajera emparejó a
 * mano: la siguiente pieza del renglón al que apunta `inheritsFromOrderItemId`, si es de la misma familia (si no, no se gasta).
 * Luego lo que quede sin pareja, por familia y en el orden en que se agregó. La pieza emparejada hereda la rebaja; las demás van
 * a `unitPriceCents` (o a la lista).
 */
export function calculateExchange(returned: ReturnedPiece[], taken: TakenLine[]): ExchangeCalculation {
  // Cada pieza que se lleva, en el orden en que se agregó; `from` es la posición en `returned` de la que hereda (-1: ninguna).
  const slots = taken.flatMap((line, lineIndex) => Array.from({ length: line.quantity }, () => ({ line, lineIndex, from: -1 })))
  const paired = returned.map(() => false)
  // Colas de las piezas que regresan y siguen sin pareja, en el orden de entrada.
  const queuesBy = (keyOf: (piece: ReturnedPiece) => string | null) => {
    const queues = new Map<string, { indexes: number[]; next: number }>()
    returned.forEach((piece, i) => {
      const key = keyOf(piece)
      if (key === null || paired[i]) return
      const queue = queues.get(key) ?? { indexes: [], next: 0 }
      queue.indexes.push(i)
      queues.set(key, queue)
    })
    return queues
  }
  const byOrderItem = queuesBy(piece => piece.orderItemId)
  for (const slot of slots) {
    const queue = byOrderItem.get(slot.line.inheritsFromOrderItemId ?? '')
    if (!queue || queue.next >= queue.indexes.length) continue
    const i = queue.indexes[queue.next]
    const family = familyOf(returned[i])
    if (family !== null && family === familyOf(slot.line)) {
      queue.next++
      paired[i] = true
      slot.from = i
    }
  }
  const byFamily = queuesBy(familyOf)
  for (const slot of slots) {
    const family = familyOf(slot.line)
    const queue = slot.from === -1 && family !== null ? byFamily.get(family) : undefined
    if (queue && queue.next < queue.indexes.length) slot.from = queue.indexes[queue.next++]
  }
  const takenPieces = slots.map(({ line, lineIndex, from }): TakenPiecePrice => {
    if (from === -1) return { lineIndex, priceCents: line.unitPriceCents ?? line.listCents, listCents: line.listCents, inheritedFrom: null }
    const piece = returned[from]
    return {
      lineIndex,
      priceCents: inheritedPriceCents(piece.paidCents, piece.listCents, line.listCents),
      listCents: line.listCents,
      inheritedFrom: { orderItemId: piece.orderItemId, paidCents: piece.paidCents },
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
 * (`parteDeUnidades` sobre lo que el renglón COBRÓ). El renglón viaja como cuatro números (spec §5.2), así que cuesta
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
 * que recibe su primer centavo; los pedazos que siguen llevan 0. Una pieza de valor cero no recibe centavos: su cantidad va a la
 * PRIMERA fila, para que cuente devuelta y vuelva al inventario una sola vez (spec §7.1). Por eso se admite la fila de $0 que
 * ancla un cambio donde nada de lo que regresa costó. Se agrupa por fila y `orderItemId`, pero el pedazo sin cantidad nunca se
 * junta con la entrada que sí la lleva: el libro de la orden (`libroDeLaOrden.ts`) topa por unidad la que lleva cantidad, y lo
 * que pasara del tope quedaría sin atribuir. En cada fila, Σ amountCents = sus centavos.
 */
export function splitItemsAcrossRefundRows(
  pieces: Array<{ orderItemId: string; cents: number }>,
  rows: Array<{ key: string; cents: number }>,
): Map<string, RefundRowItem[]> {
  pieces.forEach((piece, i) => assertCents(`pieces[${i}].cents`, piece.cents))
  rows.forEach((row, i) => assertCents(`rows[${i}].cents`, row.cents))
  const byRow = new Map<string, Map<string, RefundRowItem>>()
  for (const row of rows) {
    if (byRow.has(row.key)) throw new Error(`EXCHANGE_DUPLICATE_ROW_KEY: la fila «${row.key}» viene dos veces`)
    byRow.set(row.key, new Map())
  }
  const total = (xs: Array<{ cents: number }>) => xs.reduce((sum, x) => sum + x.cents, 0)
  if (total(pieces) !== total(rows) || (pieces.length > 0 && rows.length === 0)) {
    throw new Error(`EXCHANGE_SPLIT_MISMATCH: las piezas suman ${total(pieces)} centavos y las filas ${total(rows)}`)
  }
  const add = (key: string, orderItemId: string, quantity: number, amountCents: number) => {
    const items = byRow.get(key)!
    const entry = `${quantity > 0 ? 'q' : '0'}:${orderItemId}`
    const item = items.get(entry) ?? { orderItemId, quantity: 0, amountCents: 0 }
    item.quantity += quantity
    item.amountCents += amountCents
    items.set(entry, item)
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
