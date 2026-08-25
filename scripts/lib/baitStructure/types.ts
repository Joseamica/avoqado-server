export type Puesto = 'SUPERVISOR' | 'PROMOTOR' | 'CUBRE_DESCANSO'

/** Un renglón del Excel "Estructura BAIT.xlsx", ya interpretado. */
export interface StructureRow {
  /** Columna "ID": número de empleado de Bait, p.ej. "BEQJURR8002". */
  employeeCode: string
  fullName: string
  puesto: Puesto
  estado: string
  ciudad: string
  /** Columna "ID de Tienda" cuando es numérica; null en supervisores, cubre descanso y activaciones. */
  storeId: string | null
  /** "BAE" | "WE" | "MB" | null */
  formato: string | null
  storeName: string | null
  /** employeeCode del supervisor bajo el que aparece la fila; null si la fila ES el supervisor. */
  supervisorCode: string | null
  isVacante: boolean
}
