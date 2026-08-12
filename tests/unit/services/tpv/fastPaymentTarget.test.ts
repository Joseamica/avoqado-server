import { resolveFastPaymentTarget } from '@/services/tpv/fastPaymentTarget'

describe('resolveFastPaymentTarget — a qué venta pertenece un cobro de terminal', () => {
  it('con una solicitud que traía orden, el dinero es de ESA orden', () => {
    const target = resolveFastPaymentTarget({ orderId: 'order-1', venueId: 'venue-1', status: 'CANCEL_REQUESTED' })
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-1' })
  })

  it('sin solicitud (cobro nacido EN la terminal) es venta rápida', () => {
    // Una TPV < v26, o alguien cobrando directo en el aparato: no hay orden que asociar.
    expect(resolveFastPaymentTarget(null)).toEqual({ kind: 'fastOrder' })
  })

  it('una solicitud SIN orden también es venta rápida', () => {
    // El POS cobró sin mesa: la solicitud existe pero nunca tuvo orden.
    expect(resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'SENT' })).toEqual({ kind: 'fastOrder' })
  })

  it('un orderId en blanco NO es una orden — nunca se paga "la cadena vacía"', () => {
    expect(resolveFastPaymentTarget({ orderId: '   ', venueId: 'venue-1', status: 'SENT' })).toEqual({ kind: 'fastOrder' })
  })

  it('la orden manda aunque la solicitud ya esté cancelada: el dinero SÍ se movió', () => {
    // 🔴 Cancelar es una PETICIÓN. Si la terminal cobró igual, la venta es real y sus
    // productos salieron del inventario. Mandarla a FAST perdería esa información.
    const target = resolveFastPaymentTarget({ orderId: 'order-9', venueId: 'venue-1', status: 'CANCELLED' })
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-9' })
  })
})
