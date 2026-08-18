import { resolveFastPaymentTarget } from '@/services/tpv/fastPaymentTarget'

describe('resolveFastPaymentTarget — a qué venta pertenece un cobro de terminal', () => {
  it('con una solicitud que traía orden, el dinero es de ESA orden', () => {
    const target = resolveFastPaymentTarget(
      { orderId: 'order-1', venueId: 'venue-1', status: 'CANCEL_REQUESTED', customerId: null },
      'venue-1',
    )
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-1', seededCustomerId: null })
  })

  it('sin solicitud (cobro nacido EN la terminal) es venta rápida', () => {
    // Una TPV < v26, o alguien cobrando directo en el aparato: no hay orden que asociar.
    expect(resolveFastPaymentTarget(null, 'venue-1')).toEqual({ kind: 'fastOrder', reason: 'noRow', seededCustomerId: null })
  })

  it('una solicitud SIN orden también es venta rápida', () => {
    // El POS cobró sin mesa: la solicitud existe pero nunca tuvo orden.
    expect(resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'SENT', customerId: null }, 'venue-1')).toEqual({
      kind: 'fastOrder',
      reason: 'noOrder',
      seededCustomerId: null,
    })
  })

  it('un orderId en blanco NO es una orden — nunca se paga "la cadena vacía"', () => {
    expect(resolveFastPaymentTarget({ orderId: '   ', venueId: 'venue-1', status: 'SENT', customerId: null }, 'venue-1')).toEqual({
      kind: 'fastOrder',
      reason: 'noOrder',
      seededCustomerId: null,
    })
  })

  it('la orden manda aunque la solicitud ya esté cancelada: el dinero SÍ se movió', () => {
    // 🔴 Cancelar es una PETICIÓN. Si la terminal cobró igual, la venta es real y sus
    // productos salieron del inventario. Mandarla a FAST perdería esa información.
    const target = resolveFastPaymentTarget({ orderId: 'order-9', venueId: 'venue-1', status: 'CANCELLED', customerId: null }, 'venue-1')
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-9', seededCustomerId: null })
  })

  // 🔴 Aislamiento de inquilinos. `requestId` es @unique GLOBAL (no por venue) y lo
  // genera el CLIENTE: dos negocios pueden colisionar, por accidente o a propósito.
  it('una solicitud de OTRO venue NUNCA presta su orden — el cobro no cruza la frontera', () => {
    const target = resolveFastPaymentTarget(
      { orderId: 'order-del-vecino', venueId: 'venue-2', status: 'CANCELLED', customerId: null },
      'venue-1',
    )

    // Si esto devolviera la orden ajena, el dinero de venue-1 pagaría la venta de
    // venue-2: se le cobraría a un negocio la cuenta de otro, en silencio.
    expect(target).toEqual({ kind: 'fastOrder', reason: 'venueMismatch', seededCustomerId: null })
  })

  it('el desvío por venue ajeno se distingue de "no traía orden" — el 🚨 depende de eso', () => {
    // Ambos acaban en venta rápida, pero sólo uno es una anomalía que alguien debe
    // mirar. Sin `reason`, la colisión entre inquilinos sería indistinguible del caso
    // normal "el POS cobró sin mesa" y nadie se enteraría nunca.
    const ajeno = resolveFastPaymentTarget({ orderId: 'order-x', venueId: 'venue-2', status: 'SENT', customerId: null }, 'venue-1')
    const sinOrden = resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'SENT', customerId: null }, 'venue-1')

    expect(ajeno).not.toEqual(sinOrden)
  })
})

/**
 * 🔴 El CLIENTE que el POS eligió antes de mandar el cobro a la terminal.
 *
 * Con TARJETA la venta nacía anónima: el POS manda el relay, la terminal cobra y
 * registra el dinero por su cuenta — y la TPV no conoce al cliente (ni debe: sería PII
 * en el aparato sin nadie que la consuma). El único punto donde el server tiene los dos
 * datos juntos es esta fila de arbitraje, que ya se lee para decidir a qué venta
 * pertenece el dinero.
 *
 * El cliente viaja en el MISMO veredicto que la orden, a propósito: así el candado de
 * inquilino se aplica UNA vez y es imposible que un call site use la orden con gate y el
 * cliente sin él.
 */
describe('resolveFastPaymentTarget — el cliente sembrado por el POS', () => {
  it('el cliente de la fila viaja en el veredicto', () => {
    const target = resolveFastPaymentTarget(
      { orderId: 'order-1', venueId: 'venue-1', status: 'COMPLETED', customerId: 'cust-1' },
      'venue-1',
    )
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-1', seededCustomerId: 'cust-1' })
  })

  it('el cobro rápido SIN orden también lo lleva — es justo el caso que arregla el bug', () => {
    // Mostrador: el cajero elige cliente y cobra un monto sin productos. No hay orden
    // que heredar, así que si el cliente no se siembra aquí, la venta `FAST-*` nace
    // anónima y se pierden historial, CFDI y atribución.
    expect(resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'COMPLETED', customerId: 'cust-1' }, 'venue-1')).toEqual({
      kind: 'fastOrder',
      reason: 'noOrder',
      seededCustomerId: 'cust-1',
    })
  })

  it('🔴 una solicitud de OTRO venue tampoco presta su CLIENTE', () => {
    // Mismo candado que la orden, y por la misma razón: vincular un cliente de otro
    // negocio a esta venta es una fuga de inquilino — silenciosa, y en el historial de
    // una persona real.
    const target = resolveFastPaymentTarget(
      { orderId: 'order-x', venueId: 'venue-2', status: 'SENT', customerId: 'cust-del-vecino' },
      'venue-1',
    )
    expect(target).toEqual({ kind: 'fastOrder', reason: 'venueMismatch', seededCustomerId: null })
  })

  it('sin fila no hay cliente que sembrar', () => {
    expect(resolveFastPaymentTarget(null, 'venue-1')).toMatchObject({ seededCustomerId: null })
  })

  it('un customerId en blanco no es un cliente', () => {
    // Mismo criterio que el `orderId` vacío: una cadena en blanco no identifica a nadie
    // y buscarla sólo produce una consulta perdida por cobro.
    expect(resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'SENT', customerId: '   ' }, 'venue-1')).toMatchObject({
      seededCustomerId: null,
    })
  })

  it('una fila vieja (sin la columna) deja la venta anónima, como hoy', () => {
    // Filas creadas antes de la migración leen `customerId` undefined. Degradación
    // limpia: exactamente el comportamiento actual, nunca un crash.
    expect(resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'SENT' } as any, 'venue-1')).toMatchObject({
      seededCustomerId: null,
    })
  })
})
