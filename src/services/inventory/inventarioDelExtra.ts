/**
 * Qué inventario mueve un extra, congelado (encargo 27771e, Codex r3: «una sola foto»). Lo guardan el vale de inventario del cobro
 * (`payloadSnapshot`) y el vale por área (`modifiersSnapshot[].inventario`) para que todos los caminos que descuentan lean lo que
 * el extra descontaba al cobrar / al emitir, no lo que el dueño le haya puesto después. Montos como texto (JSON sin floats).
 */
export interface InventarioDelExtra {
  rawMaterialId: string | null
  quantityPerUnit: string | null
  unit: string | null
  inventoryMode: string | null
  linkedProductId: string | null
}

export function inventarioDelExtra(modifier: {
  rawMaterialId?: string | null
  quantityPerUnit?: { toString(): string } | number | string | null
  unit?: string | null
  inventoryMode?: string | null
  linkedProductId?: string | null
}): InventarioDelExtra {
  return {
    rawMaterialId: modifier.rawMaterialId ?? null,
    quantityPerUnit: modifier.quantityPerUnit != null ? String(modifier.quantityPerUnit) : null,
    unit: modifier.unit ?? null,
    inventoryMode: modifier.inventoryMode ?? null,
    linkedProductId: modifier.linkedProductId ?? null,
  }
}

/** ¿La foto trae el inventario del extra? (fotos anteriores al 16-nov-2026 no lo traen: se usa el extra vivo, como antes). */
export function esInventarioDelExtra(valor: unknown): valor is InventarioDelExtra {
  if (!valor || typeof valor !== 'object') return false
  const v = valor as Record<string, unknown>
  return 'rawMaterialId' in v && 'linkedProductId' in v && 'inventoryMode' in v
}
