// tests/integration/online-ordering/cuentaDeLaClienta.integration.test.ts
/**
 * Integration (REAL DB) — tienda híbrida S14/S15: un folio dice de qué clienta es y qué beneficios trae en la Bandeja, en «Por pagar» y
 * «Por entregar», en el seguimiento y en el MCP libre; y el seguimiento dice lo que sumó («Sumaste 1 sello (7 de 10)») con un sello REAL,
 * ganado al cobrar en la TPV con los sellos prendidos. Ninguna de esas respuestas lleva el teléfono ni el correo de la ficha de la clienta.
 * Codex r1: la clienta ligada desde la TPV (primario, sin `customerId`) es la dueña (#1); el avance es el contador canónico de la cartilla,
 * también con un sello otorgado después de un ajuste (#2); y las búsquedas del sello usan sus índices parciales (#3, EXPLAIN).
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getTrackingByToken } from '@/services/online-ordering/order.service'
import { listFolios } from '@/services/online-ordering/folios.service'
import { listInbox } from '@/services/online-ordering/inbox.service'
import { sqlSelloDeLaVenta } from '@/services/online-ordering/beneficiosDeLaCuenta'
import { addCustomerToOrder } from '@/services/tpv/order.tpv.service'
import { grantStamp } from '@/services/wallet/stampLedger.service'
import { registerOnlineOrderingTools } from '@/mcp/tools/onlineOrdering'
import type { McpScope } from '@/mcp/scope'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture } from '../payments/webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
  reintentarAvisosDeTarjeta: jest.fn().mockResolvedValue({ avisados: 0, fallidos: 0, ocupados: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/online-ordering/notifications.service', () => ({ notifyOrderEvent: jest.fn(async () => undefined) }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
// El plan del negocio no es lo que se prueba: con LOYALTY_PROGRAM los puntos y el sello corren de verdad; lo demás, con su candado real.
jest.mock('@/services/access/basePlan.service', () => {
  const real = jest.requireActual('@/services/access/basePlan.service')
  return {
    ...real,
    venueHasFeatureAccess: jest.fn((venueId: string, code: string) =>
      code === 'LOYALTY_PROGRAM' ? Promise.resolve(true) : real.venueHasFeatureAccess(venueId, code),
    ),
  }
})
// El permiso y el alcance del MCP se prueban con sus guardias en `tests/unit/mcp-customer/`; aquí, lo que la herramienta responde.
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))

let f: Fixture
let productId: string
let mcpList: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
const TELEFONO = '+525598765432'
const CORREO = `ana-${randomUUID()}@correo.test`

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('s14cuenta')
  const categoria = await prisma.menuCategory.create({ data: { venueId: f.venueId, name: 'Antojitos', slug: `antojitos-${f.fixture}` } })
  productId = (
    await prisma.product.create({
      data: { venueId: f.venueId, name: 'Flautas', sku: `FLA-${f.fixture}`, price: 100, categoryId: categoria.id, availableOnline: true },
    })
  ).id
  // Sellos prendidos: la cartilla pide 10 y el tope diario es 1 (el sello de este cobro es el primero del día).
  await prisma.loyaltyConfig.create({
    data: {
      venueId: f.venueId,
      active: true,
      pointsPerDollar: 1,
      pointsPerVisit: 0,
      stampsEnabled: true,
      stampsRequired: 10,
      maxStampsPerDay: 1,
    },
  })
  const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  registerOnlineOrderingTools(
    { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never,
    { staffId: f.staffId, activeOrg: f.fixture, allowedVenueIds: [f.venueId], perVenueAccess: new Map() } as unknown as McpScope,
  )
  mcpList = a => handlers.get('online_orders_list')!(a, {})
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(() => {
  const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout> | undefined
  for (const t of programadas?.values() ?? []) clearTimeout(t)
  programadas?.clear()
})
afterAll(async () => {
  if (!f) return
  await prisma.kdsOrderItem.deleteMany({ where: { kdsOrder: { venueId: f.venueId } } })
  await prisma.kdsOrder.deleteMany({ where: { venueId: f.venueId } })
  await prisma.paymentEffect.deleteMany({ where: { venueId: f.venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.notification.deleteMany({ where: { venueId: f.venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
  await prisma.walletPassOutbox.deleteMany({ where: { venueId: f.venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId: f.venueId } })
  await prisma.stampReward.deleteMany({ where: { venueId: f.venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId: f.venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId: f.venueId } } })
  await prisma.customer.deleteMany({ where: { venueId: f.venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId: f.venueId } })
  await prisma.onlineOrderingSettings.deleteMany({ where: { venueId: f.venueId } })
  await prisma.product.deleteMany({ where: { venueId: f.venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId: f.venueId } })
  await f.destruir()
})

/** Ana López, con contacto en su ficha y 6 sellos de antes (un ajuste de hace dos días, como lo deja el panel). */
async function anaConSeisSellos() {
  const ana = await prisma.customer.create({
    data: { venueId: f.venueId, firstName: 'Ana', lastName: 'López', phone: TELEFONO, email: CORREO },
  })
  const cartilla = await prisma.stampCard.create({
    data: { venueId: f.venueId, customerId: ana.id, cycle: 1, stampsRequired: 10, stampsEarned: 6 },
  })
  await prisma.stampEvent.create({
    data: {
      venueId: f.venueId,
      stampCardId: cartilla.id,
      type: 'ADJUST',
      quantity: 6,
      reason: 'Sellos de antes',
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    },
  })
  return ana
}

/** Un folio de «Nadie» de $100 con un premio de $45 en la cuenta (queda en $55), con o sin cuenta de la clienta. */
async function folioConPremio(customerId: string | null) {
  const orden = await prisma.order.create({
    data: {
      venueId: f.venueId,
      orderNumber: `F-${randomUUID().slice(0, 8)}`,
      type: 'PICKUP',
      source: 'WEB',
      originSystem: 'AVOQADO',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 100,
      discountAmount: 45,
      taxAmount: 0,
      tipAmount: 0,
      total: 55,
      paidAmount: 0,
      remainingBalance: 55,
      customerName: 'Ana',
      customerId,
      ...(customerId ? { orderCustomers: { create: { customerId, isPrimary: true } } } : {}),
      items: {
        create: [
          { productId, productName: 'Flautas', quantity: 1, unitPrice: 100, discountAmount: 0, taxAmount: 0, total: 100, sequence: 0 },
        ],
      },
      orderDiscounts: { create: { type: 'FIXED_AMOUNT', name: 'Premio', value: 45, amount: 45 } },
    },
  })
  const pedido = await prisma.onlineOrder.create({
    data: {
      orderId: orden.id,
      venueId: f.venueId,
      status: 'PENDING_ACCEPTANCE',
      paymentMode: 'PAY_AT_PICKUP',
      trackingToken: `${randomUUID()}${randomUUID()}`.replace(/-/g, ''),
      acceptDeadlineAt: new Date(Date.now() + 30 * 60_000),
      requiresAcceptance: false,
      channel: 'QR',
    },
  })
  return { orderId: orden.id, token: pedido.trackingToken }
}

const efectivoDeLaTpv = (orderId: string, centavos: number) =>
  recordOrderPayment(
    f.venueId,
    orderId,
    {
      ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinMerchant: true, amount: centavos }),
      method: 'CASH',
      authorizationNumber: undefined,
    },
    f.staffId,
  )

const leerMcp = async (status: string) => JSON.parse((await mcpList({ venueId: f.venueId, status })).content[0].text)

/** 🔴 Nunca el teléfono ni el correo de la ficha, ni el apellido completo (R2), en ninguna respuesta. */
function sinContactoDeLaFicha(respuestas: unknown[]) {
  for (const r of respuestas) {
    const texto = JSON.stringify(r)
    expect(texto).not.toContain(TELEFONO.slice(3))
    expect(texto).not.toContain(CORREO)
    expect(texto).not.toContain('López')
  }
}

describe('S14/S15 · la cuenta de la clienta en el folio, contra Postgres', () => {
  it('un folio con premio, cobrado en la TPV: Por pagar, Por entregar, la Bandeja, el MCP y el seguimiento dicen de quién es y qué trae, y «Sumaste 1 sello (7 de 10)»; nunca su contacto', async () => {
    const ana = await anaConSeisSellos()
    const { orderId, token } = await folioConPremio(ana.id)
    const cuenta = { cliente: { id: ana.id, nombre: 'Ana L.' }, beneficios: [{ nombre: 'Premio', monto: 45 }], beneficiosTotal: 1 }

    const porPagar = await listFolios({ venueId: f.venueId })
    expect(porPagar.toPay.find(o => o.orderId === orderId)).toMatchObject(cuenta)
    const mcpPorPagar = await leerMcp('to_pay')
    expect(mcpPorPagar.toPay.find((o: { orderId: string }) => o.orderId === orderId).cuenta).toBe('Con cuenta: Ana L. · Premio −$45.00')
    // Sin pagar todavía no hay nada que sumar.
    const antes = await getTrackingByToken(token)
    expect(antes).toMatchObject({
      paid: false,
      beneficios: cuenta.beneficios,
      beneficiosTotal: 1,
      beneficioRegresado: false,
      lealtad: null,
    })

    await efectivoDeLaTpv(orderId, 5_500)

    // El sello y los puntos REALES de este cobro (la cadena de lealtad de la TPV), no sembrados.
    const sello = await prisma.stampEvent.findFirstOrThrow({ where: { venueId: f.venueId, orderId, type: 'EARN' } })
    expect(sello.quantity).toBe(1)
    const puntos = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId, customerId: ana.id, type: 'EARN' } })
    expect(puntos.points).toBeGreaterThan(0)

    const despues = await getTrackingByToken(token)
    expect(despues).toMatchObject({
      paid: true,
      beneficios: cuenta.beneficios,
      beneficioRegresado: false,
      lealtad: { sello: { ganados: 7, meta: 10 }, puntos: puntos.points },
    })
    const porEntregar = await listFolios({ venueId: f.venueId })
    expect(porEntregar.toDeliver.find(o => o.orderId === orderId)).toMatchObject(cuenta)
    const bandeja = await listInbox({ venueId: f.venueId })
    expect(bandeja.orders.find(o => o.orderId === orderId)).toMatchObject(cuenta)
    const mcpPorEntregar = await leerMcp('to_deliver')
    expect(mcpPorEntregar.toDeliver.find((o: { orderId: string }) => o.orderId === orderId).cuenta).toBe(
      'Con cuenta: Ana L. · Premio −$45.00',
    )
    const mcpBandeja = await leerMcp('all')
    expect(mcpBandeja.orders.find((o: { orderId: string }) => o.orderId === orderId).cuenta).toBe('Con cuenta: Ana L. · Premio −$45.00')

    sinContactoDeLaFicha([porPagar, mcpPorPagar, antes, despues, porEntregar, bandeja, mcpPorEntregar, mcpBandeja])
    // El seguimiento público, además, nunca trae campos de contacto de la clienta.
    for (const t of [antes, despues]) expect(JSON.stringify(t)).not.toMatch(/customerPhone|customerEmail/)
  })

  it('sin cuenta: cliente null, el MCP dice «Sin cuenta» y el seguimiento no promete nada (lealtad null)', async () => {
    const { orderId, token } = await folioConPremio(null)
    await efectivoDeLaTpv(orderId, 5_500)
    expect(await prisma.stampEvent.count({ where: { venueId: f.venueId, orderId } })).toBe(0)
    const r = await listFolios({ venueId: f.venueId })
    expect(r.toDeliver.find(o => o.orderId === orderId)).toMatchObject({ cliente: null, beneficios: [{ nombre: 'Premio', monto: 45 }] })
    const mcp = await leerMcp('to_deliver')
    expect(mcp.toDeliver.find((o: { orderId: string }) => o.orderId === orderId).cuenta).toBe('Sin cuenta · Premio −$45.00')
    await expect(getTrackingByToken(token)).resolves.toMatchObject({ paid: true, lealtad: null, beneficioRegresado: false })
  })

  it('Codex r1 #1: folio sin sesión; la cajera liga a Carla desde la TPV y cobra ⇒ la Bandeja y los folios dan a Carla, el MCP «Con cuenta» y el seguimiento su lealtad', async () => {
    const correoCarla = `carla-${randomUUID()}@correo.test`
    const carla = await prisma.customer.create({
      data: { venueId: f.venueId, firstName: 'Carla', lastName: 'Soto', phone: '+525577776666', email: correoCarla },
    })
    const { orderId, token } = await folioConPremio(null)
    await addCustomerToOrder(f.venueId, orderId, carla.id, f.staffId)
    // La TPV escribe la liga primaria y no toca `Order.customerId`: justo lo que la proyección tiene que leer.
    expect(
      await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { customerId: true, orderCustomers: { select: { customerId: true, isPrimary: true } } },
      }),
    ).toEqual({ customerId: null, orderCustomers: [{ customerId: carla.id, isPrimary: true }] })

    await efectivoDeLaTpv(orderId, 5_500)

    const puntos = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId, customerId: carla.id, type: 'EARN' } })
    const cuenta = { cliente: { id: carla.id, nombre: 'Carla S.' }, beneficios: [{ nombre: 'Premio', monto: 45 }] }
    const bandeja = await listInbox({ venueId: f.venueId })
    expect(bandeja.orders.find(o => o.orderId === orderId)).toMatchObject(cuenta)
    const folios = await listFolios({ venueId: f.venueId })
    expect(folios.toDeliver.find(o => o.orderId === orderId)).toMatchObject(cuenta)
    const mcp = await leerMcp('to_deliver')
    expect(mcp.toDeliver.find((o: { orderId: string }) => o.orderId === orderId).cuenta).toBe('Con cuenta: Carla S. · Premio −$45.00')
    const t = await getTrackingByToken(token)
    expect(t!.lealtad).toEqual({ sello: { ganados: 1, meta: 10 }, puntos: puntos.points })
    for (const r of [bandeja, folios, mcp, t]) {
      const texto = JSON.stringify(r)
      expect(texto).not.toContain('5577776666')
      expect(texto).not.toContain(correoCarla)
      expect(texto).not.toContain('Soto')
    }
  })

  it('Codex r1 #2 y #3: venta a las 10:00, el gerente suma 6 a las 11:00 y el sello de la venta se otorga a las 12:00 ⇒ «7 de 10»; cada búsqueda usa su índice', async () => {
    const venta = new Date(Date.now() - 2 * 3_600_000)
    const ajuste = new Date(Date.now() - 3_600_000)
    const beto = await prisma.customer.create({ data: { venueId: f.venueId, firstName: 'Beto', lastName: 'Ruiz' } })
    const { orderId, token } = await folioConPremio(beto.id)
    // La venta se cobró a las 10:00 y su lealtad quedó pendiente (la hora de la venta es la que el sello guarda).
    await prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'PAID', paidAmount: 55, remainingBalance: 0, loyaltySaleAt: venta, loyaltyEligibleAt: venta },
    })
    // 11:00: el gerente le suma 6 sellos a su cartilla abierta.
    const cartilla = await prisma.stampCard.create({
      data: { venueId: f.venueId, customerId: beto.id, cycle: 1, stampsRequired: 10, stampsEarned: 6 },
    })
    await prisma.stampEvent.create({
      data: { venueId: f.venueId, stampCardId: cartilla.id, type: 'ADJUST', quantity: 6, reason: 'Ajuste del gerente', createdAt: ajuste },
    })
    // 12:00: el recuperador otorga el sello de esa venta con la cadena real.
    await expect(grantStamp(f.venueId, beto.id, orderId)).resolves.toMatchObject({ granted: true, stampsEarned: 7, stampsRequired: 10 })
    const earn = await prisma.stampEvent.findFirstOrThrow({ where: { venueId: f.venueId, orderId, type: 'EARN' } })
    expect(earn.createdAt.getTime()).toBe(venta.getTime())
    expect(earn.createdAt.getTime()).toBeLessThan(ajuste.getTime())

    expect((await getTrackingByToken(token))!.lealtad).toMatchObject({ sello: { ganados: 7, meta: 10 } })

    // #3: el plan de la MISMA consulta. Sin barrido secuencial, el planificador sólo puede usar los índices que su WHERE satisface.
    // Con la tabla casi vacía, recorrer COMPLETO el índice (stampCardId, createdAt) con filtro le cuesta lo mismo que el parcial
    // único y el CI elegía cualquiera de los dos (rojo intermitente del 10-nov, run 42960564002). Con un tamaño de producción
    // (2,000 movimientos sin orden, que no entran a los índices parciales) y estadísticas al día, sólo el índice parcial es barato.
    await prisma.stampEvent.createMany({
      data: Array.from({ length: 2_000 }, () => ({ venueId: f.venueId, stampCardId: cartilla.id, type: 'ADJUST' as const, quantity: 0 })),
    })
    await prisma.$executeRawUnsafe('ANALYZE "StampEvent"')
    const plan = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      return tx.$queryRaw<unknown[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sqlSelloDeLaVenta(f.venueId, orderId)}`)
    })
    const texto = JSON.stringify(plan)
    expect(texto).toContain('"Index Name":"StampEvent_venueId_orderId_part_earn_unique"')
    expect(texto).toContain('"Index Name":"StampEvent_venueId_orderId_part_reversal_unique"')
  })
})
