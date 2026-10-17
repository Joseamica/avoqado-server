/**
 * 🔴 R8-1 (ronda 8 post-QA de sellos tardíos; Codex recheck-12 P2): recibir dinero NUNCA reabre una venta cerrada.
 *
 * Una venta cobrada (PAID o REFUNDED) queda CERRADA (founder 16-oct, «como Square»; precedente del 18-ago: sin botón de cobrar). La
 * cadena de Codex: venta $100 PAID → el panel corrige su cobro a $80 (sigue PAID) → llega un cobro tardío de la TPV de $10 → el
 * recálculo sumaba $90 < $100 y escribía PARTIAL, y con eso el pago manual y el PUT del panel volvían a aceptar cliente y lealtad.
 *
 * `estadoDeCobroAlRecibirDinero` es la ÚNICA regla, la usan todos los escritores por los que ENTRA dinero.
 */
import { Prisma } from '@prisma/client'
import { esVentaCerrada, estadoDeCobroAlRecibirDinero } from '@/services/shared/orderBalance'
import { esVentaYaCobrada } from '@/services/shared/ligaDeClienteEnVenta'

const calculado = { paymentStatus: 'PARTIAL' as const, remainingBalance: new Prisma.Decimal('10.00') }

describe('R8-1: estadoDeCobroAlRecibirDinero', () => {
  it.each(['PAID', 'REFUNDED'])('🔴 venta previa %s + entra dinero ⇒ conserva su estado, saldo 0 y `cerrada`', previo => {
    expect(estadoDeCobroAlRecibirDinero(previo, true, calculado)).toEqual({ paymentStatus: previo, remainingBalance: 0, cerrada: true })
  })

  it.each(['PAID', 'REFUNDED'])(
    'venta previa %s + un cobro que la cubre de más ⇒ también `cerrada` (no se repiten los efectos de saldar)',
    previo => {
      const r = estadoDeCobroAlRecibirDinero(previo, true, { paymentStatus: 'PAID', remainingBalance: 0 })
      expect(r).toEqual({ paymentStatus: previo, remainingBalance: 0, cerrada: true })
    },
  )

  it.each(['PENDING', 'PARTIAL', null, undefined])('venta previa %s ⇒ lo calculado, como hoy', previo => {
    const r = estadoDeCobroAlRecibirDinero(previo, true, calculado)
    expect(r).toEqual({ ...calculado, cerrada: false })
    expect(r.remainingBalance).toBe(calculado.remainingBalance) // el mismo objeto: nada se convierte
  })

  it.each(['PAID', 'REFUNDED'])('venta previa %s pero NO entra dinero (el origen de una reasignación) ⇒ lo calculado, como hoy', previo => {
    expect(estadoDeCobroAlRecibirDinero(previo, false, calculado)).toEqual({ ...calculado, cerrada: false })
  })
})

describe('R8-1: un solo predicado de «venta cerrada»', () => {
  it.each(['PAID', 'REFUNDED', 'PARTIAL', 'PENDING', null, undefined])('esVentaYaCobrada(%s) dice lo mismo que esVentaCerrada', estado => {
    expect(esVentaYaCobrada({ paymentStatus: estado })).toBe(esVentaCerrada(estado))
  })

  it('cerrada = PAID o REFUNDED', () => {
    expect(['PAID', 'REFUNDED', 'PARTIAL', 'PENDING'].map(esVentaCerrada)).toEqual([true, true, false, false])
  })
})
