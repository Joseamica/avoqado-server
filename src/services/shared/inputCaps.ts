/**
 * Topes de lo que capturan las apps (D5 mesas40, 14-oct). Viven aquí para que el server y el controller de la
 * terminal usen el MISMO número que el teclado de los aparatos.
 */

/** Coincide con la cota del teclado POS Android: $1,000,000.00 por cobro. */
export const MAX_TERMINAL_PAYMENT_CENTS = 100_000_000

/** Tope de `OrderItem.notes`. Se RECORTA, nunca se rechaza: la venta o la ronda ya ocurrió en el aparato. */
export const MAX_ITEM_NOTE_CHARS = 500

/**
 * Recorta la nota de un artículo a `MAX_ITEM_NOTE_CHARS` caracteres COMPLETOS (puntos de código: un emoji en el
 * borde queda entero o fuera, nunca medio surrogate). Lo que cabe se devuelve idéntico (sin trim: cada camino
 * conserva su normalización de hoy). Nulo/vacío pasa tal cual.
 */
export function capItemNote(note: string): string
export function capItemNote(note: string | null | undefined): string | null | undefined
export function capItemNote(note: string | null | undefined): string | null | undefined {
  if (!note || note.length <= MAX_ITEM_NOTE_CHARS) return note
  return Array.from(note).slice(0, MAX_ITEM_NOTE_CHARS).join('')
}
