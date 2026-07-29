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
    prismaMock.orderItem.findMany.mockResolvedValue([{ total: new Decimal(25), discountAmount: new Decimal(0) }])
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
    prismaMock.orderItem.findMany.mockResolvedValue([{ total: new Decimal(164), discountAmount: new Decimal(0) }])
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
