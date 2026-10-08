// tests/unit/services/dashboard/staffPay/textoDeRegla.test.ts
import { textoDeRegla } from '@/services/dashboard/staffPay/valoracion'

describe('textoDeRegla (spec fase 3 §6.6)', () => {
  it('dice la regla con las palabras del spec', () => {
    expect(textoDeRegla({ tipo: 'SUPLENCIA', horas: 3, bono: '100.00' })).toBe('Suplencia avisada 3 h antes: +$100')
    expect(textoDeRegla({ tipo: 'CANCELACION_TARDIA', horas: 2 })).toBe('Cancelada 2 h antes: se paga el sueldo base')
  })
  it('centavos y miles con formato de México; menos de una hora se dice así', () => {
    expect(textoDeRegla({ tipo: 'SUPLENCIA', horas: 0, bono: '1250.50' })).toBe('Suplencia avisada menos de 1 h antes: +$1,250.50')
    expect(textoDeRegla({ tipo: 'CANCELACION_TARDIA', horas: 0 })).toBe('Cancelada menos de 1 h antes: se paga el sueldo base')
  })
})
