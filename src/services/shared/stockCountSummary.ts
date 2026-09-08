import { Prisma } from '@prisma/client'

/**
 * La ÚNICA regla de «qué resume un conteo físico». La consumen /mobile,
 * /dashboard y el MCP: si cada uno la reescribiera, divergirían — que es
 * exactamente lo que pasó (el MCP distinguía «sin contar», el dashboard no).
 *
 * Sólo las líneas con `countedAt` cuentan. Una línea sin sello no se contó:
 * su `counted = 0` es un marcador de posición, no un dato. Sumarla como
 * diferencia reportaba la bodega ENTERA de Mindform como faltante.
 */
export interface LineaDeConteo {
  expected: Prisma.Decimal | number | string
  counted: Prisma.Decimal | number | string
  countedAt: Date | string | null
  /** Unidad del insumo; null en líneas de producto (se cuentan en piezas). */
  unit: string | null
}

export interface ResumenDeConteo {
  itemCount: number
  countedCount: number
  matchedCount: number
  mismatchedCount: number
  /** Sólo líneas contadas; una entrada por unidad, ordenadas por nombre de unidad. */
  differenceByUnit: Array<{ unit: string; difference: number }>
}

/** Los productos con inventario se cuentan por pieza. */
export const UNIDAD_DE_PRODUCTO = 'PIECE'

export function resumirConteo(lineas: LineaDeConteo[]): ResumenDeConteo {
  let countedCount = 0
  let matchedCount = 0
  let mismatchedCount = 0
  const porUnidad = new Map<string, Prisma.Decimal>()

  for (const linea of lineas) {
    if (linea.countedAt == null) continue
    countedCount += 1
    // Decimal, nunca flotantes: 0.1 + 0.2 tiene que dar 0.3.
    const diff = new Prisma.Decimal(linea.counted).minus(new Prisma.Decimal(linea.expected))
    if (diff.isZero()) matchedCount += 1
    else mismatchedCount += 1
    const unit = linea.unit ?? UNIDAD_DE_PRODUCTO
    porUnidad.set(unit, (porUnidad.get(unit) ?? new Prisma.Decimal(0)).plus(diff))
  }

  const differenceByUnit = [...porUnidad.entries()]
    .map(([unit, d]) => ({ unit, difference: d.toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP).toNumber() }))
    .sort((a, b) => a.unit.localeCompare(b.unit))

  return { itemCount: lineas.length, countedCount, matchedCount, mismatchedCount, differenceByUnit }
}

export type EstadoParaClientes = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'

/**
 * APPLYING es interno (el claim del confirm). Las apps distribuidas sólo conocen
 * IN_PROGRESS/COMPLETED: mandarles un valor nuevo rompe sus decoders. Para el
 * cliente, un conteo aplicándose sigue «en progreso».
 *
 * 🔴 Traduce SÓLO `APPLYING → IN_PROGRESS`; cualquier otro valor pasa tal cual.
 * NO es el candado que mantiene CANCELLED lejos de las apps — ese candado es el
 * filtro `status: { not: 'CANCELLED' }` de la consulta `/mobile`
 * (`getStockCounts`), que tiene su propia prueba. Confiar en esta función para
 * esconder un estado dejaría pasar el que revienta sus decoders.
 */
export function estadoParaClientes(status: string): EstadoParaClientes {
  return (status === 'APPLYING' ? 'IN_PROGRESS' : status) as EstadoParaClientes
}
