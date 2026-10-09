/**
 * Los niveles de un esquema por niveles que se CREA (fase 3 de Pago al personal, FT-GRAVES S-NIVELES-ATÓMICO).
 *
 * Medido en la QA (D2): crear un esquema por niveles era una cadena, `POST /configs` y luego `/tiers/batch`. Si fallaba lo
 * segundo, quedaba un esquema ACTIVO con tasa plana que sí pagaba. Ahora `POST /configs` (de la sede y de la organización)
 * acepta `tiers` con el MISMO formato del cuerpo de `/tiers/batch`, y el esquema nace con sus niveles en una sola transacción.
 * - Con `calcType: 'TIERED'`, `tiers` es obligatorio (al menos uno).
 * - Niveles en un esquema que no es por niveles se rechazan, para no crear un esquema plano por error.
 * - Cualquier dato inválido da 400 en español, antes de escribir nada.
 * - Sin `tiers` y sin `TIERED`, todo sigue igual.
 */
import { Prisma, ThresholdType, TierPeriod, TierType } from '@prisma/client'
import { BadRequestError } from '../../../errors/AppError'
import { validateRate } from './commission-utils'
import type { CreateCommissionTierInput } from './commission-tier.service'

const esNumero = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function valorDe(opciones: Record<string, string>, valor: unknown, que: string): void {
  if (valor !== undefined && valor !== null && !Object.values(opciones).includes(valor as string)) {
    throw new BadRequestError(`${que} no es válido.`)
  }
}

/** Valida los niveles del esquema que se crea. Devuelve los niveles listos, o `undefined` si no es por niveles ni los trae. */
export function nivelesAlCrear(calcType: unknown, tiers: unknown, metaComoNivel?: unknown): CreateCommissionTierInput[] | undefined {
  const porNiveles = calcType === 'TIERED'
  if (tiers === undefined || tiers === null) {
    // «Meta como nivel»: el nivel es la meta de ventas de cada persona, así que un TIERED así no necesita `tiers`.
    if (porNiveles && metaComoNivel !== true) throw new BadRequestError('Un esquema por niveles necesita al menos un nivel.')
    return undefined
  }
  if (!porNiveles) throw new BadRequestError('Los niveles sólo aplican a un esquema por niveles: manda calcType «TIERED».')
  if (!Array.isArray(tiers) || tiers.length === 0) throw new BadRequestError('Un esquema por niveles necesita al menos un nivel.')

  const vistos = new Set<number>()
  for (const t of tiers as Array<Record<string, unknown>>) {
    if (!t || typeof t !== 'object') throw new BadRequestError('Cada nivel debe traer sus datos.')
    const nivel = t.tierLevel
    if (typeof nivel !== 'number' || !Number.isInteger(nivel) || nivel < 1) {
      throw new BadRequestError('El número de cada nivel debe ser un entero desde 1.')
    }
    if (typeof t.name !== 'string' || !t.name.trim()) throw new BadRequestError('Cada nivel necesita un nombre.')
    if (!esNumero(t.minThreshold) || t.minThreshold < 0) throw new BadRequestError('El mínimo de cada nivel debe ser un número desde 0.')
    if (t.maxThreshold !== undefined && t.maxThreshold !== null && (!esNumero(t.maxThreshold) || t.maxThreshold <= t.minThreshold)) {
      throw new BadRequestError('El máximo de un nivel tiene que ser mayor que su mínimo.')
    }
    validateRate(t.rate as number, 'La tasa de un nivel')
    valorDe(TierType, t.tierType, 'El tipo de nivel')
    valorDe(TierPeriod, t.period, 'El periodo del nivel')
    valorDe(ThresholdType, t.minThresholdType, 'El tipo de mínimo del nivel')
    valorDe(ThresholdType, t.maxThresholdType, 'El tipo de máximo del nivel')
    if (vistos.has(nivel)) throw new BadRequestError(`El nivel ${nivel} está repetido.`)
    vistos.add(nivel)
  }

  // Los rangos no se enciman: la MISMA regla (y el mismo texto) que `/tiers/batch`.
  const ordenados = [...(tiers as CreateCommissionTierInput[])].sort((a, b) => a.tierLevel - b.tierLevel)
  for (let i = 0; i < ordenados.length - 1; i++) {
    const actual = ordenados[i]
    const siguiente = ordenados[i + 1]
    const maximo = actual.maxThreshold ?? Infinity
    if (maximo > siguiente.minThreshold) {
      throw new BadRequestError(
        `El límite máximo del nivel ${actual.tierLevel} ($${maximo}) se sobrepone con el mínimo del nivel ${siguiente.tierLevel} ($${siguiente.minThreshold})`,
      )
    }
  }
  return tiers as CreateCommissionTierInput[]
}

/** Las filas de los niveles, con los mismos valores de fábrica que `/tiers/batch`. */
export function nivelesParaGuardar(configId: string, tiers: CreateCommissionTierInput[]): Prisma.CommissionTierCreateManyInput[] {
  return tiers.map(t => ({
    configId,
    tierLevel: t.tierLevel,
    tierName: t.name,
    tierType: t.tierType ?? TierType.BY_AMOUNT,
    minThreshold: t.minThreshold,
    maxThreshold: t.maxThreshold ?? null,
    minThresholdType: t.minThresholdType ?? ThresholdType.FIXED,
    maxThresholdType: t.maxThresholdType ?? ThresholdType.FIXED,
    rate: t.rate,
    tierPeriod: t.period ?? TierPeriod.MONTHLY,
  }))
}
