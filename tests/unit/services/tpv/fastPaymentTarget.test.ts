import { resolveFastPaymentTarget } from '@/services/tpv/fastPaymentTarget'

describe('resolveFastPaymentTarget — a qué venta pertenece un cobro de terminal', () => {
  it('con una solicitud que traía orden, el dinero es de ESA orden', () => {
    const target = resolveFastPaymentTarget({ orderId: 'order-1', venueId: 'venue-1', status: 'CANCEL_REQUESTED' }, 'venue-1')
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-1' })
  })

  it('sin solicitud (cobro nacido EN la terminal) es venta rápida', () => {
    // Una TPV < v26, o alguien cobrando directo en el aparato: no hay orden que asociar.
    expect(resolveFastPaymentTarget(null, 'venue-1')).toEqual({ kind: 'fastOrder', reason: 'noRow' })
  })

  it('una solicitud SIN orden también es venta rápida', () => {
    // El POS cobró sin mesa: la solicitud existe pero nunca tuvo orden.
    expect(resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'SENT' }, 'venue-1')).toEqual({
      kind: 'fastOrder',
      reason: 'noOrder',
    })
  })

  it('un orderId en blanco NO es una orden — nunca se paga "la cadena vacía"', () => {
    expect(resolveFastPaymentTarget({ orderId: '   ', venueId: 'venue-1', status: 'SENT' }, 'venue-1')).toEqual({
      kind: 'fastOrder',
      reason: 'noOrder',
    })
  })

  it('la orden manda aunque la solicitud ya esté cancelada: el dinero SÍ se movió', () => {
    // 🔴 Cancelar es una PETICIÓN. Si la terminal cobró igual, la venta es real y sus
    // productos salieron del inventario. Mandarla a FAST perdería esa información.
    const target = resolveFastPaymentTarget({ orderId: 'order-9', venueId: 'venue-1', status: 'CANCELLED' }, 'venue-1')
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-9' })
  })

  // 🔴 Aislamiento de inquilinos. `requestId` es @unique GLOBAL (no por venue) y lo
  // genera el CLIENTE: dos negocios pueden colisionar, por accidente o a propósito.
  it('una solicitud de OTRO venue NUNCA presta su orden — el cobro no cruza la frontera', () => {
    const target = resolveFastPaymentTarget({ orderId: 'order-del-vecino', venueId: 'venue-2', status: 'CANCELLED' }, 'venue-1')

    // Si esto devolviera la orden ajena, el dinero de venue-1 pagaría la venta de
    // venue-2: se le cobraría a un negocio la cuenta de otro, en silencio.
    expect(target).toEqual({ kind: 'fastOrder', reason: 'venueMismatch' })
  })

  it('el desvío por venue ajeno se distingue de "no traía orden" — el 🚨 depende de eso', () => {
    // Ambos acaban en venta rápida, pero sólo uno es una anomalía que alguien debe
    // mirar. Sin `reason`, la colisión entre inquilinos sería indistinguible del caso
    // normal "el POS cobró sin mesa" y nadie se enteraría nunca.
    const ajeno = resolveFastPaymentTarget({ orderId: 'order-x', venueId: 'venue-2', status: 'SENT' }, 'venue-1')
    const sinOrden = resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'SENT' }, 'venue-1')

    expect(ajeno).not.toEqual(sinOrden)
  })
})
