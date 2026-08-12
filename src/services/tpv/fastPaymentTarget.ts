/** Lo único que la decisión necesita saber de la fila de arbitraje. */
export interface ArbitrationRowSnapshot {
  orderId: string | null
  venueId: string
  status: string
}

/** Por qué un cobro NO se pudo atar a una venta existente. Sólo para el log/alerta. */
export type FastOrderReason =
  /** No hay fila de arbitraje (cobro nacido EN la terminal, o TPV vieja). */
  | 'noRow'
  /** La fila existe pero nunca tuvo orden (el POS cobró sin mesa). */
  | 'noOrder'
  /** 🔴 La fila pertenece a OTRO venue — colisión de `requestId` entre inquilinos. */
  | 'venueMismatch'

/** A qué venta pertenece el dinero que acaba de cobrar la terminal. */
export type FastPaymentTarget = { kind: 'existingOrder'; orderId: string } | { kind: 'fastOrder'; reason: FastOrderReason }

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
 *
 * 🔴 `expectedVenueId` es OBLIGATORIO a propósito. `TerminalPaymentRequest.requestId` es
 * `@unique` GLOBAL (no por venue) y lo genera el CLIENTE: dos inquilinos pueden colisionar
 * — por accidente o a propósito. Sin comparar el venue, la búsqueda por `requestId`
 * devolvería el `orderId` de OTRO negocio y este cobro se iría a pagar la venta de un
 * tercero. Se degrada a venta rápida (el dinero se registra en el venue correcto, el del
 * token) en vez de cruzar la frontera del inquilino.
 */
export function resolveFastPaymentTarget(row: ArbitrationRowSnapshot | null, expectedVenueId: string): FastPaymentTarget {
  if (!row) return { kind: 'fastOrder', reason: 'noRow' }
  if (row.venueId !== expectedVenueId) return { kind: 'fastOrder', reason: 'venueMismatch' }

  const orderId = row.orderId?.trim()
  // Una cadena vacía no es una orden: pagar "" reventaría o, peor, pagaría cualquier cosa.
  if (!orderId) return { kind: 'fastOrder', reason: 'noOrder' }
  return { kind: 'existingOrder', orderId }
}
