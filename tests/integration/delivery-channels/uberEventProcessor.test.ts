/**
 * Del aviso de Uber a una venta aceptada, sin intervención humana.
 *
 * Contra PostgreSQL real: la idempotencia y el estado del evento no se prueban con Prisma
 * mockeado. La red SÍ va inyectada — traer el pedido y aceptarlo son las dos únicas cosas
 * que salen a Uber.
 */
import { DeliveryOrderEventStatus, DeliveryProvider } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { processUberEvent } from '@/services/delivery-channels/providers/uber-eats/uber.eventProcessor'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { listKdsOrders } from '@/services/mobile/kds.mobile.service'
import pedidoReal from '../../fixtures/delivery/uber/pedido-real-delivery-by-uber.json'

const STORE = `store-${Date.now()}`

/** El sobre que Uber manda por webhook: un puntero, no el pedido. */
function aviso(eventId: string, orderId = pedidoReal.id) {
  return {
    event_id: eventId,
    event_type: 'orders.notification',
    resource_href: `https://test-api.uber.com/v2/eats/order/${orderId}`,
    meta: { user_id: STORE, resource_id: orderId, status: 'pos' },
  }
}

describe('procesador de eventos de Uber: aviso → pedido → venta aceptada', () => {
  let venueId: string, orgId: string, linkId: string
  const aceptados: string[] = []

  const deps = {
    fetchOrder: async () => pedidoReal,
    acceptOrder: async (orderId: string) => {
      aceptados.push(orderId)
      return { ok: true, status: 200, raw: '' }
    },
  }

  async function nuevoEvento(eventId: string, payload: unknown = aviso(eventId)) {
    const row = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: eventId,
        eventType: 'orders.notification',
        payload: payload as object,
        channelLinkId: linkId,
        venueId,
        dedupKey: `UBER_EATS:${eventId}`,
      },
    })
    return row.id
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org proc ${Date.now()}`, email: `p${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V proc ${Date.now()}`, slug: `vp-${Date.now()}` } })
    venueId = v.id
    const link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: STORE, webhookSecret: 'x' },
    })
    linkId = link.id
  })

  afterAll(async () => {
    try {
      const orders = await prisma.order.findMany({ where: { venueId }, select: { id: true } })
      const ids = orders.map(o => o.id)
      await prisma.paymentAllocation.deleteMany({
        where: { paymentId: { in: (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id) } },
      })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
      await prisma.order.deleteMany({ where: { venueId } })
      // KdsOrder tiene FK a Venue: si no se borra, el deleteMany de venue de abajo
      // truena y el catch de este bloque se lo traga — venues de prueba acumulándose
      // en silencio para siempre. (KdsOrderItem cae solo, va en cascade.)
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  it('🔴 el camino completo: trae el pedido, lo ACEPTA y lo vuelve venta', async () => {
    const eventRowId = await nuevoEvento(`ev-ok-${Date.now()}`)
    const r = await processUberEvent(eventRowId, deps)

    expect(r.outcome).toBe('PROCESSED')
    expect(r.accepted).toBe(true)
    expect(aceptados).toContain(pedidoReal.id)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(order.externalId).toBe(`UBER_EATS:${pedidoReal.id}`)
    expect(order.total.toString()).toBe('1')

    const evento = await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventRowId } })
    expect(evento.status).toBe(DeliveryOrderEventStatus.PROCESSED)
    expect(evento.orderId).toBe(order.id)
  })

  it('🔴 guarda el pedido crudo ANTES de procesarlo: si algo falla, la evidencia queda', async () => {
    const eventRowId = await nuevoEvento(`ev-raw-${Date.now()}`)
    await processUberEvent(eventRowId, deps)

    const evento = await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventRowId } })
    expect(evento.resourcePayload).toMatchObject({ id: pedidoReal.id })
    expect(evento.resourceFetchedAt).not.toBeNull()
    expect(evento.externalOrderId).toBe(pedidoReal.id)
  })

  it('IDEMPOTENTE: reprocesar no duplica la venta ni vuelve a aceptar', async () => {
    const eventRowId = await nuevoEvento(`ev-idem-${Date.now()}`)
    const a = await processUberEvent(eventRowId, deps)
    const cuantosAceptes = aceptados.length

    const b = await processUberEvent(eventRowId, deps)
    expect(b.outcome).toBe('ALREADY_DONE')
    expect(b.orderId).toBe(a.orderId)
    expect(aceptados.length).toBe(cuantosAceptes) // NO se volvió a aceptar
  })

  it('🔴 se ACEPTA aunque la ingesta falle después: el plazo es lo irrecuperable', async () => {
    // Un pedido sin `id` revienta el traductor. Aun así el accept ya salió: perder el
    // pedido por un fallo interno es malo, pero perderlo por plazo vencido es peor —
    // ahí Uber lo cancela y el cliente se queda sin comida.
    const eventRowId = await nuevoEvento(`ev-falla-${Date.now()}`)
    const antes = aceptados.length

    const r = await processUberEvent(eventRowId, { ...deps, fetchOrder: async () => ({ display_id: 'sin-id' }) })

    expect(r.outcome).toBe('FAILED')
    expect(aceptados.length).toBe(antes + 1) // se aceptó ANTES de fallar
    const evento = await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventRowId } })
    expect(evento.status).toBe(DeliveryOrderEventStatus.FAILED)
    expect(evento.error).toMatch(/id/i)
  })

  it('🔴 pedido que Uber YA CANCELÓ: no se inventa la venta', async () => {
    // Medido el 2026-08-20: pasado el plazo, Uber responde 400 "The order is no longer
    // active". Crear la venta ahí sería registrar dinero que nunca va a llegar.
    const eventRowId = await nuevoEvento(`ev-muerto-${Date.now()}`)
    const antes = await prisma.order.count({ where: { venueId } })

    const r = await processUberEvent(eventRowId, {
      ...deps,
      acceptOrder: async () => ({ ok: false, status: 400, raw: '{"message":"The order is no longer active."}' }),
    })

    expect(r.outcome).toBe('FAILED')
    expect(r.error).toBe('PEDIDO_YA_NO_ACTIVO')
    expect(await prisma.order.count({ where: { venueId } })).toBe(antes) // NO se creó venta
  })

  it('un fallo TRANSITORIO del accept no mata la venta: se ingiere y queda para reintentar', async () => {
    const eventRowId = await nuevoEvento(`ev-flaky-${Date.now()}`)
    const r = await processUberEvent(eventRowId, {
      ...deps,
      acceptOrder: async () => ({ ok: false, status: 503, raw: 'upstream timeout' }),
    })
    expect(r.outcome).toBe('PROCESSED') // la venta SÍ entra
    expect(r.accepted).toBe(false)
  })

  it('🔴 canal en MANUAL: NO se acepta solo — la decisión es del dueño', async () => {
    const manual = await prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: DeliveryProvider.UBER_EATS,
        externalLocationId: `store-manual-${Date.now()}`,
        webhookSecret: 'x',
        orderAcceptanceMode: 'MANUAL',
      },
    })
    const row = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: `ev-manual-${Date.now()}`,
        eventType: 'orders.notification',
        payload: aviso('manual') as object,
        channelLinkId: manual.id,
        venueId,
        dedupKey: `UBER_EATS:manual-${Date.now()}`,
      },
    })
    const antes = aceptados.length

    const r = await processUberEvent(row.id, deps)

    expect(r.outcome).toBe('PROCESSED') // la venta entra igual: la cocina debe verla
    expect(aceptados.length).toBe(antes) // pero NO se aceptó en Uber
  })

  it('un evento que NO es un pedido se marca procesado y no crea venta', async () => {
    const id = `ev-status-${Date.now()}`
    const eventRowId = await nuevoEvento(id, { ...aviso(id), event_type: 'orders.status_changed' })
    const antes = await prisma.order.count({ where: { venueId } })

    const r = await processUberEvent(eventRowId, deps)

    expect(r.outcome).toBe('NOT_AN_ORDER')
    expect(await prisma.order.count({ where: { venueId } })).toBe(antes)
    const evento = await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: eventRowId } })
    expect(evento.status).toBe(DeliveryOrderEventStatus.PROCESSED) // no se reintenta eternamente
  })

  it('🔴 un pedido de tienda SIN vincular no se inventa dueño: queda FAILED y visible', async () => {
    const row = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: `ev-huerf-${Date.now()}`,
        eventType: 'orders.notification',
        payload: aviso('x') as object,
        channelLinkId: null, // tienda que nadie conectó a un negocio
        dedupKey: `UBER_EATS:huerf-${Date.now()}`,
      },
    })

    const r = await processUberEvent(row.id, deps)

    expect(r.outcome).toBe('ORPHANED')
    const evento = await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: row.id } })
    expect(evento.status).toBe(DeliveryOrderEventStatus.FAILED)
    expect(evento.error).toBe('SIN_VINCULO')
    await prisma.deliveryOrderEvent.delete({ where: { id: row.id } })
  })
  // ── CANCELACIONES ────────────────────────────────────────────────────────────────────
  //
  // Uber manda `orders.cancel`, y hasta el 2026-08-20 caía en el mismo cajón que los
  // cambios de estado: "no es un pedido, márcalo visto y olvídalo". La venta se quedaba
  // CONFIRMED/PAID, la cocina seguía cocinando comida que nadie iba a recoger, y ese dinero
  // nunca llegaba pero sí se contaba en los reportes. Nada fallaba; todo mentía.
  describe('el proveedor cancela el pedido', () => {
    const avisoCancel = (eventId: string, orderId = pedidoReal.id) => ({
      event_id: eventId,
      event_type: 'orders.cancel',
      resource_href: `https://test-api.uber.com/v2/eats/order/${orderId}`,
      meta: { user_id: STORE, resource_id: orderId, status: 'pos' },
    })

    it('🔴 la venta deja de contar Y la comanda sale de la cocina', async () => {
      const idOk = `ev-precancel-${Date.now()}`
      const r1 = await processUberEvent(await nuevoEvento(idOk), deps)
      expect(r1.outcome).toBe('PROCESSED')
      expect(await prisma.kdsOrder.count({ where: { orderId: r1.orderId! } })).toBe(1)

      const idC = `ev-cancel-${Date.now()}`
      const r2 = await processUberEvent(await nuevoEvento(idC, avisoCancel(idC)), deps)

      expect(r2.outcome).toBe('CANCELLED')
      const order = await prisma.order.findUniqueOrThrow({ where: { id: r1.orderId! } })
      expect(order.status).toBe('CANCELLED') // `autoPosting` ya la excluye de los libros
      // Lo único que de verdad detiene el desperdicio: que desaparezca del tablero.
      expect(await prisma.kdsOrder.count({ where: { orderId: r1.orderId! } })).toBe(0)
    })

    it('cancelación de un pedido que TODAVÍA no llegó: no inventa una orden', async () => {
      // Uber no ordena sus webhooks; el cancel puede adelantarse a la notificación.
      const id = `ev-cancel-huerf-${Date.now()}`
      const antes = await prisma.order.count({ where: { venueId } })

      const r = await processUberEvent(await nuevoEvento(id, avisoCancel(id, 'pedido-que-no-existe')), deps)

      expect(r.outcome).toBe('CANCELLED')
      expect(r.orderId).toBeUndefined()
      expect(await prisma.order.count({ where: { venueId } })).toBe(antes)
    })

    it('IDEMPOTENTE: cancelar dos veces no vuelve a auditar ni truena', async () => {
      const idOk = `ev-precancel2-${Date.now()}`
      const r1 = await processUberEvent(await nuevoEvento(idOk), deps)

      const a = `ev-c2a-${Date.now()}`
      await processUberEvent(await nuevoEvento(a, avisoCancel(a)), deps)
      const b = `ev-c2b-${Date.now()}`
      const r3 = await processUberEvent(await nuevoEvento(b, avisoCancel(b)), deps)

      expect(r3.outcome).toBe('CANCELLED')
      const order = await prisma.order.findUniqueOrThrow({ where: { id: r1.orderId! } })
      expect(order.status).toBe('CANCELLED')
    })

    it('🔴 `orders.failure` cuenta igual que `orders.cancel`', async () => {
      // Es la generación NUEVA de la API de Uber para el mismo hecho: el pedido no va a
      // ocurrir. Tratarlos distinto deja un camino sin cubrir el día que Uber nos mueva
      // de versión — y ese día nadie se acordaría de esto.
      const idOk = `ev-prefail-${Date.now()}`
      const r1 = await processUberEvent(await nuevoEvento(idOk), deps)

      const idF = `ev-fail-${Date.now()}`
      const r2 = await processUberEvent(await nuevoEvento(idF, { ...avisoCancel(idF), event_type: 'orders.failure' }), deps)

      expect(r2.outcome).toBe('CANCELLED')
      expect((await prisma.order.findUniqueOrThrow({ where: { id: r1.orderId! } })).status).toBe('CANCELLED')
    })
  })
  // ── Requisito DURO de Uber, y seguridad de una persona ───────────────────────────────
  it('🔴 si el pedido trae INSTRUCCIONES y no llegan a la cocina, se CANCELA', async () => {
    // "Order rejection when allergens/special instructions cannot be relayed" es capacidad
    // REQUERIDA en los estándares de calidad de Uber. El caso concreto: el cliente escribió
    // "alérgico al cacahuate", la comanda falló, y la venta se guardaba igual — la cocina
    // preparaba SIN enterarse y nadie notaba que faltó nada. Cancelar es peor servicio y
    // muchísimo mejor que eso.
    const conNota = {
      ...pedidoReal,
      id: `alergia-${Date.now()}`,
      cart: { ...pedidoReal.cart, items: [{ ...pedidoReal.cart.items[0], special_instructions: 'ALÉRGICO AL CACAHUATE' }] },
    }
    const cancelados: string[] = []
    // Se simula el fallo de la comanda tirando la tabla de KDS con un venue inexistente NO
    // sirve; se fuerza con un espía sobre prisma.kdsOrder.create.
    const original = prisma.kdsOrder.create
    ;(prisma as any).kdsOrder.create = jest.fn().mockRejectedValue(new Error('KDS caído'))
    const spyCancel = jest.spyOn(uberAdapter, 'cancelOrder').mockImplementation(async (id: string) => {
      cancelados.push(id)
      return { ok: true, status: 200, raw: '' }
    })

    try {
      const id = `ev-alergia-${Date.now()}`
      const r = await processUberEvent(await nuevoEvento(id, aviso(id, conNota.id)), { ...deps, fetchOrder: async () => conNota })

      expect(r.outcome).toBe('FAILED')
      expect(r.error).toMatch(/INSTRUCCIONES_NO_TRANSMITIDAS/)
      expect(cancelados).toContain(conNota.id) // se canceló EN UBER, no sólo internamente
      const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! } })
      expect(order.status).toBe('CANCELLED')
    } finally {
      ;(prisma as any).kdsOrder.create = original
      spyCancel.mockRestore()
    }
  })

  it('un pedido SIN instrucciones no se cancela aunque falle la comanda', async () => {
    // Sin nota que perder, la venta vale más que la comanda: queda visible en la lista de
    // órdenes y alguien la puede rescatar. Cancelarla sería tirar una venta buena.
    // Id propio: otros tests de este archivo cancelan el pedido de la fixture, y reingerir
    // devuelve esa orden ya CANCELADA (idempotencia). Compartir id entre casos hace que un
    // test dependa del orden de ejecución del anterior.
    const sinNota = { ...pedidoReal, id: `sinnota-${Date.now()}` }
    const original = prisma.kdsOrder.create
    ;(prisma as any).kdsOrder.create = jest.fn().mockRejectedValue(new Error('KDS caído'))
    try {
      const id = `ev-sinnota-${Date.now()}`
      const r = await processUberEvent(await nuevoEvento(id, aviso(id, sinNota.id)), { ...deps, fetchOrder: async () => sinNota })
      expect(r.outcome).toBe('PROCESSED')
      expect((await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! } })).status).toBe('CONFIRMED')
    } finally {
      ;(prisma as any).kdsOrder.create = original
    }
  })

  it('🔴 en MANUAL la venta queda PENDIENTE, no confirmada — y el KDS lo dice', async () => {
    // CONFIRMED significa "ya le dijimos que sí al proveedor". En MANUAL no se lo dijimos, y
    // marcarlo confirmado tenía tres consecuencias: el POS no podía saber cuáles falta
    // aceptar, el tablero decía que todo iba bien mientras el reloj de ~11.5 min corría, y
    // `denyDeliveryOrder` elegía CANCELAR en vez de RECHAZAR — protocolo equivocado y peor
    // para el cliente, que ya creía tener su pedido confirmado.
    const manual = await prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: DeliveryProvider.UBER_EATS,
        externalLocationId: `store-pend-${Date.now()}`,
        webhookSecret: 'x',
        orderAcceptanceMode: 'MANUAL',
      },
    })
    const pedido = { ...pedidoReal, id: `pend-${Date.now()}` }
    const row = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: `ev-pend-${Date.now()}`,
        eventType: 'orders.notification',
        payload: aviso('p', pedido.id) as object,
        channelLinkId: manual.id,
        venueId,
        dedupKey: `UBER_EATS:pend-${Date.now()}`,
      },
    })

    const r = await processUberEvent(row.id, { ...deps, fetchOrder: async () => pedido })

    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(order.status).toBe('PENDING') // NO confirmada: nadie le ha dicho que sí a Uber

    // Y el POS tiene que poder verlo, o el botón que la cocina necesita no puede existir.
    const enCocina = await listKdsOrders(venueId, 'NEW,PREPARING,READY')
    const mio = (enCocina as Array<{ orderId: string | null; needsAcceptance?: boolean }>).find(o => o.orderId === order.id)
    expect(mio?.needsAcceptance).toBe(true)
  })

  it('en AUTO la venta entra CONFIRMADA y el KDS no pide aceptarla', async () => {
    // ⚠️ Id PROPIO, no el de la fixture: otros casos de este archivo cancelan ese pedido, y
    // reingerirlo devuelve la orden ya CANCELADA por idempotencia. Compartir id hace que un
    // test dependa del orden de ejecución del anterior — ya mordió dos veces aquí.
    const propio = { ...pedidoReal, id: `auto-conf-${Date.now()}` }
    const id = `ev-auto-conf-${Date.now()}`
    const r = await processUberEvent(await nuevoEvento(id, aviso(id, propio.id)), {
      ...deps,
      fetchOrder: async () => propio,
    })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! } })

    expect(order.status).toBe('CONFIRMED')
    const enCocina = await listKdsOrders(venueId, 'NEW,PREPARING,READY')
    const mio = (enCocina as Array<{ orderId: string | null; needsAcceptance?: boolean }>).find(o => o.orderId === order.id)
    expect(mio?.needsAcceptance).toBe(false)
  })

  // ── Los 6 eventos que Uber manda y antes IGNORÁBAMOS ─────────────────────────────────
  //
  // Uber manda 9 tipos de evento; atendíamos 3. Los demás caían en "ruido conocido, márcalo
  // visto y olvídalo" — incluidos los que pierden pedidos y los que nos dejan creyendo que
  // un canal muerto sigue vivo.
  describe('eventos que se ignoraban', () => {
    const avisoTipo = (eventId: string, tipo: string, orderId = pedidoReal.id) => ({
      event_id: eventId,
      event_type: tipo,
      resource_href: `https://test-api.uber.com/v2/eats/order/${orderId}`,
      meta: { user_id: STORE, resource_id: orderId, status: 'pos' },
    })

    it('🔴 PROGRAMADO: entra como venta pero NO va a la cocina todavía', async () => {
      // El cliente pidió a las 3pm para las 8pm. Cocinarlo al recibirlo tira la comida y
      // ocupa la pantalla toda la tarde. Antes este evento se ignoraba y el pedido se
      // PERDÍA ENTERO — nunca existía en Avoqado.
      const programado = {
        ...pedidoReal,
        id: `prog-${Date.now()}`,
        scheduled_order: true,
        estimated_ready_for_pickup_at: '2026-08-21T02:00:00Z',
      }
      const id = `ev-prog-${Date.now()}`
      const r = await processUberEvent(await nuevoEvento(id, avisoTipo(id, 'orders.scheduled.notification', programado.id)), {
        ...deps,
        fetchOrder: async () => programado,
      })

      expect(r.outcome).toBe('PROCESSED')
      const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! } })
      expect(order.scheduledFor).not.toBeNull() // la venta SÍ existe, con su hora
      expect(await prisma.kdsOrder.count({ where: { orderId: order.id } })).toBe(0) // pero NO en cocina
    })

    it('🔴 RELEASE: ya es hora ⇒ AHORA sí va a la cocina', async () => {
      const programado = {
        ...pedidoReal,
        id: `prog2-${Date.now()}`,
        scheduled_order: true,
        estimated_ready_for_pickup_at: '2026-08-21T02:00:00Z',
      }
      const idP = `ev-prog2-${Date.now()}`
      const ing = await processUberEvent(await nuevoEvento(idP, avisoTipo(idP, 'orders.scheduled.notification', programado.id)), {
        ...deps,
        fetchOrder: async () => programado,
      })
      expect(await prisma.kdsOrder.count({ where: { orderId: ing.orderId! } })).toBe(0)

      const idR = `ev-rel-${Date.now()}`
      const r = await processUberEvent(await nuevoEvento(idR, avisoTipo(idR, 'orders.release', programado.id)), deps)

      expect(r.outcome).toBe('RELEASED')
      expect(await prisma.kdsOrder.count({ where: { orderId: ing.orderId! } })).toBe(1)
    })

    it('RELEASE dos veces no duplica la comanda: la cocina no prepara doble', async () => {
      const programado = {
        ...pedidoReal,
        id: `prog3-${Date.now()}`,
        scheduled_order: true,
        estimated_ready_for_pickup_at: '2026-08-21T02:00:00Z',
      }
      const idP = `ev-prog3-${Date.now()}`
      const ing = await processUberEvent(await nuevoEvento(idP, avisoTipo(idP, 'orders.scheduled.notification', programado.id)), {
        ...deps,
        fetchOrder: async () => programado,
      })
      for (const n of [1, 2]) {
        const idR = `ev-rel-${n}-${Date.now()}`
        await processUberEvent(await nuevoEvento(idR, avisoTipo(idR, 'orders.release', programado.id)), deps)
      }
      expect(await prisma.kdsOrder.count({ where: { orderId: ing.orderId! } })).toBe(1)
    })

    it('🔴 el comercio nos QUITA la tienda ⇒ el canal se deshabilita', async () => {
      // Sin esto seguiríamos creyendo que el canal está vivo y reintentando escrituras que
      // van a fallar siempre. Es exactamente el síntoma del canal muerto que encontramos:
      // 401 al leer la tienda, 403 en su configuración, y en Avoqado figuraba ACTIVE.
      const id = `ev-deprov-${Date.now()}`
      const r = await processUberEvent(await nuevoEvento(id, avisoTipo(id, 'store.deprovisioned')), deps)

      expect(r.outcome).toBe('STORE_STATE')
      expect((await prisma.deliveryChannelLink.findUniqueOrThrow({ where: { id: linkId } })).status).toBe('DISABLED')
      await prisma.deliveryChannelLink.update({ where: { id: linkId }, data: { status: 'ACTIVE' } })
    })

    it('🔴 el cliente CAMBIA el pedido: se vuelve a traer y se guarda para revisar', async () => {
      // v1 NO muta la venta —reconciliar artículos + cobro + inventario a medias es peor que
      // no hacerlo— pero el pedido nuevo queda guardado y se grita, porque alguien tiene que
      // mirarlo antes de que la cocina prepare lo que ya no es.
      const cambiado = { ...pedidoReal, display_id: 'CAMBIADO' }
      const id = `ev-fulfill-${Date.now()}`
      const r = await processUberEvent(await nuevoEvento(id, avisoTipo(id, 'order.fulfillment_issues.resolved')), {
        ...deps,
        fetchOrder: async () => cambiado,
      })

      expect(r.outcome).toBe('NOT_AN_ORDER') // no crea otra venta
      const ev = await prisma.deliveryOrderEvent.findUniqueOrThrow({
        where: { id: (await prisma.deliveryOrderEvent.findFirstOrThrow({ where: { externalEventId: id } })).id },
      })
      expect(ev.resourcePayload).toMatchObject({ display_id: 'CAMBIADO' }) // el pedido NUEVO quedó guardado
    })
  })
})
