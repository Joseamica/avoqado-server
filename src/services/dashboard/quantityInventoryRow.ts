import type { InventoryMethod, Prisma } from '@prisma/client'

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
