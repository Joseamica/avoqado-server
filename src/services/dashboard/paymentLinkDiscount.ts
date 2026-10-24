import { Prisma, PrismaClient } from '@prisma/client'

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
  if (foto.origen === 'CATALOGO' && regla?.maxDiscountAmount && regla.maxDiscountAmount > 0) {
    // Igual que el POS: un tope de 0 significa «sin tope».
    const tope = new Prisma.Decimal(regla.maxDiscountAmount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    if (d.gt(tope)) d = tope
  }
  if (d.lte(0) || b.minus(d).lte(0)) return sinDescuento('MINIMO')

  return {
    base,
    descuento: d.toNumber(),
    neto: b.minus(d).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
    aplica: true,
    motivo: null,
    nombre: foto.name,
  }
}

type CandidatoALiga = {
  scope: string
  type: string
  requiresApproval: boolean
  isAutomatic: boolean
  buyQuantity: number | null
  getQuantity: number | null
  getDiscountPercent: unknown
  buyItemIds: string[]
  getItemIds: string[]
  maxTotalUses: number | null
  maxUsesPerCustomer: number | null
  customerGroupId: string | null
}

/**
 * Qué descuentos del catálogo caben en una liga: sólo los sin reglas de uso ni de cliente.
 * Activo y fechas NO cuentan aquí (`desgloseDeLiga` los resuelve como INACTIVO / VENCIDO).
 * Gana la primera regla que falle; `razon` se muestra al negocio.
 */
export function esCompatibleConLigas(d: CandidatoALiga): { ok: true } | { ok: false; razon: string } {
  const bogo =
    d.buyQuantity != null || d.getQuantity != null || d.getDiscountPercent != null || d.buyItemIds.length > 0 || d.getItemIds.length > 0
  const falla =
    d.maxTotalUses != null
      ? 'Tiene límite de usos: escríbelo a mano'
      : d.maxUsesPerCustomer != null
        ? 'Tiene límite por cliente: escríbelo a mano'
        : d.customerGroupId != null
          ? 'Es solo para un grupo de clientes'
          : d.requiresApproval
            ? 'Pide autorización de un gerente'
            : d.type === 'COMP'
              ? 'Es una cortesía'
              : d.isAutomatic
                ? 'Se aplica solo en el POS'
                : bogo
                  ? 'Es una promoción de tipo 2×1'
                  : d.scope !== 'ORDER'
                    ? 'Es solo para ciertos productos o categorías'
                    : null
  return falla ? { ok: false, razon: falla } : { ok: true }
}

/** Lee la regla viva del descuento del catálogo de una liga. `null` si es manual o no hay descuento. */
export async function cargarRegla(
  tx: Prisma.TransactionClient | PrismaClient,
  foto: DescuentoDeLiga | null,
): Promise<ReglaDelCatalogo | null> {
  if (!foto || foto.origen !== 'CATALOGO' || !foto.discountId) return null
  const d = await tx.discount.findUnique({
    where: { id: foto.discountId },
    select: {
      active: true,
      validFrom: true,
      validUntil: true,
      daysOfWeek: true,
      timeFrom: true,
      timeUntil: true,
      minPurchaseAmount: true,
      maxDiscountAmount: true,
      scope: true,
      type: true,
      requiresApproval: true,
      isAutomatic: true,
      buyQuantity: true,
      getQuantity: true,
      getDiscountPercent: true,
      buyItemIds: true,
      getItemIds: true,
      maxTotalUses: true,
      maxUsesPerCustomer: true,
      customerGroupId: true,
    },
  })
  if (!d) {
    return {
      active: false,
      validFrom: null,
      validUntil: null,
      daysOfWeek: [],
      timeFrom: null,
      timeUntil: null,
      minPurchaseAmount: null,
      maxDiscountAmount: null,
      existe: false,
      compatible: false,
    }
  }
  return {
    active: d.active,
    validFrom: d.validFrom,
    validUntil: d.validUntil,
    daysOfWeek: d.daysOfWeek,
    timeFrom: d.timeFrom,
    timeUntil: d.timeUntil,
    minPurchaseAmount: d.minPurchaseAmount?.toNumber() ?? null,
    maxDiscountAmount: d.maxDiscountAmount?.toNumber() ?? null,
    existe: true,
    compatible: esCompatibleConLigas(d).ok,
  }
}
