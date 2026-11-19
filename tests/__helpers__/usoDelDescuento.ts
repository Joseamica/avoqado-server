/**
 * D19 (encargo 01765a): doble del contador de usos (`src/services/shared/usoDelDescuento.ts`) para pruebas con `prismaMock`.
 *
 * Envuelve el `$queryRaw` que ya tenga la prueba: contesta el candado del descuento (`pg_advisory_xact_lock`) y la pasada de filas
 * `Discount` (`FOR NO KEY UPDATE`) leyendo cada descuento con el `discount.findFirst` de la prueba; lo demás va al doble de antes.
 */
import { prismaMock } from './setup'

export function contestarFilasDeDescuentos(): void {
  const antes = prismaMock.$queryRaw.getMockImplementation()
  prismaMock.$queryRaw.mockImplementation(async (consulta: any, ...valores: any[]) => {
    const sql: string = Array.isArray(consulta) ? consulta.join('?') : (consulta?.sql ?? String(consulta))
    if (sql.includes('pg_advisory_xact_lock')) return [{}] as any
    if (sql.includes('FROM "Discount"') && sql.includes('FOR NO KEY UPDATE')) {
      const [venueId, ids] = valores as [string, string[]]
      // Cada descuento como lo dé la prueba: `findFirst` (el de la cuenta) o, si no, `findMany` (los de renglón).
      const leer = async (id: string) =>
        (await prismaMock.discount.findFirst({ where: { id, venueId } } as any)) ??
        ((await prismaMock.discount.findMany({ where: { id: { in: [id] }, venueId } } as any)) as any[] | undefined)?.find(
          (d: any) => d?.id === id,
        ) ??
        null
      const filas = await Promise.all(ids.map(leer))
      return filas
        .filter(Boolean)
        .map((d: any) => ({ id: d.id, name: d.name, currentUses: d.currentUses ?? 0, maxTotalUses: d.maxTotalUses ?? null })) as any
    }
    return antes ? antes(consulta, ...valores) : ([] as any)
  })
}

/** Los ids de descuento a los que se les sumó un uso (`discount.update` con `increment`), en orden. */
export function usosSumados(): string[] {
  return (prismaMock.discount.update as jest.Mock).mock.calls
    .filter(([a]) => a?.data?.currentUses?.increment === 1)
    .map(([a]) => a.where.id as string)
}
