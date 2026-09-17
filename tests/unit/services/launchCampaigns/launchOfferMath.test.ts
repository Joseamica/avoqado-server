/**
 * S2 — la aritmética de la oferta (spec 2026-09-17 § 3.1 y § 7.6).
 *
 * 🔴 Es DINERO y por eso vive en un módulo PURO: sin base, sin Stripe y sin reloj (el `now` entra
 * por parámetro). Todo lo que decide cuánto se cobra se prueba aquí, donde no hay nada que
 * mockear mal.
 *
 * La oferta real del lanzamiento, y el caso que fija el contrato de los otros tres repos:
 *   PRO mensual de lista $1,158.84 con IVA (115884) → anunciado $22.00 (2200)
 *   cupón `amount_off` = 113684 · 3 facturas a 2200 · de la 4ª en adelante 115884.
 */
import {
  IVA_RATE,
  buildLaunchOfferView,
  computeCouponAmountOff,
  firstYearTotalCents,
  launchOfferAvailability,
  promoPeriodTotalCents,
  splitIvaInclusive,
  standardFirstChargeCents,
  type LaunchOfferCampaignRow,
  type StandardPlanQuote,
} from '@/services/launchCampaigns/launchOfferMath'

const AHORA = new Date('2026-10-01T18:00:00.000Z')

const POS22: LaunchOfferCampaignRow = {
  code: 'POS22',
  landingSlug: 'pos-22',
  offerVersion: 1,
  vertical: 'ALL',
  planTier: 'PRO',
  status: 'ACTIVE',
  validFrom: new Date('2026-09-01T06:00:00.000Z'),
  validUntil: new Date('2026-10-31T06:00:00.000Z'),
  redemptionCap: 100,
  redemptionCount: 3,
  advertisedPriceCents: 2200,
  discountMonths: 3,
  listPriceCentsSnapshot: 115884,
  discountAmountCents: 113684,
  headline: 'Tu punto de venta a $22 al mes',
  subheadline: null,
  bullets: [],
}
const con = (extra: Partial<LaunchOfferCampaignRow>): LaunchOfferCampaignRow => ({ ...POS22, ...extra })

const COTIZACION_ESTANDAR: StandardPlanQuote = {
  grossCents: { PRO: { monthly: 115884, annual: 1158840 }, PREMIUM: { monthly: 197084, annual: 1970840 } },
  legacyIntro: { tier: 'PRO', interval: 'monthly', introMonthlyCents: 69484 },
}

describe('splitIvaInclusive — el desglose que se MUESTRA', () => {
  it('el precio de lista de PRO: $1,158.84 = $999.00 + $159.84', () => {
    expect(splitIvaInclusive(115884)).toEqual({ subtotalCents: 99900, ivaCents: 15984 })
  })

  it('el precio promocional: $22.00 = $18.97 + $3.03', () => {
    expect(splitIvaInclusive(2200)).toEqual({ subtotalCents: 1897, ivaCents: 303 })
  })

  it('🔴 la suma SIEMPRE devuelve el bruto exacto — el IVA es el residuo, nunca se calcula aparte', () => {
    for (let gross = 1000; gross <= 200000; gross += 7) {
      const { subtotalCents, ivaCents } = splitIvaInclusive(gross)
      expect(subtotalCents + ivaCents).toBe(gross)
    }
  })

  it('el subtotal es el bruto entre 1.16, redondeado al centavo', () => {
    expect(splitIvaInclusive(2200).subtotalCents).toBe(Math.round(2200 / 1.16)) // 1896.55… → 1897
    expect(IVA_RATE).toBe(0.16)
  })

  it('cero es cero, y nunca produce un IVA negativo', () => {
    expect(splitIvaInclusive(0)).toEqual({ subtotalCents: 0, ivaCents: 0 })
  })

  it('🔴 rechaza un bruto que no es un entero de centavos', () => {
    expect(() => splitIvaInclusive(2200.5)).toThrow(/entero/i)
    expect(() => splitIvaInclusive(-1)).toThrow(/negativo/i)
  })
})

describe('computeCouponAmountOff — lo que se le manda a Stripe', () => {
  it('115884 de lista y 2200 anunciados dan un cupón de 113684', () => {
    expect(computeCouponAmountOff(115884, 2200)).toBe(113684)
  })

  it('el descuento aplicado devuelve exactamente el precio anunciado', () => {
    expect(115884 - computeCouponAmountOff(115884, 2200)).toBe(2200)
  })

  it('🔴 lanza si el precio anunciado no baja de la lista — un cupón de $0 o negativo no existe', () => {
    expect(() => computeCouponAmountOff(115884, 115884)).toThrow(/lista/i)
    expect(() => computeCouponAmountOff(115884, 200000)).toThrow(/lista/i)
  })

  it('🔴 lanza por debajo del mínimo de Stripe ($10.00 MXN)', () => {
    expect(() => computeCouponAmountOff(115884, 999)).toThrow(/10/)
    expect(computeCouponAmountOff(115884, 1000)).toBe(114884)
  })

  it('🔴 lanza si algún importe no es un entero de centavos', () => {
    expect(() => computeCouponAmountOff(115884.4, 2200)).toThrow(/entero/i)
    expect(() => computeCouponAmountOff(115884, 2200.4)).toThrow(/entero/i)
  })
})

describe('promoPeriodTotalCents y firstYearTotalCents — lo que de verdad paga el cliente', () => {
  it('3 meses promocionales a $22.00 son $66.00', () => {
    expect(promoPeriodTotalCents(2200, 3)).toBe(6600)
  })

  it('el primer año son $10,495.56 — 3 × $22.00 + 9 × $1,158.84', () => {
    expect(firstYearTotalCents(2200, 3, 115884)).toBe(1049556)
  })

  it('una promoción de 12 meses deja el primer año en 12 × el precio promocional', () => {
    expect(firstYearTotalCents(2200, 12, 115884)).toBe(26400)
  })

  it('🔴 una promoción de más de 12 meses NO resta meses al primer año', () => {
    expect(firstYearTotalCents(2200, 24, 115884)).toBe(26400)
  })
})

describe('launchOfferAvailability — el ORDEN de los motivos es parte del contrato', () => {
  it('una ficha ACTIVE, dentro de la ventana y con cupo está disponible', () => {
    expect(launchOfferAvailability(POS22, AHORA)).toEqual({ available: true })
  })

  it('DRAFT es NOT_PUBLISHED', () => {
    expect(launchOfferAvailability(con({ status: 'DRAFT' }), AHORA)).toEqual({ available: false, reason: 'NOT_PUBLISHED' })
  })

  it('ENDED es ENDED', () => {
    expect(launchOfferAvailability(con({ status: 'ENDED' }), AHORA)).toEqual({ available: false, reason: 'ENDED' })
  })

  it('PAUSED es PAUSED', () => {
    expect(launchOfferAvailability(con({ status: 'PAUSED' }), AHORA)).toEqual({ available: false, reason: 'PAUSED' })
  })

  it('antes de empezar es NOT_STARTED', () => {
    const r = launchOfferAvailability(POS22, new Date('2026-08-31T06:00:00.000Z'))
    expect(r).toEqual({ available: false, reason: 'NOT_STARTED' })
  })

  it('el instante EXACTO de validFrom ya está dentro', () => {
    expect(launchOfferAvailability(POS22, POS22.validFrom)).toEqual({ available: true })
  })

  it('🔴 el instante EXACTO de validUntil ya está FUERA — la ventana es [validFrom, validUntil)', () => {
    expect(launchOfferAvailability(POS22, POS22.validUntil)).toEqual({ available: false, reason: 'EXPIRED' })
  })

  it('con el cupo lleno es SOLD_OUT', () => {
    expect(launchOfferAvailability(con({ redemptionCount: 100 }), AHORA)).toEqual({ available: false, reason: 'SOLD_OUT' })
    expect(launchOfferAvailability(con({ redemptionCount: 101 }), AHORA)).toEqual({ available: false, reason: 'SOLD_OUT' })
    expect(launchOfferAvailability(con({ redemptionCount: 99 }), AHORA)).toEqual({ available: true })
  })

  it('🔴 ACTIVE sin los importes congelados es NOT_PUBLISHED — nunca se pinta un precio a medio congelar', () => {
    expect(launchOfferAvailability(con({ listPriceCentsSnapshot: null }), AHORA)).toEqual({ available: false, reason: 'NOT_PUBLISHED' })
    expect(launchOfferAvailability(con({ discountAmountCents: null }), AHORA)).toEqual({ available: false, reason: 'NOT_PUBLISHED' })
  })

  // Las tres siguientes fijan el ORDEN, que es lo que el motivo mostrado al visitante depende.
  it('🔴 DRAFT gana a EXPIRED: una ficha nunca publicada y ya vencida dice NOT_PUBLISHED', () => {
    const r = launchOfferAvailability(con({ status: 'DRAFT' }), new Date('2026-12-01T06:00:00.000Z'))
    expect(r).toEqual({ available: false, reason: 'NOT_PUBLISHED' })
  })

  it('🔴 ENDED gana a PAUSED y a SOLD_OUT: terminar es definitivo', () => {
    const r = launchOfferAvailability(con({ status: 'ENDED', redemptionCount: 100 }), AHORA)
    expect(r).toEqual({ available: false, reason: 'ENDED' })
  })

  it('🔴 PAUSED gana a EXPIRED y a SOLD_OUT', () => {
    const vencida = launchOfferAvailability(con({ status: 'PAUSED' }), new Date('2026-12-01T06:00:00.000Z'))
    expect(vencida).toEqual({ available: false, reason: 'PAUSED' })
    expect(launchOfferAvailability(con({ status: 'PAUSED', redemptionCount: 100 }), AHORA)).toEqual({ available: false, reason: 'PAUSED' })
  })

  it('🔴 EXPIRED gana a SOLD_OUT: una campaña vencida Y llena dice vencida', () => {
    const r = launchOfferAvailability(con({ redemptionCount: 100 }), new Date('2026-12-01T06:00:00.000Z'))
    expect(r).toEqual({ available: false, reason: 'EXPIRED' })
  })
})

describe('buildLaunchOfferView — exactamente lo que ven la landing y el dashboard', () => {
  it('la vista disponible es el ejemplo literal de la spec § 3.3', () => {
    expect(buildLaunchOfferView(POS22, AHORA)).toEqual({
      code: 'POS22',
      slug: 'pos-22',
      offerVersion: 1,
      vertical: 'ALL',
      planTier: 'PRO',
      planName: 'Pro',
      available: true,
      currency: 'MXN',
      ivaIncluded: true,
      requiresCard: true,
      promo: { monthlyCents: 2200, months: 3, subtotalCents: 1897, ivaCents: 303, periodTotalCents: 6600 },
      renewal: { monthlyCents: 115884, subtotalCents: 99900, ivaCents: 15984 },
      firstChargeCents: 2200,
      validUntil: '2026-10-31T06:00:00.000Z',
      limited: true,
      copy: { headline: 'Tu punto de venta a $22 al mes', subheadline: null, bullets: [] },
    })
  })

  it('PREMIUM se anuncia como «Premium»', () => {
    const v = buildLaunchOfferView(con({ planTier: 'PREMIUM', listPriceCentsSnapshot: 197084, discountAmountCents: 194884 }), AHORA)
    expect(v.available && v.planName).toBe('Premium')
  })

  it('🔴 lo que se cobra HOY es el precio promocional, nunca el de lista', () => {
    const v = buildLaunchOfferView(POS22, AHORA)
    expect(v.available && v.firstChargeCents).toBe(2200)
    expect(v.available && v.promo.monthlyCents).toBe(v.available && v.firstChargeCents)
  })

  it('🔴 la vista NO DISPONIBLE no trae UNA SOLA llave de precio', () => {
    for (const row of [
      con({ status: 'PAUSED' }),
      con({ status: 'ENDED' }),
      con({ status: 'DRAFT' }),
      con({ redemptionCount: 100 }),
      con({ listPriceCentsSnapshot: null }),
    ]) {
      const v = buildLaunchOfferView(row, AHORA)
      expect(v.available).toBe(false)
      const llaves = Object.keys(v)
      expect(llaves.sort()).toEqual(['available', 'code', 'slug', 'unavailableReason'])
      // La red de seguridad: ninguna llave, a ningún nivel, puede mencionar un precio.
      expect(JSON.stringify(v)).not.toMatch(/2200|115884|113684|price|Cents/i)
    }
  })

  it('🔴 tampoco lo trae una ficha VENCIDA, que es la que más tiempo va a vivir enlazada', () => {
    const v = buildLaunchOfferView(POS22, new Date('2026-12-01T06:00:00.000Z'))
    expect(v).toEqual({ code: 'POS22', slug: 'pos-22', available: false, unavailableReason: 'EXPIRED' })
  })

  it('el cupo NUNCA se expone: sólo se dice que es limitada (D10)', () => {
    const v = buildLaunchOfferView(POS22, AHORA)
    expect(v.available && v.limited).toBe(true)
    expect(JSON.stringify(v)).not.toContain('100')
    expect(Object.keys(v)).not.toContain('redemptionCap')
    expect(Object.keys(v)).not.toContain('redemptionCount')
  })
})

describe('standardFirstChargeCents — el camino SIN campaña', () => {
  it('con prueba de 30 días hoy no se cobra nada', () => {
    expect(standardFirstChargeCents(COTIZACION_ESTANDAR, 'PRO', 'monthly', false)).toBe(0)
    expect(standardFirstChargeCents(COTIZACION_ESTANDAR, 'PREMIUM', 'annual', false)).toBe(0)
  })

  it('PRO mensual pagando hoy toma la promoción legacy: $694.84', () => {
    expect(standardFirstChargeCents(COTIZACION_ESTANDAR, 'PRO', 'monthly', true)).toBe(69484)
  })

  it('🔴 la promoción legacy NO se derrama a otros tiers ni a anual', () => {
    expect(standardFirstChargeCents(COTIZACION_ESTANDAR, 'PRO', 'annual', true)).toBe(1158840)
    expect(standardFirstChargeCents(COTIZACION_ESTANDAR, 'PREMIUM', 'monthly', true)).toBe(197084)
    expect(standardFirstChargeCents(COTIZACION_ESTANDAR, 'PREMIUM', 'annual', true)).toBe(1970840)
  })

  it('sin promoción legacy vigente se cobra el precio de lista', () => {
    const sinLegacy: StandardPlanQuote = { ...COTIZACION_ESTANDAR, legacyIntro: null }
    expect(standardFirstChargeCents(sinLegacy, 'PRO', 'monthly', true)).toBe(115884)
  })
})
