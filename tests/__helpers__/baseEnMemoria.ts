/**
 * D661: un `where` de Prisma evaluado sobre filas en memoria, para que las pruebas de topes cuenten FILAS (lo que el filtro de verdad
 * selecciona) y no la forma del filtro. Sólo lo que usan los ayudantes de `online-ordering/constants.ts`: igualdad, `not`, `in`,
 * `notIn`, `gt` de fechas, una ruta JSON (`path` + `equals`), `AND`, `OR` y una relación anidada (`order: { … }`).
 * Como en Postgres, un `not` sobre un valor ausente no empata, y `campo: null` empata con un campo ausente (es NULL).
 */
export function cumpleWhere(fila: any, where: Record<string, any>): boolean {
  return Object.entries(where).every(([campo, condicion]) => {
    if (campo === 'AND') return (condicion as Record<string, any>[]).every(w => cumpleWhere(fila, w))
    if (campo === 'OR') return (condicion as Record<string, any>[]).some(w => cumpleWhere(fila, w))
    const valor = fila?.[campo]
    if (condicion === null) return valor === null || valor === undefined
    if (typeof condicion !== 'object' || condicion instanceof Date) return valor === condicion
    if ('path' in condicion) return (condicion.path as string[]).reduce((o, k) => o?.[k], valor) === condicion.equals
    if ('gt' in condicion) return valor instanceof Date && valor.getTime() > condicion.gt.getTime()
    if ('not' in condicion) return valor !== undefined && valor !== null && valor !== condicion.not
    if ('in' in condicion) return condicion.in.includes(valor)
    if ('notIn' in condicion) return !condicion.notIn.includes(valor)
    return cumpleWhere(valor, condicion)
  })
}

/** Cuenta como `count({ where })` sobre la lista. */
export const contar =
  (filas: any[]) =>
  async ({ where }: { where: Record<string, any> }) =>
    filas.filter(f => cumpleWhere(f, where)).length
