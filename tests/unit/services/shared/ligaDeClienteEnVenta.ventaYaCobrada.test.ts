/**
 * 🔴 R7-2 (ronda 7 post-QA de sellos tardíos; Codex recheck-11 P2): «venta ya cobrada» vuelve a ser lo que dice la venta — PAID o
 * REFUNDED —, sin la marca «tiene un reembolso» de la ronda 6. Esa marca bloqueaba cuentas que NUNCA se saldaron (abono de $20 y
 * devolución de $10) y no cubría corregir/cancelar un cobro desde el panel. Lo que la ronda 6 quería cerrar (re-cobrar una venta ya
 * cobrada con el pago manual) lo cierra R7-1 de raíz: el pago manual rechaza la venta PAID/REFUNDED para todos.
 *
 * Se conserva lo bueno de la ronda 6: UN solo predicado (sin copias locales), sin consulta extra.
 */
import { ForbiddenError } from '@/errors/AppError'
import {
  asegurarCambioDeClienteBajoCandado,
  asegurarCambioDeClienteEnVentaCobrada,
  CODIGO_CLIENTE_DE_VENTA_COBRADA,
  esVentaYaCobrada,
} from '@/services/shared/ligaDeClienteEnVenta'

const VENUE = 'venue-r7'
const ORDER = 'order-r7'

/** Llama a la regla SIN `await`: si (como en la ronda 6) devolviera una promesa, la prueba lo ve y no deja un rechazo suelto. */
function llamar(args: Record<string, unknown>): unknown {
  const r: unknown = asegurarCambioDeClienteEnVentaCobrada(args as never)
  if (r instanceof Promise) r.catch(() => undefined)
  return r
}

describe('🔴 R7-2: esVentaYaCobrada — PAID o REFUNDED, nada más', () => {
  it.each([
    ['PAID', true],
    ['REFUNDED', true],
    ['PARTIAL', false],
    ['PENDING', false],
    [null, false],
    [undefined, false],
  ])('%s ⇒ %s', (paymentStatus, esperado) => {
    expect(esVentaYaCobrada({ paymentStatus })).toBe(esperado)
  })

  it('🔴 un reembolso NO convierte en cobrada una cuenta abierta (Codex r11: abono $20 y devolución $10 nunca se saldó)', () => {
    // La ronda 6 la marcaba cobrada por tener un reembolso; la marca se ignora.
    expect(esVentaYaCobrada({ paymentStatus: 'PARTIAL', reembolsada: true } as never)).toBe(false)
    expect(esVentaYaCobrada({ paymentStatus: 'PENDING', reembolsada: true } as never)).toBe(false)
  })
})

describe('🔴 R7-2: asegurarCambioDeClienteEnVentaCobrada — síncrona, sin consulta', () => {
  const pide = (over: Record<string, unknown> = {}) => ({
    paymentStatus: 'PARTIAL',
    clienteActual: null,
    clienteNuevo: 'cust-nuevo',
    puedeCobrar: false,
    ...over,
  })

  it('🔴 cuenta PARTIAL + cliente nuevo + sin permiso ⇒ pasa (cuenta abierta), sin promesa ni lectura', () => {
    expect(llamar(pide())).toBeUndefined()
  })

  it.each(['PAID', 'REFUNDED'])('%s + cliente nuevo + sin permiso ⇒ 403 con el código de la regla', paymentStatus => {
    let error: unknown
    try {
      llamar(pide({ paymentStatus }))
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ statusCode: 403, code: CODIGO_CLIENTE_DE_VENTA_COBRADA })
  })

  it('PAID + mismo cliente, o con el permiso ⇒ pasa', () => {
    expect(llamar(pide({ paymentStatus: 'PAID', clienteActual: 'cust-nuevo' }))).toBeUndefined()
    expect(llamar(pide({ paymentStatus: 'PAID', puedeCobrar: true }))).toBeUndefined()
  })
})

describe('🔴 R7-2: asegurarCambioDeClienteBajoCandado — sólo lee la venta (la `tx` no necesita pagos)', () => {
  const tx = (paymentStatus: string) => ({ order: { findFirst: jest.fn().mockResolvedValue({ paymentStatus, customerId: null }) } }) as any

  it('🔴 cuenta PARTIAL (aunque tenga una devolución) ⇒ pasa sin contar reembolsos', async () => {
    await expect(
      asegurarCambioDeClienteBajoCandado(tx('PARTIAL'), { venueId: VENUE, orderId: ORDER, clienteNuevo: 'cust-nuevo', puedeCobrar: false }),
    ).resolves.toBeUndefined()
  })

  it('PAID ⇒ 403', async () => {
    await expect(
      asegurarCambioDeClienteBajoCandado(tx('PAID'), { venueId: VENUE, orderId: ORDER, clienteNuevo: 'cust-nuevo', puedeCobrar: false }),
    ).rejects.toMatchObject({ statusCode: 403, code: CODIGO_CLIENTE_DE_VENTA_COBRADA })
  })
})
