/**
 * Qué se puede editar de un esquema de comisión que ya tiene comisiones calculadas (fase 3 de Pago al personal, FT-GRAVES B1).
 *
 * Cada comisión calculada guarda su tasa y su tipo, y el esquema no se reescribe hacia atrás. Por eso, con comisiones
 * calculadas, la tasa (el monto en un fijo), el tipo, a quién se le paga y cuándo se calcula NO cambian: el dueño desactiva el
 * esquema y crea uno nuevo. Todo lo demás (nombre, descripción, fechas, base con o sin IVA, a quién aplica, desactivar) sí.
 *
 * Medido el 8-oct: el candado rechazaba que esos cuatro campos VINIERAN aunque fueran iguales a lo guardado, y el editor del
 * dashboard los manda siempre. Tras la primera venta no se podía cambiar ni el nombre, con un 400 en inglés. Ahora un campo que
 * llega con el MISMO valor guardado se quita, porque no es un cambio (y no se revalida: una tasa vieja anterior a las reglas de
 * hoy no bloquea cambiar el nombre). Con comisiones calculadas, sólo un valor DISTINTO da el 400 en español.
 */
import { Prisma } from '@prisma/client'
import { BadRequestError } from '../../../errors/AppError'

const FIJOS = ['defaultRate', 'calcType', 'recipient', 'trigger'] as const
type CampoFijo = (typeof FIJOS)[number]

export interface EsquemaGuardado {
  defaultRate: { toString(): string }
  calcType: string
  recipient: string
  trigger: string
}

/** ¿Lo que llega es lo guardado? La tasa se compara a la escala de su columna, `Decimal(12, 4)`: lo mismo que quedaría guardado. */
function esLoGuardado(campo: CampoFijo, valor: unknown, guardado: EsquemaGuardado): boolean {
  if (campo !== 'defaultRate') return valor === guardado[campo]
  if (typeof valor !== 'number' && typeof valor !== 'string') return false
  try {
    return new Prisma.Decimal(valor).toDecimalPlaces(4).equals(new Prisma.Decimal(guardado.defaultRate.toString()))
  } catch {
    return false // no es un número: lo decide la validación de la tasa
  }
}

/** El cuerpo sin los campos fijos que llegan con el MISMO valor guardado (no son cambios). No toca el original. */
export function sinLoQueNoCambia<T extends Partial<Record<CampoFijo, unknown>>>(datos: T, guardado: EsquemaGuardado): T {
  const salida: Record<string, unknown> = { ...datos }
  for (const campo of FIJOS) if (salida[campo] !== undefined && esLoGuardado(campo, salida[campo], guardado)) delete salida[campo]
  return salida as T
}

function nombreDelCampo(campo: CampoFijo, calcType: string): string {
  if (campo === 'defaultRate') return calcType === 'FIXED' ? 'el monto fijo' : 'la tasa'
  if (campo === 'calcType') return 'el tipo de comisión'
  if (campo === 'recipient') return 'a quién se le paga'
  return 'cuándo se calcula'
}

/**
 * Con comisiones calculadas, un cambio de un campo fijo es un 400 que dice qué hacer. Recibe el cuerpo YA sin lo que no cambia
 * (`sinLoQueNoCambia`). `code` y `details` dejan al cliente pintar su propio texto.
 */
export function rechazarCambiosConComisiones(
  datos: Partial<Record<CampoFijo, unknown>>,
  guardado: EsquemaGuardado,
  comisiones: number,
): void {
  const campo = FIJOS.find(c => datos[c] !== undefined)
  if (comisiones <= 0 || !campo) return
  const cuantas = comisiones === 1 ? '1 comisión calculada' : `${comisiones} comisiones calculadas`
  throw new BadRequestError(
    `Este esquema ya tiene ${cuantas} y no se puede cambiar ${nombreDelCampo(campo, guardado.calcType)}. ` +
      'Desactívalo y crea uno nuevo con el cambio.',
    'ESQUEMA_CON_COMISIONES',
    { campo, comisiones },
  )
}
