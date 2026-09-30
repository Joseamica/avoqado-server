import type { InventoryMethod, Prisma } from '@prisma/client'

/**
 * Método de inventario de un producto NUEVO. Las altas (Artículos de Android/iOS, dashboard, alta
 * rápida del TPV) guardaban `trackInventory` y tiraban el método: el producto nacía «con inventario»
 * pero sin método, sin merma ni descuento en la venta. Sin inventario ⇒ null; con inventario, el que
 * se pidió y, si no llegó ninguno (apps viejas, alta rápida por código de barras), «por cantidad».
 */
export function inventoryMethodForNewProduct(trackInventory: unknown, inventoryMethod: unknown): InventoryMethod | null {
  if (trackInventory !== true) return null
  return inventoryMethod === 'RECIPE' ? 'RECIPE' : 'QUANTITY'
}

/** Tipos que no llevan existencias: una clase, una cita, algo digital o un donativo no se cuentan. */
const NON_INVENTORIABLE_TYPES = ['CLASS', 'APPOINTMENTS_SERVICE', 'DIGITAL', 'DONATION']
export const NON_INVENTORIABLE_MESSAGE = 'Este tipo de producto no puede tener seguimiento de inventario'

/**
 * ¿Pide inventario un tipo que no lo lleva? La regla es UNA para el dashboard (Zod) y para Artículos de
 * Android/iOS: sin ella, un servicio nacía «por cantidad» y la venta le descontaba existencias.
 */
export function isNonInventoriable(type: unknown, trackInventory: unknown): boolean {
  return trackInventory === true && NON_INVENTORIABLE_TYPES.includes(String(type ?? ''))
}

/**
 * 🔴 Invariante: producto «por cantidad» (trackInventory + QUANTITY) ⇒ tiene fila de Inventory.
 *
 * Sin ella el producto no aparece en «Registrar merma» (INNER JOIN de `catalogSql`) y la venta
 * lanza «No inventory record for product». Llámalo después de CADA escritura que pueda dejar el
 * producto por cantidad, en la MISMA transacción, con el producto YA escrito (su estado final).
 *
 * La fila nace en 0 y sin movimiento de kardex (saldo 0 no es movimiento, misma regla que el
 * asistente). `skipDuplicates` = `ON CONFLICT DO NOTHING`: una fila existente no se toca, y dos
 * activaciones simultáneas no chocan. Módulo sin `prisma` a propósito: recibe la transacción,
 * así ningún `jest.mock` de un servicio de inventario lo deja `undefined` en su llamador.
 */
export async function ensureQuantityInventoryRow(
  tx: Pick<Prisma.TransactionClient, 'inventory'>,
  product: { id: string; venueId: string; trackInventory: boolean; inventoryMethod: InventoryMethod | null },
): Promise<void> {
  if (!product.trackInventory || product.inventoryMethod !== 'QUANTITY') return
  await tx.inventory.createMany({
    data: [{ productId: product.id, venueId: product.venueId, currentStock: 0, minimumStock: 0 }],
    skipDuplicates: true,
  })
}
