/**
 * Tope del importe que capturan las apps (D5 mesas40, 14-oct). Vive aquí para que el server (aviso `🚨 [Sobrepago]` de
 * `payCashOrder`) y el controller de la terminal usen el MISMO número que el teclado de los aparatos.
 *
 * La nota de un artículo (`OrderItem.notes`) NO tiene tope en el server (D5 v5, 15-oct): es identidad de la línea en el
 * carrito completo de la TPV y cada recorte abría una forma de duplicar renglones. El tope de la nota vive en la captura
 * del aparato (Android y TPV, 200).
 */

/** Coincide con la cota del teclado POS Android: $1,000,000.00 por cobro. */
export const MAX_TERMINAL_PAYMENT_CENTS = 100_000_000
