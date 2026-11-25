import {
  DIA_MS,
  cotizarOpcion,
  ofertaCambio,
  opcionDeTuPlan,
  opcionDelAlta,
  planFueraDeVenta,
  esPruebaRegaladaVigente,
  revisarComprobante,
} from '@/services/billing/opcionesDeCompra'
import { MARGEN_CHECKOUT_MS, MARGEN_OFERTA_MS, type FilaDePrueba } from '@/services/billing/cobroDiferido'
import { VIGENCIA_DE_LA_COTIZACION_MS, verificarCotizacion } from '@/services/billing/comprobanteDeCotizacion'
import type { OfertaVigente } from '@/services/billing/planOffer'
import { comprobanteDePrueba, definicionDePrueba, idsDeLaVersion } from '@tests/__helpers__/planOfferFixtures'

const ahora = new Date('2026-12-01T12:00:00Z')
const ahoraMs = ahora.getTime()
const H = 3_600_000

const oferta = (number: number, definition: ReturnType<typeof definicionDePrueba>): OfertaVigente => ({
  number,
  versionId: `cv${number}`,
  definition,
  respaldo: false,
})
const v2 = oferta(
  2,
  definicionDePrueba({
    ids: idsDeLaVersion('v2'),
    netos: { 'PRO:monthly': 79900 },
    planes: { PRO: { requiresCard: false, trialDays: 14 } },
  }),
)
const v3 = (neto: number) => oferta(3, definicionDePrueba({ ids: idsDeLaVersion('v3'), netos: { 'PRO:monthly': neto } }))

const filaRegalada = (tier: string, finEnMs: number, extra: Partial<FilaDePrueba> = {}): FilaDePrueba => ({
  active: true,
  suspendedAt: null,
  stripeSubscriptionId: null,
  endDate: new Date(ahoraMs + finEnMs),
  feature: { code: tier },
  ...extra,
})

describe('el fixture', () => {
  it('definicionDePrueba acepta cambios por plan sin tocar el otro', () => {
    const d = definicionDePrueba({ planes: { PREMIUM: { trialDays: 0 } } })
    expect(d.PREMIUM).toMatchObject({ trialDays: 0, requiresCard: true, onSale: true })
    expect(d.PRO).toMatchObject({ trialDays: 30, requiresCard: true, onSale: true })
  })
})

describe('errores', () => {
  it('ofertaCambio → 409 OFFER_CHANGED con razón y versión', () => {
    const e = ofertaCambio('PAGO_HOY', 3)
    expect(e).toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      message: 'La oferta cambió. Revisa el precio antes de pagar. No se te cobró nada.',
      details: { reason: 'PAGO_HOY', offerVersion: 3 },
    })
  })
  it('planFueraDeVenta → 409 PLAN_NOT_ON_SALE', () => {
    expect(planFueraDeVenta('PRO', 'Pro')).toMatchObject({
      statusCode: 409,
      code: 'PLAN_NOT_ON_SALE',
      message: 'El plan Pro ya no está a la venta. Elige otro plan. No se te cobró nada.',
      details: { tier: 'PRO' },
    })
  })
})

describe('opcionDelAlta', () => {
  it('opcionDelAlta: Pro sin tarjeta 14 días → { firstChargeCents: 0, trialEndsAt: 2026-12-15T12:00Z, precioCents: 92684, priceId: "price_v2_pro_m" }', () => {
    expect(opcionDelAlta(v2, 'PRO', 'monthly', ahora)).toEqual({
      priceId: 'price_v2_pro_m',
      precioCents: 92684,
      netCents: 79900,
      firstChargeCents: 0,
      trialEndsAt: new Date('2026-12-15T12:00:00Z'),
      precioDe: 2,
    })
    expect(DIA_MS).toBe(86_400_000)
  })

  it('opcionDelAlta: Premium con tarjeta y 0 días → { firstChargeCents: 197084, trialEndsAt: null }; fuera de venta → null', () => {
    const v = oferta(2, definicionDePrueba({ ids: idsDeLaVersion('v2'), planes: { PREMIUM: { trialDays: 0 } } }))
    expect(opcionDelAlta(v, 'PREMIUM', 'monthly', ahora)).toMatchObject({
      firstChargeCents: 197084,
      trialEndsAt: null,
      precioCents: 197084,
    })
    const fuera = oferta(2, definicionDePrueba({ ids: idsDeLaVersion('v2'), planes: { PREMIUM: { onSale: false } } }))
    expect(opcionDelAlta(fuera, 'PREMIUM', 'monthly', ahora)).toBeNull()
  })

  it('sin stripePriceId → 503 PLAN_NOT_CONFIGURED', () => {
    const v = oferta(2, definicionDePrueba())
    expect(() => opcionDelAlta(v, 'PRO', 'monthly', ahora)).toThrow(
      expect.objectContaining({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' }),
    )
  })
})

describe('esPruebaRegaladaVigente', () => {
  it('activa, sin suspender, sin Stripe, vigente y del mismo plan', () => {
    expect(esPruebaRegaladaVigente(filaRegalada('PRO', 10 * H), 'PRO', ahoraMs)).toBe(true)
    expect(esPruebaRegaladaVigente(filaRegalada('PRO', 0), 'PRO', ahoraMs)).toBe(true)
    expect(esPruebaRegaladaVigente(filaRegalada('PRO', -1), 'PRO', ahoraMs)).toBe(false)
    expect(esPruebaRegaladaVigente(filaRegalada('PREMIUM', 10 * H), 'PRO', ahoraMs)).toBe(false)
    expect(esPruebaRegaladaVigente(filaRegalada('PRO', 10 * H, { active: false }), 'PRO', ahoraMs)).toBe(false)
    expect(esPruebaRegaladaVigente(filaRegalada('PRO', 10 * H, { suspendedAt: ahora }), 'PRO', ahoraMs)).toBe(false)
    expect(esPruebaRegaladaVigente(filaRegalada('PRO', 10 * H, { stripeSubscriptionId: 'sub_1' }), 'PRO', ahoraMs)).toBe(false)
    expect(esPruebaRegaladaVigente(filaRegalada('PRO', 10 * H, { endDate: null }), 'PRO', ahoraMs)).toBe(false)
    expect(esPruebaRegaladaVigente(null, 'PRO', ahoraMs)).toBe(false)
  })
})

describe('opcionDeTuPlan', () => {
  const base = { vigente: v3(69900), enPruebaDeStripe: null, tier: 'PRO', interval: 'monthly', ahoraMs, margenMs: 72 * H } as const

  it('opcionDeTuPlan: prueba regalada de Pro a 73 h del fin con margen 72 h → trialEndsAt = fin y firstChargeCents 0; a 71 h → cobra hoy el precio de la vigente', () => {
    const fila73 = filaRegalada('PRO', 73 * H)
    expect(opcionDeTuPlan({ ...base, fila: fila73 })).toMatchObject({
      trialEndsAt: fila73.endDate,
      firstChargeCents: 0,
      precioCents: 81084,
      priceId: 'price_v3_pro_m',
      precioDe: 3,
    })
    expect(opcionDeTuPlan({ ...base, fila: filaRegalada('PRO', 71 * H) })).toMatchObject({
      trialEndsAt: null,
      firstChargeCents: 81084,
      precioCents: 81084,
    })
    expect(opcionDeTuPlan({ ...base, fila: null })).toMatchObject({ trialEndsAt: null, firstChargeCents: 81084 })
  })

  it('🔴 MARGEN_OFERTA_MS − MARGEN_CHECKOUT_MS === VIGENCIA_DE_LA_COTIZACION_MS (un «$0 hoy» de una prueba regalada siempre vence antes de las 48 h)', () => {
    expect(MARGEN_OFERTA_MS - MARGEN_CHECKOUT_MS).toBe(VIGENCIA_DE_LA_COTIZACION_MS)
  })

  it('opcionDeTuPlan: plan fuera de venta sin prueba → null; con una prueba regalada de ese plan, o enPruebaDeStripe del mismo plan → se puede comprar', () => {
    const fuera = oferta(3, definicionDePrueba({ ids: idsDeLaVersion('v3'), planes: { PRO: { onSale: false } } }))
    expect(opcionDeTuPlan({ ...base, vigente: fuera, fila: null })).toBeNull()
    expect(opcionDeTuPlan({ ...base, vigente: fuera, fila: filaRegalada('PREMIUM', 100 * H) })).toBeNull()
    expect(opcionDeTuPlan({ ...base, vigente: fuera, fila: filaRegalada('PRO', 100 * H) })).not.toBeNull()
    expect(opcionDeTuPlan({ ...base, vigente: fuera, fila: null, enPruebaDeStripe: 'PRO' })).not.toBeNull()
    expect(opcionDeTuPlan({ ...base, vigente: fuera, fila: null, enPruebaDeStripe: 'PREMIUM' })).toBeNull()
  })
})

describe('cotizarOpcion y revisarComprobante', () => {
  const alcance = 'org:o1'
  const firma = { versionNumber: 2, tier: 'PRO', interval: 'monthly', alcance } as const

  it('cotizarOpcion firma con issuedAt = ahora y devuelve el token con los montos', () => {
    const o = cotizarOpcion(
      { precioCents: 92684, netCents: 79900, firstChargeCents: 0, trialEndsAt: new Date('2026-12-15T12:00:00Z') },
      firma,
      ahora,
    )
    expect(o).toMatchObject({ precioCents: 92684, netCents: 79900, firstChargeCents: 0, trialEndsAt: '2026-12-15T12:00:00.000Z' })
    expect(verificarCotizacion(o.quoteToken, alcance, ahora)).toMatchObject({
      versionNumber: 2,
      precioCents: 92684,
      firstChargeCents: 0,
      issuedAt: ahora,
    })
    expect(
      cotizarOpcion({ precioCents: 92684, netCents: 79900, firstChargeCents: 92684, trialEndsAt: null }, firma, ahora).trialEndsAt,
    ).toBeNull()
  })

  const pedido = { alcance, tier: 'PRO', interval: 'monthly', versionNumber: 2, ahora } as const
  const bueno = () => comprobanteDePrueba({ alcance }, ahora)

  it('revisarComprobante: uno bueno devuelve el comprobante y rechazo null', () => {
    const r = revisarComprobante({ ...pedido, token: bueno() })
    expect(r.rechazo).toBeNull()
    expect(r.comprobante).toMatchObject({ versionNumber: 2, tier: 'PRO', precioCents: 92684 })
  })

  it.each([
    ['sin token', () => undefined, 'OFFER_CHANGED', 'QUOTE_REQUIRED', {}],
    ['otra versión', () => comprobanteDePrueba({ alcance, versionNumber: 1 }, ahora), 'OFFER_CHANGED', 'VERSION', {}],
    ['otro plan', () => comprobanteDePrueba({ alcance, tier: 'PREMIUM' }, ahora), 'OFFER_CHANGED', 'QUOTE_MISMATCH', {}],
    ['otro alcance', () => comprobanteDePrueba({ alcance: 'org:otra' }, ahora), 'QUOTE_INVALID', undefined, {}],
    ['de hace 24 h', () => comprobanteDePrueba({ alcance }, new Date(ahoraMs - 24 * H)), 'QUOTE_EXPIRED', undefined, {}],
    ['null', () => null, 'OFFER_CHANGED', 'QUOTE_REQUIRED', {}],
    ['un número', () => 42, 'QUOTE_INVALID', undefined, {}],
  ])('revisarComprobante %s → rechazo %s (%s) y nunca lanza', (_n, token, code, razon) => {
    const r = revisarComprobante({ ...pedido, token: token() })
    expect(r.comprobante).toBeNull()
    expect(r.rechazo).toMatchObject({ code })
    if (razon) expect(r.rechazo).toMatchObject({ details: { reason: razon, offerVersion: 2 } })
  })
})
