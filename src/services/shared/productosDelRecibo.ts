import { copiaGuardada, productosDeLaCopia } from './lineasDelTicket'

/**
 * D8 (26-oct): los productos de un recibo digital en el formato del correo y del HTML (`name`, `price`, `totalPrice`). El
 * generador del panel los guarda así en `order.items`; el de la terminal (`digitalReceipt.tpv.service.ts`) en `items`, fuera
 * de `order`, con `productName`, `unitPrice` y `total`. El visor del DASHBOARD hace lo mismo (`productosDelRecibo.ts`).
 */
interface ProductoDeLaTerminal {
  productName?: string
  quantity: number
  unitPrice: number
  total: number
  weightKg?: number | null
  modifiers?: { name: string; quantity?: number; price: number }[]
}

export interface ProductoDelRecibo {
  name: string
  quantity: number
  price: number
  totalPrice: number
  weightKg?: number | null
  /** Sin `price`: el modificador de una copia del ticket, que sólo trae su texto (no se pinta precio). */
  modifiers: { name: string; price?: number; quantity?: number }[]
  /** D1, sólo de una copia del ticket: el resumen impreso del peso, la nota del renglón y el área del vale. */
  peso?: string
  nota?: string
  area?: string
  /** D1: «Cortesía» en vez del precio, como el papel. */
  cortesia?: boolean
  /** D1: componente de un combo: «1x Papas», sin precio, debajo del combo. */
  pieza?: boolean
}

export function productosDelSnapshot(snapshot: unknown): ProductoDelRecibo[] {
  // D1 «fotocopia del ticket»: si el cobro guardó los renglones que imprimió, esos mandan, con o sin `parcial` (Codex plan r2 #4).
  const copia = copiaGuardada(snapshot)
  if (copia) return productosDeLaCopia(copia)
  const productos = productosGuardados(snapshot)
  // D15: el recibo de UNA parte de una venta dividida pinta un renglón «Pago parcial» con lo que cobró, como el papel del cobro; sin
  // la marca (venta completa, o recibo de antes de D15) salen sus productos como siempre.
  const totales = (snapshot as { ticketTotals?: { parcial?: boolean; subtotal?: number } | null } | null)?.ticketTotals
  if (totales?.parcial === true && typeof totales.subtotal === 'number' && productos.length) {
    return [{ name: 'Pago parcial', quantity: 1, price: totales.subtotal, totalPrice: totales.subtotal, weightKg: null, modifiers: [] }]
  }
  return productos
}

function productosGuardados(snapshot: unknown): ProductoDelRecibo[] {
  const s = snapshot as { order?: { items?: ProductoDelRecibo[] } | null; items?: ProductoDeLaTerminal[] } | null
  if (s?.order?.items?.length) return s.order.items
  return (s?.items ?? []).map(item => ({
    name: item.productName || 'Producto',
    quantity: item.quantity,
    price: item.unitPrice,
    totalPrice: item.total,
    weightKg: item.weightKg ?? null,
    modifiers: (item.modifiers ?? []).map(m => ({ name: m.name, price: m.price, quantity: m.quantity })),
  }))
}
