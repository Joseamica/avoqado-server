import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { PaymentMethod, CardBrand, TransactionCardType, OriginSystem, Prisma } from '@prisma/client'
import { proyectarComisionYNeto } from './proyeccionMonetaria'

// Codex R3 (P2): la proyección monetaria común vive en su módulo (la liquidación también la usa); se re-exporta por compatibilidad.
export { proyectarComisionYNeto } from './proyeccionMonetaria'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import { getEffectivePaymentConfig, getEffectivePricingForSlot } from '../organization-payment-config.service'
import { calculatePaymentSettlement } from './settlementCalculation.service'

/** Codex R6 (g): TODA lectura y escritura de la unidad de convergencia va con el MISMO cliente (`tx`), nunca con el global. */
type Cliente = Prisma.TransactionClient | typeof prisma

/**
 * TransactionCost Service
 *
 * Handles creation and calculation of transaction costs for Avoqado-processed payments.
 * This service tracks the economics of each payment:
 * - Provider costs (what Avoqado pays to Menta/Clip/etc)
 * - Venue pricing (what Avoqado charges the venue)
 * - Gross profit and profit margin
 *
 * CRITICAL BUSINESS RULE:
 * Only create TransactionCost for payments where:
 * 1. originSystem = AVOQADO (Avoqado processed the payment)
 * 2. method ≠ CASH (processor involved)
 * 3. type ≠ TEST (real payments only, or zero-cost for audit)
 */

/**
 * Determine the transaction card type based on payment method and card brand
 * Used to select the correct rate from ProviderCostStructure/VenuePricingStructure
 *
 * @param method - Payment method from Payment record
 * @param cardBrand - Card brand from Payment record (VISA, MASTERCARD, AMEX, etc)
 * @param isInternational - Whether the card is international (from processorData)
 * @returns TransactionCardType enum value
 */
export function determineTransactionCardType(
  method: PaymentMethod,
  cardBrand: CardBrand | null,
  isInternational?: boolean,
): TransactionCardType {
  // International cards have their own rate tier
  if (isInternational) {
    return TransactionCardType.INTERNATIONAL
  }

  // AMEX has special higher rates
  if (cardBrand === CardBrand.AMERICAN_EXPRESS) {
    return TransactionCardType.AMEX
  }

  // Map payment method to card type
  switch (method) {
    case PaymentMethod.DEBIT_CARD:
      return TransactionCardType.DEBIT
    case PaymentMethod.CREDIT_CARD:
      return TransactionCardType.CREDIT
    default:
      logger.warn('Unexpected payment method for card type determination', { method, cardBrand })
      return TransactionCardType.OTHER
  }
}

/**
 * Find the active provider cost structure for a merchant account at a given date
 *
 * @param merchantAccountId - Merchant account ID
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active ProviderCostStructure or null
 */
export async function findActiveProviderCostStructure(merchantAccountId: string, effectiveDate: Date = new Date(), db: Cliente = prisma) {
  const costStructure = await db.providerCostStructure.findFirst({
    where: {
      merchantAccountId,
      active: true,
      effectiveFrom: { lte: effectiveDate },
      OR: [
        { effectiveTo: null }, // No end date (current)
        { effectiveTo: { gte: effectiveDate } },
      ],
    },
    orderBy: {
      effectiveFrom: 'desc', // Get most recent if multiple match
    },
  })

  if (!costStructure) {
    logger.warn('No active provider cost structure found', { merchantAccountId, effectiveDate })
  }

  return costStructure
}

/**
 * Find the active venue pricing structure for a venue and account type at a given date
 *
 * @param venueId - Venue ID
 * @param accountType - Account type (PRIMARY, SECONDARY, TERTIARY)
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active VenuePricingStructure or null
 */
export async function findActiveVenuePricingStructure(
  venueId: string,
  accountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY',
  effectiveDate: Date = new Date(),
  db: Cliente = prisma,
) {
  // Use inheritance: venue pricing → org pricing fallback — Codex R4-3: A LA FECHA pedida, no «hoy». Codex R12-14: consulta
  // ACOTADA a la estructura ganadora del slot (`take: 1`), no la lista entera para quedarse con la primera.
  const effective = await getEffectivePricingForSlot(venueId, accountType, effectiveDate, db)

  if (!effective) {
    logger.warn('No active pricing structure found (checked venue + org)', { venueId, accountType, effectiveDate })
    return null
  }

  const { pricing, source } = effective
  logger.info('Resolved pricing structure', { venueId, accountType, source, count: pricing.length })

  // Return the most recent pricing structure (already ordered by effectiveFrom desc). Codex R9 (P2): CON su origen — una
  // tarifa heredada de la ORGANIZACIÓN es otra tabla (`OrganizationPricingStructure`) y su id no puede ir a la FK
  // `TransactionCost.venuePricingStructureId` (sólo admite `VenuePricingStructure`): sin el origen, el costo revienta por FK.
  const estructura = pricing[0]
  return estructura ? { ...estructura, source: source as 'venue' | 'organization' } : null
}

/**
 * Get the rate for a specific transaction type from a cost/pricing structure
 *
 * @param structure - ProviderCostStructure or VenuePricingStructure
 * @param transactionType - Card type (DEBIT, CREDIT, AMEX, INTERNATIONAL)
 * @returns Rate as Decimal
 */
function getRateForTransactionType(structure: any, transactionType: TransactionCardType): number {
  switch (transactionType) {
    case TransactionCardType.DEBIT:
      return parseFloat(structure.debitRate.toString())
    case TransactionCardType.CREDIT:
      return parseFloat(structure.creditRate.toString())
    case TransactionCardType.AMEX:
      return parseFloat(structure.amexRate.toString())
    case TransactionCardType.INTERNATIONAL:
      return parseFloat(structure.internationalRate.toString())
    default:
      logger.warn('Unknown transaction type for rate lookup', { transactionType })
      return parseFloat(structure.creditRate.toString()) // Default to credit rate
  }
}

/**
 * Calcula la tasa EFECTIVA aplicada al monto de la transacción, respetando
 * el flag `includesTax` de la pricing/cost structure.
 *
 *   - structure.includesTax === false → tasa BASE; aplicar tax (default 16%).
 *   - structure.includesTax === true  → tasa final; usar as-is.
 *   - structure.includesTax === null  → legacy; tratar como `true` para
 *     preservar el comportamiento histórico (no se sumaba tax).
 *
 * `taxRate` se persiste por estructura (default 0.16 = IVA México) — leerlo
 * de la columna evita asumir 16% hardcoded por si en el futuro hay venues
 * con jurisdicciones diferentes.
 */
function applyTaxIfNeeded(structure: any, baseRate: number): number {
  if (structure?.includesTax === false) {
    // Ojo: NO usar `structure.taxRate ? ... : 0.16` — un taxRate=0 (jurisdicción
    // sin IVA) es válido y caería en el fallback. Chequeamos null/undefined
    // explícitamente. NaN se cubre con isFinite para protegerse de strings.
    let tax = 0.16
    if (structure.taxRate !== null && structure.taxRate !== undefined) {
      const parsed = parseFloat(structure.taxRate.toString())
      if (Number.isFinite(parsed)) tax = parsed
    }
    return baseRate * (1 + tax)
  }
  return baseRate
}

/**
 * Codex R4-3 · la TARIFA CONGELADA al cobrar. `processorData.pricingSlot` es una etiqueta y una etiqueta no congela nada:
 * si el negocio sustituye la afiliación del slot y le pone otra tarifa, o edita la tarifa en sitio, «SECONDARY a la fecha»
 * ya no es lo contratado. Se guardan las TASAS (proveedor y negocio) vigentes al cobrar para la afiliación acreditada;
 * el costo se calcula con ellas aunque la configuración de hoy diga otra cosa. Los ids sólo son trazabilidad.
 */
export interface TarifaCongelada {
  slot: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' | null
  frozenAt: string
  merchantAccountId: string
  venue: {
    structureId: string
    source: 'venue' | 'organization'
    accountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY'
    debitRate: string
    creditRate: string
    amexRate: string
    internationalRate: string
    includesTax: boolean | null
    taxRate: string | null
    fixedFeePerTransaction: string | null
  } | null
  provider: {
    structureId: string
    debitRate: string
    creditRate: string
    amexRate: string
    internationalRate: string
    includesTax: boolean | null
    taxRate: string | null
    fixedCostPerTransaction: string | null
  } | null
  /**
   * Codex R10-1: qué LECTURA falló al congelar (mensaje, no la excepción). Sin este marcador, una captura fallida se guardaba
   * como `pricing: null` y el costo la leía como «sin snapshot» (AUSENTE) — la puerta al fallback PRIMARY. Con él, la evidencia
   * que SÍ se obtuvo se conserva (si sólo falló el proveedor, la tarifa del negocio sigue siendo la congelada) y una lectura
   * fallida del lado del negocio deja la obligación pendiente con su motivo (`PRICING_CAPTURE_FAILED`): nunca se reconstruye
   * después «a la fecha del cobro» desde la configuración de hoy.
   */
  capturaFallida?: { configuracion?: string; negocio?: string; proveedor?: string; total?: string }
}

const aTexto = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
/**
 * Codex R11 (P3): el marcador es una CADENA NO VACÍA siempre — un `new Error('')` (o un error de Prisma cuya primera línea es
 * vacía) dejaba `{ negocio: '' }`, y una comprobación por «verdad» lo leía como si no hubiera fallado nada (SIN_TARIFA).
 */
const mensajeDe = (e: unknown): string => {
  const texto = (e instanceof Error ? e.message : String(e)).trim().slice(0, 300)
  if (texto) return texto
  const nombre = e instanceof Error ? `${e.name}${(e as { code?: string }).code ? ` ${(e as { code?: string }).code}` : ''}` : ''
  return nombre.trim() || '(error sin mensaje)'
}

/** Los slots que una afiliación ocupa en una configuración (Codex R12-2: tiene que ser exactamente uno). */
export function slotsDeLaAfiliacion(
  config:
    | { primaryAccount?: { id: string } | null; secondaryAccount?: { id: string } | null; tertiaryAccount?: { id: string } | null }
    | null
    | undefined,
  merchantAccountId: string,
): Array<'PRIMARY' | 'SECONDARY' | 'TERTIARY'> {
  const slots: Array<'PRIMARY' | 'SECONDARY' | 'TERTIARY'> = []
  if (config?.primaryAccount?.id === merchantAccountId) slots.push('PRIMARY')
  if (config?.secondaryAccount?.id === merchantAccountId) slots.push('SECONDARY')
  if (config?.tertiaryAccount?.id === merchantAccountId) slots.push('TERTIARY')
  return slots
}

export async function tarifaCongeladaDeLaAfiliacion(
  venueId: string,
  merchantAccountId: string,
  at: Date,
): Promise<{ slot: TarifaCongelada['slot']; pricing: TarifaCongelada | null }> {
  // Codex R10-1: cada lectura se captura POR SEPARADO — un `Promise.all` con un solo `catch` tiraba la tarifa del negocio ya
  // leída cuando fallaba la consulta del proveedor, y el registrador guardaba `pricing: null` (= «sin snapshot» = PRIMARY).
  const capturaFallida: NonNullable<TarifaCongelada['capturaFallida']> = {}
  // Codex R11-1: la configuración (qué slot ocupa la afiliación) y la tarifa de ese slot se leen desde UNA MISMA vista de la
  // base — una transacción REPEATABLE READ de sólo lectura, cuya instantánea queda fijada en la primera consulta—. Con dos
  // lecturas sueltas por el cliente global, una reasignación del slot (M2 → M3) y una edición de esa tarifa (2.5 % → 8 %)
  // coladas ENTRE ambas congelaban «M2 con el 8 %», una combinación que nunca existió; y ninguna lectura había fallado.
  // Pasar el mismo cliente en READ COMMITTED no bastaría: cada sentencia vería la base de su instante.
  // El costo del PROVEEDOR (lo que paga Avoqado) se captura aparte, por el cliente global: no forma parte de esa asociación.
  // La lectura DEVUELVE lo leído (no escribe variables del cierre: TypeScript no ve esas asignaciones y estrecha a `never`).
  type LecturaDelNegocio = { slot: TarifaCongelada['slot']; negocio: Awaited<ReturnType<typeof getEffectivePricingForSlot>> }
  const lecturaDelNegocio: Promise<LecturaDelNegocio> = prisma
    .$transaction(
      async (tx): Promise<LecturaDelNegocio> => {
        let slot: TarifaCongelada['slot'] = null
        try {
          const effective = await getEffectivePaymentConfig(venueId, tx)
          // Codex R12-2: la afiliación tiene que ocupar UN solo slot. Si aparece en dos (la configuración no lo impide), la
          // captura NO elige por orden del ternario (PRIMARY al 8 % o SECONDARY al 2.5 % serían dos comisiones distintas para el
          // mismo cargo): es una captura fallida por configuración ambigua y el costo queda pendiente con el motivo a la vista.
          const slots = slotsDeLaAfiliacion(effective?.config, merchantAccountId)
          if (slots.length > 1) {
            capturaFallida.configuracion = `AFILIACION_EN_VARIOS_SLOTS: ${slots.join(',')}`
            return { slot: null, negocio: null }
          }
          slot = slots[0] ?? null
        } catch (error) {
          capturaFallida.configuracion = mensajeDe(error)
          return { slot: null, negocio: null }
        }
        if (!slot) return { slot, negocio: null }
        try {
          return { slot, negocio: await getEffectivePricingForSlot(venueId, slot, at, tx) }
        } catch (error) {
          capturaFallida.negocio = mensajeDe(error)
          return { slot, negocio: null }
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    )
    .catch((error: unknown): LecturaDelNegocio => {
      // La transacción de captura en sí (abrirla, cerrarla): no hay lectura del negocio acreditada — se guarda como TOTAL,
      // conservando lo que las lecturas hayan dejado escrito. Nunca `pricing: null`; nunca se lanza.
      if (!capturaFallida.configuracion && !capturaFallida.negocio) capturaFallida.total = mensajeDe(error)
      return { slot: null, negocio: null }
    })
  const [{ slot, negocio }, proveedor] = await Promise.all([
    lecturaDelNegocio,
    findActiveProviderCostStructure(merchantAccountId, at).catch((error: unknown) => {
      capturaFallida.proveedor = mensajeDe(error)
      return null
    }),
  ])
  const estructura = negocio?.pricing[0] ?? null
  const pricing: TarifaCongelada = {
    slot,
    frozenAt: at.toISOString(),
    merchantAccountId,
    venue:
      estructura && slot
        ? {
            structureId: estructura.id,
            source: negocio!.source as 'venue' | 'organization',
            accountType: slot,
            debitRate: String(estructura.debitRate),
            creditRate: String(estructura.creditRate),
            amexRate: String(estructura.amexRate),
            internationalRate: String(estructura.internationalRate),
            includesTax: (estructura as { includesTax?: boolean | null }).includesTax ?? null,
            taxRate: aTexto((estructura as { taxRate?: unknown }).taxRate),
            fixedFeePerTransaction: aTexto(estructura.fixedFeePerTransaction),
          }
        : null,
    provider: proveedor
      ? {
          structureId: proveedor.id,
          debitRate: String(proveedor.debitRate),
          creditRate: String(proveedor.creditRate),
          amexRate: String(proveedor.amexRate),
          internationalRate: String(proveedor.internationalRate),
          includesTax: (proveedor as { includesTax?: boolean | null }).includesTax ?? null,
          taxRate: aTexto((proveedor as { taxRate?: unknown }).taxRate),
          fixedCostPerTransaction: aTexto(proveedor.fixedCostPerTransaction),
        }
      : null,
    ...(Object.keys(capturaFallida).length > 0 ? { capturaFallida } : {}),
  }
  return { slot, pricing }
}

/** Codex R10-1: el snapshot que el registrador guarda cuando NI SIQUIERA pudo intentar la captura (un error fuera de las lecturas). */
export function tarifaConCapturaFallida(merchantAccountId: string, at: Date, error: unknown): TarifaCongelada {
  return {
    slot: null,
    frozenAt: at.toISOString(),
    merchantAccountId,
    venue: null,
    provider: null,
    capturaFallida: { total: mensajeDe(error) },
  }
}

/**
 * Codex R7 (P2-d): el snapshot congelado tiene estados DISTINTOS y no se confunden — AUSENTE (el Payment no lo trae, o lo trae
 * `null` SIN afiliación registrada —manual/QR—: se calcula con la configuración vigente), VALIDO (se calcula con él),
 * SIN_TARIFA (legible y de la MISMA afiliación, pero al cobrar esa afiliación no tenía tarifa contratada —sin slot, o con slot
 * sin estructura vigente—: Codex R9-1, es un HECHO histórico ⇒ la obligación queda PENDIENTE con
 * `AFFILIATION_PRICING_UNRESOLVED` hasta una acreditación EXPLÍCITA del cargo; nunca se cae a PRIMARY ni a la configuración de
 * hoy), CAPTURA_FALLIDA (Codex R10-1: al cobrar no se pudo LEER la tarifa del negocio —configuración o estructura—: tampoco
 * se sabe qué había, y no se reconstruye después ⇒ pendiente con `PRICING_CAPTURE_FAILED`) e INVALIDO (lo trae pero no es
 * legible, es de OTRA afiliación, le faltan campos, o es `null` con afiliación registrada —el registrador nunca escribe eso—:
 * NO se cae a la configuración vigente, la obligación queda pendiente y visible con `INVALID_PRICING_SNAPSHOT`).
 */
export type LecturaDeTarifaCongelada =
  | { estado: 'AUSENTE' }
  | { estado: 'VALIDO'; tarifa: TarifaCongelada }
  | { estado: 'SIN_TARIFA'; slot: TarifaCongelada['slot'] }
  | { estado: 'CAPTURA_FALLIDA'; motivo: string }
  | { estado: 'INVALIDO'; motivo: string }

export function leerTarifaCongelada(processorData: unknown, merchantAccountId: string | null): LecturaDeTarifaCongelada {
  const datos = processorData && typeof processorData === 'object' ? (processorData as Record<string, unknown>) : null
  if (!datos || datos.pricing === undefined) return { estado: 'AUSENTE' }
  // Codex R10-1: `pricing: null` sólo es legítimo SIN afiliación registrada (el registrador lo escribe así para manual/QR). Con
  // afiliación, el registrador siempre guarda un objeto (aunque la captura haya fallado): un `null` ahí no es «sin snapshot».
  if (datos.pricing === null)
    return merchantAccountId ? { estado: 'INVALIDO', motivo: 'PRICING_NULO_CON_AFILIACION' } : { estado: 'AUSENTE' }
  const p = typeof datos.pricing === 'object' ? (datos.pricing as Partial<TarifaCongelada>) : null
  if (!p) return { estado: 'INVALIDO', motivo: 'PRICING_NO_ES_OBJETO' }
  if (typeof p.merchantAccountId !== 'string' || !p.merchantAccountId) return { estado: 'INVALIDO', motivo: 'SIN_AFILIACION' }
  if (!merchantAccountId || p.merchantAccountId !== merchantAccountId) return { estado: 'INVALIDO', motivo: 'AFILIACION_DISTINTA' }
  // Codex R10-1: una captura fallida del lado del NEGOCIO (configuración o tarifa) no dejó evidencia de qué había al cobrar —
  // ni «sin tarifa» ni «esta tarifa». Va ANTES de mirar `venue`: con slot y `venue: null` parecería SIN_TARIFA. Si sólo falló
  // el proveedor, la evidencia del negocio es válida y se usa (el costo del proveedor se toma de su configuración a la fecha).
  // Codex R12-9: el marcador tiene FORMA — un objeto plano cuyos campos conocidos son cadenas. Un marcador ilegible (una cadena
  // suelta, un número, un null en un campo) no puede habilitar VALIDO: INVALIDO con motivo.
  if ('capturaFallida' in p && p.capturaFallida !== undefined) {
    const m = p.capturaFallida as unknown
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { estado: 'INVALIDO', motivo: 'CAPTURA_FALLIDA_ILEGIBLE' }
    for (const k of ['configuracion', 'negocio', 'proveedor', 'total']) {
      if (k in (m as Record<string, unknown>) && typeof (m as Record<string, unknown>)[k] !== 'string')
        return { estado: 'INVALIDO', motivo: 'CAPTURA_FALLIDA_ILEGIBLE' }
    }
  }
  const cf =
    p.capturaFallida && typeof p.capturaFallida === 'object' ? (p.capturaFallida as NonNullable<TarifaCongelada['capturaFallida']>) : null
  // Codex R11 (P3): decide la PRESENCIA del marcador (una cadena, aunque esté vacía), no su «verdad»: `{ negocio: '' }` es una
  // captura fallida, no SIN_TARIFA.
  const marcado = (v: unknown): v is string => typeof v === 'string'
  if (cf && (marcado(cf.total) || marcado(cf.configuracion) || marcado(cf.negocio))) {
    return {
      estado: 'CAPTURA_FALLIDA',
      motivo: marcado(cf.total)
        ? `TOTAL: ${cf.total}`
        : marcado(cf.configuracion)
          ? `CONFIGURACION: ${cf.configuracion}`
          : `NEGOCIO: ${cf.negocio}`,
    }
  }
  // Codex R5 (P2): una tasa es un número finito o una cadena DECIMAL — nunca null, booleanos ni '' (con `Number(v)` valían 0 o
  // 1 y el costo habría salido «de 0 %» o «de 100 %» sin que nadie lo notara). El cargo fijo y el IVA pueden ser null (no
  // aplican), pero no otra cosa que un número. Codex R6 (P2-d): el formato es el que `parseFloat` lee ENTERO (`-?\d+(\.\d+)?`,
  // con exponente opcional): `"0x10"` pasaba `Number()` como 16 y el cálculo lo leía como 0. Codex R7 (P2-d): `includesTax`
  // es booleano o null — `"false"` (cadena) NO es «no incluye IVA», el cálculo sólo reconoce el booleano.
  const DECIMAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/
  const esNumero = (v: unknown): boolean =>
    (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && DECIMAL.test(v.trim()) && Number.isFinite(Number(v)))
  const esNumeroONulo = (v: unknown): boolean => v === null || v === undefined || esNumero(v)
  const esBooleanoONulo = (v: unknown): boolean => v === null || v === undefined || typeof v === 'boolean'
  // Codex R12-9: los campos que el productor escribe SIEMPRE tienen que estar PRESENTES — un `includesTax` omitido no es «no
  // incluye IVA» (2.5 % + IVA sobre $1,000 son $29, no $25) y un cargo fijo omitido no es «cero». El null EXPLÍCITO sigue
  // valiendo lo que siempre valió (no aplica); la OMISIÓN es un snapshot incompleto.
  const tasas = (x: unknown, fijos: string[], obligatorios: string[]): string | null => {
    if (!x || typeof x !== 'object') return 'SIN_TASAS'
    const r = x as Record<string, unknown>
    for (const k of obligatorios) if (!(k in r) || r[k] === undefined) return `CAMPO_AUSENTE_${k}`
    for (const k of ['debitRate', 'creditRate', 'amexRate', 'internationalRate']) if (!esNumero(r[k])) return `TASA_INVALIDA_${k}`
    for (const k of ['taxRate', ...fijos]) if (!esNumeroONulo(r[k])) return `IMPORTE_INVALIDO_${k}`
    if (!esBooleanoONulo(r.includesTax)) return 'INCLUDES_TAX_INVALIDO'
    return null
  }
  const OBLIGATORIOS_DEL_NEGOCIO = [
    'structureId',
    'accountType',
    'debitRate',
    'creditRate',
    'amexRate',
    'internationalRate',
    'includesTax',
    'taxRate',
    'fixedFeePerTransaction',
  ]
  const OBLIGATORIOS_DEL_PROVEEDOR = [
    'structureId',
    'debitRate',
    'creditRate',
    'amexRate',
    'internationalRate',
    'includesTax',
    'taxRate',
    'fixedCostPerTransaction',
  ]
  const slot = p.slot ?? null
  if (slot !== null && !['PRIMARY', 'SECONDARY', 'TERTIARY'].includes(String(slot))) return { estado: 'INVALIDO', motivo: 'SLOT_INVALIDO' }
  // `venue: null` EXPLÍCITO es lo que congela el registro cuando la afiliación no tenía tarifa AL COBRAR (sin slot, o slot
  // sin estructura vigente): un snapshot legible que dice «sin tarifa», no uno corrupto. Codex R8 (P2): un campo `venue`
  // OMITIDO no acredita ese null — es un snapshot incompleto, INVALIDO (nunca «sin tarifa» ni «ausente»).
  if (!('venue' in p) || p.venue === undefined) return { estado: 'INVALIDO', motivo: 'VENUE_AUSENTE' }
  if (p.venue === null) return { estado: 'SIN_TARIFA', slot: slot as TarifaCongelada['slot'] }
  const motivoVenue = tasas(p.venue, ['fixedFeePerTransaction'], OBLIGATORIOS_DEL_NEGOCIO)
  if (motivoVenue) return { estado: 'INVALIDO', motivo: `VENUE_${motivoVenue}` }
  const motivoProveedor =
    p.provider === null || p.provider === undefined ? null : tasas(p.provider, ['fixedCostPerTransaction'], OBLIGATORIOS_DEL_PROVEEDOR)
  return {
    estado: 'VALIDO',
    tarifa: {
      slot: slot as TarifaCongelada['slot'],
      frozenAt: typeof p.frozenAt === 'string' ? p.frozenAt : '',
      merchantAccountId: p.merchantAccountId,
      venue: p.venue as TarifaCongelada['venue'],
      // Un proveedor ilegible NO invalida la tarifa del negocio (se descarta y el costo del proveedor se toma de la configuración).
      provider: motivoProveedor ? null : ((p.provider ?? null) as TarifaCongelada['provider']),
    },
  }
}

/** El snapshot congelado que un Payment conserva en `processorData.pricing`, si es VÁLIDO y de la MISMA afiliación; si no (ausente, sin tarifa o inválido), null. */
export function tarifaCongeladaDelPago(processorData: unknown, merchantAccountId: string | null): TarifaCongelada | null {
  const lectura = leerTarifaCongelada(processorData, merchantAccountId)
  return lectura.estado === 'VALIDO' ? lectura.tarifa : null
}

/**
 * Main function: Create TransactionCost record for a payment
 *
 * This function:
 * 1. Validates payment eligibility (AVOQADO origin, not CASH, not TEST)
 * 2. Determines transaction card type
 * 3. Finds merchant account from venue payment config
 * 4. Gets provider cost structure (what Avoqado pays)
 * 5. Gets venue pricing structure (what Avoqado charges)
 * 6. Calculates costs, revenue, and profit
 * 7. Creates TransactionCost record
 *
 * @param paymentId - Payment ID to create TransactionCost for
 * @returns Object with transactionCost record, feeAmount, and netAmount (or null if skipped)
 */
export async function createTransactionCost(
  paymentId: string,
  // Codex R6 (diseño B): las ESCRITURAS del costo van con el cliente de la unidad de convergencia (una transacción que
  // sostiene la fila del Payment); las lecturas de configuración (tarifas, liquidación) son de sólo lectura y no dependen
  // del candado. Sin `db`, el cliente global (llamadores históricos: scripts, backfills).
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{
  transactionCost: any
  feeAmount: number
  netAmount: number
} | null> {
  logger.info('Creating TransactionCost', { paymentId })

  // Fetch payment with venue info
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      venue: { select: { id: true, organizationId: true } },
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment ${paymentId} not found`)
  }

  // ========================================
  // CRITICAL BUSINESS RULE: Eligibility Check
  // ========================================

  // Skip if not Avoqado-originated
  if (payment.originSystem !== OriginSystem.AVOQADO) {
    logger.info('Skipping TransactionCost: Payment not originated by Avoqado', {
      paymentId,
      originSystem: payment.originSystem,
    })
    return null
  }

  // Skip if CASH (no processor involved)
  if (payment.method === PaymentMethod.CASH) {
    logger.info('Skipping TransactionCost: Cash payment (no processor cost)', { paymentId })
    return null
  }

  // Handle TEST payments
  if (payment.type === 'TEST') {
    logger.info('Creating zero-cost TransactionCost for TEST payment (audit trail)', { paymentId })
    // TEST payments get TransactionCost with zero costs for audit trail
    // Continue with zero rates below
  }

  // ========================================
  // Step 1: Determine Transaction Card Type
  // ========================================

  const processorData = payment.processorData as any
  const isInternational = processorData?.isInternational || false

  const transactionType = determineTransactionCardType(payment.method, payment.cardBrand, isInternational)

  logger.info('Transaction type determined', {
    paymentId,
    method: payment.method,
    cardBrand: payment.cardBrand,
    isInternational,
    transactionType,
  })

  // ========================================
  // Step 2: Find Merchant Account (venue → org inheritance)
  // ========================================

  // Codex R4-3: con TARIFA CONGELADA en el Payment (las tasas vigentes al cobrar para SU afiliación), el costo se calcula
  // con ella aunque el slot haya cambiado de afiliación o la tarifa se haya editado después. Los ids de estructura sólo
  // se conservan si esas filas siguen existiendo (trazabilidad, no verdad: la verdad son las tasas congeladas).
  // Codex R10 (P2): el snapshot se clasifica ANTES de exigir la configuración de pagos — un estado que YA determina la espera
  // (ilegible, sin tarifa al cobrar, captura fallida) no depende de una configuración mutable, y sin configuración salía
  // por el error genérico y el worker consumía intentos hasta DEAD_LETTER en vez de dejar la obligación pendiente con motivo.
  const lecturaCongelada =
    payment.type !== 'TEST' ? leerTarifaCongelada(processorData, payment.merchantAccountId) : { estado: 'AUSENTE' as const }
  if (lecturaCongelada.estado === 'INVALIDO') {
    // Codex R7 (P2-d): un snapshot ILEGIBLE no es un snapshot ausente — no se calcula con la configuración de hoy (que puede
    // ser otra tarifa): la obligación queda pendiente y visible con su motivo.
    throw new BadRequestError(
      `COST_PENDING_INVALID_PRICING_SNAPSHOT: payment ${paymentId} carries a frozen pricing snapshot that is not readable (${lecturaCongelada.motivo})`,
    )
  }
  if (lecturaCongelada.estado === 'CAPTURA_FALLIDA') {
    // Codex R10-1: al cobrar no se pudo leer la tarifa del negocio. No se sabe qué había, y leerla HOY «a la fecha del cobro»
    // sería reconstruir la historia desde la configuración actual (lo que R9-1 prohíbe): pendiente y visible, nunca PRIMARY.
    throw new BadRequestError(
      `COST_PENDING_PRICING_CAPTURE_FAILED: payment ${paymentId} was processed by ${payment.merchantAccountId} but its pricing could not be read at charge time (${lecturaCongelada.motivo}); only an explicit accreditation of that charge can settle its cost`,
    )
  }
  if (lecturaCongelada.estado === 'SIN_TARIFA') {
    // Codex R8-2 / R9-1: el snapshot es legible y dice «AL COBRAR, esta afiliación no tenía tarifa contratada» (slot sin
    // estructura vigente, o ningún slot). Eso es un HECHO histórico y ninguna configuración posterior lo cambia: ni PRIMARY,
    // ni el slot que la afiliación ocupe HOY (que M2 sea PRIMARY hoy no demuestra que esa tarifa correspondiera a su cargo
    // de ayer), ni una estructura creada después y retrodatada, ni una antigua editada después — las filas de tarifa se
    // editan EN SITIO (tasas y `effectiveFrom`), así que una consulta «a la fecha del cobro» no es una acreditación
    // histórica. La obligación queda PENDIENTE y visible (`AFFILIATION_PRICING_UNRESOLVED`) hasta que exista una
    // acreditación EXPLÍCITA de ese cargo (mecanismo declarado fuera del checkpoint 1); nunca se descuenta una comisión
    // que el cargo no acredita (sobre $1,000 son $80 de PRIMARY contra una tarifa que nadie contrató).
    throw new BadRequestError(
      `COST_PENDING_AFFILIATION_PRICING_UNRESOLVED: payment ${paymentId} was processed by ${payment.merchantAccountId} with no contracted pricing at charge time (frozen slot ${lecturaCongelada.slot ?? 'none'}); only an explicit accreditation of that charge can settle its cost`,
    )
  }

  // Codex R12-3: un método PROVISIONAL (el webhook lo inventó — AngelPay no lo manda — y la terminal todavía no lo acreditó)
  // no calcula costo: débito y crédito son tarifas distintas (1 % contra 2.5 % sobre $100 son $1.50 de diferencia) y un costo
  // escrito con el método inventado se vuelve definitivo (la convergencia lo reutiliza). El PLAZO ya no acredita nada: la
  // obligación sigue pendiente y visible hasta que el REST de la terminal (S3) acredite el método, o una acreditación explícita.
  // Aquí, en la unidad —no sólo en el worker—: también los llamadores directos (backfills, scripts) pasan por este criterio.
  if (processorData?.methodProvisional === true) {
    throw new BadRequestError(
      `COST_PENDING_AWAITING_ACCREDITED_CARD_DATA: payment ${paymentId} was born from the webhook with a provisional method; the terminal has not accredited the card data yet`,
    )
  }

  const congelada = lecturaCongelada.estado === 'VALIDO' ? lecturaCongelada.tarifa : null
  // Codex R12-8: con un snapshot VALIDO la configuración de enrutamiento de HOY no hace falta — la afiliación se resuelve
  // DIRECTAMENTE por el cliente de la unidad y se consume el snapshot. Exigirla convertía evidencia suficiente en un fallo
  // operativo (DEAD_LETTER) si el negocio borraba sus configuraciones. Sólo AUSENTE (sin snapshot) la necesita.
  const effective = congelada && payment.merchantAccountId ? null : await getEffectivePaymentConfig(payment.venueId, db)
  if (!effective && !(congelada && payment.merchantAccountId)) {
    throw new BadRequestError(`Venue ${payment.venueId} has no payment configuration (checked venue + org)`)
  }
  const paymentConfig = effective?.config ?? null
  const configSource = effective?.source ?? 'frozen-snapshot'

  // Resolve WHICH configured account actually processed this payment. A venue
  // can have PRIMARY / SECONDARY / TERTIARY merchant accounts, each with its
  // own venue pricing. The TPV routing layer persists the processing account on
  // `payment.merchantAccountId` — honor it so the venue is charged with the
  // pricing of the account that actually ran the card (e.g. an aggregator
  // account at 8%), instead of always assuming PRIMARY. Falls back to PRIMARY
  // when the payment has no recorded account (manual/QR payments) or it doesn't
  // match any configured slot.
  let merchantAccount = paymentConfig?.primaryAccount ?? null
  let accountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' = 'PRIMARY'
  let tarifaCongelada = false

  if (congelada && payment.merchantAccountId) {
    const acreditada = await db.merchantAccount.findUnique({ where: { id: payment.merchantAccountId } })
    if (!acreditada) {
      throw new NotFoundError(`Merchant account ${payment.merchantAccountId} recorded on payment ${paymentId} no longer exists`)
    }
    merchantAccount = acreditada as typeof merchantAccount
    accountType = congelada.venue?.accountType ?? congelada.slot ?? 'PRIMARY'
    tarifaCongelada = true
  } else if (payment.merchantAccountId && paymentConfig) {
    // Codex R12-2: sin snapshot, el slot sale de la configuración de HOY — y sólo si es UNO. Con la afiliación en dos slots no
    // hay tarifa acreditable (elegir SECONDARY por orden del `if` era arbitrario): pendiente y visible.
    const slotsDeHoy = slotsDeLaAfiliacion(paymentConfig, payment.merchantAccountId)
    if (slotsDeHoy.length > 1) {
      throw new BadRequestError(
        `COST_PENDING_PRICING_CAPTURE_FAILED: payment ${paymentId} has no frozen pricing and its affiliation ${payment.merchantAccountId} appears today in several configured slots (${slotsDeHoy.join(',')}); the configuration is ambiguous`,
      )
    }
    if (paymentConfig.secondaryAccount?.id === payment.merchantAccountId) {
      merchantAccount = paymentConfig.secondaryAccount
      accountType = 'SECONDARY'
    } else if (paymentConfig.tertiaryAccount?.id === payment.merchantAccountId) {
      merchantAccount = paymentConfig.tertiaryAccount
      accountType = 'TERTIARY'
    } else if (paymentConfig.primaryAccount?.id === payment.merchantAccountId) {
      accountType = 'PRIMARY'
    } else {
      // Codex R2 (P1-3): la afiliación ACREDITADA en el Payment (por dónde pasó el dinero) no se sustituye por otra
      // aunque ya no esté en la configuración del venue: el costo del proveedor y la liquidación se resuelven con ELLA.
      // Sólo la tarifa que se le cobra al negocio cae a la del slot PRIMARY cuando esa afiliación no tiene slot (misma
      // regla «nunca peor que PRIMARY» de abajo). Si la afiliación ya no existe, el costo queda PENDIENTE y recuperable.
      const acreditada = await db.merchantAccount.findUnique({ where: { id: payment.merchantAccountId } })
      if (!acreditada) {
        throw new NotFoundError(`Merchant account ${payment.merchantAccountId} recorded on payment ${paymentId} no longer exists`)
      }
      merchantAccount = acreditada as typeof merchantAccount
      // Codex R3 (P1-3): la TARIFA es la CONGELADA al cobrar (`processorData.pricingSlot`, el slot que esa afiliación
      // ocupaba entonces). Sin slot congelado no hay tarifa acreditada: el costo queda PENDIENTE y visible — «nunca peor
      // que PRIMARY» no demuestra que sea la tarifa contratada (8 % contra 2.5 % sobre $1,000 son $55 de diferencia).
      const slotCongelado = processorData?.pricingSlot
      if (slotCongelado === 'PRIMARY' || slotCongelado === 'SECONDARY' || slotCongelado === 'TERTIARY') {
        accountType = slotCongelado
        tarifaCongelada = true
      } else {
        throw new BadRequestError(
          `COST_PENDING_AFFILIATION_PRICING_UNRESOLVED: payment ${paymentId} was processed by ${payment.merchantAccountId}, which is no longer in the venue payment config and has no frozen pricing slot`,
        )
      }
      logger.warn(
        'Payment processed by an account not in the venue payment config; keeping the recorded affiliation and its FROZEN pricing slot',
        {
          paymentId,
          paymentMerchantAccountId: payment.merchantAccountId,
          pricingSlot: slotCongelado,
          primaryAccountId: paymentConfig.primaryAccount?.id,
          secondaryAccountId: paymentConfig.secondaryAccount?.id,
          tertiaryAccountId: paymentConfig.tertiaryAccount?.id,
        },
      )
    }
  }

  if (!merchantAccount) {
    throw new BadRequestError(`Venue ${payment.venueId} has no ${accountType.toLowerCase()} merchant account configured`)
  }

  logger.info('Merchant account identified', {
    paymentId,
    merchantAccountId: merchantAccount.id,
    accountType,
    configSource,
  })

  // ========================================
  // Step 3: Get Provider Cost Structure
  // ========================================

  const proveedorCongelado = congelada?.provider
    ? {
        id: congelada.provider.structureId,
        debitRate: congelada.provider.debitRate,
        creditRate: congelada.provider.creditRate,
        amexRate: congelada.provider.amexRate,
        internationalRate: congelada.provider.internationalRate,
        includesTax: congelada.provider.includesTax,
        taxRate: congelada.provider.taxRate,
        fixedCostPerTransaction: congelada.provider.fixedCostPerTransaction,
      }
    : null
  const providerCostStructure = proveedorCongelado ?? (await findActiveProviderCostStructure(merchantAccount.id, payment.createdAt, db))

  if (!providerCostStructure && payment.type !== 'TEST') {
    throw new BadRequestError(`No active provider cost structure found for merchant account ${merchantAccount.id} at ${payment.createdAt}`)
  }

  // ========================================
  // Step 4: Get Venue Pricing Structure
  // ========================================

  // Prefer the resolved slot's pricing. SÓLO para un Payment SIN snapshot (AUSENTE: manual/QR o anterior al registrador): si
  // ese slot no tiene estructura vigente, cae a PRIMARY en vez de fallar (el camino legacy «nunca peor que PRIMARY»). Codex
  // R12-18: con snapshot (VALIDO / SIN_TARIFA / CAPTURA_FALLIDA / INVALIDO) esta caída NO existe — crear hoy la estructura del
  // slot y «recalcular» no acredita la historia: un cargo cuya tarifa no consta sólo se resuelve con una acreditación
  // EXPLÍCITA del cargo (fuera de esta unidad).
  let pricingAccountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' = accountType
  const negocioCongelado = congelada?.venue
    ? {
        id: congelada.venue.structureId,
        debitRate: congelada.venue.debitRate,
        creditRate: congelada.venue.creditRate,
        amexRate: congelada.venue.amexRate,
        internationalRate: congelada.venue.internationalRate,
        includesTax: congelada.venue.includesTax,
        taxRate: congelada.venue.taxRate,
        fixedFeePerTransaction: congelada.venue.fixedFeePerTransaction,
      }
    : null
  let venuePricingStructure: { id: string; source?: 'venue' | 'organization'; [k: string]: unknown } | null =
    negocioCongelado ?? (await findActiveVenuePricingStructure(payment.venueId, accountType, payment.createdAt, db))

  if (!venuePricingStructure && tarifaCongelada && payment.type !== 'TEST') {
    // Codex R3 (P1-3): el slot congelado ya no tiene tarifa vigente — no se sustituye por la de otro slot: pendiente y visible.
    throw new BadRequestError(
      `COST_PENDING_AFFILIATION_PRICING_UNRESOLVED: no active venue pricing for frozen slot ${accountType} of payment ${paymentId}`,
    )
  }
  // El fallback a PRIMARY existe SÓLO para un Payment sin snapshot (AUSENTE: manual/QR o anterior al registrador). Codex R8-2:
  // con snapshot (VALIDO o SIN_TARIFA) la tarifa es la acreditada o ninguna — el `throw` de arriba ya lo garantiza porque
  // esos caminos dejan `tarifaCongelada = true`; esta condición lo deja escrito para que un cambio arriba no lo reabra.
  if (!venuePricingStructure && accountType !== 'PRIMARY' && lecturaCongelada.estado === 'AUSENTE') {
    logger.warn('No venue pricing for resolved slot; falling back to PRIMARY pricing', {
      paymentId,
      venueId: payment.venueId,
      resolvedAccountType: accountType,
      merchantAccountId: merchantAccount.id,
    })
    pricingAccountType = 'PRIMARY'
    // Codex R8 (g): también el fallback lee por EL cliente de la unidad, nunca por el global.
    venuePricingStructure = await findActiveVenuePricingStructure(payment.venueId, 'PRIMARY', payment.createdAt, db)
  }

  if (!venuePricingStructure && payment.type !== 'TEST') {
    throw new BadRequestError(
      `No active venue pricing structure found for venue ${payment.venueId}, account type ${pricingAccountType} at ${payment.createdAt}`,
    )
  }

  // ========================================
  // Step 5: Calculate Costs and Revenue
  // ========================================

  // IMPORTANT: Use total processed amount (including tip) for cost calculation
  // The payment processor charges commission on ALL money that passes through the terminal
  const baseAmount = parseFloat(payment.amount.toString())
  const tipAmount = parseFloat(payment.tipAmount?.toString() || '0')
  const amount = baseAmount + tipAmount

  logger.info('Transaction amount calculated', {
    paymentId,
    baseAmount,
    tipAmount,
    totalAmount: amount,
  })

  // For TEST payments, use zero rates
  let providerRate = 0
  let providerFixedFee = 0
  let venueRate = 0
  let venueFixedFee = 0

  if (payment.type !== 'TEST') {
    // Get rates from cost/pricing structures. La tasa efectiva considera
    // el flag `includesTax`: si la estructura tiene includesTax=false, la
    // tasa guardada es BASE y se le aplica IVA encima al calcular el fee.
    const providerBaseRate = getRateForTransactionType(providerCostStructure!, transactionType)
    providerRate = applyTaxIfNeeded(providerCostStructure!, providerBaseRate)
    providerFixedFee = providerCostStructure!.fixedCostPerTransaction
      ? parseFloat(providerCostStructure!.fixedCostPerTransaction.toString())
      : 0

    const venueBaseRate = getRateForTransactionType(venuePricingStructure!, transactionType)
    venueRate = applyTaxIfNeeded(venuePricingStructure!, venueBaseRate)
    venueFixedFee = venuePricingStructure!.fixedFeePerTransaction ? parseFloat(venuePricingStructure!.fixedFeePerTransaction.toString()) : 0
  }

  // Calculate costs
  const providerCostAmount = amount * providerRate
  const venueChargeAmount = amount * venueRate

  const totalProviderCost = providerCostAmount + providerFixedFee
  const totalVenueCharge = venueChargeAmount + venueFixedFee

  // Calculate profit
  const grossProfit = totalVenueCharge - totalProviderCost
  const profitMargin = totalVenueCharge > 0 ? grossProfit / totalVenueCharge : 0

  logger.info('Transaction cost calculated', {
    paymentId,
    amount,
    transactionType,
    providerRate,
    providerCostAmount,
    providerFixedFee,
    venueRate,
    venueChargeAmount,
    venueFixedFee,
    grossProfit,
    profitMargin,
  })

  // ========================================
  // Step 6: Create TransactionCost Record
  // ========================================

  // Codex R4-3: con tarifa congelada los ids son trazabilidad; si la fila ya no existe, la FK iría a null (no a un error).
  const [providerCostStructureId, venuePricingStructureId] = congelada
    ? await Promise.all([
        providerCostStructure?.id
          ? db.providerCostStructure.findUnique({ where: { id: providerCostStructure.id }, select: { id: true } }).then(r => r?.id ?? null)
          : Promise.resolve(null),
        venuePricingStructure?.id && congelada.venue?.source === 'venue'
          ? db.venuePricingStructure.findUnique({ where: { id: venuePricingStructure.id }, select: { id: true } }).then(r => r?.id ?? null)
          : Promise.resolve(null),
      ])
    : // Codex R9 (P2): sin snapshot, el id sólo es trazable si la estructura es del VENUE; una heredada de la organización vive
      // en otra tabla y su id en esta FK haría reventar la creación del costo (rollback) con la tarifa ya disponible.
      [providerCostStructure?.id ?? null, venuePricingStructure?.source === 'venue' ? venuePricingStructure.id : null]
  const transactionCost = await db.transactionCost.create({
    data: {
      paymentId: payment.id,
      merchantAccountId: merchantAccount.id,
      transactionType,
      amount,

      // Provider costs (what Avoqado pays)
      providerRate,
      providerCostAmount,
      providerFixedFee,
      providerCostStructureId,

      // Venue pricing (what Avoqado charges)
      venueRate,
      venueChargeAmount,
      venueFixedFee,
      venuePricingStructureId,

      // Profit calculation
      grossProfit,
      profitMargin,
    },
  })

  // Calculate fee and net amounts for caller — la MISMA proyección que usa el costo diferido (Codex R3): parte de los
  // valores tal como quedan PERSISTIDOS (4 decimales) y conserva el total (comisión + neto = importe).
  const { fee: totalFee, net: netAmountCalculated } = proyectarComisionYNeto(amount, venueChargeAmount, venueFixedFee)

  logger.info('TransactionCost created successfully', {
    transactionCostId: transactionCost.id,
    paymentId,
    grossProfit,
    profitMargin,
    feeAmount: totalFee,
    netAmount: netAmountCalculated,
  })

  // ========================================
  // Step 7: Populate VenueTransaction settlement metadata
  // ========================================
  // Without this, the dashboard's "saldo disponible" calendar can't show this
  // payment until the manual backfill script runs. Locally wrapped so any
  // failure (missing SettlementConfiguration, etc) is logged but never blocks
  // the cobro — TransactionCost is already saved and the caller has its own
  // try/catch around this whole function.
  try {
    const settlementInfo = await calculatePaymentSettlement(payment, merchantAccount.id, transactionType, db)

    if (settlementInfo) {
      await db.venueTransaction.update({
        where: { paymentId: payment.id },
        data: {
          estimatedSettlementDate: settlementInfo.estimatedSettlementDate,
          netSettlementAmount: settlementInfo.netSettlementAmount,
          settlementConfigId: settlementInfo.settlementConfigId,
        },
      })
      logger.info('Settlement metadata populated', {
        paymentId,
        estimatedSettlementDate: settlementInfo.estimatedSettlementDate,
        netSettlementAmount: settlementInfo.netSettlementAmount,
      })
    } else {
      logger.warn('No active SettlementConfiguration found; settlement metadata left null', {
        paymentId,
        merchantAccountId: merchantAccount.id,
        transactionType,
      })
    }
  } catch (settlementError) {
    logger.error('Failed to populate settlement metadata; payment unaffected', {
      paymentId,
      error: settlementError instanceof Error ? settlementError.message : settlementError,
    })
  }

  return {
    transactionCost,
    feeAmount: totalFee,
    netAmount: netAmountCalculated,
  }
}

/**
 * Create a negative TransactionCost record for a refund
 *
 * This function mirrors the original payment's TransactionCost but with negative values.
 * This ensures that:
 * - SUM(grossProfit) correctly subtracts refunded amounts
 * - Dashboard totals and profit analytics are accurate
 * - Refunds are properly tracked in financial reports
 *
 * Example:
 * - Original payment: $11.00, profit = $0.02
 * - Refund: -$11.00, profit = -$0.02
 * - Net profit after refund: $0.00 ✓
 *
 * @param refundPaymentId - The ID of the refund Payment record
 * @param originalPaymentId - The ID of the original Payment that was refunded
 * @returns The created TransactionCost record or null if original had no TransactionCost
 */
export async function createRefundTransactionCost(
  refundPaymentId: string,
  originalPaymentId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<any | null> {
  logger.info('Creating refund TransactionCost', { refundPaymentId, originalPaymentId })

  // Find the original payment's TransactionCost
  const originalTransactionCost = await db.transactionCost.findUnique({
    where: { paymentId: originalPaymentId },
  })

  if (!originalTransactionCost) {
    logger.info('No TransactionCost found for original payment, skipping refund TransactionCost', {
      refundPaymentId,
      originalPaymentId,
    })
    return null
  }

  // Fetch the refund payment to get amount info
  const refundPayment = await db.payment.findUnique({
    where: { id: refundPaymentId },
  })

  if (!refundPayment) {
    throw new NotFoundError(`Refund payment ${refundPaymentId} not found`)
  }

  // Calculate the refund ratio (for partial refunds)
  // If original was $100 and refund is $50, ratio = 0.5
  const originalAmount = parseFloat(originalTransactionCost.amount.toString())
  // Codex R2 (N4): el costo original se cobró sobre base + propina; el reembolso guarda `amount` (base) y `tipAmount`
  // (propina) por separado. El total devuelto es la suma: sin la propina, una devolución total quedaba «parcial» y ni
  // revertía la comisión entera ni devolvía el fijo.
  const refundAmount =
    Math.abs(parseFloat(refundPayment.amount.toString())) + Math.abs(parseFloat(refundPayment.tipAmount?.toString() || '0'))
  const refundRatio = originalAmount > 0 ? refundAmount / originalAmount : 1

  // Create negative TransactionCost mirroring the original (scaled by refund ratio for partial refunds)
  const providerCostAmount = -(parseFloat(originalTransactionCost.providerCostAmount.toString()) * refundRatio)
  const providerFixedFee = refundRatio === 1 ? -parseFloat(originalTransactionCost.providerFixedFee.toString()) : 0
  const venueChargeAmount = -(parseFloat(originalTransactionCost.venueChargeAmount.toString()) * refundRatio)
  const venueFixedFee = refundRatio === 1 ? -parseFloat(originalTransactionCost.venueFixedFee.toString()) : 0
  // Codex R3 (P2): el margen revertido sale de los COMPONENTES efectivamente revertidos — en un reembolso parcial los
  // fijos no se devuelven, así que `grossProfit × ratio` sobreestimaba lo que Avoqado deja de ganar.
  const grossProfit = venueChargeAmount + venueFixedFee - (providerCostAmount + providerFixedFee)
  const totalVenueCharge = venueChargeAmount + venueFixedFee
  const profitMargin = totalVenueCharge !== 0 ? grossProfit / totalVenueCharge : parseFloat(originalTransactionCost.profitMargin.toString())
  const refundTransactionCost = await db.transactionCost.create({
    data: {
      paymentId: refundPaymentId,
      merchantAccountId: originalTransactionCost.merchantAccountId,
      transactionType: originalTransactionCost.transactionType,

      // Negative amount
      amount: -refundAmount,

      // Provider costs (negative - Avoqado "un-pays" these)
      providerRate: originalTransactionCost.providerRate,
      providerCostAmount,
      providerFixedFee,
      providerCostStructureId: originalTransactionCost.providerCostStructureId,

      // Venue pricing (negative - Avoqado "un-charges" these)
      venueRate: originalTransactionCost.venueRate,
      venueChargeAmount,
      venueFixedFee,
      venuePricingStructureId: originalTransactionCost.venuePricingStructureId,

      // Profit calculation (negative - Avoqado "un-earns" this)
      grossProfit,
      profitMargin,
    },
  })

  logger.info('Refund TransactionCost created successfully', {
    refundTransactionCostId: refundTransactionCost.id,
    refundPaymentId,
    originalPaymentId,
    grossProfit: refundTransactionCost.grossProfit,
    refundRatio,
  })

  return refundTransactionCost
}
