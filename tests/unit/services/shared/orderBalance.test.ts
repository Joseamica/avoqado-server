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
import {
  cierreDelCobroSaldaLaCuenta,
  claseDeEstado,
  computeOrderBalance,
  computeStoredOrderTotal,
  estadoAlRecibirDinero,
  impuestoQueSeCobraAparte,
} from '@/services/shared/orderBalance'

const d = (v: string | number) => new Prisma.Decimal(v)

/** Atajo: una cuenta con sólo subtotal. */
const order = (over: Partial<{ subtotal: string; discountAmount: string; serviceChargeAmount: string }> = {}) => ({
  subtotal: d(over.subtotal ?? '200.00'),
  discountAmount: d(over.discountAmount ?? '0.00'),
  serviceChargeAmount: d(over.serviceChargeAmount ?? '0.00'),
  contratoDePrecio: 'IVA_INCLUIDO',
  taxAmount: 0,
  status: 'PENDING',
})

const pay = (amount: string, tip = '0.00') => ({ amount: d(amount), tipAmount: d(tip) })

/**
 * Un reembolso, tal como lo escriben los TRES caminos que los crean
 * (`refund.tpv.service.ts`, `refund.dashboard.service.ts`,
 * `refund.mobile.service.ts`): `Payment` NEGATIVO, `status: COMPLETED`,
 * `type: 'REFUND'`. Se pasan los importes en POSITIVO y el helper los niega,
 * que es como se leen en la base.
 */
const refund = (amount: string, tip = '0.00') => ({
  amount: d(`-${amount}`),
  tipAmount: d(`-${tip}`),
  type: 'REFUND' as const,
})

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
    const balance = computeOrderBalance(
      {
        subtotal: d('100.00'),
        discountAmount: null,
        serviceChargeAmount: null,
        contratoDePrecio: 'IVA_INCLUIDO',
        taxAmount: 0,
        status: 'PENDING',
      },
      [{ amount: d('40.00'), tipAmount: null }],
    )

    expect(balance.total.toString()).toBe('100')
    expect(balance.paidAmount.toString()).toBe('40')
    expect(balance.remainingBalance.toString()).toBe('60')
  })

  // ── 4. Reembolsos: un reembolso NUNCA reabre saldo ─────────────────────────
  //
  // Decisión del founder (2026-08-18), alineada con Square, Toast, Clip y el SAT:
  // el reembolso vive APARTE y la venta original NO se toca. Toast lo dice literal
  // en su API — "`totalAmount` is not affected by refunds" — y lleva el estado en
  // `Payment.refundStatus` = NONE/PARTIAL/FULL, que es el modelo que copiamos.
  // En México además es requisito fiscal: la devolución se ampara con un CFDI de
  // Egreso (nota de crédito, relación 01, uso G02); el CFDI de ingreso original
  // sigue vivo, así que una cuenta que vuelve a decir "debe $X" es incompatible
  // con lo ya timbrado.
  //
  // El defecto que esto cierra: `paidAmount` sumaba TODOS los COMPLETED, y un
  // reembolso es un `Payment` NEGATIVO con `type: REFUND` colgado de la MISMA
  // orden. Cualquier recálculo posterior (otro cobro, o el webhook de cripto)
  // hacía 200 + (−200) = 0 pagados ⇒ la venta devuelta reaparecía debiendo $200,
  // en el estado contradictorio `status COMPLETED` + `paymentStatus PARTIAL`.
  describe('reembolsos — el pago negativo NO cuenta en el saldo', () => {
    it('🔴 [+200 REGULAR, −200 REFUND] deja la cuenta SALDADA, no debiendo 200', () => {
      const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('200.00'), refund('200.00')])

      expect(balance.paidAmount.toString()).toBe('200')
      expect(balance.remainingBalance.toString()).toBe('0')
      expect(balance.isFullyPaid).toBe(true)
      // El reembolso lleva su propio carril (el `refunded_money` de Square).
      expect(balance.refundedCents).toBe(20000)
      expect(balance.refundedAmount.toString()).toBe('200')
      expect(balance.refundState).toBe('FULL')
    })

    it('un reembolso PARCIAL tampoco reabre saldo, y se marca PARTIAL', () => {
      const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('200.00'), refund('50.00')])

      expect(balance.paidAmount.toString()).toBe('200')
      expect(balance.remainingBalance.toString()).toBe('0')
      expect(balance.isFullyPaid).toBe(true)
      expect(balance.refundedCents).toBe(5000)
      expect(balance.refundState).toBe('PARTIAL')
    })

    it('la propina devuelta también cuenta como reembolsada (y no se resta de lo pagado)', () => {
      // Cobro de $200 + $10 de propina; se devuelve todo, propina incluida.
      const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('200.00', '10.00'), refund('200.00', '10.00')])

      // El total sigue incluyendo la propina COBRADA: la venta no se reescribe.
      expect(balance.tipAmount.toString()).toBe('10')
      expect(balance.total.toString()).toBe('210')
      expect(balance.paidAmount.toString()).toBe('210')
      expect(balance.remainingBalance.toString()).toBe('0')
      expect(balance.refundedCents).toBe(21000)
      expect(balance.refundState).toBe('FULL')
    })

    it('varios reembolsos parciales se acumulan hasta FULL', () => {
      const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('200.00'), refund('120.00'), refund('80.00')])

      expect(balance.refundedCents).toBe(20000)
      expect(balance.refundState).toBe('FULL')
      expect(balance.remainingBalance.toString()).toBe('0')
    })

    it('una cuenta reembolsada que recibe un cobro NUEVO vuelve a PARTIAL (el dinero nuevo es real)', () => {
      // +200, −200, +200: se cobró, se devolvió, se volvió a cobrar. Lo pagado
      // neto son $400 y lo devuelto $200 — la cuenta NO está totalmente devuelta.
      const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('200.00'), refund('200.00'), pay('200.00')])

      expect(balance.paidAmount.toString()).toBe('400')
      expect(balance.refundState).toBe('PARTIAL')
      expect(balance.isFullyPaid).toBe(true)
    })

    it('un abono parcial YA reembolsado no cierra la cuenta: sigue debiendo el resto', () => {
      // Cuenta de $200: abonó $50 y se le devolvieron. Sigue debiendo $200 —
      // pero por el abono que se canceló, no porque el refund reste.
      const balance = computeOrderBalance(order({ subtotal: '200.00' }), [pay('50.00'), refund('50.00')])

      expect(balance.paidAmount.toString()).toBe('50')
      expect(balance.remainingBalance.toString()).toBe('150')
      expect(balance.isFullyPaid).toBe(false)
      expect(balance.refundState).toBe('FULL')
    })

    it('REGRESIÓN: sin reembolsos, `refundState` es NONE y nada más cambia', () => {
      const balance = computeOrderBalance(order({ subtotal: '200.00', serviceChargeAmount: '20.00' }), [pay('100.00', '10.00')])

      expect(balance.refundState).toBe('NONE')
      expect(balance.refundedCents).toBe(0)
      expect(balance.refundedAmount.toString()).toBe('0')
      // Idénticos al caso de arriba sin el campo `type`.
      expect(balance.total.toString()).toBe('230')
      expect(balance.paidAmount.toString()).toBe('110')
      expect(balance.remainingBalance.toString()).toBe('120')
    })

    it('un `type` distinto de REFUND (REGULAR/FAST/null) SÍ cuenta como pago', () => {
      const balance = computeOrderBalance(order({ subtotal: '300.00' }), [
        { amount: d('100.00'), tipAmount: d('0.00'), type: 'REGULAR' },
        { amount: d('100.00'), tipAmount: d('0.00'), type: 'FAST' },
        { amount: d('100.00'), tipAmount: d('0.00'), type: null },
      ])

      expect(balance.paidAmount.toString()).toBe('300')
      expect(balance.refundState).toBe('NONE')
      expect(balance.isFullyPaid).toBe(true)
    })
  })
})

describe('P12 — el IVA que va aparte entra al total y al saldo (Codex r2; founder 2-oct)', () => {
  const pagos = [{ amount: 100, tipAmount: 0 }]
  const orden = (contratoDePrecio: string | null, taxAmount: number, status = 'PENDING') => ({
    subtotal: 100,
    discountAmount: 0,
    serviceChargeAmount: 0,
    contratoDePrecio,
    taxAmount,
    status,
  })
  it('🔴 IVA_APARTE: $100 + $16 de IVA no queda saldada con $100 (hoy sí)', () => {
    const b = computeOrderBalance(orden('IVA_APARTE', 16), pagos)
    expect(Number(b.total)).toBe(116)
    expect(Number(b.remainingBalance)).toBe(16)
    expect(b.isFullyPaid).toBe(false)
  })
  it('🔴 DESCONOCIDO con IVA > 0 (SoftRestaurant de antes del contrato): también suma', () => {
    expect(Number(computeOrderBalance(orden('DESCONOCIDO', 16), pagos).total)).toBe(116)
  })
  it('control: IVA_INCLUIDO nunca suma el IVA aunque venga escrito; un IVA negativo nunca baja lo que se debe', () => {
    expect(Number(computeOrderBalance(orden('IVA_INCLUIDO', 16), pagos).total)).toBe(100)
    expect(Number(computeOrderBalance(orden('IVA_APARTE', -5), pagos).total)).toBe(100)
    expect(computeOrderBalance(orden('DESCONOCIDO', 0), pagos).isFullyPaid).toBe(true)
  })
  it('🔴 computeStoredOrderTotal usa la misma regla (con IVA incluido ya no suma un IVA escrito)', () => {
    const base = { subtotal: 100, discountAmount: 10, serviceChargeAmount: 5, tipAmount: 2, status: 'PENDING' }
    expect(Number(computeStoredOrderTotal({ ...base, contratoDePrecio: 'IVA_APARTE', taxAmount: 16 }))).toBe(113)
    expect(Number(computeStoredOrderTotal({ ...base, contratoDePrecio: 'IVA_INCLUIDO', taxAmount: 16 }))).toBe(97)
  })
  it('🔴 Codex r6 #3: lo GUARDADO sigue la misma regla — una CANCELADA con IVA 16 guarda total 0; abierta, 16', () => {
    const origen = { subtotal: 0, discountAmount: 0, serviceChargeAmount: 0, tipAmount: 0, contratoDePrecio: 'IVA_APARTE', taxAmount: 16 }
    expect(Number(computeStoredOrderTotal({ ...origen, status: 'CANCELLED' }))).toBe(0)
    expect(Number(computeStoredOrderTotal({ ...origen, status: 'PENDING' }))).toBe(16)
  })
  it('control — Codex r5: una cuenta CANCELADA no debe IVA (el origen de una fusión vieja: subtotal y total 0, IVA 16) ⇒ saldo 0', () => {
    const origenFusionado = {
      subtotal: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      contratoDePrecio: 'IVA_APARTE',
      taxAmount: 16,
      status: 'CANCELLED',
    }
    expect(Number(computeOrderBalance(origenFusionado, []).remainingBalance)).toBe(0)
    expect(Number(computeOrderBalance({ ...origenFusionado, status: 'DELETED' }, []).remainingBalance)).toBe(0)
    expect(Number(impuestoQueSeCobraAparte({ contratoDePrecio: 'IVA_APARTE', taxAmount: 16, status: 'CANCELLED' }))).toBe(0)
  })
  it('🔴 la misma cuenta ABIERTA sí debe sus $16 (P12): el estado es lo único que las separa', () => {
    expect(Number(computeOrderBalance(orden('IVA_APARTE', 16), []).remainingBalance)).toBe(116)
  })
  it('🔴 Codex r7 #2: claseDeEstado — los estados vivos son una sola clase para el dinero; cancelada y borrada, la otra', () => {
    expect(['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED'].map(claseDeEstado)).toEqual(['VIVA', 'VIVA', 'VIVA', 'VIVA', 'VIVA'])
    expect(['CANCELLED', 'DELETED'].map(claseDeEstado)).toEqual(['CANCELADA', 'CANCELADA'])
  })
})

describe('Founder 3-oct: estadoAlRecibirDinero — el dinero YA capturado reabre una cancelada; sin dinero no la toca', () => {
  it('🔴 cancelada o borrada que recibe dinero ⇒ PENDING (el estado al que también la reabre la reasignación)', () => {
    expect(estadoAlRecibirDinero('CANCELLED', 116)).toBe('PENDING')
    expect(estadoAlRecibirDinero('DELETED', new Prisma.Decimal('0.01'))).toBe('PENDING')
  })
  it('control: una viva se queda como está, y una cancelada SIN dinero también', () => {
    expect(['PENDING', 'CONFIRMED', 'PREPARING', 'COMPLETED'].map(s => estadoAlRecibirDinero(s, 116))).toEqual([
      'PENDING',
      'CONFIRMED',
      'PREPARING',
      'COMPLETED',
    ])
    expect(estadoAlRecibirDinero('CANCELLED', 0)).toBe('CANCELLED')
  })
})

describe('cierreDelCobroSaldaLaCuenta — quién salda la cuenta (revisión 6d I-1: lo comparten `recordOrderPayment` y la reasignación)', () => {
  it('control — una cuenta normal la salda el cierre del cobro; una integrada (POS con `externalId`) o con vales por área, no', () => {
    const normal = { source: 'TPV', externalId: null, items: [{ areaTicketLineId: null }] }
    expect(cierreDelCobroSaldaLaCuenta(normal)).toBe(true)
    expect(cierreDelCobroSaldaLaCuenta({ ...normal, source: 'POS', externalId: 'SR-1' })).toBe(false)
    expect(cierreDelCobroSaldaLaCuenta({ ...normal, items: [{ areaTicketLineId: null }, { areaTicketLineId: 'atl-1' }] })).toBe(false)
    // Un `externalId` en blanco no la vuelve integrada (el mismo `trim()` que tenía `recordOrderPayment`), ni uno fuera de POS.
    expect(cierreDelCobroSaldaLaCuenta({ ...normal, source: 'POS', externalId: '   ' })).toBe(true)
    expect(cierreDelCobroSaldaLaCuenta({ ...normal, source: 'TPV', externalId: 'X-1' })).toBe(true)
  })
})
