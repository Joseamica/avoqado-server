/**
 * V5-A paso 4 (diseño v5.1): la regla común que TODO camino pasa antes de abrir una confirmación de pago.
 *
 * Orden: candado por negocio (sin espera) → alta económica en curso → expirar confirmaciones abiertas → inventario de
 * Stripe → compatibilidad → recién entonces crear. Cada paso que falla detiene los siguientes.
 */
import { prismaMock } from '../../../__helpers__/setup'

const mockListSessions = jest.fn()
const mockExpire = jest.fn()
const mockRetrieveSession = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  stripe: {
    checkout: {
      sessions: {
        list: (...a: unknown[]) => mockListSessions(...a),
        expire: (...a: unknown[]) => mockExpire(...a),
        retrieve: (...a: unknown[]) => mockRetrieveSession(...a),
      },
    },
  },
}))
const mockInventario = jest.fn()
jest.mock('@/services/access/inventarioDeObligaciones', () => ({ inventarioDeObligaciones: (...a: unknown[]) => mockInventario(...a) }))
const mockRegistrar = jest.fn()
const mockAvisar = jest.fn()
jest.mock('@/services/access/conflictosDeObligacion.service', () => ({
  registrarConflictoDeObligacion: (...a: unknown[]) => mockRegistrar(...a),
  avisarConflictoCreado: (...a: unknown[]) => mockAvisar(...a),
}))
jest.mock('stripe')

import { autorizarObligacionNueva } from '@/services/access/autorizarObligacionNueva'

const crear = jest.fn()
const correr = (intencion: Parameters<typeof autorizarObligacionNueva>[2] = { tipo: 'PLAN', tier: 'PRO' }) =>
  autorizarObligacionNueva('cven1', 'cus_1', intencion, crear)

beforeEach(() => {
  crear.mockReset().mockResolvedValue('https://checkout.stripe.com/c/pay/cs_nueva')
  mockListSessions.mockReset().mockResolvedValue({ data: [], has_more: false })
  mockExpire.mockReset().mockResolvedValue({ status: 'expired' })
  mockRetrieveSession.mockReset()
  mockInventario.mockReset().mockResolvedValue({ vivas: [], detalle: {}, conCambiosProgramados: [] })
  mockRegistrar.mockReset().mockResolvedValue('CREADO')
  prismaMock.$transaction.mockImplementation(async (cb: (tx: never) => Promise<unknown>) => cb(prismaMock as never))
  prismaMock.$queryRaw.mockReset().mockResolvedValue([{ tomado: true }] as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    organization: { onboardingCompletedAt: new Date(), onboardingProgress: { completedAt: new Date(), planActivationStatus: 'ACTIVE' } },
  } as never)
})

describe('autorizarObligacionNueva', () => {
  it('compatible: crea DESPUÉS de todas las comprobaciones y devuelve lo creado', async () => {
    await expect(correr()).resolves.toBe('https://checkout.stripe.com/c/pay/cs_nueva')
    const orden = [prismaMock.$queryRaw, mockListSessions, mockInventario, crear].map(f => (f as jest.Mock).mock.invocationCallOrder[0])
    expect(orden).toEqual([...orden].sort((a, b) => a - b))
  })

  it('🔴 el candado es por NEGOCIO y sin espera: si otra compra lo tiene, 409 sin tocar Stripe', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ tomado: false }] as never)

    await expect(correr()).rejects.toMatchObject({ statusCode: 409, code: 'PURCHASE_IN_PROGRESS' })
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as string[]).join('?')
    expect(sql).toMatch(/pg_try_advisory_xact_lock/)
    expect(prismaMock.$queryRaw.mock.calls[0].slice(1)).toContain('stripe-obligaciones:cven1')
    expect(mockListSessions).not.toHaveBeenCalled()
    expect(crear).not.toHaveBeenCalled()
  })

  it.each([
    [
      'marca temprana puesta sin marca de organización',
      { onboardingCompletedAt: null, onboardingProgress: { completedAt: new Date(), planActivationStatus: 'NONE' } },
    ],
    [
      'cobro de activate-plan en curso',
      {
        onboardingCompletedAt: null,
        onboardingProgress: {
          completedAt: null,
          planActivationStatus: 'IN_PROGRESS',
          planActivationLeaseUntil: new Date(Date.now() + 60_000),
        },
      },
    ],
  ])('🔴 alta económica en curso (%s): 409 y no se abre nada', async (_n, organization) => {
    prismaMock.venue.findUnique.mockResolvedValue({ organization } as never)

    await expect(correr()).rejects.toMatchObject({ statusCode: 409, code: 'ONBOARDING_BILLING_IN_PROGRESS' })
    expect(crear).not.toHaveBeenCalled()
  })

  it.each([
    [
      'marca temprana VIEJA sin marca de organización (Berthe en producción: alta del 8-dic-2025)',
      { onboardingCompletedAt: null, onboardingProgress: { completedAt: new Date('2025-12-08T18:00:00Z'), planActivationStatus: 'NONE' } },
    ],
    [
      'activate-plan IN_PROGRESS con el lease VENCIDO',
      {
        onboardingCompletedAt: null,
        onboardingProgress: {
          completedAt: null,
          planActivationStatus: 'IN_PROGRESS',
          planActivationLeaseUntil: new Date(Date.now() - 60_000),
        },
      },
    ],
  ])('🔴 sin un cobro que pueda estar EN VUELO (%s) NO se bloquea para siempre: protege lo vivo en Stripe', async (_n, organization) => {
    prismaMock.venue.findUnique.mockResolvedValue({ organization } as never)

    await expect(correr()).resolves.toBeDefined()
    expect(mockInventario).toHaveBeenCalled()
    expect(crear).toHaveBeenCalled()
  })

  it('🔴 V5-A paso 6: el PROPIO alta (que marca «cobro en curso» antes de cobrar) pasa por la regla sin bloquearse a sí misma', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({
      organization: { onboardingCompletedAt: null, onboardingProgress: { completedAt: null, planActivationStatus: 'IN_PROGRESS' } },
    } as never)

    await expect(
      autorizarObligacionNueva('cven1', 'cus_1', { tipo: 'PLAN', tier: 'PRO' }, crear, { desdeElAlta: true }),
    ).resolves.toBeDefined()
    expect(crear).toHaveBeenCalled()
  })

  it('…pero sigue sin cobrar encima de un plan vivo', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({
      organization: { onboardingCompletedAt: null, onboardingProgress: { completedAt: null, planActivationStatus: 'IN_PROGRESS' } },
    } as never)
    mockInventario.mockResolvedValue({
      vivas: [{ subscriptionId: 's_pro', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
      detalle: {},
      conCambiosProgramados: [],
    })

    await expect(
      autorizarObligacionNueva('cven1', 'cus_1', { tipo: 'PLAN', tier: 'PRO' }, crear, { desdeElAlta: true }),
    ).rejects.toMatchObject({
      code: 'PLAN_YA_CONTRATADO',
    })
    expect(crear).not.toHaveBeenCalled()
  })

  it('una organización anterior al wizard (sin progreso ni marca) NO se bloquea', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organization: { onboardingCompletedAt: null, onboardingProgress: null } } as never)
    await expect(correr()).resolves.toBeDefined()
  })

  it('🔴 expira las confirmaciones abiertas NUESTRAS (también las legacy de plan) y deja las ajenas', async () => {
    mockListSessions.mockResolvedValue({
      data: [
        { id: 'cs_nueva_kind', metadata: { kind: 'PLAN_CHECKOUT' } },
        { id: 'cs_legacy', metadata: { tierCode: 'PLAN_PREMIUM', venueId: 'cven1' } },
        { id: 'cs_terminal', metadata: { terminalOrderId: 'to_1' } },
      ],
      has_more: false,
    })

    await correr()

    expect(mockListSessions).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1', status: 'open' }), expect.anything())
    expect(mockExpire.mock.calls.map(c => c[0]).sort()).toEqual(['cs_legacy', 'cs_nueva_kind'])
  })

  it('🔴 si una abierta ya se COMPLETÓ (el expire falla y está complete): 409 y no se abre otra', async () => {
    mockListSessions.mockResolvedValue({ data: [{ id: 'cs_pagada', metadata: { kind: 'PLAN_CHECKOUT' } }], has_more: false })
    mockExpire.mockRejectedValue(new Error('session is not open'))
    mockRetrieveSession.mockResolvedValue({ id: 'cs_pagada', status: 'complete' })

    await expect(correr()).rejects.toMatchObject({ statusCode: 409, code: 'PURCHASE_ALREADY_COMPLETED' })
    expect(crear).not.toHaveBeenCalled()
  })

  it('si el expire falla pero ya está expirada, se sigue', async () => {
    mockListSessions.mockResolvedValue({ data: [{ id: 'cs_vieja', metadata: { kind: 'PLAN_CHECKOUT' } }], has_more: false })
    mockExpire.mockRejectedValue(new Error('session is not open'))
    mockRetrieveSession.mockResolvedValue({ id: 'cs_vieja', status: 'expired' })

    await expect(correr()).resolves.toBeDefined()
  })

  it('🔴 si no se pudo saber en qué quedó una abierta: 503 y no se abre otra', async () => {
    mockListSessions.mockResolvedValue({ data: [{ id: 'cs_x', metadata: { kind: 'PLAN_CHECKOUT' } }], has_more: false })
    mockExpire.mockRejectedValue(new Error('timeout'))
    mockRetrieveSession.mockRejectedValue(new Error('timeout'))

    await expect(correr()).rejects.toMatchObject({ statusCode: 503 })
    expect(crear).not.toHaveBeenCalled()
  })

  it('🔴 más confirmaciones abiertas de las que se ven (has_more): 503', async () => {
    mockListSessions.mockResolvedValue({ data: [], has_more: true })

    await expect(correr()).rejects.toMatchObject({ statusCode: 503 })
    expect(crear).not.toHaveBeenCalled()
  })

  it('🔴 incompatible con lo vivo en Stripe: 409 con el código y las suscripciones', async () => {
    mockInventario.mockResolvedValue({
      vivas: [{ subscriptionId: 's_pro', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
      detalle: {},
      conCambiosProgramados: [],
    })

    await expect(correr({ tipo: 'PLAN', tier: 'PREMIUM' })).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_YA_CONTRATADO' })
    expect(crear).not.toHaveBeenCalled()
  })

  it('🔴 lo DESCONOCIDO se registra como conflicto durable (una vez por suscripción) y bloquea', async () => {
    mockInventario.mockResolvedValue({
      vivas: [{ subscriptionId: 's_x', proyecciones: [{ tipo: 'DESCONOCIDO', productId: 'prod_misterio' }] }],
      detalle: { s_x: { status: 'active', customerId: 'cus_1', variosItems: false } },
      conCambiosProgramados: [],
    })

    await expect(correr()).rejects.toMatchObject({ statusCode: 409, code: 'OBLIGACION_DESCONOCIDA' })
    expect(mockRegistrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ venueId: 'cven1', subscriptionId: 's_x', kind: 'UNKNOWN_PRODUCT', customerId: 'cus_1' }),
    )
    expect(crear).not.toHaveBeenCalled()
  })

  it('🔴 el conflicto registrado SOBREVIVE al rechazo: la transacción confirma y el 409 sale después; se audita tras confirmar', async () => {
    let transaccion: 'CONFIRMADA' | 'REVERTIDA' | null = null
    prismaMock.$transaction.mockImplementation(async (cb: (tx: never) => Promise<unknown>) => {
      try {
        const r = await cb(prismaMock as never)
        transaccion = 'CONFIRMADA'
        return r
      } catch (e) {
        transaccion = 'REVERTIDA'
        throw e
      }
    })
    mockInventario.mockResolvedValue({
      vivas: [{ subscriptionId: 's_x', proyecciones: [{ tipo: 'DESCONOCIDO', productId: 'prod_misterio' }] }],
      detalle: { s_x: { status: 'active', customerId: 'cus_1', variosItems: false } },
      conCambiosProgramados: [],
    })

    await expect(correr()).rejects.toMatchObject({ code: 'OBLIGACION_DESCONOCIDA' })
    expect(transaccion).toBe('CONFIRMADA')
    // Codex C11: además de la bitácora, un correo a operaciones (los dos los hace el aviso, sólo al CREARLO).
    expect(mockAvisar).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: expect.any(String), subscriptionId: 's_x', kind: 'UNKNOWN_PRODUCT' }),
    )
  })

  it('🔴 una obligación con cambios PROGRAMADOS no verificables bloquea: 409 CAMBIOS_PROGRAMADOS', async () => {
    mockInventario.mockResolvedValue({ vivas: [], detalle: {}, conCambiosProgramados: ['s_prog'] })

    await expect(correr()).rejects.toMatchObject({ statusCode: 409, code: 'CAMBIOS_PROGRAMADOS' })
    expect(crear).not.toHaveBeenCalled()
  })

  it('un error del inventario (503) se propaga tal cual', async () => {
    mockInventario.mockRejectedValue(Object.assign(new Error('no pude ver'), { statusCode: 503, code: 'OBLIGATIONS_UNVERIFIED' }))

    await expect(correr()).rejects.toMatchObject({ statusCode: 503, code: 'OBLIGATIONS_UNVERIFIED' })
    expect(crear).not.toHaveBeenCalled()
  })
})

describe('🔴 Codex C3: nada bajo el candado puede sobrevivir a su transacción', () => {
  it('Stripe sin reintentos del SDK; el inventario recibe el presupuesto; la transacción dura más que el peor caso', async () => {
    await correr()

    expect(mockListSessions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }),
    )
    expect(mockInventario).toHaveBeenCalledWith('cven1', expect.objectContaining({ limite: expect.any(Number) }))
    expect((prismaMock.$transaction as jest.Mock).mock.calls[0][1].timeout).toBeGreaterThanOrEqual(150_000)
  })

  it('si las lecturas agotaron el presupuesto, NO se crea nada: 503', async () => {
    const ahora = Date.now()
    const reloj = jest.spyOn(Date, 'now')
    mockInventario.mockImplementation(async () => {
      reloj.mockReturnValue(ahora + 10 * 60_000)
      return { vivas: [], detalle: {}, conCambiosProgramados: [] }
    })

    await expect(correr()).rejects.toMatchObject({ statusCode: 503, code: 'OBLIGATIONS_UNVERIFIED' })
    expect(crear).not.toHaveBeenCalled()
    reloj.mockRestore()
  })
})
