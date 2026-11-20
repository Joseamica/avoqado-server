/**
 * hz:e82938e1:D36 — «Cobrar» de la TPV crea la venta en el SERVIDOR al ir a cobrar; si la cajera regresa con «atrás» SIN haber
 * intentado cobrar, la terminal pide anularla. Promesa: docs/audit/2026-11-20-d36-cobrar-ventas-abiertas/promesa.md (workspace).
 *
 * Es la MISMA anulación que «Cancelar cuenta» del panel y del MCP (`cancelOrderInTransaction` + `publishCancelledOrder`), con
 * candados de evidencia propios: sólo una venta de Cobrar de esta misma terminal, declarada «para cobrarse en el momento»
 * (`payLater = false`), sin NINGÚN pago (de cualquier estado), sin asignaciones de pago y sin NINGUNA solicitud a la terminal.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { prismaMock } from '@tests/__helpers__/setup'
import {
  anularVentaDeCobrarSinCobro,
  CAMINO_ATRAS_SIN_COBRO,
  MOTIVO_ATRAS_SIN_COBRO,
} from '@/services/tpv/ventaDeCobrarSinCobro.tpv.service'

const { logAction } = require('@/services/dashboard/activity-log.service')

const VENUE = 'venue-1'
const ORDER = 'order-1'
const TERMINAL = 'terminal-1'
const SERIAL = 'AVQD-2841548417'
const QUIEN = { staffId: 'staff-1', terminalSerial: SERIAL }

type Venta = {
  source?: string
  type?: string
  tableId?: string | null
  onlineOrder?: { id: string } | null
  payLater?: boolean | null
  terminalId?: string | null
  status?: string
  paymentStatus?: string
  createdAt?: Date
}

const AHORA = new Date('2026-11-20T20:00:00Z')

function venta(datos: Venta = {}) {
  const v = {
    id: ORDER,
    source: datos.source ?? 'TPV',
    type: datos.type ?? 'TAKEOUT',
    tableId: datos.tableId ?? null,
    onlineOrder: datos.onlineOrder ?? null,
    payLater: datos.payLater === undefined ? false : datos.payLater,
    terminalId: datos.terminalId === undefined ? TERMINAL : datos.terminalId,
    status: datos.status ?? 'PENDING',
    paymentStatus: datos.paymentStatus ?? 'PENDING',
    createdAt: datos.createdAt ?? new Date('2026-11-20T19:58:00Z'),
  }
  prismaMock.order.findFirst.mockResolvedValue(v as any)
  // La relectura BAJO el candado (`lockAndReadOrderForCancel`).
  prismaMock.order.findUnique.mockResolvedValue({
    id: ORDER,
    source: v.source,
    posRawData: null,
    paymentStatus: v.paymentStatus,
    status: v.status,
    version: 1,
    paidAmount: 0,
    tipAmount: 0,
    tableId: v.tableId,
  } as any)
}

beforeEach(() => {
  jest.clearAllMocks()
  venta()
  prismaMock.terminal.findFirst.mockResolvedValue({ id: TERMINAL } as any)
  prismaMock.order.update.mockResolvedValue({ id: ORDER, status: 'CANCELLED', tableId: null } as any)
  prismaMock.order.findMany.mockResolvedValue([{ id: ORDER, tableId: null, createdAt: new Date('2026-11-20T00:00:00Z') }] as any)
  prismaMock.table.findMany.mockResolvedValue([])
  prismaMock.kdsOrder.findMany.mockResolvedValue([])
  prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.paymentAllocation.count.mockResolvedValue(0)
  prismaMock.terminalPaymentRequest.count.mockResolvedValue(0)
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
  prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
    const sql = Array.isArray(query) ? query.join(' ') : ''
    if (sql.includes('"OrderDiscount"')) return []
    if (sql.includes('"KdsOrderItem"')) return []
    if (sql.includes('FROM "Venue"')) return [{ id: VENUE }]
    if (sql.includes('FROM "Order"')) return [{ id: ORDER }]
    if (sql.includes('pg_advisory_xact_lock')) return []
    throw new Error('SQL inesperado en la anulación')
  })
})

describe('anularVentaDeCobrarSinCobro — «atrás» en Cobrar antes de cobrar', () => {
  it('anula una venta de Cobrar limpia, con UNA entrada de bitácora que dice el camino, la terminal y el motivo', async () => {
    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).resolves.toEqual({ estado: 'RETIRADA' })

    expect(prismaMock.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED' } }))
    // Codex r1 #7: la entrada va DENTRO de la transacción (una caída tras el commit no deja una anulación sin bitácora), y es UNA.
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'ORDER_CANCELLED',
        entity: 'Order',
        entityId: ORDER,
        staffId: 'staff-1',
        venueId: VENUE,
        data: { camino: CAMINO_ATRAS_SIN_COBRO, terminal: SERIAL, reason: MOTIVO_ATRAS_SIN_COBRO },
      },
    })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 una venta de más de 24 h ya no se anula sola (el reintento sin red tiene tope)', async () => {
    venta({ createdAt: new Date('2026-11-19T19:59:00Z') })

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'VENTA_VIEJA' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('🔴 lo que cambió entre la lectura previa y el candado (p. ej. ya es «Pagar después») revierte la anulación (Codex r1 #2)', async () => {
    venta()
    const previa = await prismaMock.order.findFirst({} as any)
    prismaMock.order.findFirst.mockReset()
    prismaMock.order.findFirst
      .mockResolvedValueOnce(previa as any) // la lectura previa
      .mockResolvedValue({ ...(previa as any), payLater: true } as any) // bajo el candado

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'NO_ES_VENTA_DE_COBRAR' })
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('la terminal se busca dentro del negocio, por el serial del token', async () => {
    await anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)

    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { serialNumber: SERIAL, venueId: VENUE } }))
  })

  // ── Lo que NO se anula: cuentas abiertas a propósito ─────────────────────────────────────────────────────────────────────────

  it('🔴 un «Pagar después» (payLater = true) es una cuenta abierta a propósito: no se toca', async () => {
    venta({ payLater: true })

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({
      statusCode: 400,
      code: 'NO_ES_VENTA_DE_COBRAR',
    })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 una venta que no declaró su intención (TPV vieja, payLater nulo) no se toca: puede ser un «Pagar después»', async () => {
    venta({ payLater: null })

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'NO_ES_VENTA_DE_COBRAR' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it.each([
    ['de mesa', { tableId: 'mesa-7' }],
    ['un pedido en línea (folio)', { onlineOrder: { id: 'web-1' } }],
    ['del kiosco', { source: 'KIOSK' }],
    ['del POS de ANDROID', { source: 'AVOQADO_ANDROID' }],
    ['para comer aquí', { type: 'DINE_IN' }],
  ] as Array<[string, Venta]>)('🔴 una cuenta %s no es una venta de Cobrar: no se toca', async (_caso, datos) => {
    venta(datos)

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'NO_ES_VENTA_DE_COBRAR' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  // ── La misma terminal ──────────────────────────────────────────────────────────────────────────────────────────────────────

  it('🔴 otra terminal no puede anular la venta que creó ésta', async () => {
    venta({ terminalId: 'otra-terminal' })

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'OTRA_TERMINAL' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('🔴 una venta sin terminal registrada no se anula por aquí', async () => {
    venta({ terminalId: null })

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'OTRA_TERMINAL' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('🔴 sin terminal en el token (o una que no es de este negocio) no se anula nada', async () => {
    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, { staffId: 'staff-1', terminalSerial: null }, AHORA)).rejects.toMatchObject({
      code: 'TERMINAL_NO_IDENTIFICADA',
    })
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'TERMINAL_NO_IDENTIFICADA' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  // ── Ningún rastro de cobro ─────────────────────────────────────────────────────────────────────────────────────────────────

  it.each(['PENDING', 'PROCESSING', 'FAILED', 'REFUNDED'])(
    '🔴 un pago %s sobre la venta (cripto pendiente, tarjeta rechazada…) la deja como está',
    async () => {
      // La guarda de siempre cuenta sólo los COMPLETED (0 aquí); la de D36 cuenta todos.
      prismaMock.payment.count.mockImplementation((async (args: any) => (args?.where?.status ? 0 : 1)) as any)

      await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({
        statusCode: 409,
        code: 'VENTA_CON_RASTRO_DE_COBRO',
      })
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    },
  )

  it('🔴 un pago COMPLETED lo frena la guarda de siempre (400, «usa Reembolso»), antes que la de D36', async () => {
    prismaMock.payment.count.mockResolvedValue(1)

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ statusCode: 400 })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 el conteo de D36 es de CUALQUIER estado (sin filtro de status) y del negocio', async () => {
    prismaMock.payment.count.mockImplementation((async (args: any) => (args?.where?.status ? 0 : 1)) as any)

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'VENTA_CON_RASTRO_DE_COBRO' })
    expect(prismaMock.payment.count).toHaveBeenCalledWith({ where: { orderId: ORDER, venueId: VENUE } })
  })

  it('🔴 una asignación de pago a la venta la deja como está', async () => {
    prismaMock.paymentAllocation.count.mockResolvedValue(1)

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'VENTA_CON_RASTRO_DE_COBRO' })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 cualquier solicitud del POS a la terminal sobre la venta (también una ya cerrada) la deja como está', async () => {
    prismaMock.terminalPaymentRequest.count.mockResolvedValue(1)

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ code: 'VENTA_CON_RASTRO_DE_COBRO' })
    expect(prismaMock.terminalPaymentRequest.count).toHaveBeenCalledWith({ where: { venueId: VENUE, orderId: ORDER } })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 con dinero (PAID) responde lo de siempre y no audita', async () => {
    venta({ paymentStatus: 'PAID' })

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ statusCode: 400 })
    expect(logAction).not.toHaveBeenCalled()
  })

  // ── Reintentos ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('una venta YA anulada contesta YA_RETIRADA sin volver a escribir ni a auditar (el reintento sin red)', async () => {
    venta({ status: 'CANCELLED' })

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).resolves.toEqual({ estado: 'YA_RETIRADA' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('dos retiros a la vez: el segundo ve la anulación BAJO el candado y contesta YA_RETIRADA, sin auditar', async () => {
    // La prelectura la vio pendiente; la relectura bajo el candado, ya cancelada por el primero.
    prismaMock.order.findUnique.mockResolvedValue({
      id: ORDER,
      source: 'TPV',
      posRawData: null,
      paymentStatus: 'PENDING',
      status: 'CANCELLED',
      version: 2,
      paidAmount: 0,
      tipAmount: 0,
      tableId: null,
    } as any)

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).resolves.toEqual({ estado: 'YA_RETIRADA' })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('una venta que no es de este negocio no existe', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)

    await expect(anularVentaDeCobrarSinCobro(VENUE, ORDER, QUIEN, AHORA)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORDER, venueId: VENUE } }))
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })
})
