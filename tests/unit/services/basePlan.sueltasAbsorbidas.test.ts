/**
 * «Como lo hace Claude» — decisión del founder, 21-sep-2026.
 *
 * Al subir de plan, la función suelta que el plan YA incluye se cancela y se acreditan los días
 * no usados, en vez de cobrar las dos. Esta es la pieza que hoy no existía: saber CUÁLES absorbe
 * el plan al que te mudas. Es pura a propósito — decide, no cobra — para que la cotización y la
 * ejecución no puedan contestar distinto.
 */
import { sueltasAbsorbidasPorElPlan } from '../../../src/services/access/basePlan.service'

describe('sueltasAbsorbidasPorElPlan', () => {
  it('PREMIUM absorbe inventario, que es su diferenciador', () => {
    expect(sueltasAbsorbidasPorElPlan('PREMIUM', ['INVENTORY_TRACKING'])).toEqual(['INVENTORY_TRACKING'])
  })

  it('PRO NO absorbe inventario: no se lo da, así que el cliente debe seguir pagándolo aparte', () => {
    expect(sueltasAbsorbidasPorElPlan('PRO', ['INVENTORY_TRACKING'])).toEqual([])
  })

  it('PRO sí absorbe lealtad y referidos, que ya vienen incluidos', () => {
    expect(sueltasAbsorbidasPorElPlan('PRO', ['LOYALTY_PROGRAM', 'REFERRAL_PROGRAM'])).toEqual(['LOYALTY_PROGRAM', 'REFERRAL_PROGRAM'])
  })

  it('un plan NUNCA se absorbe a sí mismo ni a otro plan', () => {
    expect(sueltasAbsorbidasPorElPlan('PREMIUM', ['PLAN_PRO', 'PLAN_PREMIUM'])).toEqual([])
  })

  it('lo que ya es gratis para todos se absorbe con cualquier plan', () => {
    // Pagar CHATBOT suelto es pagar de más SIEMPRE: está en el paquete gratis.
    expect(sueltasAbsorbidasPorElPlan('PRO', ['CHATBOT'])).toEqual(['CHATBOT'])
  })

  it('separa lo absorbido de lo que se conserva, en una lista mixta', () => {
    const sueltas = ['INVENTORY_TRACKING', 'LOYALTY_PROGRAM', 'PLAN_PRO']
    expect(sueltasAbsorbidasPorElPlan('PRO', sueltas)).toEqual(['LOYALTY_PROGRAM'])
  })

  it('sin sueltas no absorbe nada', () => {
    expect(sueltasAbsorbidasPorElPlan('PREMIUM', [])).toEqual([])
  })
})
