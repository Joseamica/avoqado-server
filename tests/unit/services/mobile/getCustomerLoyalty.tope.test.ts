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

  it('cuenta con abono, pagada o anulada: nada que ofrecer, el botón sale apagado (Codex r4)', async () => {
    for (const o of [{ paymentStatus: 'PARTIAL' }, { paymentStatus: 'PAID' }, { status: 'CANCELLED' }, { status: 'DELETED' }]) {
      preparar({ saldo: 500, orden: { total: 100, subtotal: 100, discountAmount: 0, ...o } as any })
      const r = await getCustomerLoyalty('v1', 'c1', 'o1')
      expect(r).toMatchObject({ maxRedeemablePoints: 0, maxRedeemableValue: 0, canRedeem: false, balance: 500, balanceValue: 500 })
    }
  })

  it('con mínimo 0, una cuenta sin nada que descontar no prende el botón (Codex r5)', async () => {
    preparar({
      saldo: 500,
      orden: { total: 100, subtotal: 100, discountAmount: 0, paymentStatus: 'PARTIAL' } as any,
      cfg: { minPointsRedeem: 0 },
    })
    expect((await getCustomerLoyalty('v1', 'c1', 'o1')).canRedeem).toBe(false)
    preparar({ saldo: 500, orden: { total: 100, subtotal: 100, discountAmount: 0 }, cfg: { minPointsRedeem: 0 } })
    expect((await getCustomerLoyalty('v1', 'c1', 'o1')).canRedeem).toBe(true)
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

  it('tasa 0.0059, mínimo 250 y saldo 250 (Codex r3): se ofrecen los 250 y el botón sigue prendido', () => {
    // 250 × 0.0059 = 1.4749999999999999: ANDROID pinta $1.47 y el canje descuenta $1.48 (de menos en pantalla, nunca de más).
    expect(puntosQueCaben(100, 0.0059, 250, 250)).toBe(250)
    expect(puntosQueSeCanjean(250, 0.0059, 100)).toEqual({ puntos: 250, monto: 1.48 })
  })

  it('el ajuste del empate nunca baja del mínimo, aunque la pantalla diga un centavo de más', () => {
    expect(puntosQueCaben(1, 0.0201, 500, 50)).toBe(50)
    expect(puntosQueCaben(1, 0.0201, 500, 49)).toBe(49)
  })

  /**
   * Pasada exhaustiva de la familia «redondeo» (las tres rondas de Codex fueron de ella): tasas de 0.0001 a 0.06 de diezmilésimo en
   * diezmilésimo, más tasas comunes; cuentas con centavos; mínimos y saldos que caen justo en el borde. Tres reglas a la vez:
   *   1. con el máximo ofrecido el canje no topa (quema exactamente esos puntos y descuenta su valor redondeado);
   *   2. si el canje exacto alcanza el mínimo, la caja deja canjear (nunca se apaga por el redondeo);
   *   3. la pantalla de ANDROID no promete más de lo que se descuenta, salvo que bajar un punto deje al cliente bajo el mínimo.
   */
  it('barrido exhaustivo: el canje no topa, nunca se apaga un canje válido y la pantalla no promete de más', () => {
    const tasas = [...Array.from({ length: 600 }, (_, i) => (i + 1) / 10000), 0.0149, 0.0201, 0.0059, 0.125, 0.3333, 1, 1.5, 7]
    const valores = [0.01, 0.3, 0.99, 1, 1.47, 1.5, 9.99, 95.5, 223, 1234.56]
    let casos = 0
    for (const tasa of tasas) {
      for (const valor of valores) {
        const exacto = puntosQueCaben(valor, tasa, Number.MAX_SAFE_INTEGER) // sin saldo ni mínimo: el mayor que el canje no topa
        for (const saldo of [1, exacto - 1, exacto, exacto + 1, 1_000_000].filter(n => n >= 1)) {
          for (const minimo of [1, Math.min(saldo, exacto), Math.min(saldo, exacto) - 1].filter(n => n >= 1)) {
            casos++
            const p = puntosQueCaben(valor, tasa, saldo, minimo)
            const tope = Math.min(saldo, exacto)
            if (p > 0) {
              const canje = puntosQueSeCanjean(p, tasa, valor)
              expect(canje).toEqual({ puntos: p, monto: Math.round(p * tasa * 100) / 100 }) // 1
              if (p - 1 >= minimo) expect(comoAndroid(p * tasa)).toBeLessThanOrEqual(canje.monto) // 3
            }
            if (tope >= minimo) expect(p).toBeGreaterThanOrEqual(minimo) // 2
            expect(p).toBeLessThanOrEqual(tope)
          }
        }
      }
    }
    expect(casos).toBeGreaterThan(20000)
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

/**
 * Pasada exhaustiva de la familia «cuándo se prende Recompensas» (Codex r4 y r5 fueron de ella): para cada combinación de programa,
 * estado de la cuenta, pago, mínimo, saldo y base, el botón (`canRedeem`) se prende SI Y SÓLO SI la previa del canje (las mismas
 * negativas y la misma regla del canje) acepta algún número de puntos sin recortarlos; y si se prende, acepta exactamente el máximo.
 */
describe('canRedeem ⇔ el canje acepta algún número de puntos sin recortarlos (pasada exhaustiva)', () => {
  it('todas las combinaciones', async () => {
    let casos = 0
    for (const active of [true, false]) {
      for (const status of ['PENDING', 'CANCELLED', 'DELETED']) {
        for (const paymentStatus of ['PENDING', 'PARTIAL', 'PAID']) {
          for (const minPointsRedeem of [0, 1, 5, 20]) {
            for (const saldo of [0, 1, 4, 5, 19, 20, 60]) {
              for (const [subtotal, discountAmount] of [
                [0, 0],
                [10, 10],
                [10, 0],
                [0.04, 0],
                [100, 30],
              ]) {
                for (const redemptionRate of [1, 0.0201, 0.25]) {
                  jest.clearAllMocks()
                  const orden = { total: subtotal - discountAmount, subtotal, discountAmount, status, paymentStatus }
                  preparar({ saldo, orden: orden as any, cfg: { active, minPointsRedeem, redemptionRate } })
                  const vista = await getCustomerLoyalty('v1', 'c1', 'o1')
                  const aceptados: number[] = []
                  for (let p = 1; p <= saldo; p++) {
                    // Sin recortar: el canje quema esos puntos y descuenta su valor completo. La caja nunca ofrece quemar un punto
                    // entero por menos de lo que vale (cuenta de $0.04 a $1 por punto): así era antes y así sigue.
                    const r = await previaDelCanjeEnCuenta('v1', 'c1', 'o1', p)
                    if (r.ok && r.puntos === p && r.monto === Math.round(p * redemptionRate * 100) / 100) aceptados.push(p)
                  }
                  casos++
                  const etiqueta = JSON.stringify({
                    active,
                    status,
                    paymentStatus,
                    minPointsRedeem,
                    saldo,
                    subtotal,
                    discountAmount,
                    redemptionRate,
                  })
                  expect([etiqueta, vista.canRedeem]).toEqual([etiqueta, aceptados.length > 0])
                  if (vista.canRedeem) {
                    const conMax = await previaDelCanjeEnCuenta('v1', 'c1', 'o1', vista.maxRedeemablePoints)
                    expect([etiqueta, conMax]).toEqual([etiqueta, expect.objectContaining({ ok: true, puntos: vista.maxRedeemablePoints })])
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(casos).toBe(2 * 3 * 3 * 4 * 7 * 5 * 3)
  })
})
