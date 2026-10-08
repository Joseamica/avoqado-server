/**
 * Qué tasas acepta la API al guardar un esquema de comisión (fase 3 de Pago al personal, final-fijo-niveles).
 *
 * `CommissionConfig.defaultRate` es una TASA (0.0300 = 3 %) en porcentaje, niveles y los demás tipos, pero en un esquema de
 * MONTO FIJO es el monto en pesos que se paga por venta (`commission-calculation.service.ts:177-179`). Por eso la regla de
 * 0-100 % NO aplica al fijo. La columna es Decimal(5,4): el monto de un fijo cabe hasta $9.9999.
 *
 * Medido el 8-oct contra Postgres: el asistente del dashboard, con «Monto fijo» y niveles, mandaba TIERED con
 * `defaultRate = fixedAmount`; por la ruta de la organización (que no validaba nada) un fijo de $5 quedaba como tasa de 500 % y
 * una venta de $116 fuera de nivel comisionaba $500. Por la de la sede, `validateRate` respondía 500 sin explicar nada, y con eso
 * tampoco se podía crear un fijo de más de $1.
 *
 * Todos los errores son 400 en español: el dashboard pinta el mensaje tal cual.
 */
import { BadRequestError } from '../../../errors/AppError'

/** Decimal(5,4): 9.99995 ya se redondea a 10.0000 y no cabe. Se mide en diezmilésimas para no depender del redondeo. */
const DIEZMILESIMAS_MAXIMAS_DEL_FIJO = 99_999

const enPorcentaje = (tasa: number) => `${Number((tasa * 100).toFixed(2))} %`
const esNumero = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** Una tasa (0.03 = 3 %) va de 0 % a 100 %, los dos incluidos. `que` nombra la tasa en el mensaje. */
export function validarTasa(tasa: unknown, que = 'La tasa de comisión', pista = ''): void {
  if (!esNumero(tasa)) throw new BadRequestError(`${que} debe ser un número.`)
  if (tasa < 0 || tasa > 1) throw new BadRequestError(`${que} va de 0 % a 100 %: ${enPorcentaje(tasa)} no es válida.${pista}`)
}

/** La tasa del esquema según su tipo: en un FIJO es el monto en pesos; en todo lo demás, una tasa de 0 a 100 %. */
export function validarTasaDelEsquema(calcType: string | null | undefined, defaultRate: unknown): void {
  if (calcType === 'FIXED') {
    if (!esNumero(defaultRate)) throw new BadRequestError('El monto fijo por venta debe ser un número.')
    if (defaultRate < 0) throw new BadRequestError('El monto fijo por venta no puede ser negativo.')
    if (Math.round(defaultRate * 10_000) > DIEZMILESIMAS_MAXIMAS_DEL_FIJO) {
      throw new BadRequestError('Por ahora el monto fijo por venta puede ser de hasta $9.99.')
    }
    return
  }
  validarTasa(defaultRate, 'La tasa de comisión', ' Si querías pagar un monto fijo por venta, elige «Monto fijo».')
}

interface TasasQueLlegan {
  calcType?: string | null
  defaultRate?: unknown
  roleRates?: unknown
  goalBonusRate?: unknown
}

/**
 * Todas las tasas de un esquema que se crea (`existente` ausente) o se actualiza. Al actualizar se valida lo que QUEDA: un tipo
 * nuevo con la tasa de antes (un fijo de $5 que pasa a niveles sería 500 %) o una tasa nueva con el tipo de antes. Lo que no
 * toca la tasa no la revalida.
 */
export function validarTasasDelEsquema(
  datos: TasasQueLlegan,
  existente?: { calcType: string; defaultRate: number | { toString(): string } },
): void {
  if (!existente || datos.defaultRate !== undefined || datos.calcType !== undefined) {
    const tasa = datos.defaultRate !== undefined ? datos.defaultRate : existente ? Number(existente.defaultRate.toString()) : undefined
    validarTasaDelEsquema(datos.calcType ?? existente?.calcType ?? 'PERCENTAGE', tasa)
  }
  if (datos.roleRates && typeof datos.roleRates === 'object') {
    for (const [rol, tasa] of Object.entries(datos.roleRates)) validarTasa(tasa, `La tasa del rol ${rol}`)
  }
  if (datos.goalBonusRate !== undefined && datos.goalBonusRate !== null) validarTasa(datos.goalBonusRate, 'La tasa por meta superada')
}
