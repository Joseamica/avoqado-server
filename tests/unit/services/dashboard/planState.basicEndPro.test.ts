/**
 * Plan Básico (17-nov, Task 9, ruling R7): «Terminar mi Pro al acabar el periodo» (la acción con la etiqueta del Básico,
 * `purpose: 'BASIC_PLAN'`) sólo procede en el ÚLTIMO periodo con descuento — la misma regla `isLastDiscountedPeriod` que
 * `basicOffer.canEndProNow`. Antes, el servidor contesta 409 con la fecha. «Cancelar plan» de siempre (sin `purpose`) no cambia.
 */
import { prismaMock } from '../../../__helpers__/setup'
import * as stripeService from '@/services/stripe.service'
import { ConflictError } from '@/errors/AppError'
import { cancelPlan } from '@/services/dashboard/planState.service'
import { scheduleDowngradeToFree } from '@/services/dashboard/seatReconciliation.service'
import { downgradeToFreeSchema, cancelPlanSchema } from '@/schemas/dashboard/venue.schema'

jest.mock('@/services/stripe.service')
const mockStripe = stripeService as jest.Mocked<typeof stripeService>

const DAY = 86400000
const FIN = new Date(Date.now() + 10 * DAY) // próximo cobro
const repetido = (endsAt: Date) => ({ percentOff: 30, amountOffCents: null, duration: 'repeating' as const, endsAt })
const sub = (over: Record<string, unknown> = {}) => ({
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: FIN,
  createdAt: new Date(Date.now() - 90 * DAY),
  hasActiveDiscount: false,
  pausedUntil: null,
  interval: 'month' as const,
  grossAmountCents: 115884,
  descuento: null,
  ...over,
})
const filaPro = {
  id: 'vf_1',
  active: true,
  endDate: null,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: { toNumber: () => 999 },
  stripeSubscriptionId: 'sub_123',
  updatedAt: new Date(),
  feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
}

beforeEach(() => {
  prismaMock.venueFeature.findMany.mockResolvedValue([filaPro] as never)
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v1', timezone: 'America/Mexico_City', stripeCustomerId: 'cus_1' } as never)
  mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as never)
})

describe('R7 · «Terminar mi Pro» del Básico sólo en el último periodo con descuento', () => {
  it('último periodo con descuento (termina antes del próximo cobro) → procede', async () => {
    mockStripe.retrievePlanSubscription.mockResolvedValue(
      sub({ hasActiveDiscount: true, descuento: repetido(new Date(FIN.getTime() - DAY)) }) as never,
    )
    await cancelPlan('v1', { purpose: 'BASIC_PLAN' })
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
  })

  it('sin descuento → procede', async () => {
    mockStripe.retrievePlanSubscription.mockResolvedValue(sub() as never)
    await cancelPlan('v1', { purpose: 'BASIC_PLAN' })
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
  })

  it('🔴 todavía quedan meses con descuento → 409 con la fecha, y Stripe no se toca', async () => {
    mockStripe.retrievePlanSubscription.mockResolvedValue(
      sub({ hasActiveDiscount: true, descuento: repetido(new Date('2027-03-05T18:00:00Z')) }) as never,
    )
    const error = await cancelPlan('v1', { purpose: 'BASIC_PLAN' }).catch(e => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.statusCode).toBe(409)
    expect(error.message).toBe('Tu descuento sigue hasta el 5 de marzo de 2027. Te avisaremos antes para que elijas el Básico.')
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled()
  })

  it('🔴 descuento vigente que no se entiende (desconocido) → 409 sin fecha, y Stripe no se toca', async () => {
    mockStripe.retrievePlanSubscription.mockResolvedValue(sub({ hasActiveDiscount: true, descuento: null }) as never)
    const error = await cancelPlan('v1', { purpose: 'BASIC_PLAN' }).catch(e => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.message).toBe('Tu descuento sigue vigente. Te avisaremos antes para que elijas el Básico.')
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled()
  })

  it('forever → 409 sin fecha (nunca «null»)', async () => {
    mockStripe.retrievePlanSubscription.mockResolvedValue(
      sub({ hasActiveDiscount: true, descuento: { percentOff: 30, amountOffCents: null, duration: 'forever', endsAt: null } }) as never,
    )
    const error = await cancelPlan('v1', { purpose: 'BASIC_PLAN' }).catch(e => e)
    expect(error.message).not.toMatch(/null/)
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled()
  })

  it('«Cancelar plan» de siempre (sin purpose) NO cambia: con meses de descuento, sigue cancelando', async () => {
    mockStripe.retrievePlanSubscription.mockResolvedValue(
      sub({ hasActiveDiscount: true, descuento: repetido(new Date('2027-03-05T18:00:00Z')) }) as never,
    )
    await cancelPlan('v1', {})
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
  })

  it('el camino de «Tu plan» (bajar a Gratis con su revisión de usuarios) también lleva el candado', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([] as never)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.staffVenue.count.mockResolvedValue(1)
    mockStripe.retrievePlanSubscription.mockResolvedValue(
      sub({ hasActiveDiscount: true, descuento: repetido(new Date('2027-03-05T18:00:00Z')) }) as never,
    )
    await expect(scheduleDowngradeToFree('v1', [], { purpose: 'BASIC_PLAN' })).rejects.toBeInstanceOf(ConflictError)
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled()
  })

  it('las dos rutas aceptan `purpose: BASIC_PLAN` y rechazan otro valor', () => {
    const params = { venueId: 'v1' }
    expect(downgradeToFreeSchema.parse({ params, body: { purpose: 'BASIC_PLAN' } }).body.purpose).toBe('BASIC_PLAN')
    expect(cancelPlanSchema.parse({ params, body: { purpose: 'BASIC_PLAN' } }).body.purpose).toBe('BASIC_PLAN')
    expect(() => downgradeToFreeSchema.parse({ params, body: { purpose: 'OTRA' } })).toThrow()
  })
})
