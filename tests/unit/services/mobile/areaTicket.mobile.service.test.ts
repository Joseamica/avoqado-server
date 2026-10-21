/**
 * Vales por área — pruebas del server (§10).
 *
 * Cubre lo que el spec pide explícitamente:
 *  · Claim: área intenta agregar con la cuenta en CHECKOUT_CLAIMED → rechazo claro.
 *  · Claim caducado a los 5 min libera la cuenta.
 *  · `fulfill` dos veces → un registro, mismo id. Sobre orden no pagada → rechazo.
 *    Sobre CANCELLED → rechazo.
 *  · Resolución de código: vivo · pagado · entregado · inexistente. Verificador
 *    inválido → rechazo SIN TOCAR LA BASE.
 *  · Partición: dos dispositivos nunca reciben la misma; contador que retrocede →
 *    AREA_CODE_REPLAY.
 */

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { Decimal } from '@prisma/client/runtime/library'

import { buildAreaTicketCode } from '@/lib/areaTicketCode'
import {
  AREA_TICKET_CLAIM_TTL_MS,
  addAreaTicketItems,
  assignDevicePartition,
  claimAreaTicket,
  deriveAreaTicketState,
  fulfillOrderArea,
  isClaimLive,
  listPendingFulfillment,
  openAreaTicket,
  resolveAreaTicket,
} from '@/services/mobile/areaTicket.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const DEVICE = 'device-uid-1'
const AREA = 'area-cremeria'
const CODE = buildAreaTicketCode(47, 12) // 10 dígitos, partición 47, contador 12

/** Terminal del ÁREA (cremería), con partición 47. */
function mockAreaTerminal(overrides: Record<string, any> = {}) {
  prismaMock.terminal.findFirst.mockResolvedValue({
    id: 'terminal-area',
    name: 'Sunmi D3 (Cremería)',
    partition: 47,
    fulfillmentAreaId: AREA,
    areaTicketLastCounter: 11,
    ...overrides,
  })
}

/** Cuenta base: un renglón de la cremería + un renglón de caja (área null). */
function ticketRow(overrides: Record<string, any> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'ORD-1',
    venueId: VENUE,
    areaTicketCode: CODE,
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: new Decimal(108.19),
    discountAmount: new Decimal(0),
    total: new Decimal(108.19),
    tipAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    paidAmount: new Decimal(0),
    version: 1,
    claimedByTerminalId: null,
    claimedAt: null,
    createdAt: new Date('2026-07-28T18:00:00Z'),
    customerName: null,
    items: [
      {
        id: 'oi-jamon',
        productId: 'p-jamon',
        productName: 'Jamón serrano',
        quantity: 1,
        unitPrice: new Decimal(164),
        weightQuantity: new Decimal(0.224),
        total: new Decimal(36.74),
        discountAmount: new Decimal(0),
        notes: null,
        fulfillmentAreaId: AREA,
        fulfillmentArea: { id: AREA, name: 'Cremería' },
        fulfillmentLines: [],
      },
      {
        id: 'oi-papas',
        productId: 'p-papas',
        productName: 'Papas',
        quantity: 1,
        unitPrice: new Decimal(71.45),
        weightQuantity: null,
        total: new Decimal(71.45),
        discountAmount: new Decimal(0),
        notes: null,
        // 🔴 null a propósito: línea de caja, "se entrega al momento".
        fulfillmentAreaId: null,
        fulfillmentArea: null,
        fulfillmentLines: [],
      },
    ],
    fulfillments: [],
    ...overrides,
  }
}

describe('vales por área — estado derivado (§5.4)', () => {
  it('OPEN cuando no hay claim, no está pagada y no está cancelada', () => {
    expect(deriveAreaTicketState(ticketRow() as any)).toBe('OPEN')
  })

  it('CHECKOUT_CLAIMED mientras el claim está vivo', () => {
    const row = ticketRow({ claimedByTerminalId: 'caja', claimedAt: new Date() })
    expect(deriveAreaTicketState(row as any)).toBe('CHECKOUT_CLAIMED')
  })

  it('🔴 el claim CADUCA a los 5 minutos y la cuenta vuelve a OPEN', () => {
    // Una caja que se cuelga no puede secuestrar la cuenta con el producto del
    // cliente atrapado en el área.
    const expired = new Date(Date.now() - AREA_TICKET_CLAIM_TTL_MS - 1000)
    const row = ticketRow({ claimedByTerminalId: 'caja', claimedAt: expired })
    expect(isClaimLive(expired)).toBe(false)
    expect(deriveAreaTicketState(row as any)).toBe('OPEN')
  })

  it('ALREADY_PAID cuando está pagada y el área todavía no entrega', () => {
    expect(deriveAreaTicketState(ticketRow({ paymentStatus: 'PAID' }) as any)).toBe('ALREADY_PAID')
  })

  it('DELIVERED cuando TODAS las áreas con renglones ya entregaron', () => {
    const row = ticketRow({ paymentStatus: 'PAID', fulfillments: [{ fulfillmentAreaId: AREA }] })
    expect(deriveAreaTicketState(row as any)).toBe('DELIVERED')
  })

  it('las líneas de CAJA (área null) no impiden llegar a DELIVERED', () => {
    // Se entregan al momento; exigirles una entrega dejaría todo vale eternamente
    // "pendiente" en la pantalla de las 3 áreas reales.
    const row = ticketRow({
      paymentStatus: 'PAID',
      items: [{ fulfillmentAreaId: null }],
      fulfillments: [],
    })
    expect(deriveAreaTicketState(row as any)).toBe('DELIVERED')
  })

  it('CANCELLED gana sobre todo lo demás', () => {
    const row = ticketRow({ status: 'CANCELLED', paymentStatus: 'PAID' })
    expect(deriveAreaTicketState(row as any)).toBe('CANCELLED')
  })
})

describe('vales por área — resolución del código (§5.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('🔴 un verificador inválido se rechaza SIN TOCAR LA BASE', () => {
    return resolveAreaTicket(VENUE, '9470000019').then(result => {
      expect(result.state).toBe('NOT_FOUND')
      expect(result.ticket).toBeNull()
      // El assert que importa: cero consultas.
      expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    })
  })

  it('un código inexistente responde NOT_FOUND con mensaje legible, nunca un 404 mudo', async () => {
    prismaMock.order.findUnique.mockResolvedValue(null)
    const result = await resolveAreaTicket(VENUE, CODE)
    expect(result.state).toBe('NOT_FOUND')
    expect(result.message).toMatch(/no corresponde a ningún vale/i)
  })

  it('una cuenta viva devuelve sus renglones y el área de cada uno', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ticketRow())
    const result = await resolveAreaTicket(VENUE, CODE)

    expect(result.state).toBe('OPEN')
    expect(result.ticket!.items).toHaveLength(2)
    expect(result.ticket!.items[0]).toMatchObject({ fulfillmentAreaName: 'Cremería', weightQuantity: 0.224 })
    expect(result.ticket!.items[1]).toMatchObject({ fulfillmentAreaId: null })
  })

  it('una cuenta pagada responde ALREADY_PAID con instrucción para el área', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ paymentStatus: 'PAID' }))
    const result = await resolveAreaTicket(VENUE, CODE)
    expect(result.state).toBe('ALREADY_PAID')
    expect(result.message).toMatch(/ya está pagado/i)
  })

  it('🔴 una cuenta ya entregada responde DELIVERED con hora y persona (anti doble canje)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      ticketRow({
        paymentStatus: 'PAID',
        fulfillments: [
          {
            id: 'f-1',
            fulfillmentAreaId: AREA,
            fulfillmentArea: { id: AREA, name: 'Cremería' },
            deliveredAt: new Date('2026-07-28T20:31:00Z'),
            deliveredByStaff: { firstName: 'Rosa', lastName: 'M' },
          },
        ],
      }),
    )
    const result = await resolveAreaTicket(VENUE, CODE)
    expect(result.state).toBe('DELIVERED')
    expect(result.message).toMatch(/ya se entregó/i)
    expect(result.message).toMatch(/Rosa/)
  })
})

describe('vales por área — claim de la caja (§5.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true })
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
    // The venue-scoped Order lock finds the ticket's row in this venue, and the locked read sees the same row as the pre-read.
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-1' }])
    prismaMock.order.findFirstOrThrow.mockImplementation((...args: any[]) => prismaMock.order.findUnique(...args))
    // B2c (P5): agregar al vale lee las filas de descuento de la orden.
    prismaMock.orderDiscount.findMany.mockResolvedValue([])
  })

  it('🔴 el ÁREA no puede agregar renglones mientras la caja tiene la cuenta reclamada', async () => {
    // Sin esto, el área suma jamón mientras la caja cobra y el total se mueve bajo
    // los pies del cajero.
    mockAreaTerminal({ id: 'terminal-area' })
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ claimedByTerminalId: 'terminal-caja', claimedAt: new Date() }))

    await expect(
      addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-jamon', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'AREA_TICKET_CLAIMED_BY_OTHER' })

    expect(prismaMock.orderItem.create).not.toHaveBeenCalled()
  })

  it('la MISMA terminal que tiene el claim SÍ puede agregar (es la caja sumando papas)', async () => {
    mockAreaTerminal({ id: 'terminal-caja', fulfillmentAreaId: null })
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ claimedByTerminalId: 'terminal-caja', claimedAt: new Date() }))
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p-papas', name: 'Papas', price: new Decimal(25), sku: null, category: { name: 'Abarrotes' }, categoryId: 'c-1' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([])
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-new' })
    prismaMock.orderItem.findMany.mockResolvedValue([
      { id: 'oi-new', total: new Decimal(25), discountAmount: new Decimal(0), orderPromotionId: null },
    ])
    prismaMock.order.update.mockResolvedValue({ id: 'order-1' })
    prismaMock.order.findUniqueOrThrow.mockResolvedValue(ticketRow())

    await addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-papas', quantity: 1 }] })

    expect(prismaMock.orderItem.create).toHaveBeenCalledTimes(1)
    // 🔴 La línea de la CAJA va sin área: se entrega al momento.
    expect(prismaMock.orderItem.create.mock.calls[0][0].data.fulfillmentAreaId).toBeNull()
  })

  it('🔴 el área estampa SU área en la línea, tomada de la terminal y NO del payload', async () => {
    mockAreaTerminal()
    prismaMock.order.findUnique.mockResolvedValue(ticketRow())
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p-jamon', name: 'Jamón', price: new Decimal(164), sku: null, category: { name: 'Cremería' }, categoryId: 'c-2' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([])
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-new' })
    prismaMock.orderItem.findMany.mockResolvedValue([
      { id: 'oi-new', total: new Decimal(164), discountAmount: new Decimal(0), orderPromotionId: null },
    ])
    prismaMock.order.update.mockResolvedValue({ id: 'order-1' })
    prismaMock.order.findUniqueOrThrow.mockResolvedValue(ticketRow())

    await addAreaTicketItems(VENUE, CODE, {
      deviceUid: DEVICE,
      staffId: 'staff-1',
      // El cliente MIENTE y manda otra área — se ignora.
      items: [{ productId: 'p-jamon', quantity: 1, fulfillmentAreaId: 'area-de-otro' } as any],
    })

    expect(prismaMock.orderItem.create.mock.calls[0][0].data.fulfillmentAreaId).toBe(AREA)
  })

  it('nadie puede agregar a una cuenta ya pagada', async () => {
    mockAreaTerminal()
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ paymentStatus: 'PAID' }))

    await expect(
      addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-jamon', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'AREA_TICKET_ALREADY_PAID' })
  })

  it('🔴 el claim CADUCADO deja que otra caja se lleve la cuenta', async () => {
    mockAreaTerminal({ id: 'terminal-caja-2', fulfillmentAreaId: null })
    const expired = new Date(Date.now() - AREA_TICKET_CLAIM_TTL_MS - 1000)
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ claimedByTerminalId: 'terminal-caja-1', claimedAt: expired }))
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.order.findUniqueOrThrow.mockResolvedValue(ticketRow({ claimedByTerminalId: 'terminal-caja-2', claimedAt: new Date() }))

    const ticket = await claimAreaTicket(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1' })
    expect(ticket.claimedByTerminalId).toBe('terminal-caja-2')
  })

  it('una segunda caja NO puede robar un claim VIVO de otra', async () => {
    mockAreaTerminal({ id: 'terminal-caja-2', fulfillmentAreaId: null })
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ claimedByTerminalId: 'terminal-caja-1', claimedAt: new Date() }))

    await expect(claimAreaTicket(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1' })).rejects.toMatchObject({
      code: 'AREA_TICKET_CLAIMED_BY_OTHER',
    })
  })

  it('reclamar dos veces desde la MISMA caja renueva el claim (idempotente)', async () => {
    mockAreaTerminal({ id: 'terminal-caja', fulfillmentAreaId: null })
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ claimedByTerminalId: 'terminal-caja', claimedAt: new Date() }))
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.order.findUniqueOrThrow.mockResolvedValue(ticketRow({ claimedByTerminalId: 'terminal-caja', claimedAt: new Date() }))

    const ticket = await claimAreaTicket(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1' })
    expect(ticket.claimedByTerminalId).toBe('terminal-caja')
  })
})

describe('vales por área — entrega (§5.5)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true })
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
    prismaMock.fulfillmentArea.findFirst.mockResolvedValue({ id: AREA, name: 'Cremería' })
  })

  it('🔴 EXIGE que la cuenta esté PAGADA (es todo el punto: evitar el doble canje)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ paymentStatus: 'PENDING' }))

    await expect(fulfillOrderArea(VENUE, 'order-1', { fulfillmentAreaId: AREA, staffId: 'staff-1' })).rejects.toMatchObject({
      code: 'ORDER_NOT_PAID',
    })
    expect(prismaMock.orderFulfillment.create).not.toHaveBeenCalled()
  })

  it('rechaza entregar sobre una cuenta CANCELADA', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ status: 'CANCELLED', paymentStatus: 'PAID' }))

    await expect(fulfillOrderArea(VENUE, 'order-1', { fulfillmentAreaId: AREA, staffId: 'staff-1' })).rejects.toMatchObject({
      code: 'AREA_TICKET_CANCELLED',
    })
  })

  it('entrega los renglones de SU área y sólo esos (la línea de caja no se toca)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ paymentStatus: 'PAID' }))
    prismaMock.orderFulfillment.create.mockResolvedValue({
      id: 'f-1',
      deliveredAt: new Date('2026-07-28T20:31:00Z'),
      deliveredByStaff: { firstName: 'Rosa', lastName: 'M' },
    })

    const result = await fulfillOrderArea(VENUE, 'order-1', { fulfillmentAreaId: AREA, staffId: 'staff-1' })

    expect(result.created).toBe(true)
    expect(result.orderItemIds).toEqual(['oi-jamon']) // NO 'oi-papas' (línea de caja)
    const created = prismaMock.orderFulfillment.create.mock.calls[0][0]
    expect(created.data.lines.create).toEqual([{ orderItemId: 'oi-jamon' }])
  })

  it('🔴 IDEMPOTENTE: el segundo intento devuelve la entrega ORIGINAL con hora y persona, NO un error', async () => {
    // Un error aquí haría que el área dudara y entregara dos veces.
    const original = {
      id: 'f-1',
      fulfillmentAreaId: AREA,
      fulfillmentArea: { id: AREA, name: 'Cremería' },
      deliveredAt: new Date('2026-07-28T20:31:00Z'),
      deliveredByStaff: { firstName: 'Rosa', lastName: 'M' },
    }
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ paymentStatus: 'PAID', fulfillments: [original] }))
    prismaMock.orderFulfillmentLine.findMany.mockResolvedValue([{ orderItemId: 'oi-jamon' }])

    const result = await fulfillOrderArea(VENUE, 'order-1', { fulfillmentAreaId: AREA, staffId: 'staff-1' })

    expect(result.created).toBe(false)
    expect(result.fulfillmentId).toBe('f-1')
    expect(result.message).toMatch(/Ya se entregó/i)
    expect(result.message).toMatch(/Rosa/)
    expect(prismaMock.orderFulfillment.create).not.toHaveBeenCalled()
  })

  it('rechaza cuando la cuenta no tiene renglones de esa área', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      ticketRow({ paymentStatus: 'PAID', items: [{ id: 'oi-papas', fulfillmentAreaId: null, fulfillmentLines: [] }] }),
    )

    await expect(fulfillOrderArea(VENUE, 'order-1', { fulfillmentAreaId: AREA, staffId: 'staff-1' })).rejects.toMatchObject({
      code: 'AREA_TICKET_NO_LINES_FOR_AREA',
    })
  })

  it('rechaza un área que no existe en el local (aislamiento de inquilino)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ paymentStatus: 'PAID' }))
    prismaMock.fulfillmentArea.findFirst.mockResolvedValue(null)

    await expect(fulfillOrderArea(VENUE, 'order-1', { fulfillmentAreaId: 'area-de-otro-venue', staffId: 'staff-1' })).rejects.toThrow(
      /no existe en este local/i,
    )
  })
})

describe('vales por área — partición del dispositivo (§5.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true })
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
    prismaMock.fulfillmentArea.findFirst.mockResolvedValue(null)
  })

  it('asigna la primera partición libre (empieza en 10, no en 0)', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 't-1', partition: null, areaTicketLastCounter: 0, fulfillmentAreaId: null })
    prismaMock.terminal.findMany.mockResolvedValue([])
    prismaMock.terminal.update.mockResolvedValue({ id: 't-1', partition: 10, areaTicketLastCounter: 0, fulfillmentAreaId: null })

    const result = await assignDevicePartition(VENUE, { deviceUid: DEVICE, staffId: 'staff-1' })
    expect(result.partition).toBe(10)
  })

  it('🔴 dos dispositivos NUNCA reciben la misma partición', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 't-2', partition: null, areaTicketLastCounter: 0, fulfillmentAreaId: null })
    prismaMock.terminal.findMany.mockResolvedValue([{ partition: 10 }, { partition: 11 }, { partition: 13 }])
    prismaMock.terminal.update.mockResolvedValue({ id: 't-2', partition: 12, areaTicketLastCounter: 0, fulfillmentAreaId: null })

    const result = await assignDevicePartition(VENUE, { deviceUid: 'other-device', staffId: 'staff-1' })
    // Toma el primer HUECO (12), no "la siguiente": 12 estaba libre.
    expect(result.partition).toBe(12)
    expect(prismaMock.terminal.update.mock.calls[0][0].data.partition).toBe(12)
  })

  it('es idempotente: un dispositivo que ya tiene partición recibe la SUYA', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 't-1', partition: 47, areaTicketLastCounter: 340, fulfillmentAreaId: AREA })

    const result = await assignDevicePartition(VENUE, { deviceUid: DEVICE, staffId: 'staff-1' })
    expect(result.partition).toBe(47)
    expect(result.lastCounter).toBe(340)
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('avisa claramente cuando se agotaron las 90 particiones (no falla en silencio)', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 't-x', partition: null, areaTicketLastCounter: 0, fulfillmentAreaId: null })
    prismaMock.terminal.findMany.mockResolvedValue(Array.from({ length: 90 }, (_, i) => ({ partition: 10 + i })))

    await expect(assignDevicePartition(VENUE, { deviceUid: DEVICE, staffId: 'staff-1' })).rejects.toMatchObject({
      code: 'AREA_PARTITIONS_EXHAUSTED',
    })
  })
})

describe('vales por área — apertura de la cuenta (§5.1, §5.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true })
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
    prismaMock.discount.findMany.mockResolvedValue([])
    prismaMock.modifier.findMany.mockResolvedValue([])
  })

  it('🔴 un contador que RETROCEDE se rechaza con AREA_CODE_REPLAY', async () => {
    // Un restore de iOS puede revivir un UserDefaults viejo y hacer que el aparato
    // reacuñe códigos ya usados: dos clientes distintos con el mismo papel.
    mockAreaTerminal({ areaTicketLastCounter: 500 })
    prismaMock.order.findUnique.mockResolvedValue(null)

    await expect(
      openAreaTicket(VENUE, { code: CODE, deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-jamon', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'AREA_CODE_REPLAY' })

    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('🔴 un código de OTRA partición se rechaza (no se acuñan códigos ajenos)', async () => {
    mockAreaTerminal({ partition: 11 })

    await expect(
      openAreaTicket(VENUE, { code: CODE, deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-jamon', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'AREA_CODE_WRONG_PARTITION' })
  })

  it('un verificador inválido se rechaza SIN TOCAR LA BASE', async () => {
    await expect(
      openAreaTicket(VENUE, { code: '9470000019', deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p', quantity: 1 }] }),
    ).rejects.toThrow(/no es válido/i)

    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('reabrir con el MISMO código devuelve la cuenta existente (idempotente, no duplica)', async () => {
    mockAreaTerminal()
    prismaMock.order.findUnique.mockResolvedValue(ticketRow())

    const ticket = await openAreaTicket(VENUE, {
      code: CODE,
      deviceUid: DEVICE,
      staffId: 'staff-1',
      items: [{ productId: 'p-jamon', quantity: 1 }],
    })

    expect(ticket.orderId).toBe('order-1')
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('sube el máximo contador visto DENTRO de la misma transacción que crea la cuenta', async () => {
    mockAreaTerminal()
    prismaMock.order.findUnique.mockResolvedValue(null)
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'p-jamon',
        name: 'Jamón serrano',
        price: new Decimal(164),
        sku: null,
        category: { name: 'Cremería' },
        categoryId: 'c-2',
        soldByWeight: true,
      },
    ])
    prismaMock.order.create.mockResolvedValue(ticketRow())
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })

    await openAreaTicket(VENUE, {
      code: CODE,
      deviceUid: DEVICE,
      staffId: 'staff-1',
      items: [{ productId: 'p-jamon', quantity: 1, weightQuantity: 0.224 }],
    })

    // El contador sólo puede SUBIR: `lt` en el where evita bajarlo ante una carrera.
    expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ areaTicketLastCounter: { lt: 12 } }),
        data: { areaTicketLastCounter: 12 },
      }),
    )
    // IVA por producto (plan 2): el vale nace con precios que ya traen el IVA incluido.
    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contratoDePrecio: 'IVA_INCLUIDO' }) }),
    )
  })

  it('🔴 los importes por peso cuadran al centavo con el sistema del cliente (§4.3)', async () => {
    // El día de la migración los totales tienen que coincidir con su ticket real:
    // 0.224 × 164.00 = 36.736 → 36.74
    mockAreaTerminal()
    prismaMock.order.findUnique.mockResolvedValue(null)
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'p-jamon',
        name: 'Jamón serrano',
        price: new Decimal(164),
        sku: null,
        category: { name: 'Cremería' },
        categoryId: 'c-2',
        soldByWeight: true,
      },
      {
        id: 'p-queso',
        name: 'Queso',
        price: new Decimal(233.5),
        sku: null,
        category: { name: 'Cremería' },
        categoryId: 'c-2',
        soldByWeight: true,
      },
    ])
    prismaMock.order.create.mockResolvedValue(ticketRow())
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })

    await openAreaTicket(VENUE, {
      code: CODE,
      deviceUid: DEVICE,
      staffId: 'staff-1',
      items: [
        { productId: 'p-jamon', quantity: 1, weightQuantity: 0.224 },
        { productId: 'p-queso', quantity: 1, weightQuantity: 0.306 },
      ],
    })

    const lines = prismaMock.order.create.mock.calls[0][0].data.items.create
    expect(Number(lines[0].total)).toBe(36.74) // 0.224 × 164.00
    expect(Number(lines[1].total)).toBe(71.45) // 0.306 × 233.50
    // Y las dos líneas llevan el área de la terminal, no la del payload.
    expect(lines.every((l: any) => l.fulfillmentAreaId === AREA)).toBe(true)
  })
})

describe('vales por área — pendientes de entrega (§5.5)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('devuelve lista vacía para una terminal de CAJA (no guarda nada, entrega al momento)', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ fulfillmentAreaId: null })

    const result = await listPendingFulfillment(VENUE, { deviceUid: DEVICE })
    expect(result).toEqual({ fulfillmentAreaId: null, tickets: [] })
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })

  it('pide sólo cuentas PAGADAS, con renglones del área y SIN entrega registrada', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ fulfillmentAreaId: AREA })
    prismaMock.order.findMany.mockResolvedValue([])
    prismaMock.fulfillmentArea.findFirst.mockResolvedValue({ name: 'Cremería' })

    await listPendingFulfillment(VENUE, { deviceUid: DEVICE })

    const where = prismaMock.order.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      venueId: VENUE,
      paymentStatus: 'PAID',
      items: { some: { fulfillmentAreaId: AREA } },
      fulfillments: { none: { fulfillmentAreaId: AREA } },
    })
    expect(where.status).toEqual({ notIn: ['CANCELLED', 'DELETED'] })
  })
})

/**
 * Plan 3b — adding lines to an EXISTING ticket. The first CAS already takes the Order row lock, but a claim, a partial
 * payment, a tip, a service charge or a cancellation does not bump `version`: the decision and the totals must come
 * from a read taken with the row locked. The tx double and the global client are DIFFERENT objects, so any escape to
 * the global client fails here instead of hiding behind a shared double.
 */
describe('area tickets — addAreaTicketItems decides on the locked Order (Plan 3b)', () => {
  let tx: any
  let committed: boolean
  const locked = (overrides: Record<string, any> = {}) => ({
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    claimedAt: null,
    claimedByTerminalId: null,
    tipAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    paidAmount: new Decimal(0),
    ...overrides,
  })
  const add = (items: any[] = [{ productId: 'p-jamon', quantity: 1 }]) =>
    addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items })
  const txModelCalls = () =>
    [...Object.values(tx.order), ...Object.values(tx.orderItem)].flatMap((fn: any) => fn.mock.invocationCallOrder as number[])

  beforeEach(() => {
    committed = false
    const model = (...names: string[]) => Object.fromEntries(names.map(name => [name, jest.fn()]))
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
      order: model('findFirstOrThrow', 'findUniqueOrThrow', 'updateMany', 'update'),
      orderItem: model('create', 'findMany'),
      orderDiscount: model('findMany'),
    }
    // The locked read (the photo that decides) and the response read are different calls.
    tx.order.findFirstOrThrow.mockResolvedValue(locked())
    tx.order.findUniqueOrThrow.mockResolvedValue(ticketRow())
    tx.order.updateMany.mockResolvedValue({ count: 1 })
    tx.order.update.mockResolvedValue({ id: 'order-1' })
    tx.orderItem.create.mockResolvedValue({ id: 'oi-new' })
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'oi-1', total: new Decimal(100), discountAmount: new Decimal(0), orderPromotionId: null },
      { id: 'oi-new', total: new Decimal(50), discountAmount: new Decimal(0), orderPromotionId: null },
    ])
    // B2c (P5): the totals also read the Order's discount rows (none here).
    tx.orderDiscount.findMany.mockResolvedValue([])
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      const result = await callback(tx)
      committed = true
      return result
    })
    mockAreaTerminal()
    // The pre-read (fast rejection and error precedence) stays on the global client.
    prismaMock.order.findUnique.mockResolvedValue(ticketRow())
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true })
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p-jamon', name: 'Jamón', price: new Decimal(164), sku: null, category: { name: 'Cremería' }, categoryId: 'c-2' },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([])
    // Every Order or line access of the operation on the GLOBAL client is an escape from the lock.
    for (const op of ['findFirstOrThrow', 'findUniqueOrThrow', 'updateMany', 'update']) {
      prismaMock.order[op].mockRejectedValue(new Error(`GLOBAL order.${op}`))
    }
    for (const op of ['create', 'findMany']) prismaMock.orderItem[op].mockRejectedValue(new Error(`GLOBAL orderItem.${op}`))
  })

  it('locks the route-venue Order before any tx access and totals with the tip, charge and paid read under the lock', async () => {
    // A partial payment with its tip and a service charge landed after the pre-read, without a version bump.
    tx.order.findFirstOrThrow.mockResolvedValue(
      locked({ paymentStatus: 'PARTIAL', tipAmount: new Decimal(10), serviceChargeAmount: new Decimal(20), paidAmount: new Decimal(50) }),
    )

    await add()

    expect(committed).toBe(true)
    // Tagged template: [strings, ...values] — the ticket's Order, scoped to the ROUTE venue.
    expect(tx.$queryRaw.mock.calls.map((call: any[]) => call.slice(1))).toEqual([['order-1', VENUE]])
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...txModelCalls()))
    expect(tx.order.findFirstOrThrow.mock.calls[0][0].where).toEqual({ id: 'order-1', venueId: VENUE })
    const { where, data } = tx.order.update.mock.calls[0][0]
    expect(where).toEqual({ id: 'order-1' })
    // 150 of lines − 0 of line discounts + 20 of charge + 10 of tip; remaining = 180 − 50 paid. The stale photo gave 150 / 150.
    expect(Number(data.total)).toBe(180)
    expect(Number(data.remainingBalance)).toBe(130)
  })

  it.each([
    [
      'a live claim by another terminal',
      { claimedByTerminalId: 'terminal-caja', claimedAt: new Date() },
      'AREA_TICKET_CLAIMED_BY_OTHER',
      'La caja está cobrando esta cuenta. Espera a que termine.',
    ],
    ['a cancellation', { status: 'CANCELLED' }, 'AREA_TICKET_CANCELLED', 'Esta cuenta fue cancelada.'],
  ])('%s seen only by the locked read is rejected and no line or total is written', async (_case, change, code, message) => {
    tx.order.findFirstOrThrow.mockResolvedValue(locked(change))

    await expect(add()).rejects.toMatchObject({ code, message, statusCode: 409 })

    expect(committed).toBe(false)
    expect(tx.orderItem.create).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })

  it('an Order the lock cannot see (gone, or no longer this venue) is not found and nothing is written', async () => {
    tx.$queryRaw.mockResolvedValue([])

    await expect(add()).rejects.toMatchObject({
      statusCode: 404,
      message: 'Ese código no corresponde a ningún vale de este local. Verifica los 10 dígitos.',
    })

    expect(committed).toBe(false)
    expect(tx.order.updateMany).not.toHaveBeenCalled()
    expect(tx.orderItem.create).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })

  it('the CAS still compares the version THIS request saw: a bump while it waited is VERSION_CONFLICT', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 })

    await expect(add()).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 })

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', venueId: VENUE, version: 1, paymentStatus: { in: ['PENDING', 'PARTIAL'] } },
      data: { version: { increment: 1 } },
    })
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })

  it('a PAID without a version bump still answers VERSION_CONFLICT (the CAS runs before the state checks)', async () => {
    tx.order.findFirstOrThrow.mockResolvedValue(locked({ paymentStatus: 'PAID' }))
    tx.order.updateMany.mockResolvedValue({ count: 0 })

    await expect(add()).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })

  it('still writes each line with its nested modifiers on the tx', async () => {
    prismaMock.modifier.findMany.mockResolvedValue([{ id: 'mod-1', name: 'Rebanado fino', price: new Decimal(5) }])

    await add([{ productId: 'p-jamon', quantity: 1, modifierIds: ['mod-1'] }])

    expect(tx.orderItem.create).toHaveBeenCalledTimes(1)
    expect(tx.orderItem.create.mock.calls[0][0].data).toMatchObject({
      orderId: 'order-1',
      fulfillmentAreaId: AREA,
      modifiers: { create: [{ modifierId: 'mod-1', name: 'Rebanado fino', quantity: 1 }] },
    })
  })
})

describe('vales por área — los descuentos sobreviven (B2c, P5)', () => {
  const papas = { id: 'p-papas', name: 'Papas', price: new Decimal(50), sku: null, category: { name: 'Abarrotes' }, categoryId: 'c-1' }
  const d10 = {
    id: 'd10',
    venueId: VENUE,
    name: '10 %',
    type: 'PERCENTAGE',
    value: new Decimal(10),
    scope: 'ITEM',
    active: true,
    validFrom: null,
    validUntil: null,
    maxTotalUses: null,
    currentUses: 0,
    compReason: null,
  }
  const renglon = (id: string, total: number, discountAmount = 0) => ({
    id,
    total: new Decimal(total),
    discountAmount: new Decimal(discountAmount),
    orderPromotionId: null,
    taxAmount: new Decimal(0),
  })
  const escrito = () => (prismaMock.order.update as jest.Mock).mock.calls.at(-1)[0].data

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true })
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-1' }])
    prismaMock.order.findFirstOrThrow.mockImplementation((...args: any[]) => prismaMock.order.findUnique(...args))
    prismaMock.orderDiscount.findMany.mockResolvedValue([])
    mockAreaTerminal({ id: 'terminal-caja', fulfillmentAreaId: null })
    prismaMock.order.findUnique.mockResolvedValue(ticketRow({ claimedByTerminalId: 'terminal-caja', claimedAt: new Date() }))
    prismaMock.product.findMany.mockResolvedValue([papas])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([])
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-new', appliedDiscountId: null, discountAmount: new Decimal(0) })
    prismaMock.order.update.mockResolvedValue({ id: 'order-1' })
    prismaMock.order.findUniqueOrThrow.mockResolvedValue(ticketRow())
  })

  it('🔴 antes/después: agregar al vale conserva el descuento de cuenta (10 % de $150 = $15); antes se borraba y cobraba $150', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([renglon('oi-jamon', 100), renglon('oi-new', 50)])
    prismaMock.orderDiscount.findMany.mockResolvedValue([
      {
        id: 'od-cta',
        type: 'PERCENTAGE',
        value: new Decimal(10),
        amount: new Decimal(10),
        appliedToItemIds: [],
        createdAt: new Date(0),
        taxReduction: new Decimal(0),
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { 'oi-jamon': 1000 } },
      },
    ])
    await addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-papas', quantity: 1 }] })
    expect(Number(escrito().discountAmount)).toBe(15)
    expect(Number(escrito().total)).toBe(135)
    expect(prismaMock.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od-cta' },
      data: {
        amount: 15,
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, renglones: { 'oi-jamon': 1000, 'oi-new': 500 } },
      },
    })
  })

  it('🔴 antes/después: una cortesía del móvil (importe 0) ya no se descuenta dos veces; antes la cuenta quedaba en −$50', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([renglon('oi-cort', 0, 100), renglon('oi-new', 50)])
    await addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-papas', quantity: 1 }] })
    expect(Number(escrito().discountAmount)).toBe(0)
    expect(Number(escrito().total)).toBe(50)
  })

  it('🔴 Codex r2 N4: un descuento FIJO de cuenta mayor que lo que queda deja el total en $0, nunca negativo (v1 de este plan: −$20)', async () => {
    // A ($100) ya regalado desde el móvil (importe 0), B ($50) y C nuevo ($10); un descuento fijo de cuenta de $80.
    prismaMock.orderItem.findMany.mockResolvedValue([renglon('oi-a', 0, 100), renglon('oi-b', 50), renglon('oi-new', 10)])
    prismaMock.orderDiscount.findMany.mockResolvedValue([
      {
        id: 'od-80',
        type: 'FIXED_AMOUNT',
        value: new Decimal(80),
        amount: new Decimal(80),
        appliedToItemIds: [],
        createdAt: new Date(0),
        taxReduction: new Decimal(0),
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { 'oi-b': 5000 } },
      },
    ])
    await addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-papas', quantity: 1 }] })
    expect(Number(escrito().discountAmount)).toBe(80)
    expect(Number(escrito().total)).toBe(0)
    expect(Number(escrito().remainingBalance)).toBe(0)
  })

  it('control — N4: el descuento excedente se come la mercancía, nunca el cargo por servicio ni la propina', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      ticketRow({
        claimedByTerminalId: 'terminal-caja',
        claimedAt: new Date(),
        serviceChargeAmount: new Decimal(10),
        tipAmount: new Decimal(5),
      }),
    )
    prismaMock.orderItem.findMany.mockResolvedValue([renglon('oi-b', 50), renglon('oi-new', 10)])
    prismaMock.orderDiscount.findMany.mockResolvedValue([
      {
        id: 'od-80',
        type: 'FIXED_AMOUNT',
        value: new Decimal(80),
        amount: new Decimal(80),
        appliedToItemIds: [],
        createdAt: new Date(0),
        taxReduction: new Decimal(0),
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { 'oi-b': 5000 } },
      },
    ])
    await addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-papas', quantity: 1 }] })
    expect(Number(escrito().total)).toBe(15)
  })

  it('control — Codex r3 V7: una promoción regalada desde la terminal sigue descontada al agregar (café $100 + combo cortesiado $80 + $10 ⇒ $110; la v3 de este plan, $190)', async () => {
    // La línea del combo cortesiada conserva su total (80), su descuento (80), `isCortesia` y su `orderPromotionId`; su fila
    // espejo COMP vive aparte. Hoy la suma de descuentos de renglón ya la contaba.
    prismaMock.orderItem.findMany.mockResolvedValue([
      renglon('oi-cafe', 100),
      { ...renglon('oi-promo', 80, 80), isCortesia: true, orderPromotionId: 'op-1' },
      renglon('oi-new', 10),
    ])
    prismaMock.orderDiscount.findMany.mockResolvedValue([
      {
        id: 'od-comp',
        type: 'COMP',
        isComp: true,
        value: new Decimal(100),
        amount: new Decimal(80),
        appliedToItemIds: ['oi-promo'],
        createdAt: new Date(0),
        taxReduction: new Decimal(0),
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-promo': 8000 } },
      },
    ])
    await addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-papas', quantity: 1 }] })
    expect(Number(escrito().discountAmount)).toBe(80)
    expect(Number(escrito().total)).toBe(110)
  })

  it('🔴 antes/después: una línea de promoción NORMAL no se descuenta dos veces (su precio ya es neto): $200; hoy restaba otra vez sus $60 ($140)', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      renglon('oi-cafe', 100),
      { ...renglon('oi-pa', 60, 40), orderPromotionId: 'op-1' },
      { ...renglon('oi-pb', 30, 20), orderPromotionId: 'op-1' },
      renglon('oi-new', 10),
    ])
    await addAreaTicketItems(VENUE, CODE, { deviceUid: DEVICE, staffId: 'staff-1', items: [{ productId: 'p-papas', quantity: 1 }] })
    expect(Number(escrito().discountAmount)).toBe(0)
    expect(Number(escrito().total)).toBe(200)
  })

  it('el renglón nuevo con descuento de artículo trae su fila ESPEJO', async () => {
    prismaMock.discount.findMany.mockResolvedValue([d10])
    prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-new', appliedDiscountId: 'd10', discountAmount: new Decimal(5) })
    prismaMock.orderItem.findMany.mockResolvedValue([renglon('oi-new', 50, 5)])
    await addAreaTicketItems(VENUE, CODE, {
      deviceUid: DEVICE,
      staffId: 'staff-1',
      items: [{ productId: 'p-papas', quantity: 1, discountId: 'd10' }],
    })
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        discountId: 'd10',
        appliedToItemIds: ['oi-new'],
        appliedById: 'sv-1',
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-new': 500 } },
      }),
    })
    expect(Number(escrito().discountAmount)).toBe(5)
  })

  it('abrir un vale con descuento de artículo crea su fila ESPEJO', async () => {
    mockAreaTerminal()
    prismaMock.order.findUnique.mockResolvedValue(null)
    prismaMock.discount.findMany.mockResolvedValue([d10])
    prismaMock.order.create.mockResolvedValue(
      ticketRow({
        items: [{ ...ticketRow().items[1], id: 'oi-1', appliedDiscountId: 'd10', discountAmount: new Decimal(5), total: new Decimal(50) }],
      }),
    )
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
    await openAreaTicket(VENUE, {
      code: CODE,
      deviceUid: DEVICE,
      staffId: 'staff-1',
      items: [{ productId: 'p-papas', quantity: 1, discountId: 'd10' }],
    })
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        discountId: 'd10',
        appliedToItemIds: ['oi-1'],
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-1': 500 } },
      }),
    })
  })
})
