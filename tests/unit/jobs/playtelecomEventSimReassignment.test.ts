import { isOrderPureCategoryMatch } from '@/jobs/playtelecomEventSimReassignment.job'

describe('isOrderPureCategoryMatch', () => {
  it('es true cuando TODOS los items de la orden son de la categoría pedida', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', 'SIM de Evento'], 'SIM de Evento')).toBe(true)
  })

  it('ignora mayúsculas y espacios al comparar', () => {
    expect(isOrderPureCategoryMatch(['  sim de evento  '], 'SIM de Evento')).toBe(true)
  })

  it('es false cuando hay un item de OTRA categoría mezclado', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', '$100 de Promotor'], 'SIM de Evento')).toBe(false)
  })

  it('es false cuando un item no tiene categoría (producto no serializado)', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', null], 'SIM de Evento')).toBe(false)
  })

  it('es false para una orden vacía (nunca reasigna algo sin items)', () => {
    expect(isOrderPureCategoryMatch([], 'SIM de Evento')).toBe(false)
  })
})
