/**
 * Doble de UNA fila de `Order` con sus marcas de lealtad, cuyo `findMany`/`updateMany` SÍ respetan el `where`.
 *
 * 🔴 Por qué existe (auditoría de Codex, ronda B, 14-oct-2026): la primera prueba de la recuperación durable usaba un
 * `updateMany` que ignoraba sus condiciones, así que no podía ver el cruce que importa — una corrida vieja que cierra la
 * venta DESPUÉS de que la liga tardía la reabrió (B1). Aquí cada condición del `where` se evalúa contra la fila, y una
 * condición que el doble no entiende TRUENA: aprobarla en silencio haría pasar la prueba por el motivo equivocado.
 */
import { Prisma } from '@prisma/client'

export interface FilaDeLealtad {
  id: string
  venueId: string
  total: Prisma.Decimal
  tipAmount: Prisma.Decimal
  loyaltyEligibleAt: Date | null
  loyaltyProcessedAt: Date | null
  loyaltyProcessingAt: Date | null
  loyaltyLastError: string | null
  loyaltyAttempts: number
  loyaltyStaffId: string | null
  customer: { id: string; firstName: string | null; lastName: string | null } | null
  /** Cuántos `OrderCustomer` tiene la venta: lo lee `orderCustomers: { none: {} }`. */
  clientes: number
}

type Condiciones = Record<string, unknown>

export function cumpleElWhere(fila: FilaDeLealtad, where: Condiciones): boolean {
  const campos = fila as unknown as Record<string, unknown>
  return Object.entries(where).every(([campo, condicion]) => {
    if (campo === 'OR') return (condicion as Condiciones[]).some(alternativa => cumpleElWhere(fila, alternativa))
    if (campo === 'orderCustomers') {
      const relacion = condicion as { none?: Condiciones }
      if (relacion.none && Object.keys(relacion.none).length === 0) return fila.clientes === 0
      throw new Error(`El doble no entiende orderCustomers=${JSON.stringify(condicion)}`)
    }
    const valor = campos[campo]
    if (condicion === null) return valor === null
    if (condicion instanceof Date) return valor instanceof Date && valor.getTime() === condicion.getTime()
    if (typeof condicion === 'object') {
      const c = condicion as Record<string, unknown>
      if ('not' in c && c.not === null) return valor !== null && valor !== undefined
      // `{ not: 'texto' }` sobre una columna que admite NULL es `col <> 'texto'` en SQL: NULL no pasa (por eso el cierre «sin
      // cliente» lo combina con `{ col: null }` en un OR). El doble respeta esa regla de SQL, no la de JavaScript.
      if ('not' in c && typeof c.not === 'string') return typeof valor === 'string' && valor !== c.not
      if ('lt' in c) return valor !== null && valor !== undefined && (valor as number | Date) < (c.lt as number | Date)
      throw new Error(`El doble no entiende ${campo}=${JSON.stringify(condicion)}`)
    }
    return valor === condicion
  })
}

function aplicar(fila: FilaDeLealtad, data: Condiciones): void {
  const campos = fila as unknown as Record<string, unknown>
  for (const [campo, valor] of Object.entries(data)) {
    const incremento =
      valor && typeof valor === 'object' && !(valor instanceof Date) ? (valor as { increment?: number }).increment : undefined
    campos[campo] = incremento !== undefined ? (campos[campo] as number) + incremento : valor
  }
}

/** `findMany` y `updateMany` de `order` sobre esa sola fila. */
export function tablaDeUnaVenta(fila: FilaDeLealtad) {
  return {
    findMany: jest.fn(async ({ where }: { where: Condiciones }) => (cumpleElWhere(fila, where) ? [fila] : [])),
    updateMany: jest.fn(async ({ where, data }: { where: Condiciones; data: Condiciones }) => {
      if (!cumpleElWhere(fila, where)) return { count: 0 }
      aplicar(fila, data)
      return { count: 1 }
    }),
  }
}
