/**
 * Contrato de precio de una venta: ¿el precio cobrado YA traía el IVA (la norma en México), o el IVA se sumó
 * encima? Lo declara cada escritor de `Order` al crear (prueba de arquitectura `orderContratoDePrecioWriters`) y lo
 * lee la facturación (plan 3) para decidir si una venta con IVA mixto (0 %, exento) se puede facturar. Nunca se
 * infiere de `source` ni de `taxAmount`: una igualdad de totales no demuestra la naturaleza del precio (Codex r4).
 */
export type ContratoDePrecio = 'IVA_INCLUIDO' | 'IVA_APARTE' | 'DESCONOCIDO'

/** Fusión de dos cuentas: si no coinciden, ya no se sabe (spec v5). La fusión nunca se bloquea por esto. */
export function combinarContratos(a: ContratoDePrecio, b: ContratoDePrecio): ContratoDePrecio {
  return a === b ? a : 'DESCONOCIDO'
}

/** Cobro manual del dashboard sin orden: sólo un IVA tecleado > 0 demuestra «aparte»; lo demás no se adivina. */
export function contratoDePagoManual(taxAmount: unknown): ContratoDePrecio {
  const n = typeof taxAmount === 'number' ? taxAmount : typeof taxAmount === 'string' && taxAmount.trim() !== '' ? Number(taxAmount) : NaN
  return Number.isFinite(n) && n > 0 ? 'IVA_APARTE' : 'DESCONOCIDO'
}
