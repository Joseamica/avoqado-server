/**
 * Topes de lo que capturan las apps (D5 mesas40, 14-oct). Viven aquí para que el server y el controller de la
 * terminal usen el MISMO número que el teclado de los aparatos.
 */
import { createHash } from 'crypto'

/** Coincide con la cota del teclado POS Android: $1,000,000.00 por cobro. */
export const MAX_TERMINAL_PAYMENT_CENTS = 100_000_000

/** Tope de `OrderItem.notes`. Se RECORTA, nunca se rechaza: la venta o la ronda ya ocurrió en el aparato. */
export const MAX_ITEM_NOTE_CHARS = 500

/**
 * Recorta la nota de un artículo a `MAX_ITEM_NOTE_CHARS` caracteres COMPLETOS (puntos de código: un emoji en el
 * borde queda entero o fuera, nunca medio surrogate). Lo que cabe se devuelve idéntico (sin trim: cada camino
 * conserva su normalización de hoy). Nulo/vacío pasa tal cual.
 *
 * Lo que pasa del tope se guarda como `primeros N + «…» + 8 hex de sha256(nota completa)`, con N tal que el total sea
 * exactamente `MAX_ITEM_NOTE_CHARS`: dos notas largas distintas con el mismo prefijo siguen distintas (D5 v3, Codex P1).
 * Determinista e idempotente: el resultado ya cabe, así que `cap(cap(x)) === cap(x)`.
 *
 * 🔴 NO sirve como IDENTIDAD de una línea: una nota escrita literalmente igual que la forma recortada de otra colisiona
 * con ella (Codex r2). Por eso el carrito completo de la TPV (`addItemsToOrder` con `asNewRound=false`), donde la nota es
 * llave de la fusión y del match contra filas existentes, NO recorta (D5 v4); el tope va sólo en caminos que crean.
 */
export function capItemNote(note: string): string
export function capItemNote(note: string | null | undefined): string | null | undefined
export function capItemNote(note: string | null | undefined): string | null | undefined {
  if (!note || note.length <= MAX_ITEM_NOTE_CHARS) return note
  const chars = Array.from(note)
  if (chars.length <= MAX_ITEM_NOTE_CHARS) return note
  const huella = createHash('sha256').update(note).digest('hex').slice(0, 8)
  return chars.slice(0, MAX_ITEM_NOTE_CHARS - 1 - huella.length).join('') + '…' + huella
}
