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
  ventaYaCobradaBajoCandado,
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

describe('🔴 R7-2: asegurarCambioDeClienteEnVentaCobrada — síncrona, sin consulta (R11-2: recibe el veredicto `cobrada`)', () => {
  const pide = (over: Record<string, unknown> = {}) => ({
    cobrada: false,
    clienteActual: null,
    clienteNuevo: 'cust-nuevo',
    puedeCobrar: false,
    ...over,
  })

  it('🔴 cuenta PARTIAL + cliente nuevo + sin permiso ⇒ pasa (cuenta abierta), sin promesa ni lectura', () => {
    expect(llamar(pide())).toBeUndefined()
  })

  it('cobrada + cliente nuevo + sin permiso ⇒ 403 con el código de la regla', () => {
    let error: unknown
    try {
      llamar(pide({ cobrada: true }))
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ statusCode: 403, code: CODIGO_CLIENTE_DE_VENTA_COBRADA })
  })

  it('cobrada + mismo cliente, o con el permiso ⇒ pasa', () => {
    expect(llamar(pide({ cobrada: true, clienteActual: 'cust-nuevo' }))).toBeUndefined()
    expect(llamar(pide({ cobrada: true, puedeCobrar: true }))).toBeUndefined()
  })
})

/** La venta de $100 (IVA incluido) y lo que sus cobros capturados suman (sin los reembolsos). */
const venta = (paymentStatus: string, cobrado: string | null, over: Record<string, unknown> = {}) =>
  ({
    order: {
      findFirst: jest.fn().mockResolvedValue({
        paymentStatus,
        customerId: null,
        status: 'PENDING',
        subtotal: '100.00',
        discountAmount: '0.00',
        serviceChargeAmount: '0.00',
        contratoDePrecio: 'IVA_INCLUIDO',
        taxAmount: '0.00',
        ...over,
      }),
    },
    orderCustomer: { findFirst: jest.fn().mockResolvedValue(null) },
    payment: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: cobrado, tipAmount: null } }),
      findFirst: jest.fn().mockResolvedValue({ status: 'COMPLETED', type: null, createdAt: new Date(), processedById: 'cashier' }),
    },
  }) as any

describe('🔴 R7-2 / R11-2: asegurarCambioDeClienteBajoCandado — la regla compartida bajo el candado', () => {
  const tx = (paymentStatus: string, cobrado: string | null = null) => venta(paymentStatus, cobrado)

  it('🔴 cuenta PARTIAL con un abono que no la cubre (aunque tenga una devolución) ⇒ pasa', async () => {
    await expect(
      asegurarCambioDeClienteBajoCandado(tx('PARTIAL', '30.00'), {
        venueId: VENUE,
        orderId: ORDER,
        clienteNuevo: 'cust-nuevo',
        puedeCobrar: false,
      }),
    ).resolves.toBeUndefined()
  })

  it('venta PENDING cuyos cobros capturados YA la cubren espera a su finalización antes de atribuir cliente', async () => {
    await expect(
      asegurarCambioDeClienteBajoCandado(tx('PENDING', '100.00'), {
        venueId: VENUE,
        orderId: ORDER,
        clienteNuevo: 'cust-y',
        puedeCobrar: false,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SALE_NOT_ELIGIBLE_FOR_CUSTOMER' })
  })

  it('gerencia también relee estado y atribución para impedir reemplazar un cliente', async () => {
    const t = tx('PAID')
    await expect(
      asegurarCambioDeClienteBajoCandado(t, {
        venueId: VENUE,
        orderId: ORDER,
        clienteNuevo: 'cust-y',
        puedeCobrar: true,
        actor: { canAssignHistorical: true },
      }),
    ).resolves.toBeUndefined()
    expect(t.order.findFirst).toHaveBeenCalled()
  })

  it('PAID ⇒ 403', async () => {
    await expect(
      asegurarCambioDeClienteBajoCandado(tx('PAID'), { venueId: VENUE, orderId: ORDER, clienteNuevo: 'cust-nuevo', puedeCobrar: false }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CUSTOMER_ASSIGNMENT_REQUIRES_MANAGER' })
  })
})

/**
 * 🔴 R11-2 (Codex recheck-15 #2): «venta ya cobrada» para la decisión A = cerrada por estado O con cobros capturados que ya cubren
 * su total. La ventana: la terminal capturó $100, la finalización falló y la venta sigue PENDING; COCINA no puede dejar primario a
 * un cliente ahí (la recuperación le daría sello y puntos).
 */
describe('🔴 R11-2: ventaYaCobradaBajoCandado', () => {
  const lee = (t: any) => ventaYaCobradaBajoCandado(t, { venueId: VENUE, orderId: ORDER })

  it.each([
    ['PENDING con $100 capturados de $100', 'PENDING', '100.00', true],
    ['PARTIAL con $100 capturados (el estado se atrasó)', 'PARTIAL', '100.00', true],
    ['PENDING con $60 de $100 (abono)', 'PENDING', '60.00', false],
    ['PENDING sin cobros', 'PENDING', null, false],
  ])('%s ⇒ cobrada = %s', async (_caso, estado, cobrado, esperado) => {
    await expect(lee(venta(estado as string, cobrado as string | null))).resolves.toMatchObject({ cobrada: esperado })
  })

  it.each(['PAID', 'REFUNDED'])('%s ⇒ cobrada, sin leer los cobros', async estado => {
    const t = venta(estado, null)
    await expect(lee(t)).resolves.toMatchObject({ cobrada: true })
    expect(t.payment.aggregate).not.toHaveBeenCalled()
  })

  it('🔴 suma sólo los cobros capturados que NO son reembolso (con `type` vacío dentro), de ESTA venta y negocio', async () => {
    const t = venta('PENDING', '100.00')
    await lee(t)
    expect(t.payment.aggregate).toHaveBeenCalledWith({
      where: { orderId: ORDER, venueId: VENUE, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
      _sum: { amount: true, tipAmount: true },
    })
  })

  it('una cortesía total ($0) sin cobros sigue abierta: sin dinero no hay «ya cobrada»', async () => {
    await expect(lee(venta('PENDING', null, { discountAmount: '100.00' }))).resolves.toMatchObject({ cobrada: false })
  })

  it('el IVA que va aparte también se debe: $100 + $16 con $100 capturados no está cubierta', async () => {
    await expect(lee(venta('PENDING', '100.00', { contratoDePrecio: 'IVA_APARTE', taxAmount: '16.00' }))).resolves.toMatchObject({
      cobrada: false,
    })
  })

  it('otra venta o negocio ⇒ null (quien llama responde 404)', async () => {
    const t = venta('PENDING', null)
    t.order.findFirst.mockResolvedValue(null)
    await expect(lee(t)).resolves.toBeNull()
  })
})

/** Cuentas fuera del plano (23-oct): el PUT del panel no cierra una cuenta sin cobrar y dice lo que falta (`pendiente`). */
describe('ventaYaCobradaBajoCandado — pendiente', () => {
  const lee = (t: any) => ventaYaCobradaBajoCandado(t, { venueId: VENUE, orderId: ORDER })

  it('abono de $40 a $100 ⇒ faltan $60, no cobrada', async () => {
    const r = await lee(venta('PENDING', '40.00'))
    expect(r).toMatchObject({ cobrada: false })
    expect(r!.pendiente.toFixed(2)).toBe('60.00')
  })

  it('PAID ⇒ nada pendiente, sin leer los cobros', async () => {
    const t = venta('PAID', null)
    const r = await lee(t)
    expect(r).toMatchObject({ cobrada: true })
    expect(r!.pendiente.toFixed(2)).toBe('0.00')
    expect(t.payment.aggregate).not.toHaveBeenCalled()
  })

  it('cortesía total ($0) sin cobros ⇒ nada pendiente, pero NO cobrada (como hoy)', async () => {
    const r = await lee(venta('PENDING', null, { discountAmount: '100.00' }))
    expect(r).toMatchObject({ cobrada: false })
    expect(r!.pendiente.toFixed(2)).toBe('0.00')
  })

  it('$99.99 cobrados de $100 ⇒ cobrada (la tolerancia de un centavo de los cobros)', async () => {
    await expect(lee(venta('PENDING', '99.99'))).resolves.toMatchObject({ cobrada: true })
  })
})
