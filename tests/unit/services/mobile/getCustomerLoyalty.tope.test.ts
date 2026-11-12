/**
 * hz:ce654971:D18 — la vista de lealtad que usa el POS (`getCustomerLoyalty`) topa con la MISMA regla y la MISMA base que el canje
 * (`redeemPointsToOrderInTransaction`): subtotal − descuentos, nunca `order.total` (que trae cargos por servicio e IVA aparte).
 */
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  getOrCreateLoyaltyConfig: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import { getOrCreateLoyaltyConfig } from '@/services/dashboard/loyalty.dashboard.service'
import {
  getCustomerLoyalty,
  previaDelCanje,
  previaDelCanjeEnCuenta,
  puntosQueCaben,
  puntosQueSeCanjean,
} from '@/services/mobile/loyalty.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const config = (o: Partial<{ redemptionRate: number; minPointsRedeem: number; active: boolean }> = {}) => ({
  active: true,
  pointsPerDollar: 1,
  redemptionRate: 1,
  minPointsRedeem: 10,
  ...o,
})

function preparar({
  saldo,
  orden,
  cfg = {},
}: {
  saldo: number
  orden?: { total: number; subtotal: number; discountAmount: number } | null // `total` va para mostrar que ya no se lee
  cfg?: Parameters<typeof config>[0]
}) {
  ;(getOrCreateLoyaltyConfig as jest.Mock).mockResolvedValue(config(cfg))
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: 'Ana', lastName: null, loyaltyPoints: saldo })
  prismaMock.order.findFirst.mockResolvedValue(orden ?? null)
}

describe('getCustomerLoyalty — tope igual al canje (D18)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con cargo por servicio, topa contra subtotal − descuentos y no contra el total', async () => {
    // $100 de productos, $10 de descuento, $9 de cargo por servicio ⇒ total $99; el canje sólo puede bajar $90.
    preparar({ saldo: 500, orden: { total: 99, subtotal: 100, discountAmount: 10 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemableValue).toBe(90)
    expect(r.maxRedeemablePoints).toBe(90)
    // Lo que ofrece la caja es exactamente lo que el canje aplicaría con esos puntos.
    expect(puntosQueSeCanjean(r.maxRedeemablePoints, r.redemptionRate, 100 - 10)).toEqual({ puntos: 90, monto: 90 })
  })

  it('con IVA aparte, el IVA no entra al tope', async () => {
    preparar({ saldo: 500, orden: { total: 116, subtotal: 100, discountAmount: 0 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemableValue).toBe(100)
    expect(r.maxRedeemablePoints).toBe(100)
  })

  it('los puntos ofrecidos nunca valen más de lo que el canje descuenta (tasa con decimales)', async () => {
    preparar({ saldo: 5000, orden: { total: 0.3, subtotal: 0.3, discountAmount: 0 }, cfg: { redemptionRate: 0.1, minPointsRedeem: 1 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemableValue).toBe(0.3)
    expect(r.maxRedeemablePoints).toBe(3)
    expect(puntosQueSeCanjean(r.maxRedeemablePoints, 0.1, 0.3)).toEqual({ puntos: 3, monto: 0.3 })
  })

  it('base de centavos: los puntos ofrecidos caben sin que el canje los tope', async () => {
    preparar({ saldo: 500, orden: { total: 105.5, subtotal: 95.5, discountAmount: 0 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemableValue).toBe(95.5)
    expect(r.maxRedeemablePoints).toBe(95)
    const canje = puntosQueSeCanjean(r.maxRedeemablePoints, 1, 95.5)
    expect(canje.monto).toBe(r.maxRedeemablePoints * r.redemptionRate)
  })

  it('cuenta ya descontada por completo ⇒ no se puede canjear', async () => {
    preparar({ saldo: 500, orden: { total: 9, subtotal: 100, discountAmount: 100 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemablePoints).toBe(0)
    expect(r.canRedeem).toBe(false)
  })

  // ── Regresión: lo que ya hacía ──
  it('sin orden, el tope es el saldo', async () => {
    preparar({ saldo: 250 })
    const r = await getCustomerLoyalty('v1', 'c1')
    expect(r.maxRedeemableValue).toBe(250)
    expect(r.maxRedeemablePoints).toBe(250)
    expect(r.canRedeem).toBe(true)
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
  })

  it('saldo menor que la cuenta: se ofrece todo el saldo', async () => {
    preparar({ saldo: 40, orden: { total: 200, subtotal: 200, discountAmount: 0 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemablePoints).toBe(40)
    expect(r.maxRedeemableValue).toBe(40)
  })

  it('orden que no existe en el negocio: sin tope de cuenta', async () => {
    preparar({ saldo: 60, orden: null })
    const r = await getCustomerLoyalty('v1', 'c1', 'o-ajena')
    expect(r.maxRedeemablePoints).toBe(60)
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o-ajena', venueId: 'v1' } }))
  })

  it('por debajo del mínimo no se puede canjear', async () => {
    preparar({ saldo: 5, orden: { total: 100, subtotal: 100, discountAmount: 0 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.canRedeem).toBe(false)
  })
})

describe('puntosQueCaben — el tope redondea a centavos como el canje (Codex r1)', () => {
  it('tasa 0.0149 sobre $1.50: caben 101 (101 × 0.0149 = 1.5049 → $1.50) y el canje no los topa', () => {
    expect(puntosQueCaben(1.5, 0.0149, 500)).toBe(101)
    expect(puntosQueSeCanjean(101, 0.0149, 1.5)).toEqual({ puntos: 101, monto: 1.5 })
    expect(puntosQueSeCanjean(102, 0.0149, 1.5).puntos).toBe(101) // uno más ya lo topa el canje
  })

  it('barrido: con el máximo el canje nunca topa, y con uno más sí (salvo que se acabe el saldo)', () => {
    for (const tasa of [0.01, 0.0149, 0.05, 0.1, 0.25, 0.3333, 1, 1.5, 7]) {
      for (const valor of [0.01, 0.3, 1.5, 9.99, 95.5, 223, 1234.56]) {
        const saldo = 100000
        const p = puntosQueCaben(valor, tasa, saldo)
        const conP = puntosQueSeCanjean(p, tasa, valor)
        if (p > 0) expect(conP.puntos).toBe(p)
        expect(conP.monto).toBeLessThanOrEqual(valor)
        if (p < saldo) expect(Math.round((p + 1) * tasa * 100) / 100).toBeGreaterThan(valor)
        else expect(Math.round(saldo * tasa * 100) / 100).toBeLessThanOrEqual(valor)
      }
    }
  })

  it('nunca más que el saldo, y 0 con tasa o valor en cero', () => {
    expect(puntosQueCaben(1000, 1, 40)).toBe(40)
    expect(puntosQueCaben(10, 0, 40)).toBe(0)
    expect(puntosQueCaben(0, 1, 40)).toBe(0)
  })
})

describe('previaDelCanje — la vista previa del MCP es lo que el canje hará con esos puntos (Codex r1)', () => {
  const vista = { balance: 500, redemptionRate: 0.0149, minPointsRedeem: 1, maxRedeemableValue: 1.5 }

  it('101 puntos sobre $1.50: la previa dice 101 → $1.50, igual que el canje', () => {
    expect(previaDelCanje(101, vista)).toEqual({ ok: true, puntos: 101, monto: 1.5 })
  })

  it('pedir de más: la previa dice lo que el canje quema de verdad (topado), no otra cifra', () => {
    expect(previaDelCanje(300, vista)).toEqual({ ok: true, ...puntosQueSeCanjean(300, 0.0149, 1.5) })
  })

  it('las negativas del canje: mínimo, saldo y cuenta sin nada que descontar', () => {
    expect(previaDelCanje(5, { ...vista, minPointsRedeem: 10 })).toMatchObject({ ok: false })
    expect(previaDelCanje(501, vista)).toEqual({ ok: false, error: 'Puntos insuficientes: el cliente tiene 500' })
    expect(previaDelCanje(10, { ...vista, maxRedeemableValue: 0 })).toMatchObject({ ok: false })
  })
})

/** `String.format(Locale.US, "%.2f", x)` de ANDROID: la mitad hacia arriba sobre el decimal que escribe `x`. */
const comoAndroid = (x: number) => Number(new Prisma.Decimal(String(x)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP))

describe('puntosQueCaben — lo que ANDROID pinta al abrir es lo que se descuenta (Codex r2)', () => {
  it('tasa 0.0201 sobre $1.00: 50 pts pintarían «$1.01» y descuentan $1.00 ⇒ se ofrecen 49', () => {
    expect(comoAndroid(50 * 0.0201)).toBe(1.01)
    expect(puntosQueCaben(1, 0.0201, 500)).toBe(49)
  })

  it('barrido: el máximo ofrecido se pinta igual que lo que descuenta el canje', () => {
    for (const tasa of [0.01, 0.0149, 0.0201, 0.05, 0.1, 0.125, 0.3333, 1, 1.5, 7]) {
      for (const valor of [0.01, 0.3, 1, 1.5, 9.99, 95.5, 223, 1234.56]) {
        const p = puntosQueCaben(valor, tasa, 100000)
        const canje = puntosQueSeCanjean(p, tasa, valor)
        if (p > 0) expect(comoAndroid(p * tasa)).toBe(canje.monto)
      }
    }
  })
})

describe('previaDelCanjeEnCuenta — las negativas del canje también en la previa (Codex r2)', () => {
  beforeEach(() => jest.clearAllMocks())
  const cuenta = (o: Partial<{ status: string; paymentStatus: string }> = {}) => ({
    total: 1,
    subtotal: 1,
    discountAmount: 0,
    status: 'PENDING',
    paymentStatus: 'PENDING',
    ...o,
  })

  it('cuenta abierta: la cifra es la del canje', async () => {
    preparar({ saldo: 500, orden: cuenta() as any, cfg: { redemptionRate: 0.0201, minPointsRedeem: 1 } })
    await expect(previaDelCanjeEnCuenta('v1', 'c1', 'o1', 50)).resolves.toMatchObject({ ok: true, ...puntosQueSeCanjean(50, 0.0201, 1) })
  })

  it('programa apagado', async () => {
    preparar({ saldo: 500, orden: cuenta() as any, cfg: { active: false } })
    await expect(previaDelCanjeEnCuenta('v1', 'c1', 'o1', 50)).resolves.toEqual({
      ok: false,
      error: 'El programa de lealtad no está activo en esta sucursal',
    })
  })

  it('cuenta que no existe, anulada o ya pagada', async () => {
    preparar({ saldo: 500, orden: null })
    await expect(previaDelCanjeEnCuenta('v1', 'c1', 'o1', 50)).resolves.toEqual({ ok: false, error: 'Orden no encontrada' })
    preparar({ saldo: 500, orden: cuenta({ status: 'CANCELLED' }) as any })
    await expect(previaDelCanjeEnCuenta('v1', 'c1', 'o1', 50)).resolves.toMatchObject({ ok: false })
    preparar({ saldo: 500, orden: cuenta({ paymentStatus: 'PARTIAL' }) as any })
    await expect(previaDelCanjeEnCuenta('v1', 'c1', 'o1', 50)).resolves.toEqual({
      ok: false,
      error: 'No se puede modificar una orden ya pagada',
    })
  })
})
