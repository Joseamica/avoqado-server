import { Prisma } from '@prisma/client'

/** Foto del descuento guardada en `PaymentLink.discount`. */
export type DescuentoDeLiga = {
  v: 1
  origen: 'MANUAL' | 'CATALOGO'
  discountId: string | null
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: number
  name: string
}

export type MotivoNoDisponible = 'VENCIDO' | 'NO_INICIA' | 'AGOTADO' | 'FUERA_DE_HORARIO' | 'MINIMO' | 'INACTIVO'

export type Desglose = {
  base: number
  descuento: number
  neto: number
  aplica: boolean
  motivo: MotivoNoDisponible | null
  nombre: string | null
}

/** Reglas vigentes del descuento del catálogo (leídas al momento). `null` para MANUAL. */
export type ReglaDelCatalogo = {
  active: boolean
  validFrom: Date | null
  validUntil: Date | null
  /** 0-6 = domingo-sábado; vacío = todos los días. */
  daysOfWeek: number[]
  /** "HH:MM" en la zona del negocio; null = todo el día. */
  timeFrom: string | null
  timeUntil: string | null
  minPurchaseAmount: number | null
  maxDiscountAmount: number | null
  existe: boolean
  compatible: boolean
}

const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Día de la semana (0-6) y "HH:MM" en la zona del negocio. */
function diaYHora(ahora: Date, zona: string): { dia: number; hhmm: string } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ahora)
  const get = (t: string) => partes.find(p => p.type === t)?.value ?? ''
  return { dia: DIAS.indexOf(get('weekday')), hhmm: `${get('hour')}:${get('minute')}` }
}

function motivoDeCatalogo(r: ReglaDelCatalogo, ahora: Date, zona: string): MotivoNoDisponible | null {
  if (!r.existe || !r.compatible || !r.active) return 'INACTIVO'
  if (r.validFrom && r.validFrom > ahora) return 'NO_INICIA'
  if (r.validUntil && r.validUntil < ahora) return 'VENCIDO'
  const { dia, hhmm } = diaYHora(ahora, zona)
  if (r.daysOfWeek.length > 0 && !r.daysOfWeek.includes(dia)) return 'FUERA_DE_HORARIO'
  if (r.timeFrom && r.timeUntil) {
    // ponytail: ventana que cruza medianoche se evalúa por hora, sin atribuir la madrugada al día anterior
    const dentro = r.timeFrom <= r.timeUntil ? hhmm >= r.timeFrom && hhmm < r.timeUntil : hhmm >= r.timeFrom || hhmm < r.timeUntil
    if (!dentro) return 'FUERA_DE_HORARIO'
  }
  return null
}

/**
 * Base / descuento / neto de una liga. Decimal con mitad hacia arriba a 2 decimales
 * (no usa `calculateDiscountPesos`: su redondeo en float falla en medios centavos).
 * Si el descuento no aplica: descuento 0, neto = base y `motivo` con la razón.
 */
export function desgloseDeLiga(
  base: number,
  foto: DescuentoDeLiga | null,
  regla: ReglaDelCatalogo | null,
  ahora: Date,
  zona: string,
): Desglose {
  const sinDescuento = (motivo: MotivoNoDisponible | null): Desglose => ({
    base,
    descuento: 0,
    neto: base,
    aplica: false,
    motivo,
    nombre: foto?.name ?? null,
  })
  if (!foto) return sinDescuento(null)

  if (foto.origen === 'CATALOGO') {
    if (!regla) return sinDescuento('INACTIVO')
    const motivo = motivoDeCatalogo(regla, ahora, zona)
    if (motivo) return sinDescuento(motivo)
  }

  const b = new Prisma.Decimal(base)
  if (foto.origen === 'CATALOGO' && regla?.minPurchaseAmount != null && b.lt(regla.minPurchaseAmount)) {
    return sinDescuento('MINIMO')
  }

  let d =
    foto.type === 'PERCENTAGE'
      ? b.mul(foto.value).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      : new Prisma.Decimal(foto.value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  if (foto.origen === 'CATALOGO' && regla?.maxDiscountAmount != null && d.gt(regla.maxDiscountAmount)) {
    d = new Prisma.Decimal(regla.maxDiscountAmount)
  }
  if (b.minus(d).lte(0)) return sinDescuento('MINIMO')

  return {
    base,
    descuento: d.toNumber(),
    neto: b.minus(d).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
    aplica: true,
    motivo: null,
    nombre: foto.name,
  }
}
