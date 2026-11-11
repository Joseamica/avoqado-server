// tests/unit/services/online-ordering/order.service.beneficios.test.ts
/**
 * S11 (B2, P2-3, P2-4): canjear dentro del folio, una vez, al crearlo. Rulings de `task-S11-go.md`: R1/R1' (la decisión de precio es
 * durable y UNA por negocio + llave), R2 (pagar al recoger nace con el total estricto ≤ `expectedTotal`; `descartados` sale del error
 * estricto), R7 (bitácora de cada canje en la transacción del folio) y E11 (la misma regla de identidad al cotizar y al crear).
 * La cadena (`aplicarBeneficiosEnTx`) y el cierre en $0 son dobles aquí: su comportamiento real lo prueba la integración.
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import AppError, { ForbiddenError, ServiceUnavailableError } from '@/errors/AppError'
import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'

jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))
jest.mock('@/services/online-ordering/quote.service', () => ({
  __esModule: true,
  quoteCart: jest.fn(),
  toPublicQuote: jest.fn((q: any) => ({
    total: Number((q.totalConBeneficios ?? q.total).toFixed(2)),
    ...(q.beneficios ? { beneficios: q.beneficios } : {}),
    ...(q.descartados ? { descartados: q.descartados } : {}),
  })),
}))
jest.mock('@/services/online-ordering/beneficios.service', () => ({
  __esModule: true,
  BENEFIT_UNAVAILABLE: 'BENEFIT_UNAVAILABLE',
  aplicarBeneficiosEnTx: jest.fn(),
  cotizarConBeneficios: jest.fn(),
}))
jest.mock('@/services/online-ordering/folios.service', () => ({
  __esModule: true,
  prepararCierreEnCero: jest.fn(async () => ({ marcarCocina: true, minutes: 15 })),
  cerrarFolioEnCeroEnTx: jest.fn(),
  trasCerrarFolioEnCero: jest.fn(),
}))
jest.mock('@/services/online-ordering/cortesiaDeFolio', () => ({ __esModule: true, despertarPasesTrasCommit: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn() },
}))

import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { quoteCart } from '@/services/online-ordering/quote.service'
import { aplicarBeneficiosEnTx, cotizarConBeneficios } from '@/services/online-ordering/beneficios.service'
import { cerrarFolioEnCeroEnTx, trasCerrarFolioEnCero } from '@/services/online-ordering/folios.service'
import { despertarPasesTrasCommit } from '@/services/online-ordering/cortesiaDeFolio'
import { clientaDeLaSesion } from '@/services/online-ordering/clientaDeLaSesion'
import {
  createOnlineOrder,
  decisionDePrecio,
  onlineOrderRequestHash,
  type CreateOnlineOrderOptions,
} from '@/services/online-ordering/order.service'

const D = (v: string) => new Prisma.Decimal(v)
const PUEDE_CREAR: CreateOnlineOrderOptions = { assertCanCreate: async () => {} }
const NOW = new Date('2026-11-10T18:30:00.000Z')
const KEY = 'b'.repeat(32)
const PHONE = '+525543453965'
const KEY_LOCK = `online-order-key:v1:web:${KEY}`
const ADMISSION_LOCK = 'online-order-admission:v1'

const NADIE = {
  status: 'OPEN',
  reason: null,
  config: { acceptsPayAtPickup: true, defaultPrepMinutes: 15, requiresAcceptance: false, hours: null },
}
const MI_EQUIPO = { ...NADIE, config: { ...NADIE.config, requiresAcceptance: true } }
const QUOTE = (total = '100.00') => ({
  ok: true,
  issues: [],
  subtotal: D(total),
  total: D(total),
  minOrderAmount: D('0'),
  lines: [
    {
      productId: 'p1',
      productName: 'Combo',
      productSku: 'C-1',
      categoryName: 'Menú',
      quantity: 1,
      unitPrice: D(total),
      modifiers: [],
      note: null,
      lineTotal: D(total),
    },
  ],
})

/** La clienta de «Nadie» con sesión de CORREO: sin teléfono probado. */
const input = (o: Record<string, unknown> = {}) => ({
  venueId: 'v1',
  idempotencyKey: KEY,
  items: [{ productId: 'p1', quantity: 1 }],
  paymentMode: 'PAY_AT_PICKUP' as const,
  expectedTotal: '100.00',
  customer: { name: 'Ana Pérez', email: null },
  customerId: 'cust1',
  verifiedPhone: null,
  note: null,
  whatsappConsent: false,
  now: NOW,
  ...o,
})
const huella = (o: { customerId?: string; beneficios?: any; expectedTotal?: string; customerPhone?: string } = {}) =>
  onlineOrderRequestHash({
    venueId: 'v1',
    customerId: o.customerId ?? 'cust1',
    paymentMode: 'PAY_AT_PICKUP',
    expectedTotal: o.expectedTotal ?? '100.00',
    items: [{ productId: 'p1', quantity: 1 }],
    customerName: 'Ana Pérez',
    customerPhone: o.customerPhone ?? '',
    beneficios: o.beneficios,
  })
const AUDITORIA_PREMIO = {
  staffId: null,
  venueId: 'v1',
  action: 'STAMP_REWARD_REDEEMED',
  entity: 'StampReward',
  entityId: 'r1',
  data: { orderId: 'ord1', customerId: 'cust1', discountAmount: 10 },
}
const canje = (total: string, o: Record<string, unknown> = {}) => ({
  total: D(total),
  aplicados: [],
  descartados: [],
  premio: false,
  auditorias: [],
  ...o,
})
const PRECIO = {
  organizationId_actorStaffId_endpoint_idempotencyKey: decisionDePrecio('v1', KEY),
}

/** Una tabla `IdempotencyRequest` en memoria (las dos llaves: la de identidad de hoy y la de precio por negocio + llave). */
function tablaDeDecisiones() {
  const filas = new Map<string, any>()
  const k = (w: any) => JSON.stringify(Object.values(w.organizationId_actorStaffId_endpoint_idempotencyKey ?? w))
  prismaMock.idempotencyRequest.findUnique.mockImplementation((async (a: any) => filas.get(k(a.where)) ?? null) as any)
  prismaMock.idempotencyRequest.create.mockImplementation((async (a: any) => {
    const { organizationId, actorStaffId, endpoint, idempotencyKey } = a.data
    filas.set(k({ organizationId, actorStaffId, endpoint, idempotencyKey }), a.data)
    return a.data
  }) as any)
  return filas
}

beforeEach(() => {
  ;(getAcceptingStatus as jest.Mock).mockResolvedValue(NADIE)
  ;(quoteCart as jest.Mock).mockResolvedValue(QUOTE())
  ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('100.00'))
  ;(cotizarConBeneficios as jest.Mock).mockImplementation(async () => ({ ...QUOTE(), beneficios: { calculados: false } }))
  ;(cerrarFolioEnCeroEnTx as jest.Mock).mockResolvedValue({ cerrado: true, postingId: 'post1', cas: { r: 'OK', now: NOW } })
  prismaMock.order.findUnique.mockReset()
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.findFirst.mockResolvedValue(null)
  prismaMock.onlineOrder.count.mockResolvedValue(0)
  prismaMock.onlineOrderCharge.count.mockResolvedValue(0)
  prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(null)
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.order.create.mockResolvedValue({ id: 'ord1', orderNumber: 'WABCD' } as any)
  prismaMock.onlineOrder.create.mockImplementation(async (a: any) => ({ id: 'oo1', ...a.data }) as any)
  prismaMock.idempotencyRequest = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) }
  prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ requiresAcceptance: false })
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.activityLog.createMany.mockResolvedValue({ count: 0 } as any)
})

describe('S11 · la identidad del folio (E1, E2, E11)', () => {
  it('«Nadie» con sesión de correo: el folio nace con customerId (sin teléfono) y la cadena corre con la clienta', async () => {
    const res = await createOnlineOrder(input(), PUEDE_CREAR)
    expect(res).toMatchObject({ replay: false, total: '100.00' })
    const data = (prismaMock.order.create.mock.calls[0][0] as any).data
    expect(data).toMatchObject({ customerId: 'cust1', customerPhone: null })
    expect(aplicarBeneficiosEnTx).toHaveBeenCalledWith(prismaMock, { venueId: 'v1', orderId: 'ord1', customerId: 'cust1', eleccion: {} })
    expect((prismaMock.onlineOrder.create.mock.calls[0][0] as any).data.requestHash).toBe(huella())
  })

  it('«Mi equipo» sin teléfono probado sigue 401 PHONE_VERIFICATION_REQUIRED, sin cotizar ni canjear', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(MI_EQUIPO)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ requiresAcceptance: true })
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 401, code: 'PHONE_VERIFICATION_REQUIRED' })
    expect(quoteCart).not.toHaveBeenCalled()
    expect(aplicarBeneficiosEnTx).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('«Mi equipo» con su teléfono probado: como hoy, y además con sus beneficios', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(MI_EQUIPO)
    const r = await createOnlineOrder(
      input({ verifiedPhone: PHONE, customer: { name: 'Ana Pérez', phone: '55 4345 3965' }, beneficios: { premioId: 'r1' } }),
      PUEDE_CREAR,
    )
    expect(r).toMatchObject({ status: 'PENDING_ACCEPTANCE' })
    expect((prismaMock.order.create.mock.calls[0][0] as any).data).toMatchObject({ customerId: 'cust1', customerPhone: PHONE })
    expect(aplicarBeneficiosEnTx).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ eleccion: { premioId: 'r1' } }))
  })

  it('E11: la misma regla al cotizar y al crear: una sesión con algún contacto probado (o el token de pedidos) es la clienta', () => {
    // La forma de `req.customerAuth` (sesión única con sus contactos probados, o el token de pedidos de hoy con su teléfono).
    const sesion = (o: Partial<CustomerAuthContext>): CustomerAuthContext => ({
      customerId: 'c1',
      venueId: 'v1',
      tipo: 'SESION',
      contactos: [],
      accountActivatedAt: null,
      ...o,
    })
    expect(clientaDeLaSesion(null)).toBeNull()
    expect(clientaDeLaSesion(sesion({}))).toBeNull()
    expect(clientaDeLaSesion(sesion({ contactos: [{ tipo: 'EMAIL', valor: 'ana@x.mx', metodo: 'EMAIL_CODE', probadoEn: 1 }] }))).toBe('c1')
    expect(clientaDeLaSesion(sesion({ tipo: 'PEDIDOS_DE_HOY', verifiedPhone: PHONE }))).toBe('c1')
  })
})

describe('S11 · la secuencia del canje dentro de la transacción del folio (literal, R3, R7)', () => {
  it('llave → admisión → cuenta → canje → OnlineOrder → nombre, todo en la MISMA transacción', async () => {
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust1', firstName: 'Ana', lastName: 'Pérez' } as any)
    await createOnlineOrder(input({ beneficios: { premioId: 'r1', puntos: 50, cupon: ' diez ' } }), PUEDE_CREAR)
    const llaves = (prismaMock.$executeRaw as jest.Mock).mock.calls.map(([, k]) => k)
    expect(llaves).toEqual([KEY_LOCK, ADMISSION_LOCK]) // R3: la llave antes que la admisión, como hoy
    const orden = [
      (prismaMock.$executeRaw as jest.Mock).mock.invocationCallOrder[1],
      prismaMock.order.create.mock.invocationCallOrder[0],
      (aplicarBeneficiosEnTx as jest.Mock).mock.invocationCallOrder[0],
      prismaMock.onlineOrder.create.mock.invocationCallOrder[0],
      prismaMock.customer.findFirst.mock.invocationCallOrder[0],
    ]
    expect([...orden].sort((a, b) => a - b)).toEqual(orden)
    // La elección se normaliza (cupón recortado y en mayúsculas) y viaja a la cadena.
    expect(aplicarBeneficiosEnTx).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({ eleccion: { premioId: 'r1', puntos: 50, cupon: 'DIEZ' } }),
    )
  })

  it('R7: las bitácoras del canje se escriben con el tx del folio, en la misma transacción (nunca con logAction global)', async () => {
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('90.00', { auditorias: [AUDITORIA_PREMIO] }))
    await createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)
    expect(prismaMock.activityLog.createMany).toHaveBeenCalledWith({
      data: [
        {
          staffId: null,
          venueId: 'v1',
          action: 'STAMP_REWARD_REDEEMED',
          entity: 'StampReward',
          entityId: 'r1',
          data: AUDITORIA_PREMIO.data,
        },
      ],
    })
    expect(prismaMock.activityLog.createMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      (aplicarBeneficiosEnTx as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('R7: la repetición de la MISMA solicitud no canjea ni escribe bitácora', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'ord1',
      orderNumber: 'WABCD',
      total: D('90.00'),
      onlineOrder: {
        id: 'oo1',
        status: 'PENDING_ACCEPTANCE',
        trackingToken: 'T'.repeat(32),
        acceptDeadlineAt: NOW,
        requestHash: huella({ beneficios: { premioId: 'r1' } }),
      },
    } as any)
    const r = await createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)
    expect(r).toMatchObject({ replay: true, total: '90.00' })
    expect(aplicarBeneficiosEnTx).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.createMany).not.toHaveBeenCalled()
  })

  it('Codex r8: el premio canjeado con el desglose RECORTADO (sin su fila en `aplicados`) igual despierta Wallet', async () => {
    const recortado = Array.from({ length: 500 }, (_, i) => ({
      tipo: 'DESCUENTO',
      nombre: `Auto ${i}`,
      monto: D('0.01'),
      orderDiscountId: `od${i}`,
    }))
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(
      canje('85.00', { aplicados: recortado, aplicadosCompletos: false, premio: true }),
    )
    const r = await createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)
    expect(r).toMatchObject({ total: '85.00' })
    expect(r).not.toHaveProperty('aplicados')
    expect(despertarPasesTrasCommit).toHaveBeenCalledWith('v1', ['cust1'])
  })

  it('E10: con un premio canjeado, Wallet se despierta DESPUÉS del commit; sin premio, no', async () => {
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(
      canje('90.00', { aplicados: [{ tipo: 'PREMIO', nombre: 'Café', monto: D('10.00'), orderDiscountId: 'od1' }], premio: true }),
    )
    await createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)
    expect(despertarPasesTrasCommit).toHaveBeenCalledWith('v1', ['cust1'])
    expect((despertarPasesTrasCommit as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
      (prismaMock.$transaction as jest.Mock).mock.invocationCallOrder.at(-1)!,
    )
    ;(despertarPasesTrasCommit as jest.Mock).mockClear()
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('100.00'))
    await createOnlineOrder(input({ idempotencyKey: 'n'.repeat(32) }), PUEDE_CREAR)
    expect(despertarPasesTrasCommit).not.toHaveBeenCalled()
  })
})

describe("S11 · PRICE_CHANGED: nunca más caro que lo que vio, y la decisión es durable (R1, R1', R2)", () => {
  it('R2: el total estricto MENOR que expectedTotal crea el folio con el total menor (S10 degradado + automático de $10)', async () => {
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('90.00'))
    const r = await createOnlineOrder(input(), PUEDE_CREAR)
    expect(r).toMatchObject({ replay: false, total: '90.00' })
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
  })

  it('el total estricto MAYOR ⇒ PRICE_CHANGED (final) con la recotización, guardado bajo negocio + llave', async () => {
    tablaDeDecisiones()
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('110.00'))
    ;(cotizarConBeneficios as jest.Mock).mockResolvedValue({ ...QUOTE('110.00'), beneficios: { calculados: true }, descartados: [] })
    const err = await createOnlineOrder(input(), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED', final: true, details: { quote: { total: 110 } } })
    expect(cotizarConBeneficios).toHaveBeenCalledWith('v1', [{ productId: 'p1', quantity: 1 }], { customerId: 'cust1', eleccion: null })
    const guardada = (prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data
    expect(guardada).toMatchObject({ ...decisionDePrecio('v1', KEY), requestHash: huella(), responseStatus: 409 })
    expect(guardada.responseBody).toMatchObject({ code: 'PRICE_CHANGED' })
  })

  it('premio perdido con la recotización DEGRADADA ⇒ descartados [PREMIO] del error estricto (R2), y nada de cocina ni Wallet', async () => {
    tablaDeDecisiones()
    ;(aplicarBeneficiosEnTx as jest.Mock).mockRejectedValue(
      new AppError('Este premio ya fue canjeado.', 409, true, 'BENEFIT_UNAVAILABLE', { cual: 'PREMIO' }),
    )
    const err = await createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject({
      statusCode: 409,
      code: 'PRICE_CHANGED',
      final: true,
      details: { descartados: ['PREMIO'], quote: { total: 100, descartados: ['PREMIO'], beneficios: { calculados: false } } },
    })
    expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
    expect(despertarPasesTrasCommit).not.toHaveBeenCalled()
    expect(cerrarFolioEnCeroEnTx).not.toHaveBeenCalled()
  })

  it("R1/R1': la MISMA solicitud con K recibe la decisión guardada y nunca crea; K con OTRA elección ⇒ IDEMPOTENCY_KEY_CONFLICT", async () => {
    tablaDeDecisiones()
    ;(aplicarBeneficiosEnTx as jest.Mock).mockRejectedValueOnce(
      new AppError('Este premio ya fue canjeado.', 409, true, 'BENEFIT_UNAVAILABLE', { cual: 'PREMIO' }),
    )
    await expect(createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)).rejects.toMatchObject({ code: 'PRICE_CHANGED' })
    // El envío demorado (la MISMA solicitud) llega después: aunque el premio ya regresó, recibe la decisión y no crea.
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('90.00'))
    await expect(createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'PRICE_CHANGED',
      final: true,
    })
    // K con otra elección (sin el premio) choca: la corrección va con K2.
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
    // K sin sesión (otra identidad, mismo negocio + llave) también choca: la decisión es una sola.
    await expect(createOnlineOrder(input({ customerId: null }), PUEDE_CREAR)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1) // sólo el primer intento, revertido
    expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledTimes(1)
  })

  it('sin sesión y con beneficios en el cuerpo ⇒ PRICE_CHANGED motivo SIN_SESION, guardado bajo negocio + llave; nada se canjea ni se crea', async () => {
    tablaDeDecisiones()
    const err = await createOnlineOrder(
      input({ customerId: null, beneficios: { premioId: 'r1' }, expectedTotal: '90.00' }),
      PUEDE_CREAR,
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({
      statusCode: 409,
      code: 'PRICE_CHANGED',
      final: true,
      details: { motivo: 'SIN_SESION', quote: { total: 100 } },
    })
    expect(aplicarBeneficiosEnTx).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    const guardada = (prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data
    expect(guardada).toMatchObject(decisionDePrecio('v1', KEY))
    // R1': el envío demorado de la MISMA llave con sesión (otra huella) ya no crea.
    await expect(createOnlineOrder(input({ beneficios: { premioId: 'r1' }, expectedTotal: '90.00' }), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('una decisión de precio guardada antes con la misma huella se respeta aunque el carrito ya cuadre', async () => {
    tablaDeDecisiones().set(JSON.stringify(Object.values(PRECIO.organizationId_actorStaffId_endpoint_idempotencyKey)), {
      requestHash: huella(),
      responseStatus: 409,
      responseBody: { code: 'PRICE_CHANGED', message: 'El precio cambió', details: { quote: { total: 110 } } },
    })
    await expect(createOnlineOrder(input(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'PRICE_CHANGED', final: true })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })
  describe("Codex r4 #1 (R1'): lo ya decidido sobre K gana antes de la tienda, también al pagar al recoger", () => {
    const guardada = () =>
      tablaDeDecisiones().set(JSON.stringify(Object.values(PRECIO.organizationId_actorStaffId_endpoint_idempotencyKey)), {
        requestHash: huella({ beneficios: { premioId: 'r1' } }),
        responseStatus: 409,
        responseBody: { code: 'PRICE_CHANGED', message: 'El precio cambió', details: { quote: { total: 110 } } },
      })
    const caminos: Array<[string, () => void]> = [
      [
        'tienda cerrada',
        () => (getAcceptingStatus as jest.Mock).mockResolvedValue({ status: 'CLOSED', reason: 'OUTSIDE_HOURS', config: {} }),
      ],
      [
        'tienda de sólo tarjeta',
        () => (getAcceptingStatus as jest.Mock).mockResolvedValue({ ...NADIE, config: { ...NADIE.config, acceptsPayAtPickup: false } }),
      ],
    ]

    it.each(caminos)('K rechazada + %s ⇒ la decisión guardada, sin cotizar ni canjear', async (_, preparar) => {
      guardada()
      preparar()
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])
      await expect(createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PRICE_CHANGED',
        final: true,
        details: { quote: { total: 110 } },
      })
      expect(cotizarConBeneficios).not.toHaveBeenCalled()
      expect(aplicarBeneficiosEnTx).not.toHaveBeenCalled()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
    })

    it.each(caminos)('K rechazada + otra elección con la misma K + %s ⇒ IDEMPOTENCY_KEY_CONFLICT', async (_, preparar) => {
      guardada()
      preparar()
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])
      await expect(createOnlineOrder(input({ beneficios: { premioId: 'r2' } }), PUEDE_CREAR)).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        final: true,
      })
      expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })
    describe('Codex r6 · intercalado real: A valida con K libre y espera el plan; B decide K; después A falla', () => {
      const enEspera = () => {
        let soltar!: (e: Error) => void
        const puerta = new Promise<Error>(r => (soltar = r))
        const opts: CreateOnlineOrderOptions & { assertCanCreate: jest.Mock } = {
          assertCanCreate: jest.fn(async () => {
            throw await puerta
          }),
        }
        return { opts, soltar }
      }
      const hasta = async (cond: () => boolean) => {
        for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setImmediate(r))
        expect(cond()).toBe(true)
      }
      const casos: Array<[string, Record<string, unknown>, () => Error, Record<string, unknown>]> = [
        [
          '503 + la MISMA solicitud ⇒ la decisión de B',
          { beneficios: { premioId: 'r1' } },
          () => new ServiceUnavailableError('x', 'FEATURE_CHECK_UNAVAILABLE'),
          { statusCode: 409, code: 'PRICE_CHANGED', final: true },
        ],
        [
          '503 + otra elección con K ⇒ IDEMPOTENCY_KEY_CONFLICT',
          { beneficios: { premioId: 'r2' } },
          () => new ServiceUnavailableError('x', 'FEATURE_CHECK_UNAVAILABLE'),
          { statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT', final: true },
        ],
        [
          'un rechazo definitivo (403 PLAN_REQUIRED) ⇒ la decisión de B, y no se guarda otra',
          { beneficios: { premioId: 'r1' } },
          () => new ForbiddenError('x', 'PLAN_REQUIRED'),
          { statusCode: 409, code: 'PRICE_CHANGED', final: true },
        ],
      ]

      it.each(casos)('%s', async (_, deA, caida, esperado) => {
        tablaDeDecisiones()
        const a = enEspera()
        const respuestaDeA = createOnlineOrder(input(deA), a.opts).catch((e: unknown) => e)
        await hasta(() => a.opts.assertCanCreate.mock.calls.length === 1)
        // B, la misma solicitud con K: el premio ya no está ⇒ PRICE_CHANGED guardado bajo negocio + llave.
        ;(aplicarBeneficiosEnTx as jest.Mock).mockRejectedValueOnce(
          new AppError('Este premio ya fue canjeado.', 409, true, 'BENEFIT_UNAVAILABLE', { cual: 'PREMIO' }),
        )
        await expect(createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)).rejects.toMatchObject({
          code: 'PRICE_CHANGED',
        })
        expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledTimes(1)
        a.soltar(caida())
        expect(await respuestaDeA).toMatchObject(esperado)
        expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledTimes(1)
        expect(prismaMock.order.create).toHaveBeenCalledTimes(1) // sólo el intento de B, revertido
      })
    })

    describe('Codex r7: una decisión recuperada sale tal cual (también un 401 guardado); un fallo al recuperarla, no', () => {
      const PLAN_503: CreateOnlineOrderOptions = {
        assertCanCreate: async () => {
          throw new ServiceUnavailableError('No pudimos verificar la disponibilidad. Intenta de nuevo.', 'FEATURE_CHECK_UNAVAILABLE')
        },
      }
      const anonimo = () => input({ customerId: null })

      it('el 401 guardado en «Mi equipo» + el negocio ya en «Nadie» + plan 503 ⇒ el 401 guardado, con final', async () => {
        tablaDeDecisiones().set(
          JSON.stringify(
            Object.values({
              organizationId: 'venue:v1',
              actorStaffId: `anon:${KEY}`,
              endpoint: 'POST /public/ordering/orders',
              idempotencyKey: KEY,
            }),
          ),
          {
            requestHash: huella({ customerId: '' }),
            responseStatus: 401,
            responseBody: {
              code: 'PHONE_VERIFICATION_REQUIRED',
              message: 'Verifica tu teléfono por WhatsApp para pedir y pagar al recoger.',
            },
          },
        )
        await expect(createOnlineOrder(anonimo(), PLAN_503)).rejects.toMatchObject({
          statusCode: 401,
          code: 'PHONE_VERIFICATION_REQUIRED',
          final: true,
        })
        expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
      })

      it('control: la lectura falla de verdad (aunque sea con un 4xx sin marca de decisión) ⇒ el error original', async () => {
        const caida = new ServiceUnavailableError('x', 'FEATURE_CHECK_UNAVAILABLE')
        ;(prismaMock.idempotencyRequest.findUnique as jest.Mock).mockRejectedValue(new AppError('lectura rota', 409, true, 'X'))
        await expect(
          createOnlineOrder(anonimo(), { assertCanCreate: async () => Promise.reject(caida) }).catch((e: unknown) => e),
        ).resolves.toBe(caida)
      })
    })

    describe('Codex r5: con el plan sin poder verificarse (503), también', () => {
      const PLAN_503: CreateOnlineOrderOptions = {
        assertCanCreate: async () => {
          throw new ServiceUnavailableError('No pudimos verificar la disponibilidad. Intenta de nuevo.', 'FEATURE_CHECK_UNAVAILABLE')
        },
      }
      const sesiones: Array<[string, Record<string, unknown>, () => void]> = [
        ['sesión de correo en «Nadie»', {}, () => undefined],
        [
          'teléfono verificado en «Mi equipo»',
          { verifiedPhone: PHONE, customer: { name: 'Ana Pérez', email: null, phone: PHONE } },
          () => (getAcceptingStatus as jest.Mock).mockResolvedValue(MI_EQUIPO),
        ],
      ]
      const guardadaPara = (o: Record<string, unknown>) =>
        tablaDeDecisiones().set(JSON.stringify(Object.values(PRECIO.organizationId_actorStaffId_endpoint_idempotencyKey)), {
          requestHash: huella({ beneficios: { premioId: 'r1' }, customerPhone: o.verifiedPhone ? PHONE : '' }),
          responseStatus: 409,
          responseBody: { code: 'PRICE_CHANGED', message: 'El precio cambió', details: { quote: { total: 110 } } },
        })

      it.each(sesiones)('K decidida + %s ⇒ la decisión guardada, no el 503', async (_, o, preparar) => {
        guardadaPara(o)
        preparar()
        await expect(createOnlineOrder(input({ ...o, beneficios: { premioId: 'r1' } }), PLAN_503)).rejects.toMatchObject({
          statusCode: 409,
          code: 'PRICE_CHANGED',
          final: true,
          details: { quote: { total: 110 } },
        })
        expect(prismaMock.order.create).not.toHaveBeenCalled()
        expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
      })

      it.each(sesiones)('K decidida + otra elección + %s ⇒ IDEMPOTENCY_KEY_CONFLICT, no el 503', async (_, o, preparar) => {
        guardadaPara(o)
        preparar()
        await expect(createOnlineOrder(input({ ...o, beneficios: { premioId: 'r2' } }), PLAN_503)).rejects.toMatchObject({
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          final: true,
        })
        expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
      })

      it('la recotización del PRICE_CHANGED falla mientras un gemelo ya decidió K ⇒ la decisión del gemelo; sin gemelo, el error de la recotización', async () => {
        const filas = tablaDeDecisiones()
        const perdido = () =>
          (aplicarBeneficiosEnTx as jest.Mock).mockRejectedValueOnce(
            new AppError('Este premio ya fue canjeado.', 409, true, 'BENEFIT_UNAVAILABLE', { cual: 'PREMIO' }),
          )
        const caida = new Error('quoteCart cayó')
        perdido()
        ;(cotizarConBeneficios as jest.Mock).mockImplementationOnce(async () => {
          filas.set(JSON.stringify(Object.values(PRECIO.organizationId_actorStaffId_endpoint_idempotencyKey)), {
            requestHash: huella({ beneficios: { premioId: 'r1' } }),
            responseStatus: 409,
            responseBody: { code: 'PRICE_CHANGED', message: 'El precio cambió', details: { quote: { total: 100 } } },
          })
          throw caida
        })
        await expect(createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)).rejects.toMatchObject({
          code: 'PRICE_CHANGED',
          final: true,
          details: { quote: { total: 100 } },
        })
        filas.clear()
        perdido()
        ;(cotizarConBeneficios as jest.Mock).mockRejectedValueOnce(caida)
        await expect(createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR).catch((e: unknown) => e)).resolves.toBe(
          caida,
        )
        expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
      })

      it('K libre + plan sin verificar ⇒ el 503 de siempre (reintentable), sin guardar nada', async () => {
        tablaDeDecisiones()
        await expect(createOnlineOrder(input({ beneficios: { premioId: 'r1' } }), PLAN_503)).rejects.toMatchObject({
          statusCode: 503,
          code: 'FEATURE_CHECK_UNAVAILABLE',
        })
        expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
      })
    })
  })
})

describe('S11 · la huella (E4)', () => {
  it('sin beneficios es la de hoy: igual a la de antes de S11, también con una elección vacía', () => {
    const r = {
      venueId: 'v1',
      customerId: 'cust1',
      paymentMode: 'PAY_AT_PICKUP',
      expectedTotal: '100.00',
      items: [{ productId: 'p1', quantity: 1 }],
      customerName: 'Ana Pérez',
      customerPhone: '',
    }
    const deHoy = createHash('sha256')
      .update(
        JSON.stringify({
          venueId: 'v1',
          customerId: 'cust1',
          paymentMode: 'PAY_AT_PICKUP',
          expectedTotal: '100.00',
          items: [{ productId: 'p1', quantity: 1, note: null, modifiers: [] }],
          customer: { name: 'Ana Pérez', phone: '' },
        }),
      )
      .digest('hex')
    expect(onlineOrderRequestHash(r)).toBe(deHoy)
    expect(onlineOrderRequestHash({ ...r, beneficios: null })).toBe(deHoy)
    expect(onlineOrderRequestHash({ ...r, beneficios: {} })).toBe(deHoy)
    expect(onlineOrderRequestHash({ ...r, beneficios: { cupon: '  ' } })).toBe(deHoy)
  })

  it('con beneficios cambia, y el cupón cuenta igual escrito en minúsculas o con espacios', () => {
    const r = {
      venueId: 'v1',
      customerId: 'cust1',
      paymentMode: 'PAY_AT_PICKUP',
      expectedTotal: '100.00',
      items: [{ productId: 'p1', quantity: 1 }],
      customerName: 'Ana Pérez',
      customerPhone: '',
    }
    const sin = onlineOrderRequestHash(r)
    expect(onlineOrderRequestHash({ ...r, beneficios: { premioId: 'r1' } })).not.toBe(sin)
    expect(onlineOrderRequestHash({ ...r, beneficios: { puntos: 50 } })).not.toBe(
      onlineOrderRequestHash({ ...r, beneficios: { puntos: 51 } }),
    )
    expect(onlineOrderRequestHash({ ...r, beneficios: { cupon: ' diez ' } })).toBe(
      onlineOrderRequestHash({ ...r, beneficios: { cupon: 'DIEZ' } }),
    )
  })

  it('la misma llave con otra elección, sobre un folio YA creado ⇒ IDEMPOTENCY_KEY_CONFLICT (final) sin canjear', async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'ord1',
      orderNumber: 'WABCD',
      total: D('90.00'),
      onlineOrder: {
        id: 'oo1',
        status: 'PENDING_ACCEPTANCE',
        trackingToken: 'T'.repeat(32),
        acceptDeadlineAt: NOW,
        requestHash: huella({ beneficios: { premioId: 'r1' } }),
      },
    } as any)
    await expect(createOnlineOrder(input({ beneficios: { puntos: 10 } }), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      final: true,
    })
    expect(aplicarBeneficiosEnTx).not.toHaveBeenCalled()
  })
})

describe('S11 · el folio en $0 (E5, E6)', () => {
  it('«Nadie» en $0 por un premio: se cierra en la MISMA transacción, nace «Por entregar» y lo de después va tras el commit', async () => {
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(
      canje('0.00', { aplicados: [{ tipo: 'PREMIO', nombre: 'Combo gratis', monto: D('100.00'), orderDiscountId: 'od1' }], premio: true }),
    )
    const r = await createOnlineOrder(input({ beneficios: { premioId: 'r1' }, expectedTotal: '0.00' }), PUEDE_CREAR)
    expect(r).toMatchObject({ replay: false, total: '0.00', status: 'ACCEPTED' })
    expect(cerrarFolioEnCeroEnTx).toHaveBeenCalledWith(prismaMock, {
      venueId: 'v1',
      orderId: 'ord1',
      marcarCocina: true,
      minutes: 15,
      reloj: expect.any(Function),
    })
    expect((cerrarFolioEnCeroEnTx as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
      prismaMock.onlineOrder.create.mock.invocationCallOrder[0],
    )
    expect(trasCerrarFolioEnCero).toHaveBeenCalledWith(
      { venueId: 'v1', orderId: 'ord1', staffId: null, marcarCocina: true, minutes: 15 },
      expect.objectContaining({ cerrado: true, postingId: 'post1' }),
    )
    expect(despertarPasesTrasCommit).toHaveBeenCalledWith('v1', ['cust1'])
  })

  it('$0 sin beneficio (el carrito ya vale $0) ⇒ ZERO_TOTAL como hoy, sin canjear', async () => {
    ;(quoteCart as jest.Mock).mockResolvedValue(QUOTE('0.00'))
    await expect(createOnlineOrder(input({ expectedTotal: '0.00' }), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 400,
      code: 'ZERO_TOTAL',
    })
    expect(aplicarBeneficiosEnTx).not.toHaveBeenCalled()
  })

  it('«Mi equipo» en $0 por un beneficio: nace por aceptar como cualquier folio (no se cierra al crear)', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(MI_EQUIPO)
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('0.00'))
    const r = await createOnlineOrder(
      input({ verifiedPhone: PHONE, customer: { name: 'Ana Pérez', phone: PHONE }, beneficios: { premioId: 'r1' }, expectedTotal: '0.00' }),
      PUEDE_CREAR,
    )
    expect(r).toMatchObject({ status: 'PENDING_ACCEPTANCE', total: '0.00' })
    expect(cerrarFolioEnCeroEnTx).not.toHaveBeenCalled()
  })
})

describe('S11 · R8: el folio en $0 entra aunque la tienda sólo acepte tarjeta', () => {
  const SOLO_TARJETA = { ...MI_EQUIPO, config: { ...MI_EQUIPO.config, acceptsPayAtPickup: false, acceptsCardOnline: false } }
  const conTelefono = (o: Record<string, unknown> = {}) =>
    input({ verifiedPhone: PHONE, customer: { name: 'Ana Pérez', phone: PHONE }, beneficios: { premioId: 'r1' }, ...o })

  it('un beneficio que deja el total estricto en $0 ⇒ nace el folio en $0, por aceptar («Mi equipo» conserva la aceptación humana)', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(SOLO_TARJETA)
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('0.00'))
    const r = await createOnlineOrder(conTelefono({ expectedTotal: '0.00' }), PUEDE_CREAR)
    expect(r).toMatchObject({ replay: false, total: '0.00', status: 'PENDING_ACCEPTANCE' })
    expect((prismaMock.onlineOrder.create.mock.calls[0][0] as any).data).toMatchObject({
      paymentMode: 'PAY_AT_PICKUP',
      requiresAcceptance: true,
    })
  })

  it('el mismo con $5 ⇒ el rechazo de hoy (mismo código y texto), guardado como hoy y sin pedido', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(SOLO_TARJETA)
    ;(aplicarBeneficiosEnTx as jest.Mock).mockResolvedValue(canje('5.00'))
    const err = await createOnlineOrder(conTelefono({ expectedTotal: '5.00' }), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_MODE_NOT_ACCEPTED',
      message: 'Este negocio no acepta pagar al recoger.',
      final: true,
    })
    expect(prismaMock.onlineOrder.create).not.toHaveBeenCalled()
    const guardada = (prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data
    expect(guardada).toMatchObject({ organizationId: 'venue:v1', actorStaffId: 'customer:cust1', responseStatus: 400 })
  })
})

describe("S11 · el seguimiento del borrador liberado dice por qué y el precio nuevo (R4, R4')", () => {
  const borrador = (status: string, lastError: string | null = null) => ({
    id: 'ch1',
    status,
    lastError,
    updatedAt: NOW,
    request: { quote: { subtotal: '100', total: '100', lines: [] } },
    amount: D('100.00'),
    checkoutExpiresAt: NOW,
    createdAt: NOW,
    venueId: 'v1',
    venue: {
      name: 'Café',
      slug: 'cafe',
      timezone: 'America/Mexico_City',
      address: null,
      city: null,
      state: null,
      zipCode: null,
      phone: null,
    },
  })
  const motivo = (data: Record<string, unknown>) => prismaMock.activityLog.findFirst.mockResolvedValue({ data } as any)

  beforeEach(() => {
    prismaMock.onlineOrder.findUnique.mockResolvedValue(null)
  })

  it('liberado (RELEASED) porque el premio ya no estaba ⇒ «no se te cobró» y el precio nuevo con lo descartado', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador('RELEASED') as any)
    motivo({ motivo: 'BENEFIT_GONE', cual: 'PREMIO', totalEstricto: '90.00', descartados: ['PREMIO'] })
    const { getTrackingByToken } = await import('@/services/online-ordering/order.service')
    const t = await getTrackingByToken('T'.repeat(32))
    expect(t).toMatchObject({
      status: 'PAYMENT_NOT_COMPLETED',
      cardStatus: 'RELEASED',
      precioNuevo: {
        motivo: 'BENEFIT_GONE',
        total: 90,
        descartados: ['PREMIO'],
        mensaje: 'Tu beneficio ya no estaba: no se te cobró. Confirma el precio nuevo.',
      },
    })
    expect(prismaMock.activityLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entity: 'OnlineOrderCharge', entityId: 'ch1', action: 'ONLINE_ORDER_CARD_PRICE_CHANGED' } }),
    )
  })

  it("R4': el total cambió (incluso a $0) ⇒ precioNuevo con el total estricto que se calculó al confirmar", async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador('RELEASED') as any)
    motivo({ motivo: 'PRICE_CHANGED', cual: null, totalEstricto: '0.00', descartados: [] })
    const { getTrackingByToken } = await import('@/services/online-ordering/order.service')
    expect(await getTrackingByToken('T'.repeat(32))).toMatchObject({
      precioNuevo: {
        motivo: 'PRICE_CHANGED',
        total: 0,
        descartados: [],
        mensaje: 'El total de tu pedido cambió: no se te cobró. Confirma el precio nuevo.',
      },
    })
  })

  it('con la liberación en curso (RELEASING) nunca dice «no se te cobró»; cobrada fuera (CAPTURED_OUTSIDE) tampoco', async () => {
    const { getTrackingByToken } = await import('@/services/online-ordering/order.service')
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador('RELEASING') as any)
    motivo({ motivo: 'BENEFIT_GONE', cual: 'PREMIO', totalEstricto: '90.00', descartados: ['PREMIO'] })
    const enCurso = await getTrackingByToken('T'.repeat(32))
    expect(enCurso).toMatchObject({ cardStatus: 'RELEASING', precioNuevo: { motivo: 'BENEFIT_GONE', total: 90 } })
    expect(enCurso!.precioNuevo!.mensaje).not.toMatch(/no se te cobró/)
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador('CAPTURED', 'CAPTURED_OUTSIDE') as any)
    const fuera = await getTrackingByToken('T'.repeat(32))
    expect(fuera).toMatchObject({ cardStatus: 'CAPTURED' })
    expect(fuera!.precioNuevo?.mensaje ?? '').not.toMatch(/no se te cobró/)
  })

  it('un borrador sin motivo (vencido, abandonado) no trae precioNuevo', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador('RELEASED') as any)
    prismaMock.activityLog.findFirst.mockResolvedValue(null)
    const { getTrackingByToken } = await import('@/services/online-ordering/order.service')
    expect(await getTrackingByToken('T'.repeat(32))).not.toHaveProperty('precioNuevo')
  })
})
