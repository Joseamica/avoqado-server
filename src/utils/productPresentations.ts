import { Decimal } from '@prisma/client/runtime/library'

/**
 * Conversión de unidades POR PRODUCTO ("presentaciones de compra/salida").
 *
 * El CEDIS compra en una unidad (ej. caja de huevo) y remisiona en otra(s)
 * (cono, caja, kilos). A diferencia de `convertUnit` (que sólo convierte dentro
 * de la MISMA dimensión — kg↔g — y PROHÍBE conteo↔peso), aquí el factor a la
 * unidad base es EXPLÍCITO por producto, así que cruza dimensiones sin adivinar:
 * el operador declara "1 kilo = 18.18 huevos" una vez y el sistema lo respeta.
 *
 * Módulo PURO (Decimal, sin Prisma, sin I/O) para poder testear la aritmética de
 * dinero/inventario al centavo. Un producto SIN presentaciones no pasa por aquí:
 * sigue por `convertUnit` como hoy (byte-idéntico).
 */

/** Una unidad configurada para un insumo, con su equivalencia a la unidad base. */
export interface ProductPresentation {
  /** Nombre libre de la presentación: "cono", "caja", "kilo"… (no es el enum Unit). */
  name: string
  /** Cuántas unidades BASE hay en UNA de esta presentación. Explícito ⇒ cruza dimensiones. */
  factorToBase: Decimal.Value
}

/** El conjunto de presentaciones de un insumo. La unidad base tiene factor 1 implícito. */
export interface PresentationSet {
  /** Unidad base del insumo (su `RawMaterial.unit` — lo que se contabiliza en stock). */
  baseUnit: string
  /** Presentaciones adicionales. La base NO necesita listarse (factor 1). */
  presentations: ProductPresentation[]
}

/** ¿El insumo tiene presentaciones configuradas? Si no, el caller usa `convertUnit`. */
export function hasPresentations(set: PresentationSet | null | undefined): boolean {
  return !!set && set.presentations.length > 0
}

/**
 * Factor a base de una unidad dentro de un producto. La base = 1. Lanza si la
 * unidad no es la base ni una presentación conocida, o si el factor es inválido
 * (no queremos convertir contra un factor 0/negativo/NaN en silencio: es un
 * insumo mal configurado, no algo que coercer).
 */
function factorOf(set: PresentationSet, unitName: string): Decimal {
  if (unitName === set.baseUnit) return new Decimal(1)
  const found = set.presentations.find(p => p.name === unitName)
  if (!found) {
    throw new Error(`Presentación desconocida para este insumo: "${unitName}"`)
  }
  const factor = new Decimal(found.factorToBase)
  if (!factor.isFinite() || factor.lte(0)) {
    throw new Error(`Factor de presentación inválido para "${unitName}"`)
  }
  return factor
}

/**
 * Convierte una cantidad expresada en `fromUnit` a la unidad base del insumo.
 * Es lo que usan recepción/despacho/ajuste antes de tocar `currentStock`
 * (el stock SIEMPRE se contabiliza en base).
 *
 * Ej. huevo base PIEZA: toBaseQuantity(50, "caja") = 18 000; toBaseQuantity(2, "kilo") = 36.36.
 */
export function toBaseQuantity(quantity: Decimal.Value, fromUnit: string, set: PresentationSet): Decimal {
  return new Decimal(quantity).mul(factorOf(set, fromUnit))
}

/**
 * Convierte una cantidad ya expresada en unidad base a una presentación
 * (para mostrar "tienes 18 000 piezas = 50 cajas").
 */
export function fromBaseQuantity(baseQuantity: Decimal.Value, toUnit: string, set: PresentationSet): Decimal {
  return new Decimal(baseQuantity).div(factorOf(set, toUnit))
}

/** Convierte entre dos presentaciones cualesquiera del mismo insumo. */
export function convertBetweenPresentations(quantity: Decimal.Value, fromUnit: string, toUnit: string, set: PresentationSet): Decimal {
  return new Decimal(quantity).mul(factorOf(set, fromUnit)).div(factorOf(set, toUnit))
}

/**
 * Costo por unidad BASE dado el costo por presentación de compra.
 * Ej. compras la caja de huevo a $360 → costo por pieza = 360 / 360 = $1.
 * Sin esto, el costo unitario queda inflado por el factor de empaque.
 */
export function costPerBaseUnit(costPerFromUnit: Decimal.Value, fromUnit: string, set: PresentationSet): Decimal {
  return new Decimal(costPerFromUnit).div(factorOf(set, fromUnit))
}

/**
 * Valida un conjunto de presentaciones antes de guardarlo: sin nombres
 * duplicados (ni chocando con la base), factores finitos y > 0. Mensajes en
 * español (se muestran al usuario vía la capa de servicio).
 */
export function assertValidPresentations(set: PresentationSet): void {
  const seen = new Set<string>([set.baseUnit])
  for (const p of set.presentations) {
    const name = p.name.trim()
    if (name.length === 0) throw new Error('El nombre de la presentación es requerido')
    if (seen.has(name)) throw new Error(`Presentación duplicada: "${name}"`)
    seen.add(name)
    const factor = new Decimal(p.factorToBase)
    if (!factor.isFinite() || factor.lte(0)) {
      throw new Error(`El factor de "${name}" debe ser un número mayor que cero`)
    }
  }
}
