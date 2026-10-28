/**
 * Integration (Postgres REAL) — el «listo» de Rappi, a lo más 3 llamadas por pedido (Tarea 13 del plan «Rappi fase 2»).
 *
 * Rappi deja de hacer caso al `ready-for-pickup` después de la TERCERA solicitud y considera mal uso lo que siga. El contador
 * vive en la fila del aviso `NEW_ORDER` (`resourcePayload.listo`) y se suma ANTES de llamar, en una transacción con
 * `FOR UPDATE`. En las pruebas unitarias el Prisma es de mentira y `FOR UPDATE` es texto; esto prueba lo que sólo la base
 * puede decir:
 *  (a) 🔴 la cuarta llamada no sale aunque el proceso se reinicie (cada pasada del barrido con un job NUEVO, sin memoria), y
 *      cada llamada ya estaba contada en la base cuando salió;
 *  (b) 🔴 la reserva MEZCLA: la marca de aceptación (`aceptacion`, Tarea 9) sobrevive, también si se escribe a la vez;
 *  (c) 🔴 seis reservas a la vez sobre el mismo pedido dan exactamente tres permisos;
 *  (d) un 2xx o un 400 de transición inválida cierran el «listo»; el 424 real del sandbox («inténtelo más tarde») no;
 *  (e) 🔴 el aviso que guarda el INGRESO REAL (`persistRappiWebhookEvent`) es la fila donde el «listo» cuenta (la llave del
 *      ingreso y la del contador coinciden);
 *  (f) 🔴 una llamada que el candado de tiendas bloquea (nunca salió) devuelve su reserva: no gasta ninguna de las 3.
 *
 * La red de Rappi va simulada (`marcarListoRappi`); todo lo demás —núcleo, adaptador, contador, barrido— es el real. Sólo crea
 * filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import crypto from 'crypto'

import { DeliveryOrderEventStatus, DeliveryProvider, KdsOrderStatus, OrderSource, Prisma, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { DeliveryLineActionReconcilerJob } from '@/jobs/delivery-line-action-reconciler.job'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { reclamarEvento } from '@/services/delivery-channels/core/deliveryWebhookEvent.service'
import { markDeliveryOrderReady } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'
import { DeliveryWriteNotSentError } from '@/services/delivery-channels/core/types'
import {
  anotarAceptacion,
  cerrarListo,
  leerEstado,
  MAX_LLAMADAS_LISTO,
  reservarLlamadaDeListo,
} from '@/services/delivery-channels/providers/rappi/rappi.estadoDelPedido'
import { llaveDeAvisoDePedido, persistRappiWebhookEvent } from '@/services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'

// 🔴 Nada sale a Rappi: la llamada HTTP del «listo» es lo único simulado.
const mockMarcarListoRappi = jest.fn()
jest.mock('@/services/delivery-channels/providers/rappi/rappi.client', () => ({
  marcarListoRappi: (...a: unknown[]) => mockMarcarListoRappi(...a),
}))

jest.setTimeout(60_000)

/** 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada (mismo criterio que `rappiMarcaDeAceptacion.test.ts`). */
const esBaseDePrueba = (nombre: string) =>
  nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_(?:[a-z0-9]+|cambio_r5)_test_)/.test(nombre)
{
  // A nivel de MÓDULO, no en un hook: corre antes de cualquier `beforeAll`/`afterAll`.
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

/** El cuerpo REAL del 424 del sandbox DEV (M4, recorrido-real.md, 21-oct), antes y después del tiempo de cocina. */
const CUERPO_424_REAL =
  '{"message":"424 {\\"code\\":\\"error.ready_for_pickup.unsuccessful\\",\\"message\\":\\"No se pudo procesar su solicitud, por favor intentelo mas tarde.\\"}"}'
/** El texto REAL de «transición inválida» de Rappi (M11, 21-oct, al rechazar un pedido TOMADO). */
const TRANSICION_INVALIDA_REAL =
  '[ORDER 722609056] Invalid transition from {TAKEN} to {REJECTED} state, check out https://dev-portal.rappi.com/managing-user-orders/#order-status for further details'

const ACEPTACION = { en: '2026-10-21T22:26:18.000Z', evidencia: 'HTTP_2XX' }

describe('el «listo» de Rappi contra Postgres: a lo más 3 llamadas, aunque el proceso se reinicie', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const tienda = `rappi-listo-it-${sufijo}`
  let orgId: string | undefined
  let venueId: string | undefined
  let link: DeliveryChannelLink
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: `Org listo-it ${sufijo}`, email: `listo-it-${sufijo}@t.mx`, phone: '5555555555' } })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V listo-it ${sufijo}`, slug: `v-listo-it-${sufijo}` } }))
      .id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: tienda, webhookSecret: 'x' },
    })
  })

  beforeEach(() => {
    mockMarcarListoRappi.mockReset().mockResolvedValue({ ok: false, status: 424, raw: CUERPO_424_REAL })
    // Red de seguridad: el barrido no distingue venue; si quedara un «listo» de Uber pendiente en esta base, no sale a la red.
    jest.spyOn(uberAdapter, 'markOrderReady').mockResolvedValue({ ok: true, status: 200, raw: '' })
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    // 🔴 jest-circus corre `afterAll` aunque `beforeAll` haya lanzado: sin ids propios no se borra nada.
    if (!venueId || !orgId) return
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.venueTransaction.deleteMany({ where: { venueId } })
      await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`listo-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  /**
   * El aviso `NEW_ORDER` guardado, con la llave que le pone el ingreso y la marca de aceptación de la Tarea 9. `null` = sin
   * `resourcePayload` (NULL en la base). `RECEIVED` sólo hace falta para poder reclamarlo (la marca de aceptación lo exige).
   */
  async function aviso(
    ext: string,
    resourcePayload: Prisma.InputJsonValue | null = { aceptacion: ACEPTACION },
    status: DeliveryOrderEventStatus = DeliveryOrderEventStatus.PROCESSED,
  ) {
    const dedupKey = llaveDeAvisoDePedido('NEW_ORDER', tienda, ext)
    return prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.RAPPI,
        externalEventId: dedupKey,
        eventType: 'NEW_ORDER',
        dedupKey,
        externalOrderId: ext,
        channelLinkId: link.id,
        venueId,
        payload: { prueba: true },
        status,
        resourcePayload: resourcePayload ?? Prisma.DbNull,
      },
    })
  }

  /** Una venta de Rappi como la deja la ingesta real, con la comanda ya marcada lista (SIN aviso: cada prueba pone el suyo). */
  async function ventaListaParaElListo(ext: string, displayId: string) {
    const { order } = await ingestDeliveryOrder(
      {
        externalId: ext,
        displayId,
        source: OrderSource.RAPPI,
        items: [{ externalId: `sku-${displayId}`, name: `Tacos ${displayId}`, quantity: 1, unitPrice: '120.00', total: '120.00' }],
        payment: {
          currency: 'MXN',
          saleAmount: '120.00',
          merchantFees: '0.00',
          discountAmount: '0.00',
          tipAmount: '0.00',
          externallyPaidSale: '120.00',
          externallyPaidTip: '0.00',
          cashDueSale: '0.00',
          cashDueTip: '0.00',
        },
        raw: { fuente: 'test' },
        placedAt: new Date(),
      },
      link,
    )
    await prisma.kdsOrder.updateMany({ where: { orderId: order.id }, data: { status: KdsOrderStatus.READY } })
    return order
  }

  /** Una venta de Rappi como la deja la ingesta real, con su aviso guardado y la comanda ya marcada lista. */
  async function sembrar() {
    const ext = `listo-it-${sufijo}-${++n}`
    const order = await ventaListaParaElListo(ext, `R-${n}`)
    const fila = await aviso(ext)
    return { order, ext, fila }
  }

  const estadoDe = async (filaId: string) => (await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: filaId } })).resourcePayload
  const llamadasA = (ext: string) => mockMarcarListoRappi.mock.calls.filter(c => c[0] === ext)
  const listoDe = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).readyReportedAt

  it('🔴 a lo más 3 llamadas HTTP por pedido, contadas en la base ANTES de llamar: la cuarta no sale a la red, aunque el proceso se haya reiniciado', async () => {
    const s = await sembrar()
    // Lo que la base ya tenía contado en el instante en que salió cada llamada (otra conexión: sólo ve lo confirmado).
    const contadasAlSalir: number[] = []
    mockMarcarListoRappi.mockImplementation(async () => {
      contadasAlSalir.push(leerEstado(await estadoDe(s.fila.id)).listo?.llamadas ?? -1)
      return { ok: false, status: 424, raw: CUERPO_424_REAL }
    })

    // Cada pasada con un job NUEVO = un proceso recién reiniciado: su espera en memoria está vacía y reintenta en el acto.
    for (let i = 0; i < 5; i++) await new DeliveryLineActionReconcilerJob().runOnce()

    expect(MAX_LLAMADAS_LISTO).toBe(3)
    expect(llamadasA(s.ext)).toHaveLength(3)
    for (const c of llamadasA(s.ext)) expect(c).toEqual([s.ext, tienda, { reintentarEn401: false }])
    expect(contadasAlSalir).toEqual([1, 2, 3])
    // El tope quedó escrito, y la marca de aceptación sigue ahí.
    expect(await estadoDe(s.fila.id)).toEqual({ aceptacion: ACEPTACION, listo: { llamadas: 3, cerrado: 'TOPE' } })
    // «Se dejó de intentar» NO es «listo confirmado».
    expect(await listoDe(s.order.id)).toBeNull()
  })

  it('🔴 un 424 de Rappi (cuerpo REAL) no cierra el «listo» y sí consume una de las 3', async () => {
    const s = await sembrar()

    const r = await markDeliveryOrderReady(venueId!, s.order.id)

    expect(r.outcome).toBe('FAILED')
    expect(llamadasA(s.ext)).toHaveLength(1)
    expect(await estadoDe(s.fila.id)).toEqual({ aceptacion: ACEPTACION, listo: { llamadas: 1 } })
    expect(await listoDe(s.order.id)).toBeNull()
  })

  it('un 2xx cierra el «listo»: sella readyReportedAt y ya no se vuelve a llamar', async () => {
    const s = await sembrar()
    mockMarcarListoRappi.mockResolvedValue({ ok: true, status: 200, raw: '{}' })

    expect((await markDeliveryOrderReady(venueId!, s.order.id)).outcome).toBe('READY')
    expect(await listoDe(s.order.id)).not.toBeNull()
    expect(await estadoDe(s.fila.id)).toEqual({ aceptacion: ACEPTACION, listo: { llamadas: 1, cerrado: 'HTTP_2XX' } })

    expect((await markDeliveryOrderReady(venueId!, s.order.id)).outcome).toBe('ALREADY_DONE')
    expect(await reservarLlamadaDeListo(s.ext, tienda)).toEqual({ permitido: false })
    expect(llamadasA(s.ext)).toHaveLength(1)
  })

  it('400 de transición inválida ⇒ NO_REINTENTAR, se cierra y la siguiente ya no sale (y no sella readyReportedAt)', async () => {
    const s = await sembrar()
    mockMarcarListoRappi.mockResolvedValue({ ok: false, status: 400, raw: JSON.stringify({ message: TRANSICION_INVALIDA_REAL }) })

    expect((await markDeliveryOrderReady(venueId!, s.order.id)).outcome).toBe('NO_REINTENTAR')
    expect(await estadoDe(s.fila.id)).toEqual({ aceptacion: ACEPTACION, listo: { llamadas: 1, cerrado: 'TRANSICION_INVALIDA' } })

    expect(await markDeliveryOrderReady(venueId!, s.order.id)).toEqual({ outcome: 'NO_REINTENTAR', error: 'TOPE_DE_LISTO' })
    expect(llamadasA(s.ext)).toHaveLength(1)
    // El primer cierre manda: el TOPE de después no borra por qué se cerró.
    expect(leerEstado(await estadoDe(s.fila.id)).listo).toEqual({ llamadas: 1, cerrado: 'TRANSICION_INVALIDA' })
    expect(await listoDe(s.order.id)).toBeNull()
  })

  it('🔴 la reserva y el cierre MEZCLAN: la marca de aceptación y lo demás de resourcePayload sobreviven', async () => {
    const ext = `listo-it-${sufijo}-mezcla`
    const fila = await aviso(ext, { aceptacion: ACEPTACION, otraCosa: 'x' })

    expect(await reservarLlamadaDeListo(ext, tienda)).toEqual({ permitido: true })
    expect(await estadoDe(fila.id)).toEqual({ aceptacion: ACEPTACION, otraCosa: 'x', listo: { llamadas: 1 } })

    await cerrarListo(ext, tienda, 'HTTP_2XX')
    expect(await estadoDe(fila.id)).toEqual({ aceptacion: ACEPTACION, otraCosa: 'x', listo: { llamadas: 1, cerrado: 'HTTP_2XX' } })
  })

  it('un resourcePayload vacío o que no es objeto se sustituye por el contador, sin lanzar', async () => {
    const vacia = await aviso(`listo-it-${sufijo}-vacia`, null)
    const lista = await aviso(`listo-it-${sufijo}-lista`, [1, 2])

    expect(await reservarLlamadaDeListo(`listo-it-${sufijo}-vacia`, tienda)).toEqual({ permitido: true })
    expect(await reservarLlamadaDeListo(`listo-it-${sufijo}-lista`, tienda)).toEqual({ permitido: true })

    expect(await estadoDe(vacia.id)).toEqual({ listo: { llamadas: 1 } })
    expect(await estadoDe(lista.id)).toEqual({ listo: { llamadas: 1 } })
  })

  it('🔴 sin el aviso guardado del pedido: NO se permite (no hay dónde contar) y no escribe nada (Codex b1 #4)', async () => {
    expect(await reservarLlamadaDeListo(`listo-it-${sufijo}-sin-aviso`, tienda)).toEqual({ permitido: false, sinAviso: true })
    await expect(cerrarListo(`listo-it-${sufijo}-sin-aviso`, tienda, 'TOPE')).resolves.toBeUndefined()
  })

  it('🔴 un vínculo manual que CAMBIA DE TIENDA: el «listo» sigue contando en el aviso ORIGINAL y la cuarta llamada no sale (Codex b1 #4)', async () => {
    // Un vínculo manual (sin `ownerAuthorizedAt`) puede cambiar su `externalLocationId` desde SUPERADMIN. El aviso guardado
    // conserva la llave con la tienda ORIGINAL; el «listo» llega con la de HOY. Antes no encontraba el contador y cada
    // intento salía «sin tope» (Codex reprodujo cuatro llamadas). Vínculo propio: el de las demás pruebas no se mueve.
    const tiendaA = `rappi-listo-it-a-${sufijo}`
    const tiendaB = `rappi-listo-it-b-${sufijo}`
    const manual = await prisma.deliveryChannelLink.create({
      data: { venueId: venueId!, provider: DeliveryProvider.RAPPI, externalLocationId: tiendaA, webhookSecret: 'x' },
    })
    expect(manual.ownerAuthorizedAt).toBeNull()
    const ext = `listo-it-${sufijo}-cambio-de-tienda`
    const { order } = await ingestDeliveryOrder(
      {
        externalId: ext,
        displayId: 'R-cambio',
        source: OrderSource.RAPPI,
        items: [{ externalId: 'sku-cambio', name: 'Tacos cambio', quantity: 1, unitPrice: '120.00', total: '120.00' }],
        payment: {
          currency: 'MXN',
          saleAmount: '120.00',
          merchantFees: '0.00',
          discountAmount: '0.00',
          tipAmount: '0.00',
          externallyPaidSale: '120.00',
          externallyPaidTip: '0.00',
          cashDueSale: '0.00',
          cashDueTip: '0.00',
        },
        raw: { fuente: 'test' },
        placedAt: new Date(),
      },
      manual,
    )
    // El aviso, como lo guarda el ingreso: llave con la tienda A, el pedido en `externalOrderId` y el vínculo.
    const dedupKey = llaveDeAvisoDePedido('NEW_ORDER', tiendaA, ext)
    const original = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.RAPPI,
        externalEventId: dedupKey,
        eventType: 'NEW_ORDER',
        dedupKey,
        externalOrderId: ext,
        channelLinkId: manual.id,
        venueId,
        payload: { prueba: true },
        status: DeliveryOrderEventStatus.PROCESSED,
        resourcePayload: { aceptacion: ACEPTACION },
      },
    })
    // SUPERADMIN mueve el vínculo a la tienda B.
    await prisma.deliveryChannelLink.update({ where: { id: manual.id }, data: { externalLocationId: tiendaB } })

    // Cinco intentos (el KDS y el barrido reintentan): con el 424 real, cada uno que sale cuenta.
    const desenlaces: string[] = []
    for (let i = 0; i < 5; i++) desenlaces.push((await markDeliveryOrderReady(venueId!, order.id)).outcome)

    // Salen exactamente tres, con la tienda de HOY (es la que Rappi conoce ahora); la cuarta y la quinta ya no.
    expect(llamadasA(ext)).toHaveLength(MAX_LLAMADAS_LISTO)
    for (const c of llamadasA(ext)) expect(c).toEqual([ext, tiendaB, { reintentarEn401: false }])
    expect(desenlaces).toEqual(['FAILED', 'FAILED', 'FAILED', 'NO_REINTENTAR', 'NO_REINTENTAR'])
    // El contador vive en el aviso ORIGINAL, y la marca de aceptación sigue ahí.
    expect(await estadoDe(original.id)).toEqual({ aceptacion: ACEPTACION, listo: { llamadas: 3, cerrado: 'TOPE' } })
    expect(await listoDe(order.id)).toBeNull()
  })

  it('🔴 una reserva y la marca de aceptación A LA VEZ sobre la misma fila: ninguna pisa a la otra', async () => {
    const ext = `listo-it-${sufijo}-a-la-vez`
    const fila = await aviso(ext, {}, DeliveryOrderEventStatus.RECEIVED)
    const token = await reclamarEvento(fila.id, 45_000)
    if (!token) throw new Error('el reclamo de la prueba no se obtuvo')

    let reserva!: Promise<{ permitido: boolean }>
    let marca!: Promise<boolean>
    // Se toma el candado de la fila desde fuera y se sueltan los dos escritores detrás de él: los dos tienen que esperar y,
    // al soltarlo, el que entra segundo ve lo que escribió el primero.
    try {
      await prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT "id" FROM "DeliveryOrderEvent" WHERE "id" = ${fila.id} FOR UPDATE`
          reserva = reservarLlamadaDeListo(ext, tienda)
          marca = anotarAceptacion(fila.id, token, 'HTTP_2XX')
          await esperarEnFila(2)
        },
        { timeout: 20_000 },
      )
    } finally {
      // Pase lo que pase, los dos escritores terminan DENTRO de esta prueba: uno colgado no se cuela en la siguiente.
      await Promise.allSettled([reserva, marca].filter(Boolean))
    }

    expect(await reserva).toEqual({ permitido: true })
    expect(await marca).toBe(true)
    expect(leerEstado(await estadoDe(fila.id))).toEqual({
      aceptacion: { en: expect.any(String), evidencia: 'HTTP_2XX' },
      listo: { llamadas: 1 },
    })
  })

  it('🔴 el aviso NEW_ORDER que guarda el INGRESO REAL es la fila donde el «listo» cuenta: la llave del ingreso y la del contador coinciden', async () => {
    // El resto de las pruebas siembran el aviso a mano con `llaveDeAvisoDePedido`. Esta fija que el ingreso real
    // (`persistRappiWebhookEvent`) guarda ESA misma llave. 🔴 Con otra llave el contador igual encontraría la fila, por el camino 2
    // de `avisoBloqueado` (por `externalOrderId` y tienda): lo que detecta el desalineo es la aserción del `dedupKey` de abajo.
    const ext = `listo-it-${sufijo}-ingreso`
    const cuerpo = Buffer.from(JSON.stringify({ order_detail: { order_id: ext }, store: { external_id: tienda } }), 'utf8')
    const secreto = `secreto-ingreso-${sufijo}`
    const t = '1760000000'
    const firma = crypto
      .createHmac('sha256', secreto)
      .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), cuerpo]))
      .digest('hex')

    const ingreso = await persistRappiWebhookEvent({
      rawBody: cuerpo,
      signatureHeader: `t=${t},sign=${firma}`,
      evento: 'NEW_ORDER',
      secrets: [secreto],
    })
    expect(ingreso.outcome).toBe('PERSISTED')
    const fila = await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: ingreso.eventRowId! } })
    expect(fila).toMatchObject({
      dedupKey: llaveDeAvisoDePedido('NEW_ORDER', tienda, ext),
      externalOrderId: ext,
      channelLinkId: link.id,
      venueId,
    })

    const order = await ventaListaParaElListo(ext, 'R-ingreso')
    mockMarcarListoRappi.mockResolvedValue({ ok: true, status: 200, raw: '{}' })

    // La llave ya quedó fijada arriba (`dedupKey`); aquí se comprueba que el «listo» sale (READY) y cuenta en la fila del ingreso.
    expect((await markDeliveryOrderReady(venueId!, order.id)).outcome).toBe('READY')
    expect(llamadasA(ext)).toEqual([[ext, tienda, { reintentarEn401: false }]])
    expect(leerEstado(await estadoDe(fila.id)).listo).toEqual({ llamadas: 1, cerrado: 'HTTP_2XX' })
    // Cuenta en LA fila del ingreso: no apareció una segunda para el pedido.
    expect(await prisma.deliveryOrderEvent.count({ where: { venueId, externalOrderId: ext } })).toBe(1)
  })

  it('🔴 el candado de tiendas bloquea la llamada (nunca salió): NO gasta ninguna de las 3 — tras cinco bloqueos siguen disponibles las tres', async () => {
    const s = await sembrar()
    // `RappiEscrituraBloqueadaError` extiende esta clase: el candado salta ANTES de la red.
    const bloqueo = new DeliveryWriteNotSentError(
      'STORE_NOT_AUTHORIZED',
      '[Rappi] escritura BLOQUEADA para la tienda',
      'Rappi todavía no está habilitada',
    )
    mockMarcarListoRappi.mockRejectedValue(bloqueo)

    for (let i = 0; i < 5; i++) await expect(markDeliveryOrderReady(venueId!, s.order.id)).rejects.toBe(bloqueo)

    // Cada intento reservó (+1) y devolvió (-1): el contador quedó donde empezó y el «listo» NO se cerró por TOPE.
    expect(llamadasA(s.ext)).toHaveLength(5)
    expect(await estadoDe(s.fila.id)).toEqual({ aceptacion: ACEPTACION, listo: { llamadas: 0 } })
    expect(await listoDe(s.order.id)).toBeNull()

    // Se abre el candado: salen exactamente las tres que Rappi atiende, y la cuarta ya no.
    mockMarcarListoRappi.mockReset().mockResolvedValue({ ok: false, status: 424, raw: CUERPO_424_REAL })
    const desenlaces: string[] = []
    for (let i = 0; i < 4; i++) desenlaces.push((await markDeliveryOrderReady(venueId!, s.order.id)).outcome)

    expect(desenlaces).toEqual(['FAILED', 'FAILED', 'FAILED', 'NO_REINTENTAR'])
    expect(llamadasA(s.ext)).toHaveLength(MAX_LLAMADAS_LISTO)
    expect(await estadoDe(s.fila.id)).toEqual({ aceptacion: ACEPTACION, listo: { llamadas: 3, cerrado: 'TOPE' } })
  })

  it('🔴 seis reservas a la vez sobre el mismo pedido: exactamente tres con permiso (FOR UPDATE)', async () => {
    const ext = `listo-it-${sufijo}-seis`
    const fila = await aviso(ext)

    const r = await Promise.all(Array.from({ length: 6 }, () => reservarLlamadaDeListo(ext, tienda)))

    expect(r.filter(x => x.permitido)).toHaveLength(3)
    expect(await estadoDe(fila.id)).toEqual({ aceptacion: ACEPTACION, listo: { llamadas: 3 } })
  })
})

/**
 * Hay al menos `n` conexiones esperando un candado de `DeliveryOrderEvent`. 🔴 No basta `pg_blocking_pids(<el que lo tiene>)`:
 * Postgres forma a los que esperan una FILA, y el segundo espera al primero de la fila, no al dueño del candado.
 */
async function esperarEnFila(n: number) {
  for (let intento = 0; intento < 250; intento++) {
    const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%DeliveryOrderEvent%'`
    if (count >= n) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`No hubo ${n} conexiones esperando el candado de la fila`)
}
