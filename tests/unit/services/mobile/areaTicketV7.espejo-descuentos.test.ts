import { AreaTicketCheckoutStatus, AreaTicketStatus, FulfillmentMode, Prisma } from '@prisma/client'

import { canonicalSnapshotHash, materializeAreaTicketCheckout } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

/**
 * Tarjeta hz:nube0000:na24531d (17-nov-2026): al cobrar vales V7 la venta nace con el descuento en cada renglón pero SIN su fila
 * `OrderDiscount`, así que no sale en «Descuentos» del DASHBOARD ni en las estadísticas (el servicio viejo de vales sí la crea con
 * `crearEspejosDelVale`). Ahora cada renglón con descuento (del vale o suelto de la caja) gana su fila ESPEJO en la misma
 * transacción que la venta: quien la dio es quien emitió el vale (o la caja), el suelto lleva su motivo, y Σ filas = cabecera.
 *
 * Fase 1 (v5.1, 18-nov): filas agrupadas (vale: descuento, área y emisor; suelto: descuento, motivo y aprobador), todas con la marca
 * `deValeV7` (no se quitan desde la caja) y los usos del descuento exactamente como antes: el cobro de vales no toca `currentUses`.
 */
const MARCA = { espejo: true, deValeV7: true }
const VENUE = 'venue-espejo'
const CAJA = 'checkout-device'

const d10 = {
  id: 'd10',
  venueId: VENUE,
  name: '10 %',
  type: 'PERCENTAGE',
  value: new Prisma.Decimal(10),
  scope: 'ITEM',
  active: true,
  validFrom: null,
  validUntil: null,
  maxTotalUses: null,
  currentUses: 0,
  compReason: null,
  requiresApproval: false,
}
const dGerente = { ...d10, id: 'd-gerente', name: 'Gerente 20 %', value: new Prisma.Decimal(20), requiresApproval: true }

type Linea = { id: string; producto: string; precio: number; descuento: number; descuentoId: string | null }

function vale(id: string, emisor: string | null, lineas: Linea[], area = 'area-cremeria') {
  const now = new Date()
  const lines = lineas.map((l, i) => ({
    id: l.id,
    clientLineId: `c-${l.id}`,
    productId: `p-${l.producto}`,
    productNameSnapshot: l.producto,
    skuSnapshot: null,
    categoryNameSnapshot: null,
    modifiersSnapshot: [],
    quantity: new Prisma.Decimal(1),
    weightKg: null,
    unitPrice: new Prisma.Decimal(l.precio),
    discountAmount: new Prisma.Decimal(l.descuento),
    appliedDiscountId: l.descuentoId,
    taxAmount: new Prisma.Decimal(0),
    total: new Prisma.Decimal(l.precio),
    notes: null,
    createdAt: new Date(now.getTime() + i),
  }))
  const subtotal = lineas.reduce((s, l) => s + l.precio, 0)
  const descuento = lineas.reduce((s, l) => s + l.descuento, 0)
  return {
    id,
    code: `9${id.padStart(9, '0').slice(-9)}`,
    status: AreaTicketStatus.CLAIMED,
    fulfillmentAreaId: area,
    fulfillmentModeSnapshot: FulfillmentMode.HOLD_UNTIL_PAID,
    fulfillmentArea: { id: area, name: area, fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID },
    sourceTerminalId: 'terminal-area',
    sourceTerminal: { id: 'terminal-area', name: 'Cremería' },
    issuedByStaffId: emisor,
    currency: 'MXN',
    subtotal: new Prisma.Decimal(subtotal),
    discountAmount: new Prisma.Decimal(descuento),
    taxAmount: new Prisma.Decimal(0),
    total: new Prisma.Decimal(subtotal - descuento),
    pricingSnapshotHash: canonicalSnapshotHash('MXN', lines as any),
    printStatus: 'NOT_PRINTED',
    version: 1,
    issuedAt: now,
    printedAt: null,
    claimedAt: now,
    claimExpiresAt: new Date(now.getTime() + 60_000),
    paidAt: null,
    expiresAt: null,
    orderId: null,
    checkoutSessionId: 'checkout-session',
    lines,
    fulfillment: null,
    externalSettlement: null,
  }
}

let ordenCreada: any

function prepararCobro(tickets: any[], sesion: Partial<Record<string, unknown>> = {}) {
  const now = new Date()
  const session = {
    id: 'checkout-session',
    status: AreaTicketCheckoutStatus.OPEN,
    terminalId: 'terminal-checkout',
    terminal: { id: 'terminal-checkout', name: 'Caja' },
    staffId: null,
    orderId: null,
    order: null,
    materializeIdempotencyKey: null,
    activePaymentAttemptId: null,
    version: 1,
    lastHeartbeatAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    tickets,
    paymentAttempts: [],
    ...sesion,
  }
  prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue(session)
  prismaMock.terminal.findFirst.mockResolvedValue({
    id: 'terminal-checkout',
    name: 'Caja',
    fulfillmentAreaId: null,
    fulfillmentArea: null,
    canIssueAreaTickets: false,
    canCheckoutAreaTickets: true,
    canDeliverAreaTickets: false,
    defaultWorkspace: 'AREA_OPERATIONS',
    scaleProfile: null,
  })
  prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ allowMixedCart: true })
  // La membresía de cada persona: el área que emitió (staff-area / staff-area-2) y la caja (staff-caja).
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
    where?.staffId ? { id: `sv-${where.staffId}`, staffId: where.staffId, venueId: VENUE, active: true } : null,
  )
  prismaMock.staffVenue.findMany.mockImplementation(async ({ where }: any) =>
    (where?.staffId?.in ?? []).map((staffId: string) => ({ id: `sv-${staffId}`, staffId })),
  )
  prismaMock.discount.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.discount.findMany.mockImplementation(async ({ where }: any) =>
    [d10, dGerente].filter(d => (where?.id?.in ?? []).includes(d.id)),
  )
  prismaMock.product.findMany.mockResolvedValue([
    { id: 'p-papas', name: 'Papas', price: new Prisma.Decimal(50), sku: null, category: { name: 'Abarrotes' }, categoryId: 'c-1' },
  ])
  prismaMock.modifier.findMany.mockResolvedValue([])
  ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
  let n = 0
  prismaMock.order.create.mockImplementation(async ({ data }: any) => {
    ordenCreada = { id: 'order-v7', ...data }
    return ordenCreada
  })
  prismaMock.orderItem.create.mockImplementation(async ({ data }: any) => ({
    id: data.id ?? `oi-${data.areaTicketLineId ?? `suelto-${++n}`}`,
    appliedDiscountId: data.appliedDiscountId ?? null,
    discountAmount: new Prisma.Decimal(data.discountAmount ?? 0),
    total: new Prisma.Decimal(data.total ?? 0),
  }))
  prismaMock.areaTicket.updateMany.mockResolvedValue({ count: tickets.length })
  prismaMock.areaTicketCheckoutSession.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.areaTicketCheckoutSession.findUniqueOrThrow.mockImplementation(async () => ({
    ...session,
    status: AreaTicketCheckoutStatus.MATERIALIZED,
    orderId: ordenCreada?.id ?? session.orderId,
    order: ordenCreada ?? session.order,
  }))
  prismaMock.orderDiscount.create.mockImplementation(async ({ data }: any) => ({ id: `od-${data.appliedToItemIds?.[0]}`, ...data }))
  return session
}

const filasCreadas = () => (prismaMock.orderDiscount.create as jest.Mock).mock.calls.map(c => c[0].data)
const suma = (filas: any[]) => filas.reduce((s, f) => s + Number(f.amount), 0)
const cobrar = (extra: Record<string, unknown> = {}) =>
  materializeAreaTicketCheckout(VENUE, 'checkout-session', {
    idempotencyKey: 'k1',
    deviceUid: CAJA,
    staffId: 'staff-caja',
    ...extra,
  } as any)

describe('Vales V7: cada descuento del cobro deja su fila espejo marcada (na24531d, fase 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ordenCreada = undefined
    // hz:0555ee15:D5: armar la venta revisa la existencia de lo no apartado (lee los renglones y los apartados de la sesión); aquí no hay nada.
    prismaMock.orderItem.findMany.mockResolvedValue([])
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([])
  })

  it('🔴 un renglón del vale con 10 % ⇒ su fila espejo MARCADA, a nombre de quien emitió el vale', async () => {
    prepararCobro([
      vale('t1', 'staff-area', [
        { id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 10, descuentoId: 'd10' },
        { id: 'line-queso', producto: 'Queso', precio: 40, descuento: 0, descuentoId: null },
      ]),
    ])

    await cobrar()

    expect(filasCreadas()).toEqual([
      expect.objectContaining({
        orderId: 'order-v7',
        discountId: 'd10',
        type: 'PERCENTAGE',
        name: '10 %',
        amount: new Prisma.Decimal(10),
        appliedToItemIds: ['oi-line-jamon'],
        appliedById: 'sv-staff-area',
        isComp: false,
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, ...MARCA, renglones: { 'oi-line-jamon': 1000 } },
      }),
    ])
    // La fila no trae motivo (el vale no lo congela): queda «Sin motivo».
    expect(filasCreadas()[0].reason).toBeUndefined()
    // Σ filas = el descuento de la venta: nada se cuenta dos veces ni falta.
    expect(Number(ordenCreada.discountAmount)).toBe(10)
  })

  it('🔴 el producto suelto de la caja con descuento y motivo ⇒ su fila espejo marcada con el motivo, a nombre de la caja', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 10, descuentoId: 'd10' }])])

    await cobrar({
      performedBy: 'staff-caja',
      normalItems: [
        {
          productId: 'p-papas',
          quantity: 1,
          discountId: 'd10',
          discountReason: 'Cliente frecuente',
          discountReasonComment: 'viene diario',
        },
      ],
    })

    const filas = filasCreadas()
    expect(filas).toHaveLength(2)
    expect(filas.find(f => f.appliedById === 'sv-staff-caja')).toEqual(
      expect.objectContaining({
        discountId: 'd10',
        amount: new Prisma.Decimal(5),
        reason: 'Cliente frecuente',
        reasonComment: 'viene diario',
        reparto: expect.objectContaining(MARCA),
      }),
    )
    expect(filas.find(f => f.appliedById === 'sv-staff-area')).toEqual(expect.objectContaining({ amount: new Prisma.Decimal(10) }))
    expect(suma(filas)).toBe(Number(ordenCreada.discountAmount))
    expect(suma(filas)).toBe(15)
  })

  it('🔴 un descuento con «Requiere aprobación» en el vale: lo dio el emisor; quién lo aprobó no se inventa (el vale no lo congeló)', async () => {
    prepararCobro([
      vale('t1', 'staff-area', [{ id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 20, descuentoId: 'd-gerente' }]),
    ])

    await cobrar()

    expect(filasCreadas()).toEqual([expect.objectContaining({ discountId: 'd-gerente', appliedById: 'sv-staff-area' })])
    expect(filasCreadas()[0].authorizedById).toBeUndefined()
  })

  it('🔴 Codex r1 #3: el dueño cambió el % entre emitir y cobrar ⇒ la fila dice el monto congelado como importe fijo, no «20 %» con $10', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 10, descuentoId: 'd10' }])])
    prismaMock.discount.findMany.mockImplementation(async ({ where }: any) =>
      [{ ...d10, value: new Prisma.Decimal(20) }].filter(d => (where?.id?.in ?? []).includes(d.id)),
    )

    await cobrar()

    expect(filasCreadas()).toEqual([
      expect.objectContaining({
        discountId: 'd10',
        name: '10 %',
        type: 'FIXED_AMOUNT',
        value: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(10),
      }),
    ])
  })

  it('🔴 Codex r2 #5: un importe fijo de respaldo que no cabe en `value` (≥ $1,000,000) se describe con el catálogo, nunca truena', async () => {
    prepararCobro([
      vale('t1', 'staff-area', [{ id: 'line-lote', producto: 'Lote', precio: 2_000_000, descuento: 1_000_000, descuentoId: 'd10' }]),
    ])
    prismaMock.discount.findMany.mockImplementation(async ({ where }: any) =>
      [{ ...d10, value: new Prisma.Decimal(20) }].filter(d => (where?.id?.in ?? []).includes(d.id)),
    )

    await cobrar()

    expect(filasCreadas()).toEqual([
      expect.objectContaining({ type: 'PERCENTAGE', value: new Prisma.Decimal(20), amount: new Prisma.Decimal(1_000_000) }),
    ])
  })

  // Rama defensiva (Codex r7 #4): hoy un descuento borrado entre emitir y armar ya truena antes, en la llave foránea del renglón (deuda
  // r1 #4); si el catálogo no lo devuelve por cualquier otra razón, la fila no se cae: va sin liga por lo congelado.
  it('rama defensiva: si el catálogo no devuelve el descuento, la fila marcada va sin liga, como importe fijo por lo congelado', async () => {
    prepararCobro([
      vale('t1', 'staff-area', [{ id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 10, descuentoId: 'd-borrado' }]),
    ])

    await cobrar()

    expect(filasCreadas()).toEqual([
      expect.objectContaining({
        discountId: null,
        type: 'FIXED_AMOUNT',
        amount: new Prisma.Decimal(10),
        reparto: expect.objectContaining(MARCA),
      }),
    ])
  })

  it('🔴 Codex r1 #8: una rebaja que redondeó a $0.00 no deja fila', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-chicle', producto: 'Chicle', precio: 1, descuento: 0, descuentoId: 'd10' }])])

    await cobrar()

    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('🔴 Codex r2 #2: varios renglones del mismo descuento, área y emisor ⇒ UNA fila dirigida a todos (no una por renglón)', async () => {
    prepararCobro([
      vale('t1', 'staff-area', [
        { id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 10, descuentoId: 'd10' },
        { id: 'line-queso', producto: 'Queso', precio: 40, descuento: 4, descuentoId: 'd10' },
        { id: 'line-jamon2', producto: 'Jamón', precio: 100, descuento: 20, descuentoId: 'd-gerente' },
      ]),
    ])

    await cobrar()

    const filas = filasCreadas()
    expect(filas).toHaveLength(2)
    expect(filas.find(f => f.discountId === 'd10')).toEqual(
      expect.objectContaining({
        type: 'PERCENTAGE',
        amount: new Prisma.Decimal(14),
        appliedToItemIds: ['oi-line-jamon', 'oi-line-queso'],
        appliedById: 'sv-staff-area',
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, ...MARCA, renglones: { 'oi-line-jamon': 1000, 'oi-line-queso': 400 } },
      }),
    )
    expect(filas.find(f => f.discountId === 'd-gerente')).toEqual(
      expect.objectContaining({ amount: new Prisma.Decimal(20), appliedToItemIds: ['oi-line-jamon2'] }),
    )
    expect(suma(filas)).toBe(Number(ordenCreada.discountAmount))
  })

  it('🔴 Codex r3 #5: la llave es (descuento, área, emisor): dos áreas ⇒ dos filas; la misma área con dos emisores ⇒ dos filas', async () => {
    prepararCobro([
      vale('t1', 'staff-area', [{ id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 10, descuentoId: 'd10' }], 'area-cremeria'),
      vale('t2', 'staff-area', [{ id: 'line-pan', producto: 'Pan', precio: 30, descuento: 3, descuentoId: 'd10' }], 'area-panaderia'),
      vale('t3', 'staff-area-2', [{ id: 'line-queso', producto: 'Queso', precio: 40, descuento: 4, descuentoId: 'd10' }], 'area-cremeria'),
    ])

    await cobrar()

    const filas = filasCreadas()
    expect(filas).toHaveLength(3)
    const porRenglones = Object.fromEntries(filas.map(f => [f.appliedToItemIds.join(','), f.appliedById]))
    expect(porRenglones).toEqual({ 'oi-line-jamon': 'sv-staff-area', 'oi-line-pan': 'sv-staff-area', 'oi-line-queso': 'sv-staff-area-2' })
    expect(suma(filas)).toBe(Number(ordenCreada.discountAmount))
  })

  it('🔴 Codex r3 #3: tres sueltos con el mismo descuento y sin motivo ⇒ UNA fila; motivos distintos ⇒ una fila por motivo', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-queso', producto: 'Queso', precio: 40, descuento: 0, descuentoId: null }])])

    await cobrar({
      normalItems: [
        { productId: 'p-papas', quantity: 1, discountId: 'd10' },
        { productId: 'p-papas', quantity: 1, discountId: 'd10' },
        { productId: 'p-papas', quantity: 1, discountId: 'd10', discountReason: 'Queja' },
        { productId: 'p-papas', quantity: 1, discountId: 'd10', discountReason: 'Queja', discountReasonComment: 'frío' },
      ],
    })

    const filas = filasCreadas()
    expect(filas).toHaveLength(3)
    const sinMotivo = filas.find(f => f.reason === undefined)
    expect(sinMotivo).toEqual(expect.objectContaining({ amount: new Prisma.Decimal(10), appliedById: 'sv-staff-caja' }))
    expect(sinMotivo.appliedToItemIds).toHaveLength(2)
    expect(Object.values(sinMotivo.reparto.renglones)).toEqual([500, 500])
    expect(
      filas
        .filter(f => f.reason === 'Queja')
        .map(f => `${f.reasonComment ?? '(sin comentario)'}:${Number(f.amount)}`)
        .sort(),
    ).toEqual(['(sin comentario):5', 'frío:5'])
    expect(suma(filas)).toBe(Number(ordenCreada.discountAmount))
  })

  it('un suelto con «Requiere aprobación» aprobado por la sesión ⇒ la sesión lo dio y lo aprobó (D4, como el vale viejo)', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-queso', producto: 'Queso', precio: 40, descuento: 0, descuentoId: null }])])

    await cobrar({
      performedBy: 'staff-gerente',
      aprobacionDelDescuento: {},
      normalItems: [{ productId: 'p-papas', quantity: 1, discountId: 'd-gerente' }],
    })

    expect(filasCreadas()).toEqual([
      expect.objectContaining({ discountId: 'd-gerente', appliedById: 'sv-staff-gerente', authorizedById: 'sv-staff-gerente' }),
    ])
  })

  it('🔴 Codex r6 #3: un «Otro importe» con descuento y motivo ⇒ su fila lleva el motivo (no «Sin motivo»)', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-queso', producto: 'Queso', precio: 40, descuento: 0, descuentoId: null }])])

    await cobrar({
      normalItems: [
        { name: 'Envoltura', unitPrice: 5000, quantity: 1, discountId: 'd10', discountReason: 'Queja' },
        { name: 'Envío', unitPrice: 5000, quantity: 1, discountId: 'd10', discountReason: 'Promoción' },
      ],
    })

    const filas = filasCreadas()
    expect(filas.map(f => [f.reason, Number(f.amount)]).sort()).toEqual([
      ['Promoción', 5],
      ['Queja', 5],
    ])
  })

  it('🔴 usos como hoy: el cobro de vales NO toca el contador de usos del descuento (vales ni sueltos)', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 10, descuentoId: 'd10' }])])

    await cobrar({ normalItems: [{ productId: 'p-papas', quantity: 1, discountId: 'd10' }] })

    expect(filasCreadas()).toHaveLength(2)
    expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.discount.update).not.toHaveBeenCalled()
  })

  it('regresión: sin descuentos no nace ninguna fila', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-queso', producto: 'Queso', precio: 40, descuento: 0, descuentoId: null }])])

    await cobrar()

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('regresión: la misma llave sobre una sesión ya cobrada devuelve la venta sin escribir filas otra vez', async () => {
    prepararCobro([vale('t1', 'staff-area', [{ id: 'line-jamon', producto: 'Jamón', precio: 100, descuento: 10, descuentoId: 'd10' }])], {
      status: AreaTicketCheckoutStatus.MATERIALIZED,
      orderId: 'order-v7',
      order: { id: 'order-v7', total: new Prisma.Decimal(90), paidAmount: new Prisma.Decimal(0), remainingBalance: new Prisma.Decimal(90) },
      materializeIdempotencyKey: 'k1',
    })

    await cobrar()

    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })
})
