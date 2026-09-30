import { evaluarCompatibilidad } from '@/services/access/obligacionesDeCobro'
import { elPlanConcede } from '@/services/access/basePlan.service'
const bundle = { subscriptionId: 'bundle', proyecciones: [{ tipo: 'PAQUETE' as const, featureCodes: ['CFDI', 'LOYALTY_PROGRAM'] }] }
const plan = { tipo: 'PLAN' as const, tier: 'PRO' as const, featureCodes: ['LOYALTY_PROGRAM'] }
const hybrid = (proyecciones: any[], reemplaza: string[] = []) => ({ tipo: 'HYBRID' as const, proyecciones, reemplaza })
describe('one admission rule for hybrid and legacy obligations', () => {
  it('allows a plan and an extra outside its frozen inclusions', () => {
    expect(evaluarCompatibilidad([], hybrid([plan, { tipo: 'FUNCION', featureCode: 'CFDI' }]), elPlanConcede)).toEqual({ ok: true })
  })
  it('rejects buying a feature already sold by a bundle through the old checkout', () => {
    expect(evaluarCompatibilidad([bundle], { tipo: 'FUNCION', featureCode: 'CFDI' }, elPlanConcede)).toMatchObject({
      ok: false,
      codigo: 'FUNCION_YA_CONTRATADA',
    })
  })
  it('rejects overlap with a retained bundle but accepts an explicit whole replacement', () => {
    expect(evaluarCompatibilidad([bundle], hybrid([plan]), elPlanConcede)).toMatchObject({ ok: false })
    expect(evaluarCompatibilidad([bundle], hybrid([plan], ['bundle']), elPlanConcede)).toEqual({ ok: true })
  })
  it('rejects unknown source obligations even when requested for replacement', () => {
    expect(
      evaluarCompatibilidad(
        [{ subscriptionId: 'unknown', proyecciones: [{ tipo: 'DESCONOCIDO', productId: 'prod_?' }] }],
        hybrid([plan], ['unknown']),
        elPlanConcede,
      ),
    ).toMatchObject({ codigo: 'OBLIGACION_DESCONOCIDA' })
  })
  it('cannot replace a subscription absent from this venue inventory', () => {
    expect(evaluarCompatibilidad([], hybrid([plan], ['foreign']), elPlanConcede)).toMatchObject({ ok: false })
  })
  it('uses frozen plan grants, preserving a legacy plan fallback only for legacy projections', () => {
    expect(
      evaluarCompatibilidad(
        [{ subscriptionId: 'pro', proyecciones: [plan] }],
        { tipo: 'FUNCION', featureCode: 'PROMOTIONS' },
        elPlanConcede,
      ),
    ).toEqual({ ok: true })
    expect(
      evaluarCompatibilidad(
        [{ subscriptionId: 'pro', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
        { tipo: 'FUNCION', featureCode: 'PROMOTIONS' },
        elPlanConcede,
      ),
    ).toMatchObject({ codigo: 'INCLUIDA_EN_EL_PLAN' })
  })
})
