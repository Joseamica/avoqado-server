/**
 * Aritmética canónica del saldo de una cuenta — función PURA.
 *
 * Existe porque tres caminos de cobro distintos (efectivo móvil, TPV, cripto)
 * reimplementaban la misma suma y ninguno la escribía igual. El de cripto ni
 * siquiera sumaba: pisaba `paidAmount` con el último abono y ponía
 * `remainingBalance: 0` incondicionalmente, o sea que un abono de $50 sobre una
 * cuenta de $200 BORRABA los $150 por cobrar.
 *
 * Las reglas que estos tests fijan (copiadas de `payCashOrder`, el camino que ya
 * lo hacía bien):
 *
 *   mercancía = max(0, subtotal − descuento)      ← el clamp va ANTES de sumar
 *   total     = mercancía + cargo por servicio + propinas
 *   pagado    = Σ (amount + tipAmount) de los pagos COMPLETED
 *   restante  = total − pagado
 *   pagada    ⟺ restante <= 0.01                  ← tolerancia de un centavo
 *
 * Todo en `Prisma.Decimal`: en float, 0.1 + 0.2 deja un residuo que convierte
 * una cuenta saldada en una cuenta con "$0.0000000001 por cobrar".
 */

import { Prisma } from '@prisma/client'
import { computeOrderBalance } from '@/services/shared/orderBalance'

const d = (v: string | number) => new Prisma.Decimal(v)

/** Atajo: una cuenta con sólo subtotal. */
const order = (over: Partial<{ subtotal: string; discountAmount: string; serviceChargeAmount: string }> = {}) => ({
  subtotal: d(over.subtotal ?? '200.00'),
  discountAmount: d(over.discountAmount ?? '0.00'),
  serviceChargeAmount: d(over.serviceChargeAmount ?? '0.00'),
})

const pay = (amount: string, tip = '0.00') => ({ amount: d(amount), tipAmount: d(tip) })

describe('computeOrderBalance — aritmética canónica del saldo', () => {
  // ── 1. El defecto que originó todo esto ────────────────────────────────────
  it('un abono parcial deja saldo real, NO cierra la cuenta', () => {
    const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('50.00')])

    expect(balance.isFullyPaid).toBe(false)
    expect(balance.total.toString()).toBe('200')
    expect(balance.paidAmount.toString()).toBe('50')
    expect(balance.remainingBalance.toString()).toBe('150')
  })

  it('el abono que completa la cuenta sí la salda', () => {
    const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('150.00'), pay('50.00')])

    expect(balance.isFullyPaid).toBe(true)
    expect(balance.paidAmount.toString()).toBe('200')
    expect(balance.remainingBalance.toString()).toBe('0')
  })

  // ── 2. El total canónico no es `subtotal` a secas ───────────────────────────
  it('suma el cargo por servicio al total (es ingreso del negocio, no propina)', () => {
    const balance = computeOrderBalance(order({ subtotal: '200.00', serviceChargeAmount: '20.00' }), [pay('100.00')])

    expect(balance.total.toString()).toBe('220')
    expect(balance.remainingBalance.toString()).toBe('120')
    expect(balance.isFullyPaid).toBe(false)
  })

  it('la propina de los pagos entra al total Y a lo pagado', () => {
    // $200 de mercancía + $20 de servicio + $10 de propina = $230 a cobrar.
    // El cliente puso $100 + $10 de propina = $110. Faltan $120.
    const balance = computeOrderBalance(order({ subtotal: '200.00', serviceChargeAmount: '20.00' }), [pay('100.00', '10.00')])

    expect(balance.tipAmount.toString()).toBe('10')
    expect(balance.total.toString()).toBe('230')
    expect(balance.paidAmount.toString()).toBe('110')
    expect(balance.remainingBalance.toString()).toBe('120')
  })

  it('aplica el descuento a la mercancía', () => {
    const balance = computeOrderBalance(order({ subtotal: '200.00', discountAmount: '50.00' }), [pay('100.00')])

    expect(balance.total.toString()).toBe('150')
    expect(balance.remainingBalance.toString()).toBe('50')
  })

  it('🔴 un descuento mayor que el subtotal NO produce un total negativo', () => {
    // Estado real en la base: una cortesía de cuenta completa encima de un
    // descuento previo. Sin el clamp, la venta RESTA del corte del día.
    const balance = computeOrderBalance(order({ subtotal: '100.00', discountAmount: '300.00', serviceChargeAmount: '20.00' }), [])

    // El clamp es sobre la MERCANCÍA: el cargo por servicio sobrevive.
    expect(balance.total.toString()).toBe('20')
    expect(balance.remainingBalance.toString()).toBe('20')
    expect(balance.isFullyPaid).toBe(false)
  })

  // ── 3. Bordes ──────────────────────────────────────────────────────────────
  it('tolerancia de un centavo: $2.00 sobre $2.01 se considera pagada', () => {
    const balance = computeOrderBalance(order({ subtotal: '2.01' }), [pay('2.00')])

    expect(balance.isFullyPaid).toBe(true)
    // El centavo se conserva en el saldo — no se inventa un 0 que descuadre el corte.
    expect(balance.remainingBalance.toString()).toBe('0.01')
  })

  it('un centavo MÁS que la tolerancia sigue siendo cuenta abierta', () => {
    const balance = computeOrderBalance(order({ subtotal: '2.02' }), [pay('2.00')])

    expect(balance.isFullyPaid).toBe(false)
    expect(balance.remainingBalance.toString()).toBe('0.02')
  })

  it('un sobrepago deja saldo 0, nunca negativo', () => {
    const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('250.00')])

    expect(balance.isFullyPaid).toBe(true)
    expect(balance.paidAmount.toString()).toBe('250')
    expect(balance.remainingBalance.toString()).toBe('0')
  })

  it('sin pagos, el saldo es el total completo', () => {
    const balance = computeOrderBalance(order({ subtotal: '200.00' }), [])

    expect(balance.isFullyPaid).toBe(false)
    expect(balance.paidAmount.toString()).toBe('0')
    expect(balance.remainingBalance.toString()).toBe('200')
  })

  it('suma en Decimal, no en float (0.10 + 0.20 salda exactamente 0.30)', () => {
    const balance = computeOrderBalance(order({ subtotal: '0.30' }), [pay('0.10'), pay('0.20')])

    expect(balance.remainingBalance.toString()).toBe('0')
    expect(balance.isFullyPaid).toBe(true)
  })

  it('tolera nulos en descuento, cargo por servicio y propina', () => {
    const balance = computeOrderBalance({ subtotal: d('100.00'), discountAmount: null, serviceChargeAmount: null }, [
      { amount: d('40.00'), tipAmount: null },
    ])

    expect(balance.total.toString()).toBe('100')
    expect(balance.paidAmount.toString()).toBe('40')
    expect(balance.remainingBalance.toString()).toBe('60')
  })
})
