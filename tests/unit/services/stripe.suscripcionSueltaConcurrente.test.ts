/**
 * Auditorías de Codex del 21-sep-2026 sobre la coexistencia plan ↔ funciones sueltas.
 *
 * #2 (P1): `createTrialSubscriptions` leía «sin suscripción», creaba en Stripe y cerraba con un
 *     `upsert` incondicional: dos compras simultáneas creaban DOS suscripciones y la segunda pisaba
 *     el vínculo de la primera, que quedaba cobrando sin que nada local la apuntara.
 *
 *     🔴 La ronda 4 RECHAZÓ el primer arreglo (llave de idempotencia DERIVADA del vínculo leído +
 *     compensación tras perder el CAS) con tres regresiones propias: una recompra tras borrar el
 *     vínculo reusaba la llave `:none` y Stripe devolvía el cuerpo GUARDADO de una suscripción ya
 *     cancelada (R4-2); cambiar de tarjeta en un reintento daba `idempotency_error` (R4-3); y la
 *     compensación podía cancelar la suscripción que la otra compra SÍ ligó, porque las dos recibían
 *     la misma por la llave compartida (R4-4).
 *
 *     El diseño nuevo no deduplica POR LLAVE entre compras: las SERIALIZA con un candado de base por
 *     (venue, función) que cubre leer → crear → ligar. La llave es única por invocación y sólo
 *     protege los reintentos de red de ESA llamada. Así la suscripción creada es propiedad exclusiva
 *     de quien la creó, y compensarla no puede tocar la de nadie más.
 * #7 (P1): al recomprar una suelta `past_due` se pagaba la factura pero «¿quedó activa?» salía de
 *     la foto VIEJA. Y R4-7: la recompra que queda activa conservaba `suspendedAt` del ciclo anterior,
 *     así que el resolver seguía negando el acceso pagado.
 */
const mockSubRetrieve = jest.fn()
const mockSubCreate = jest.fn()
const mockSubCancel = jest.fn()
const mockInvoicePay = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockSubRetrieve, create: mockSubCreate, cancel: mockSubCancel },
    invoices: { pay: mockInvoicePay },
  })),
)

const orden: string[] = []
const mockLock = jest.fn()
const mockVfFindUnique = jest.fn()
const mockVfUpdateMany = jest.fn()
const mockVfCreate = jest.fn()
const venueFeature = {
  findUnique: (...a: unknown[]) => {
    orden.push('leer')
    return mockVfFindUnique(...a)
  },
  updateMany: (...a: unknown[]) => mockVfUpdateMany(...a),
  create: (...a: unknown[]) => mockVfCreate(...a),
  update: jest.fn().mockResolvedValue({}),
}
const tx = {
  $queryRaw: (...a: unknown[]) => {
    orden.push('candado')
    return mockLock(...a)
  },
  $executeRaw: () => Promise.resolve(0),
  venueFeature,
}
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn().mockResolvedValue({ name: 'Cafe', slug: 'cafe' }) },
    feature: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'feat-inv', code: 'INVENTORY_TRACKING', name: 'Inventario', stripePriceId: 'price_inv', monthlyPrice: 89 }]),
    },
    venueFeature,
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}))
jest.mock('../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
// Estas pruebas prueban la compra con la venta suelta ABIERTA; la cerrada tiene su propio bloque.
const mockVentaAbierta = jest.fn(() => true)
jest.mock('../../../src/services/access/ventaSuelta', () => ({ ventaSueltaAbierta: () => mockVentaAbierta() }))

import { createTrialSubscriptions } from '../../../src/services/stripe.service'

const errorDeRed = () => Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' })

beforeEach(() => {
  jest.clearAllMocks()
  // `clearAllMocks` NO vacía la cola de `mockResolvedValueOnce`: una respuesta sobrante se colaría
  // en la prueba siguiente.
  for (const m of [mockSubRetrieve, mockSubCreate, mockSubCancel, mockInvoicePay, mockLock, mockVfFindUnique, mockVfUpdateMany, mockVfCreate]) {
    m.mockReset()
  }
  orden.length = 0
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockLock.mockResolvedValue([{ tomado: true }])
  mockSubCreate.mockResolvedValue({ id: 'sub_nueva', status: 'trialing' })
  mockVfUpdateMany.mockResolvedValue({ count: 1 })
  mockVfCreate.mockResolvedValue({})
  mockSubCancel.mockResolvedValue({ id: 'sub_nueva', status: 'canceled' })
})

describe('#2 · las compras de la MISMA función se serializan con un candado', () => {
  it('🔴 lee el vínculo sólo DESPUÉS de haber adquirido el candado de (venue, función)', async () => {
    mockVfFindUnique.mockResolvedValue(null)
    // El candado tarda en concederse: si el código no lo ESPERA, la lectura se adelanta.
    mockLock.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 10))
      orden.push('adquirido')
      return [{ tomado: true }]
    })

    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)

    expect(orden.slice(0, 3)).toEqual(['candado', 'adquirido', 'leer'])
    expect((mockLock.mock.calls[0][0] as string[]).join('?')).toContain('pg_try_advisory_xact_lock')
    // El candado va por venue Y función: comprar inventario no espera a quien compra lealtad.
    const valores = mockLock.mock.calls[0].slice(1)
    expect(valores).toContain('venue-feature-sub:v1:feat-inv')
  })
})

describe('#2 · la llave de idempotencia es de UNA invocación, nunca compartida entre compras', () => {
  it('🔴 R4-2: dos compras con el vínculo vacío usan llaves DISTINTAS (una recompra nunca recibe el cuerpo guardado de otra)', async () => {
    mockVfFindUnique.mockResolvedValue(null)

    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)
    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)

    const llaves = mockSubCreate.mock.calls.map(c => c[1]?.idempotencyKey)
    expect(llaves[0]).toMatch(/^venue-feature-sub:v1:feat-inv:/)
    expect(llaves[0]).not.toBe(llaves[1])
  })

  it('los REINTENTOS de red de una misma llamada reusan su llave (Stripe no duplica)', async () => {
    mockVfFindUnique.mockResolvedValue(null)
    mockSubCreate.mockRejectedValueOnce(errorDeRed()).mockResolvedValue({ id: 'sub_nueva', status: 'trialing' })

    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)

    expect(mockSubCreate).toHaveBeenCalledTimes(2)
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe(mockSubCreate.mock.calls[1][1].idempotencyKey)
  })
})

describe('#2 · si otro escritor movió el vínculo, sólo se compensa lo que ESTA llamada creó', () => {
  it('🔴 CAS perdido tras CREAR: cancela la suya y falla, sin intentar cobrarla', async () => {
    mockVfFindUnique.mockResolvedValueOnce({ id: 'vf1', stripeSubscriptionId: null }).mockResolvedValue({ id: 'vf1', stripeSubscriptionId: null })
    mockVfUpdateMany.mockResolvedValue({ count: 0 })

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 0)).rejects.toThrow()

    expect(mockSubCancel).toHaveBeenCalledWith('sub_nueva')
    // R4-5: se cancela ANTES de pagar la primera factura — no hay cobro que devolver.
    expect(mockInvoicePay).not.toHaveBeenCalled()
  })

  it('🔴 R4-4: CAS perdido con una suscripción REUSADA (no creada aquí): no la cancela', async () => {
    mockVfFindUnique
      .mockResolvedValueOnce({ id: 'vf1', stripeSubscriptionId: 'sub_viva' }) // dentro del candado
      .mockResolvedValueOnce({ id: 'vf1', stripeSubscriptionId: 'sub_de_otro_escritor' }) // relectura tras perder el CAS
    mockSubRetrieve.mockResolvedValue({ id: 'sub_viva', status: 'active' })
    mockVfUpdateMany.mockResolvedValue({ count: 0 })

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)).rejects.toThrow()

    expect(mockSubCancel).not.toHaveBeenCalled()
  })

  it('🔴 R4-1: si la escritura local revienta tras crear, cancela la creada y propaga el error', async () => {
    mockVfFindUnique.mockResolvedValue(null)
    mockVfCreate.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'P1017' }))

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)).rejects.toThrow(/Failed to create 1 subscription/)

    expect(mockSubCancel).toHaveBeenCalledWith('sub_nueva')
  })

  it('si la escritura sí quedó ligada a la creada (el fallo vino después), NO la cancela', async () => {
    mockVfFindUnique
      .mockResolvedValueOnce(null) // dentro del candado
      .mockResolvedValueOnce({ id: 'vf1', stripeSubscriptionId: 'sub_nueva' }) // relectura tras el fallo
    mockVfCreate.mockRejectedValue(Object.assign(new Error('commit ambiguo'), { code: 'P2028' }))

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)).rejects.toThrow()

    expect(mockSubCancel).not.toHaveBeenCalled()
  })

  it('la escritura del vínculo es CONDICIONAL a la suscripción que se leyó', async () => {
    mockVfFindUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: null })

    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)

    expect(mockVfUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'vf1', stripeSubscriptionId: null } }))
  })
})

describe('#7 · recomprar una suelta atrasada no pisa la recuperación', () => {
  it('🔴 tras pagar la factura, «¿quedó activa?» sale del estado VIGENTE, no de la foto de antes', async () => {
    mockVfFindUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_atrasada' })
    mockSubRetrieve
      .mockResolvedValueOnce({ id: 'sub_atrasada', status: 'past_due', latest_invoice: 'in_1' }) // antes de pagar
      .mockResolvedValueOnce({ id: 'sub_atrasada', status: 'active' }) // después de pagar
    mockInvoicePay.mockResolvedValue({ id: 'in_1', status: 'paid' })

    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 0)

    const escrito = mockVfUpdateMany.mock.calls[0][0].data
    expect(escrito.active).toBe(true)
  })

  it('🔴 R4-7: la recompra que queda ACTIVA limpia las banderas de cobranza del ciclo anterior', async () => {
    mockVfFindUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_cancelada' })
    mockSubRetrieve.mockResolvedValue({ id: 'sub_cancelada', status: 'canceled' })
    mockSubCreate.mockResolvedValue({ id: 'sub_nueva', status: 'active' })

    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 0)

    const escrito = mockVfUpdateMany.mock.calls[0][0].data
    expect(escrito).toMatchObject({ active: true, suspendedAt: null, gracePeriodEndsAt: null, paymentFailureCount: 0 })
  })

  it('si tras pagar SIGUE atrasada, NO borra la suspensión (la cobranza sigue viva)', async () => {
    mockVfFindUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_atrasada' })
    mockSubRetrieve.mockResolvedValue({ id: 'sub_atrasada', status: 'past_due', latest_invoice: 'in_1' })
    mockInvoicePay.mockRejectedValue(new Error('card_declined'))

    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 0)

    const escrito = mockVfUpdateMany.mock.calls[0][0].data
    expect(escrito).not.toHaveProperty('suspendedAt')
    expect(escrito.active).toBe(false)
  })
})

describe('ronda 5 · el candado no retiene conexiones y Stripe cabe en la transacción (P2-7)', () => {
  it('🔴 si otra compra de la misma función tiene el candado, falla YA sin esperar ni tocar Stripe', async () => {
    mockVfFindUnique.mockResolvedValue(null)
    mockLock.mockResolvedValue([{ tomado: false }])

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)).rejects.toThrow(/en curso/)

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockVfFindUnique).not.toHaveBeenCalled()
  })

  it('🔴 la creación lleva tiempo máximo propio y sin reintentos internos del SDK', async () => {
    mockVfFindUnique.mockResolvedValue(null)

    await createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)

    expect(mockSubCreate.mock.calls[0][1]).toMatchObject({ timeout: 15_000, maxNetworkRetries: 0 })
  })
})

describe('ronda 5 · la compensación decide DESPUÉS de que la transacción anterior terminó (P1-5)', () => {
  it('🔴 antes de releer, vuelve a tomar el candado (espera a que el commit en vuelo termine)', async () => {
    mockVfFindUnique.mockResolvedValue(null)
    mockVfCreate.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'P1017' }))

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)).rejects.toThrow()

    // La segunda toma es BLOQUEANTE (espera), no la de «probar y seguir».
    const segunda = (mockLock.mock.calls[1]?.[0] as string[] | undefined)?.join('?') ?? ''
    expect(segunda).toContain('pg_advisory_xact_lock')
    expect(segunda).not.toContain('pg_try')
    expect(orden.slice(-2)).toEqual(['candado', 'leer'])
    expect(mockSubCancel).toHaveBeenCalledWith('sub_nueva')
  })

  it('🔴 si no se logra tomar el candado para compensar, NO cancela (el desenlace es incierto)', async () => {
    mockVfFindUnique.mockResolvedValue(null)
    mockVfCreate.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'P1017' }))
    mockLock.mockResolvedValueOnce([{ tomado: true }]).mockRejectedValueOnce(new Error('lock timeout'))

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)).rejects.toThrow()

    expect(mockSubCancel).not.toHaveBeenCalled()
  })
})

describe('ronda 5 · si falla la relectura tras pagar, no se escribe la foto vieja (P1-6)', () => {
  it('🔴 aborta sin tocar el vínculo: el webhook que activó la fila no se pisa con active:false', async () => {
    mockVfFindUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_atrasada' })
    mockSubRetrieve
      .mockResolvedValueOnce({ id: 'sub_atrasada', status: 'past_due', latest_invoice: 'in_1' })
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    mockInvoicePay.mockResolvedValue({ id: 'in_1', status: 'paid' })

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 0)).rejects.toThrow()

    expect(mockVfUpdateMany).not.toHaveBeenCalled()
    expect(mockSubCancel).not.toHaveBeenCalled()
  })
})

describe('venta suelta CERRADA (founder, 21-sep): el candado vive en la RAÍZ', () => {
  afterEach(() => mockVentaAbierta.mockReturnValue(true))

  it('🔴 con la venta cerrada, createTrialSubscriptions no crea NADA en Stripe ni en la base', async () => {
    mockVentaAbierta.mockReturnValue(false)
    mockVfFindUnique.mockResolvedValue(null)

    await expect(createTrialSubscriptions('cus_1', 'v1', ['INVENTORY_TRACKING'], 5)).rejects.toThrow(/cerrada/)

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockVfCreate).not.toHaveBeenCalled()
    expect(mockLock).not.toHaveBeenCalled()
  })
})
