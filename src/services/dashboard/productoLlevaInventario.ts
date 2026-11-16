/**
 * ¿El alta lleva inventario? La MISMA regla con que el paso 2 del asistente decide si lo configura
 * (`configureInventoryStep2`): sin «lleva inventario» o sin método, el producto nace sin inventario y el paso 3 no corre.
 *
 * La usa también el candado de plan de `/wizard/complete` (`src/routes/dashboard/inventory.routes.ts`): dar de alta un
 * producto SIN inventario es de todos los planes; sólo el alta CON inventario pide INVENTORY_TRACKING (D8, 16-nov-2026).
 * Módulo puro, sin efectos al importarse: la ruta lo lee sin cargar el servicio.
 */
export function productoLlevaInventario(data: { useInventory?: unknown; inventoryMethod?: unknown } | null | undefined): boolean {
  return Boolean(data?.useInventory && data?.inventoryMethod)
}
