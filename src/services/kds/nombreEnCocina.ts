import { Prisma } from '@prisma/client'

/** Abreviatura de las unidades de peso con que se vende por báscula. */
const ABREVIATURA: Record<string, string> = { KILOGRAM: 'kg', GRAM: 'g', MILLIGRAM: 'mg', POUND: 'lb', OUNCE: 'oz' }

/**
 * Nombre del renglón en la comanda (papel y pantalla). Codex 3.6 (S6): una venta por peso guarda `quantity = 1` y el
 * peso aparte; sin esto la cocina leía «Arrachera ×1» en vez de 0.750 kg. El peso va en el nombre porque la comanda no
 * tiene otro lugar para él y así se ve igual en todas las pantallas y en el papel. Las apps arman el mismo texto.
 */
export function nombreEnCocina(nombre: string, peso: Prisma.Decimal | null | undefined, unidad: string | null | undefined): string {
  if (peso == null) return nombre
  const abreviatura = ABREVIATURA[unidad ?? 'KILOGRAM'] ?? (unidad ?? '').toLowerCase()
  return `${nombre} (${new Prisma.Decimal(peso).toFixed(3)} ${abreviatura})`
}
