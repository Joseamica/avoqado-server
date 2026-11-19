import { conMarcaDeVales } from '@/services/shared/cuentaConVales'

/**
 * D15 (pizarrón hz:e82938e1:D15, 18-nov): cada descuento de la cuenta que se manda a la caja dice si quedó FIJO al cobrar los vales
 * (`congeladoPorVales`), con la misma marca que usa el candado de quitar (`esFilaDeValeV7` sobre el reparto). La caja nueva pinta su
 * «Quitar» en gris; la vieja ignora el campo. El `reparto` es interno: no viaja.
 */
const repartoDeVale = { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, deValeV7: true, renglones: { 'oi-1': 1000 } }
const repartoEspejo = { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-1': 1000 } }

describe('conMarcaDeVales (D15)', () => {
  it('🔴 la fila del cobro de vales sale con congeladoPorVales: true y sin su reparto', () => {
    expect(conMarcaDeVales({ id: 'od-1', name: '10 % producto', amount: 10, reparto: repartoDeVale })).toEqual({
      id: 'od-1',
      name: '10 % producto',
      amount: 10,
      congeladoPorVales: true,
    })
  })

  it('una cortesía o un descuento de cuenta (sin la marca) sale con congeladoPorVales: false', () => {
    expect(conMarcaDeVales({ id: 'od-2', reparto: repartoEspejo })).toEqual({ id: 'od-2', congeladoPorVales: false })
    expect(conMarcaDeVales({ id: 'od-3', reparto: null })).toEqual({ id: 'od-3', congeladoPorVales: false })
    expect(conMarcaDeVales({ id: 'od-4', reparto: undefined })).toEqual({ id: 'od-4', congeladoPorVales: false })
  })
})
