/**
 * Integration (REAL DB) — Rappi fase 3: el dueño desconecta su tienda desde el panel.
 *
 * Revisar (lecturas) → avisar a Rappi «no integrada» → cerrar en una transacción corta que sólo escribe si la fila sigue
 * ACTIVE/PAUSED con la MISMA conexión. Sin candados ni reservas (D3 = A, 25-oct). La red de Rappi se sustituye: el adaptador
 * simulado puede cambiar la fila mientras «contesta», para intercalar de verdad una reconexión, un PATCH o una baja.
 */
import { DeliveryChannelStatus, DeliveryOrderEventStatus, DeliveryProvider, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { DeliveryWriteNotSentError } from '@/services/delivery-channels/core/types'
import { rappiAdapter } from '@/services/delivery-channels/providers/rappi/rappi.adapter'
import {
  conexionIdDe,
  contarPedidosEnCurso,
  desconectarTiendaRappi,
  VENTANA_TRAS_CONECTAR_MS,
} from '@/services/delivery-channels/providers/rappi/rappi.desconectar'
import { updateChannelLink } from '@/services/delivery-channels/core/deliveryChannelLink.service'

const escrituras: Promise<unknown>[] = []
jest.mock('@/services/dashboard/activity-log.service', () => {
  const actual = jest.requireActual('@/services/dashboard/activity-log.service')
  return {
    ...actual,
    logAction: (...args: unknown[]) => {
      const r = actual.logAction(...args)
      escrituras.push(r)
      return r
    },
  }
})

const OK = { ok: true, status: 200, raw: '{}' }
const hace = (ms: number) => new Date(Date.now() - ms).toISOString()

describe('Rappi fase 3: desconectar una tienda', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let n = 0
  let orgId: string, venueId: string, otroVenue: string, staffId: string
  let aviso: jest.SpyInstance

  async function vinculo(p: { status?: DeliveryChannelStatus; intentId?: string | null; confirmadaHaceMs?: number; venue?: string } = {}) {
    const intentId = p.intentId === undefined ? `intent-${sufijo}-${n}` : p.intentId
    const config = intentId
      ? { rappiProvisioning: { intentId, since: hace(600_000), confirmedAt: hace(p.confirmadaHaceMs ?? 600_000) }, horario: 'del negocio' }
      : { horario: 'del negocio' }
    return prisma.deliveryChannelLink.create({
      data: {
        venueId: p.venue ?? venueId,
        provider: DeliveryProvider.RAPPI,
        externalLocationId: `t-desc-${sufijo}-${n++}`,
        externalAccountId: 'Tienda QA',
        webhookSecret: 'x',
        status: p.status ?? DeliveryChannelStatus.ACTIVE,
        config,
      },
    })
  }
  const releer = (id: string) => prisma.deliveryChannelLink.findUniqueOrThrow({ where: { id } })
  const bitacora = async (entityId: string, action: string) => {
    await Promise.all(escrituras)
    return prisma.activityLog.findMany({ where: { venueId, entityId, action } })
  }
  const desconectar = (link: { id: string; config: unknown; externalLocationId: string }, extra: { forzar?: boolean } = {}) =>
    desconectarTiendaRappi({
      venueId,
      linkId: link.id,
      conexionId: conexionIdDe(link),
      performedBy: staffId,
      origen: 'DASHBOARD',
      ...extra,
    })

  async function orden(
    linkId: string,
    p: { status?: 'CONFIRMED' | 'COMPLETED' | 'CANCELLED'; haceMs?: number; externalId?: string } = {},
  ) {
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: `Rappi QA ${n++}`,
        source: 'RAPPI',
        originSystem: 'DELIVERY_PLATFORM',
        status: p.status ?? 'CONFIRMED',
        subtotal: new Prisma.Decimal(100),
        total: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal(100),
        contratoDePrecio: 'IVA_INCLUIDO',
        deliveryChannelLinkId: linkId,
        externalId: p.externalId ?? null,
        createdAt: new Date(Date.now() - (p.haceMs ?? 3_600_000)),
      },
    })
  }
  async function evento(
    linkId: string,
    p: { status?: DeliveryOrderEventStatus; error?: string; orderId?: string; eventType?: string; externalOrderId?: string } = {},
  ) {
    const id = `ev-desc-${sufijo}-${n++}`
    return prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.RAPPI,
        externalEventId: id,
        eventType: p.eventType ?? 'NEW_ORDER',
        payload: {},
        channelLinkId: linkId,
        venueId,
        status: p.status ?? DeliveryOrderEventStatus.RECEIVED,
        error: p.error ?? null,
        orderId: p.orderId ?? null,
        externalOrderId: p.externalOrderId ?? null,
        dedupKey: `RAPPI:${id}`,
      },
    })
  }

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: 'Rappi desconectar', email: `${sufijo}@example.test`, phone: '5500000000' } })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Rappi desc', slug: `rappi-desc-${sufijo}` } })).id
    otroVenue = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Rappi desc 2', slug: `rappi-desc2-${sufijo}` } })).id
    staffId = (await prisma.staff.create({ data: { email: `staff-${sufijo}@example.test`, firstName: 'QA', lastName: 'Rappi' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
  })

  beforeEach(() => {
    aviso = jest.spyOn(rappiAdapter, 'notifyIntegrationStatus').mockResolvedValue(OK)
  })
  afterEach(() => aviso.mockRestore())

  afterAll(async () => {
    if (!venueId || !otroVenue || !orgId) return
    await Promise.all(escrituras)
    for (const v of [venueId, otroVenue]) {
      await prisma.activityLog.deleteMany({ where: { venueId: v } })
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId: v } })
      await prisma.order.deleteMany({ where: { venueId: v } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId: v } })
      await prisma.staffVenue.deleteMany({ where: { venueId: v } })
    }
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
    await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenue] } } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  // ── Lo nuevo ─────────────────────────────────────────────────────────────────────────────

  it('desconecta una tienda ACTIVE cuando Rappi contesta 200', async () => {
    const l = await vinculo()
    const r = await desconectar(l)
    expect(r).toMatchObject({ yaEstaba: false, forzada: false })
    expect(r.link.status).toBe('DISABLED')
    expect(aviso).toHaveBeenCalledTimes(1)
    expect(aviso).toHaveBeenCalledWith(l.externalLocationId, false)
    const fila = await releer(l.id)
    expect(fila.status).toBe('DISABLED')
    // La configuración del negocio y el aprovisionamiento se conservan: «Reconectar» reusa la fila.
    expect(fila.config).toMatchObject({ horario: 'del negocio', rappiProvisioning: { intentId: expect.any(String) } })
    const log = await bitacora(l.id, 'DELIVERY_CHANNEL_DISCONNECTED')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      staffId,
      data: expect.objectContaining({ provider: 'RAPPI', statusPrevio: 'ACTIVE', origen: 'DASHBOARD', forzada: false }),
    })
  })

  it('desconecta una tienda PAUSED y limpia snoozedUntil', async () => {
    const l = await vinculo({ status: DeliveryChannelStatus.PAUSED })
    await prisma.deliveryChannelLink.update({ where: { id: l.id }, data: { snoozedUntil: new Date(Date.now() + 3_600_000) } })
    await desconectar(l)
    const fila = await releer(l.id)
    expect(fila).toMatchObject({ status: 'DISABLED', snoozedUntil: null })
    expect((await bitacora(l.id, 'DELIVERY_CHANNEL_DISCONNECTED'))[0].data).toMatchObject({ statusPrevio: 'PAUSED' })
  })

  it('si Rappi contesta 500 no desconecta (D1)', async () => {
    aviso.mockResolvedValue({ ok: false, status: 500, raw: 'boom' })
    const l = await vinculo()
    await expect(desconectar(l)).rejects.toMatchObject({ statusCode: 502, code: 'RAPPI_NO_ACEPTO' })
    expect((await releer(l.id)).status).toBe('ACTIVE')
    const fallo = await bitacora(l.id, 'DELIVERY_INTEGRATION_STATUS_FAILED')
    expect(fallo).toHaveLength(1)
    expect(fallo[0].data).toMatchObject({ provider: 'RAPPI', integrada: false, tipo: 'NO_ACEPTO', status: 500 })
    expect(await bitacora(l.id, 'DELIVERY_CHANNEL_DISCONNECTED')).toHaveLength(0)
  })

  it('si el aviso lanza DeliveryWriteNotSentError responde RAPPI_NO_ACEPTO y sigue ACTIVE', async () => {
    aviso.mockRejectedValue(new DeliveryWriteNotSentError('UNAVAILABLE', 'no salió'))
    const l = await vinculo()
    await expect(desconectar(l)).rejects.toMatchObject({ statusCode: 502, code: 'RAPPI_NO_ACEPTO' })
    expect((await releer(l.id)).status).toBe('ACTIVE')
  })

  it('si el aviso da timeout responde RAPPI_SIN_CONFIRMAR y sigue ACTIVE', async () => {
    aviso.mockRejectedValue(new Error('timeout of 10000ms exceeded'))
    const l = await vinculo()
    await expect(desconectar(l)).rejects.toMatchObject({ statusCode: 502, code: 'RAPPI_SIN_CONFIRMAR' })
    expect((await releer(l.id)).status).toBe('ACTIVE')
    expect((await bitacora(l.id, 'DELIVERY_INTEGRATION_STATUS_FAILED'))[0].data).toMatchObject({ tipo: 'SIN_CONFIRMAR' })
  })

  it('con forzar y Rappi 500 dos veces termina DISABLED con forzada: true', async () => {
    aviso.mockResolvedValue({ ok: false, status: 500, raw: 'boom' })
    const l = await vinculo()
    const r = await desconectar(l, { forzar: true })
    expect(r).toMatchObject({ forzada: true, yaEstaba: false })
    expect(aviso).toHaveBeenCalledTimes(2)
    expect((await releer(l.id)).status).toBe('DISABLED')
    expect((await bitacora(l.id, 'DELIVERY_CHANNEL_DISCONNECTED'))[0].data).toMatchObject({ forzada: true, rappiStatus: 500 })
  })

  it('con forzar y Rappi 200 no queda como forzada', async () => {
    const l = await vinculo()
    expect(await desconectar(l, { forzar: true })).toMatchObject({ forzada: false })
    expect(aviso).toHaveBeenCalledTimes(1)
  })

  it('forzar no salta pedidos en curso, PENDING ni el primer minuto tras conectar', async () => {
    const conPedido = await vinculo()
    await orden(conPedido.id)
    await expect(desconectar(conPedido, { forzar: true })).rejects.toMatchObject({ code: 'RAPPI_PEDIDOS_EN_CURSO' })
    const pendiente = await vinculo({ status: DeliveryChannelStatus.PENDING })
    await expect(desconectar(pendiente, { forzar: true })).rejects.toMatchObject({ code: 'RAPPI_CONEXION_EN_CURSO' })
    const recien = await vinculo({ confirmadaHaceMs: 5_000 })
    await expect(desconectar(recien, { forzar: true })).rejects.toMatchObject({ code: 'RAPPI_OPERACION_EN_CURSO' })
    expect(aviso).not.toHaveBeenCalled()
  })

  it('DISABLED es idempotente y no llama a Rappi', async () => {
    const l = await vinculo({ status: DeliveryChannelStatus.DISABLED })
    expect(await desconectar(l)).toMatchObject({ yaEstaba: true })
    expect(aviso).not.toHaveBeenCalled()
  })

  it('PENDING responde RAPPI_CONEXION_EN_CURSO sin llamar a Rappi', async () => {
    const l = await vinculo({ status: DeliveryChannelStatus.PENDING })
    await expect(desconectar(l)).rejects.toMatchObject({ statusCode: 409, code: 'RAPPI_CONEXION_EN_CURSO' })
    expect(aviso).not.toHaveBeenCalled()
  })

  it('confirmada hace 30 s responde RAPPI_OPERACION_EN_CURSO sin llamar a Rappi; a los 61 s se desconecta', async () => {
    expect(VENTANA_TRAS_CONECTAR_MS).toBe(60_000)
    const recien = await vinculo({ confirmadaHaceMs: 30_000 })
    await expect(desconectar(recien)).rejects.toMatchObject({ statusCode: 409, code: 'RAPPI_OPERACION_EN_CURSO' })
    expect(aviso).not.toHaveBeenCalled()
    const viejita = await vinculo({ confirmadaHaceMs: 61_000 })
    expect((await desconectar(viejita)).link.status).toBe('DISABLED')
  })

  it('un vínculo manual (sin aprovisionamiento) no se frena por el minuto y usa conexionId manual:<tienda>', async () => {
    const l = await vinculo({ intentId: null })
    expect(conexionIdDe(l)).toBe(`manual:${l.externalLocationId}`)
    expect((await desconectar(l)).link.status).toBe('DISABLED')
  })

  it('un conexionId viejo (otro intentId tras reconectar) da RAPPI_CAMBIO_LA_CONEXION sin llamar a Rappi', async () => {
    const l = await vinculo()
    const viejo = conexionIdDe(l)
    await prisma.deliveryChannelLink.update({
      where: { id: l.id },
      data: { config: { rappiProvisioning: { intentId: `otro-${sufijo}`, since: hace(600_000), confirmedAt: hace(600_000) } } },
    })
    await expect(
      desconectarTiendaRappi({ venueId, linkId: l.id, conexionId: viejo, performedBy: staffId, origen: 'DASHBOARD' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RAPPI_CAMBIO_LA_CONEXION' })
    expect(aviso).not.toHaveBeenCalled()
    expect((await releer(l.id)).status).toBe('ACTIVE')
  })

  it('un vínculo manual cuya tienda cambió por PATCH da RAPPI_CAMBIO_LA_CONEXION', async () => {
    const l = await vinculo({ intentId: null })
    const viejo = conexionIdDe(l)
    await updateChannelLink(venueId, l.id, { externalLocationId: `${l.externalLocationId}-nueva` })
    await expect(
      desconectarTiendaRappi({ venueId, linkId: l.id, conexionId: viejo, performedBy: staffId, origen: 'DASHBOARD' }),
    ).rejects.toMatchObject({ code: 'RAPPI_CAMBIO_LA_CONEXION' })
    expect(aviso).not.toHaveBeenCalled()
  })

  // ── El cierre condicionado: la fila cambia MIENTRAS Rappi contesta ───────────────────────

  it('si durante el aviso una reconexión cambió el intentId, el cierre no escribe y da RAPPI_CAMBIO_LA_CONEXION', async () => {
    const l = await vinculo()
    aviso.mockImplementation(async () => {
      await prisma.deliveryChannelLink.update({
        where: { id: l.id },
        data: { config: { rappiProvisioning: { intentId: `reconexion-${sufijo}`, since: hace(1_000), confirmedAt: hace(500) } } },
      })
      return OK
    })
    await expect(desconectar(l)).rejects.toMatchObject({ statusCode: 409, code: 'RAPPI_CAMBIO_LA_CONEXION' })
    expect((await releer(l.id)).status).toBe('ACTIVE')
    expect(await bitacora(l.id, 'DELIVERY_CHANNEL_DISCONNECTED')).toHaveLength(0)
  })

  it('si durante el aviso un PATCH cambió la tienda, el cierre no escribe', async () => {
    const l = await vinculo({ intentId: null })
    aviso.mockImplementation(async () => {
      await prisma.deliveryChannelLink.update({ where: { id: l.id }, data: { externalLocationId: `${l.externalLocationId}-x` } })
      return OK
    })
    await expect(desconectar(l)).rejects.toMatchObject({ code: 'RAPPI_CAMBIO_LA_CONEXION' })
    expect((await releer(l.id)).status).toBe('ACTIVE')
  })

  it('si durante el aviso una baja de Rappi dejó DISABLED, responde yaEstaba y no escribe bitácora de desconexión', async () => {
    const l = await vinculo()
    aviso.mockImplementation(async () => {
      await prisma.deliveryChannelLink.update({ where: { id: l.id }, data: { status: DeliveryChannelStatus.DISABLED } })
      return OK
    })
    expect(await desconectar(l)).toMatchObject({ yaEstaba: true })
    expect(await bitacora(l.id, 'DELIVERY_CHANNEL_DISCONNECTED')).toHaveLength(0)
  })

  it('dos desconexiones a la vez: un solo DISABLED, una sola bitácora, la otra recibe yaEstaba', async () => {
    const l = await vinculo()
    aviso.mockImplementation(() => new Promise(r => setTimeout(() => r(OK), 50)))
    const [a, b] = await Promise.all([desconectar(l), desconectar(l)])
    expect([a.yaEstaba, b.yaEstaba].sort()).toEqual([false, true])
    expect((await releer(l.id)).status).toBe('DISABLED')
    expect(await bitacora(l.id, 'DELIVERY_CHANNEL_DISCONNECTED')).toHaveLength(1)
  })

  // ── Pedidos en curso ─────────────────────────────────────────────────────────────────────

  it('una orden abierta de hace 1 h bloquea con pedidosEnCurso 1; una de hace 25 h no', async () => {
    const l = await vinculo()
    await orden(l.id, { haceMs: 25 * 3_600_000 })
    await orden(l.id, { haceMs: 3_600_000 })
    await expect(desconectar(l)).rejects.toMatchObject({ statusCode: 409, code: 'RAPPI_PEDIDOS_EN_CURSO', details: { pedidosEnCurso: 1 } })
    expect(aviso).not.toHaveBeenCalled()
  })

  it('COMPLETED, CANCELLED o de otro vínculo no cuentan', async () => {
    const l = await vinculo()
    const otro = await vinculo()
    await orden(l.id, { status: 'COMPLETED' })
    await orden(l.id, { status: 'CANCELLED' })
    await orden(otro.id)
    expect((await contarPedidosEnCurso(prisma, [l.id])).get(l.id) ?? 0).toBe(0)
  })

  it('un evento de pedido nuevo sin orden RECEIVED, o FAILED reintentable, bloquea', async () => {
    const a = await vinculo()
    await evento(a.id)
    const b = await vinculo()
    await evento(b.id, { status: DeliveryOrderEventStatus.FAILED, error: 'HISTORIAL_NO_LEIDO' })
    const conteo = await contarPedidosEnCurso(prisma, [a.id, b.id])
    expect(conteo.get(a.id)).toBe(1)
    expect(conteo.get(b.id)).toBe(1)
  })

  it('FAILED terminal, PROCESSED, DUPLICATE y eventos que no son pedido nuevo no cuentan', async () => {
    const l = await vinculo()
    for (const error of ['CANCELADO_ANTES_DE_REGISTRAR', 'PEDIDO_YA_NO_ACTIVO', 'CHANNEL_DISABLED']) {
      await evento(l.id, { status: DeliveryOrderEventStatus.FAILED, error })
    }
    await evento(l.id, { status: DeliveryOrderEventStatus.PROCESSED })
    await evento(l.id, { status: DeliveryOrderEventStatus.DUPLICATE })
    await evento(l.id, { eventType: 'ORDER_EVENT_CANCEL' })
    expect((await contarPedidosEnCurso(prisma, [l.id])).get(l.id) ?? 0).toBe(0)
  })

  it('un pedido ya registrado (orden abierta + su evento PROCESSED) cuenta 1, no 2', async () => {
    const l = await vinculo()
    const o = await orden(l.id)
    await evento(l.id, { status: DeliveryOrderEventStatus.PROCESSED, orderId: o.id })
    expect((await contarPedidosEnCurso(prisma, [l.id])).get(l.id)).toBe(1)
  })

  it('la orden ya creada con su aviso aún sin orderId (ventana de la ingesta) cuenta 1, no 2 (Codex código r2)', async () => {
    const l = await vinculo()
    const pedidoRappi = `rp-${sufijo}-${n}`
    await orden(l.id, { externalId: `RAPPI:${pedidoRappi}` })
    await evento(l.id, { externalOrderId: pedidoRappi })
    expect((await contarPedidosEnCurso(prisma, [l.id])).get(l.id)).toBe(1)
  })

  it('si el folio del pedido tiene orden en OTRA tienda del negocio, el aviso vivo de ésta sigue contando (Codex código r3)', async () => {
    const a = await vinculo()
    const b = await vinculo()
    const pedidoRappi = `rp-${sufijo}-${n}`
    await orden(b.id, { externalId: `RAPPI:${pedidoRappi}` })
    await evento(a.id, { externalOrderId: pedidoRappi })
    const conteo = await contarPedidosEnCurso(prisma, [a.id, b.id])
    expect(conteo.get(a.id)).toBe(1)
    expect(conteo.get(b.id)).toBe(1)
  })

  it('con 3 vínculos hace UNA consulta', async () => {
    const ls = await Promise.all([vinculo(), vinculo(), vinculo()])
    const espia = jest.spyOn(prisma, '$queryRaw')
    await contarPedidosEnCurso(
      prisma,
      ls.map(l => l.id),
    )
    expect(espia).toHaveBeenCalledTimes(1)
    espia.mockRestore()
  })

  // ── Aislamiento y proveedor ──────────────────────────────────────────────────────────────

  it('un linkId de otro venue da 404 y no toca nada', async () => {
    const ajeno = await vinculo({ venue: otroVenue })
    await expect(
      desconectarTiendaRappi({ venueId, linkId: ajeno.id, conexionId: conexionIdDe(ajeno), performedBy: staffId, origen: 'DASHBOARD' }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect((await releer(ajeno.id)).status).toBe('ACTIVE')
    expect(aviso).not.toHaveBeenCalled()
  })

  it('un vínculo UBER_EATS da SOLO_RAPPI', async () => {
    const uber = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `uber-${sufijo}`, webhookSecret: 'x', status: 'ACTIVE' },
    })
    await expect(desconectar(uber)).rejects.toMatchObject({ statusCode: 400, code: 'SOLO_RAPPI' })
  })
})
