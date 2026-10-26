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
  modifiers: { name: string; price: number; quantity?: number }[]
}

export function productosDelSnapshot(snapshot: unknown): ProductoDelRecibo[] {
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
