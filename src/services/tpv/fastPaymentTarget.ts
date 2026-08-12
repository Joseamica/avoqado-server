/** Lo único que la decisión necesita saber de la fila de arbitraje. */
export interface ArbitrationRowSnapshot {
  orderId: string | null
  venueId: string
  status: string
}

/** A qué venta pertenece el dinero que acaba de cobrar la terminal. */
export type FastPaymentTarget = { kind: 'existingOrder'; orderId: string } | { kind: 'fastOrder' }

/**
 * ¿A qué venta pertenece este cobro?
 *
 * 🔴 El caso que arregla: el cajero manda un cobro desde el POS, cancela, y la terminal
 * cobra igual. Hoy ese dinero cae en una venta sintética `FAST-…` con CERO líneas de
 * producto — así que no se descuenta inventario, los reportes por producto no la ven, y
 * el carrito del cajero sigue mostrando sin pagar algo que el cliente ya pagó. El dinero
 * cuadra y la venta no: el descuadre que nadie reclama porque el total del día sí suma.
 *
 * La información SIEMPRE estuvo ahí: la solicitud de arbitraje guarda el `orderId`.
 *
 * Que la solicitud esté `CANCELLED` no cambia nada: cancelar es una PETICIÓN, y si la
 * terminal cobró igual, la venta ocurrió de verdad.
 */
export function resolveFastPaymentTarget(row: ArbitrationRowSnapshot | null): FastPaymentTarget {
  const orderId = row?.orderId?.trim()
  // Una cadena vacía no es una orden: pagar "" reventaría o, peor, pagaría cualquier cosa.
  if (!orderId) return { kind: 'fastOrder' }
  return { kind: 'existingOrder', orderId }
}
