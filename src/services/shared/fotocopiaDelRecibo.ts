import { copiaGuardada, copiaValida, type LineaDelTicket, type LineasDelTicket } from './lineasDelTicket'
import { productosDelSnapshot } from './productosDelRecibo'
import { TOPE_DEL_PAPEL_CENTAVOS, ticketTotalsDelSnapshot } from './ticketTotals'

/**
 * Encargo 27fd34 (Codex r5 #1, r6 #1 y r7 #1 de D41): la «fotocopia» de un recibo digital ya emitido, en el formato de la copia D1
 * (`lineasDelTicket`), para que la reimpresión pinte LO MISMO que el recibo: sus renglones, su subtotal y su descuento. Se usa cuando
 * Soporte movió el cobro a otra cuenta después de emitir el recibo (`scripts/reasignar-cobro-a-su-orden.ts`): los renglones de la
 * cuenta nueva no son los del recibo.
 *
 * Sólo si el recibo se puede copiar sin inventar nada; si no, null y la reimpresión queda como hoy:
 * - un cobro (no devolución) sin cargo por servicio ni IVA aparte (la copia no los pinta);
 * - renglones que suman exactamente su subtotal, y subtotal − descuento = lo cobrado sin propina;
 * - centavos que caben en el papel de ANDROID (`Int`) y la copia dentro de su esquema (≤ 100 renglones, 8 KB).
 */
export function fotocopiaDelRecibo(snapshot: unknown): LineasDelTicket | null {
  const totales = ticketTotalsDelSnapshot(snapshot)
  if (!totales || totales.kind !== 'COBRO' || totales.serviceCharge !== 0 || totales.addedTax !== 0) return null
  // El recibo de una parte que guardó su copia D1 ya ES una copia: ésa es la que pintó.
  const d1 = copiaGuardada(snapshot)
  if (d1) return d1
  const productos = productosDelSnapshot(snapshot)
  if (!productos.length) return null
  const centavos = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    const c = Math.round(v * 100)
    return c >= 0 && c <= TOPE_DEL_PAPEL_CENTAVOS ? c : null
  }
  const corta = (t: unknown, max: number) => (typeof t === 'string' ? t.trim().slice(0, max) : '')
  // El renglón pesado dice cuánto se pesó, como el recibo y el papel del cobro («0.435 kg × $420.00/kg»; Codex r1 #4).
  const pesoDe = (p: (typeof productos)[number]) =>
    corta(p.peso, 40) ||
    (typeof p.weightKg === 'number' && p.weightKg > 0 && Number.isFinite(p.weightKg) && Number.isFinite(p.price)
      ? corta(`${p.weightKg.toFixed(3)} kg × $${p.price.toFixed(2)}/kg`, 40)
      : '')
  const lineas: LineaDelTicket[] = []
  for (const p of productos) {
    const unitarioCents = centavos(p.price)
    const totalCents = centavos(p.totalPrice)
    if (
      unitarioCents === null ||
      totalCents === null ||
      !(typeof p.quantity === 'number' && p.quantity > 0 && Number.isFinite(p.quantity))
    ) {
      return null
    }
    const modificadores = (p.modifiers ?? [])
      .map(m => corta(m?.name, 60))
      .filter(Boolean)
      .slice(0, 10)
    lineas.push({
      nombre: corta(p.name, 120) || 'Producto',
      cantidad: p.quantity,
      unitarioCents,
      totalCents,
      ...(modificadores.length ? { modificadores } : {}),
      ...(p.cortesia ? { cortesia: true } : {}),
      ...(p.pieza ? { pieza: true } : {}),
      ...(pesoDe(p) ? { peso: pesoDe(p) } : {}),
      ...(corta(p.nota, 140) ? { nota: corta(p.nota, 140) } : {}),
      ...(corta(p.area, 60) ? { area: corta(p.area, 60) } : {}),
    })
  }
  const subtotalCents = centavos(totales.subtotal)
  const descuentoCents = centavos(totales.discount ?? 0)
  const cobradoCents = centavos(totales.total - totales.tip)
  if (subtotalCents === null || descuentoCents === null || cobradoCents === null) return null
  if (subtotalCents - descuentoCents !== cobradoCents) return null
  return copiaValida({ lineas, subtotalCents, descuentoCents })
}
