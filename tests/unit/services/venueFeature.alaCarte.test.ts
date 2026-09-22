/**
 * La puerta à-la-carte (`addFeaturesToVenue`) — dos P1 de la auditoría del 21-sep-2026.
 *
 * #3: por esta ruta se podía contratar `PLAN_PREMIUM` como si fuera una función suelta,
 *     saltándose el guard del checkout de planes (que sí rechaza un segundo plan activo).
 * #8: los días de prueba venían en el body del cliente (`0..365`), así que quien pudiera
 *     comprar podía regalarse un año.
 */
const mockCreateTrialSubscriptions = jest.fn()
const mockCancelSubscription = jest.fn()
const mockEstado = jest.fn()

jest.mock('../../../src/services/stripe.service', () => ({
  createTrialSubscriptions: (...args: unknown[]) => mockCreateTrialSubscriptions(...args),
  stripeAfirmaQueNoExiste: (e: any) => e?.code === 'resource_missing',
  estadoDeLaSuscripcion: (...args: unknown[]) => mockEstado(...args),
  cancelSubscription: (...args: unknown[]) => mockCancelSubscription(...args),
}))

const mockVenueFindUnique = jest.fn()
const mockVenueFeatureFindMany = jest.fn()
const mockVenueFeatureFindFirst = jest.fn()
const mockVenueFeatureUpdate = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...a) },
    venueFeature: {
      findMany: (...a: unknown[]) => mockVenueFeatureFindMany(...a),
      findFirst: (...a: unknown[]) => mockVenueFeatureFindFirst(...a),
      update: (...a: unknown[]) => mockVenueFeatureUpdate(...a),
      // R0: la baja apaga con CAS contra el vínculo cancelado (updateMany).
      updateMany: (...a: unknown[]) => mockVenueFeatureUpdate(...a),
    },
  },
}))

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { addFeaturesToVenue, removeFeatureFromVenue } from '../../../src/services/dashboard/venueFeature.dashboard.service'

const venueListo = {
  id: 'venue-1',
  name: 'Testarudo',
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
  seatCapExempt: false,
  organization: { seatCapExempt: false },
  features: [],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenueFindUnique.mockResolvedValue(venueListo)
  mockVenueFeatureFindMany.mockResolvedValue([])
  mockCreateTrialSubscriptions.mockResolvedValue([])
  mockVenueFeatureUpdate.mockResolvedValue({ count: 1 })
})

describe('addFeaturesToVenue — un PLAN no se contrata por la puerta de las funciones sueltas', () => {
  it('rechaza PLAN_PREMIUM', async () => {
    await expect(addFeaturesToVenue('venue-1', ['PLAN_PREMIUM'])).rejects.toThrow(/plan/i)
    expect(mockCreateTrialSubscriptions).not.toHaveBeenCalled()
  })

  it('rechaza PLAN_PRO aunque venga mezclado con una suelta legítima', async () => {
    await expect(addFeaturesToVenue('venue-1', ['INVENTORY_TRACKING', 'PLAN_PRO'])).rejects.toThrow(/plan/i)
    // 🔴 todo-o-nada: no puede colarse la suelta y perderse el rechazo del plan
    expect(mockCreateTrialSubscriptions).not.toHaveBeenCalled()
  })

  it('rechaza ANTES de tocar la base o Stripe', async () => {
    await expect(addFeaturesToVenue('venue-1', ['PLAN_PRO'])).rejects.toThrow()
    expect(mockVenueFindUnique).not.toHaveBeenCalled()
  })

  it('deja pasar una función suelta de verdad', async () => {
    await expect(addFeaturesToVenue('venue-1', ['INVENTORY_TRACKING'])).resolves.toBeDefined()
  })
})

describe('addFeaturesToVenue — los días de prueba los decide el SERVIDOR', () => {
  it('usa la política del servidor, no un número que mande quien compra', async () => {
    await addFeaturesToVenue('venue-1', ['INVENTORY_TRACKING'])
    const diasQueViajaronAStripe = mockCreateTrialSubscriptions.mock.calls[0]?.[3]
    expect(diasQueViajaronAStripe).toBe(5)
  })

  it('la firma ya no acepta un trial del cliente', () => {
    // 4 parámetros del cliente sería la firma vieja (venueId, codes, trialDays, paymentMethodId).
    expect(addFeaturesToVenue.length).toBeLessThanOrEqual(3)
  })
})

/**
 * Otra forma de cobrar doble, encontrada el 21-sep al diseñar la fase 2: se podía comprar SUELTA una
 * función que el plan del negocio YA incluye (un PRO pagando $599 por lealtad, que su plan trae).
 * El paywall no la ofrece porque el acceso ya está concedido, pero la API la vendía igual.
 */
describe('addFeaturesToVenue — no se vende suelto lo que el plan ya incluye', () => {
  const conPlan = (code: 'PLAN_PRO' | 'PLAN_PREMIUM') => {
    mockVenueFeatureFindMany.mockImplementation((args: any) =>
      args?.where?.feature?.code?.in?.includes?.('PLAN_PRO')
        ? [{ active: true, suspendedAt: null, endDate: null, feature: { code } }]
        : [],
    )
  }

  it('🔴 un PRO no puede comprar suelta una función que PRO incluye', async () => {
    conPlan('PLAN_PRO')
    await expect(addFeaturesToVenue('venue-1', ['LOYALTY_PROGRAM'])).rejects.toMatchObject({
      statusCode: 409,
      code: 'FEATURE_INCLUDED_IN_PLAN',
    })
    expect(mockCreateTrialSubscriptions).not.toHaveBeenCalled()
  })

  it('un PRO SÍ puede comprar suelta una función exclusiva de PREMIUM', async () => {
    conPlan('PLAN_PRO')
    await expect(addFeaturesToVenue('venue-1', ['INVENTORY_TRACKING'])).resolves.toBeDefined()
    expect(mockCreateTrialSubscriptions).toHaveBeenCalled()
  })

  it('un PREMIUM no puede comprar suelta nada de lo que su plan trae', async () => {
    conPlan('PLAN_PREMIUM')
    await expect(addFeaturesToVenue('venue-1', ['INVENTORY_TRACKING'])).rejects.toMatchObject({ code: 'FEATURE_INCLUDED_IN_PLAN' })
  })

  it('🔴 lo que es gratis para todos (CHATBOT) no se vende ni sin plan', async () => {
    await expect(addFeaturesToVenue('venue-1', ['CHATBOT'])).rejects.toMatchObject({ code: 'FEATURE_INCLUDED_IN_PLAN' })
  })

  it('todo o nada: si una de las pedidas ya está incluida, no se compra ninguna', async () => {
    conPlan('PLAN_PRO')
    await expect(addFeaturesToVenue('venue-1', ['INVENTORY_TRACKING', 'LOYALTY_PROGRAM'])).rejects.toMatchObject({
      code: 'FEATURE_INCLUDED_IN_PLAN',
    })
    expect(mockCreateTrialSubscriptions).not.toHaveBeenCalled()
  })

  it('sin plan, una función de PRO sí se puede comprar suelta', async () => {
    await expect(addFeaturesToVenue('venue-1', ['LOYALTY_PROGRAM'])).resolves.toBeDefined()
  })
})

/**
 * Hallazgo #6: `removeFeatureFromVenue` capturaba el fallo de Stripe, desactivaba igual y el
 * controlador respondía «subscription canceled successfully». El cliente perdía el acceso y
 * SEGUÍA PAGANDO. El comentario del código decía «admin can manually cancel» — nadie se enteraba.
 */
describe('removeFeatureFromVenue — cancelar no puede mentir', () => {
  const filaConSub = {
    id: 'vf-1',
    venueId: 'venue-1',
    stripeSubscriptionId: 'sub_x',
    feature: { id: 'f1', code: 'LOYALTY_PROGRAM', name: 'Lealtad' },
  }

  it('si Stripe falla y la suscripción SIGUE viva, NO desactiva y responde 503 (es Stripe, no el cliente)', async () => {
    mockVenueFeatureFindFirst.mockResolvedValue(filaConSub)
    mockCancelSubscription.mockRejectedValue(new Error('Stripe caído'))
    mockEstado.mockResolvedValue('active')

    await expect(removeFeatureFromVenue('venue-1', 'vf-1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SUBSCRIPTION_CANCEL_PENDING',
    })
    expect(mockVenueFeatureUpdate).not.toHaveBeenCalled()
  })

  it('🔴 respuesta AMBIGUA pero Stripe confirma que SÍ se canceló → completa la baja local', async () => {
    // Codex, 21-sep: si Stripe canceló y la respuesta se perdió —o falló la escritura local que
    // `cancelSubscription` hace después—, rendirse deja al cliente sin poder dar de baja nunca:
    // Stripe ya no cobra y la base dice que sigue activa. Se pregunta el estado real.
    mockVenueFeatureFindFirst.mockResolvedValue(filaConSub)
    mockCancelSubscription.mockRejectedValue(new Error('socket hang up'))
    mockEstado.mockResolvedValue('canceled')

    await expect(removeFeatureFromVenue('venue-1', 'vf-1')).resolves.toBeDefined()
    expect(mockVenueFeatureUpdate).toHaveBeenCalled()
  })

  it('si ni siquiera se puede consultar Stripe → 503 y NO desactiva', async () => {
    mockVenueFeatureFindFirst.mockResolvedValue(filaConSub)
    mockCancelSubscription.mockRejectedValue(new Error('Stripe caído'))
    mockEstado.mockRejectedValue(new Error('Stripe caído'))

    await expect(removeFeatureFromVenue('venue-1', 'vf-1')).rejects.toMatchObject({ statusCode: 503 })
    expect(mockVenueFeatureUpdate).not.toHaveBeenCalled()
  })

  it('si Stripe dice que esa suscripción NO EXISTE, sí desactiva: no hay nada que cancelar', async () => {
    mockVenueFeatureFindFirst.mockResolvedValue(filaConSub)
    const noExiste: any = new Error('No such subscription')
    noExiste.code = 'resource_missing'
    mockCancelSubscription.mockRejectedValue(noExiste)

    await expect(removeFeatureFromVenue('venue-1', 'vf-1')).resolves.toBeDefined()
    expect(mockVenueFeatureUpdate).toHaveBeenCalled()
  })

  it('camino normal: cancela en Stripe y desactiva', async () => {
    mockVenueFeatureFindFirst.mockResolvedValue(filaConSub)
    mockCancelSubscription.mockResolvedValue({ id: 'sub_x', status: 'canceled' })

    await expect(removeFeatureFromVenue('venue-1', 'vf-1')).resolves.toBeDefined()
    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_x')
    expect(mockVenueFeatureUpdate).toHaveBeenCalled()
  })
})

describe('R0 · la baja apaga SÓLO la fila que sigue ligada a la suscripción cancelada', () => {
  it('🔴 desactiva condicionado al vínculo que se canceló (no por id a secas)', async () => {
    mockVenueFeatureFindFirst.mockResolvedValue({
      id: 'vf-1',
      venueId: 'venue-1',
      stripeSubscriptionId: 'sub_x',
      feature: { id: 'f1', code: 'LOYALTY_PROGRAM', name: 'Lealtad' },
    })
    mockCancelSubscription.mockResolvedValue(undefined)

    await removeFeatureFromVenue('venue-1', 'vf-1')

    expect(mockVenueFeatureUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'vf-1', stripeSubscriptionId: 'sub_x' }, data: { active: false } }),
    )
  })

  it('🔴 si el vínculo cambió (recompra) NO responde «baja hecha» ni la registra: 409', async () => {
    mockVenueFeatureFindFirst.mockResolvedValue({
      id: 'vf-1',
      venueId: 'venue-1',
      stripeSubscriptionId: 'sub_x',
      feature: { id: 'f1', code: 'LOYALTY_PROGRAM', name: 'Lealtad' },
    })
    mockCancelSubscription.mockResolvedValue(undefined)
    mockVenueFeatureUpdate.mockResolvedValue({ count: 0 })
    const { logAction } = jest.requireMock('../../../src/services/dashboard/activity-log.service')

    await expect(removeFeatureFromVenue('venue-1', 'vf-1')).rejects.toMatchObject({ statusCode: 409, code: 'SUBSCRIPTION_LINK_CHANGED' })
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'FEATURE_REMOVED' }))
  })
})
