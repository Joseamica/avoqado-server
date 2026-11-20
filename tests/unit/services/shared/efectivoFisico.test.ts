/**
 * 🔴 DINERO — Máquina de efectivo, fase 1a, Task A5 (Codex R1 #10).
 *
 * La máquina QuickPay Mini registra sus ventas como `method CASH` + `fundsFlow EXTERNAL_RECORDED`: son VENTAS en efectivo, pero
 * ese dinero NO está en el cajón. Las fórmulas del turno sumaban «todo lo CASH» como cajón y le firmaban al cajero un faltante del
 * tamaño de lo que cobró la máquina. `efectivoFisicoDeCobros` separa las dos cifras con la autoridad de `tenderSemantics`.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { efectivoFisicoDeCobros, type CobroConEfectivo } from '@/services/shared/efectivoFisico'
import { paymentCountsAsDrawerCash } from '@/services/shared/tenderSemantics'

const pago = (o: Partial<CobroConEfectivo> = {}): CobroConEfectivo => ({
  amount: new Decimal(0),
  tipAmount: new Decimal(0),
  method: 'CASH',
  fundsFlow: null,
  tenderTypeId: null,
  tenderCountsAsCash: null,
  ...o,
})

describe('efectivoFisicoDeCobros — ventas en efectivo vs lo que está en el cajón', () => {
  it('🔴 $100 en el cajón + $150 de la máquina: las ventas en efectivo son 250 y el cajón 100', () => {
    const r = efectivoFisicoDeCobros([
      pago({ amount: new Decimal(100) }),
      pago({ amount: new Decimal(150), fundsFlow: 'EXTERNAL_RECORDED' }),
    ])
    expect(r.ventasEnEfectivo.toNumber()).toBe(250)
    expect(r.propinasEnEfectivo.toNumber()).toBe(0)
    expect(r.alCajon.toNumber()).toBe(100)
    expect(r.ventasAlCajon.toNumber()).toBe(100)
  })

  it('la propina sigue a su cobro: la del cajón entra al cajón, la de la máquina sólo a las propinas en efectivo', () => {
    const r = efectivoFisicoDeCobros([
      pago({ amount: new Decimal(100), tipAmount: new Decimal(10) }),
      pago({ amount: new Decimal(150), tipAmount: new Decimal(5), fundsFlow: 'EXTERNAL_RECORDED' }),
    ])
    expect(r.ventasEnEfectivo.toNumber()).toBe(250)
    expect(r.propinasEnEfectivo.toNumber()).toBe(15)
    expect(r.alCajon.toNumber()).toBe(110)
    expect(r.ventasAlCajon.toNumber()).toBe(100)
  })

  // ── Regresión: lo de antes del `fundsFlow` no cambia de cifra ──

  it('🔴 cobros viejos sin fundsFlow: el cajón es exactamente ventas + propinas en efectivo (la fórmula de siempre)', () => {
    const r = efectivoFisicoDeCobros([pago({ amount: new Decimal(1800), tipAmount: new Decimal(20) }), pago({ amount: new Decimal(-30) })])
    expect(r.ventasEnEfectivo.toNumber()).toBe(1770)
    expect(r.propinasEnEfectivo.toNumber()).toBe(20)
    expect(r.alCajon.toNumber()).toBe(1790)
    expect(r.ventasAlCajon.toNumber()).toBe(1770)
  })

  it('un cobro CASH_DRAWER explícito cuenta igual que uno viejo', () => {
    const r = efectivoFisicoDeCobros([pago({ amount: new Decimal(100), tipAmount: new Decimal(1), fundsFlow: 'CASH_DRAWER' })])
    expect(r.alCajon.toNumber()).toBe(101)
  })

  it('un tender que no es CASH (vale, Uber, tarjeta) no es venta en efectivo ni entra aquí: el vale lo lleva totalDrawerExtra', () => {
    const r = efectivoFisicoDeCobros([
      pago({ amount: new Decimal(80), method: 'OTHER', tenderTypeId: 'tt-vale', tenderCountsAsCash: true }),
      pago({ amount: new Decimal(200), tipAmount: new Decimal(20), method: 'CREDIT_CARD' }),
    ])
    expect(r.ventasEnEfectivo.toNumber()).toBe(0)
    expect(r.propinasEnEfectivo.toNumber()).toBe(0)
    expect(r.alCajon.toNumber()).toBe(0)
  })

  it('🔴 el veredicto del cajón es el de tenderSemantics en TODAS las combinaciones (nunca un `method === CASH` local)', () => {
    for (const fundsFlow of [null, 'CASH_DRAWER', 'EXTERNAL_RECORDED', 'AVOQADO_PROCESSED'] as const) {
      for (const tenderCountsAsCash of [null, true, false] as const) {
        const cobro = pago({ amount: new Decimal(7), tipAmount: new Decimal(3), fundsFlow, tenderCountsAsCash })
        const r = efectivoFisicoDeCobros([cobro])
        const caso = `fundsFlow=${fundsFlow} snapshot=${tenderCountsAsCash}`
        expect(`${caso} ventas=${r.ventasEnEfectivo.toNumber()}`).toBe(`${caso} ventas=7`)
        expect(`${caso} cajon=${r.alCajon.toNumber()}`).toBe(`${caso} cajon=${paymentCountsAsDrawerCash(cobro) ? 10 : 0}`)
      }
    }
  })

  it('una lista vacía da ceros, y tolera montos nulos y en texto sin perder centavos', () => {
    const vacia = efectivoFisicoDeCobros([])
    expect([vacia.ventasEnEfectivo, vacia.propinasEnEfectivo, vacia.alCajon, vacia.ventasAlCajon].map(d => d.toNumber())).toEqual([
      0, 0, 0, 0,
    ])

    const r = efectivoFisicoDeCobros([
      pago({ amount: null, tipAmount: null }),
      pago({ amount: '0.1' }),
      pago({ amount: 0.2, fundsFlow: 'CASH_DRAWER' }),
    ])
    expect(r.ventasEnEfectivo.toFixed(2)).toBe('0.30')
    expect(r.alCajon.toFixed(2)).toBe('0.30')
  })
})
