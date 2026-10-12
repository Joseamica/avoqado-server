import { seTraslapan, diaAnterior, hoyDeLaSede, validarFechaDeCambio } from '@/services/dashboard/rh/vigencias'

describe('vigencias RH (spec §3.2)', () => {
  describe('feature', () => {
    it('detecta traslape con vigencias abiertas', () => {
      expect(seTraslapan({ desde: '2026-10-01', hasta: null }, { desde: '2026-12-01', hasta: null })).toBe(true)
    })
    it('días contiguos no se traslapan', () => {
      expect(seTraslapan({ desde: '2026-10-01', hasta: '2026-10-09' }, { desde: '2026-10-10', hasta: null })).toBe(false)
    })
    it('mismo día de inicio y fin sí se traslapa (vigencia de un día)', () => {
      expect(seTraslapan({ desde: '2026-10-09', hasta: '2026-10-09' }, { desde: '2026-10-09', hasta: null })).toBe(true)
    })
    it('vigencia de un día contra una cerrada que termina ese día se traslapa', () => {
      expect(seTraslapan({ desde: '2026-10-09', hasta: null }, { desde: '2026-10-01', hasta: '2026-10-09' })).toBe(true)
    })
    it('dos rangos cerrados que se cruzan un solo día se traslapan', () => {
      expect(seTraslapan({ desde: '2026-10-01', hasta: '2026-10-09' }, { desde: '2026-10-09', hasta: '2026-10-20' })).toBe(true)
    })
    it('dos rangos cerrados separados no se traslapan', () => {
      expect(seTraslapan({ desde: '2026-10-01', hasta: '2026-10-08' }, { desde: '2026-10-10', hasta: '2026-10-20' })).toBe(false)
    })
    it('un rango contenido en otro se traslapa', () => {
      expect(seTraslapan({ desde: '2026-10-01', hasta: '2026-10-31' }, { desde: '2026-10-10', hasta: '2026-10-12' })).toBe(true)
    })
    it('diaAnterior cruza mes y año bisiesto', () => {
      expect(diaAnterior('2028-03-01')).toBe('2028-02-29')
      expect(diaAnterior('2027-01-01')).toBe('2026-12-31')
    })
    it('hoyDeLaSede usa la zona de la sede, no UTC', () => {
      // 2026-10-10 05:30 UTC = 2026-10-09 23:30 en Ciudad de México
      expect(hoyDeLaSede('America/Mexico_City', new Date('2026-10-10T05:30:00Z'))).toBe('2026-10-09')
      expect(hoyDeLaSede('America/Tijuana', new Date('2026-10-10T05:30:00Z'))).toBe('2026-10-09')
      expect(hoyDeLaSede('UTC', new Date('2026-10-10T05:30:00Z'))).toBe('2026-10-10')
    })
  })
  describe('regresión', () => {
    it('rechaza fecha futura', () => {
      expect(() => validarFechaDeCambio('2026-10-10', '2026-10-09')).toThrow('No se permiten fechas futuras')
    })
    it('acepta hoy y fechas pasadas', () => {
      expect(() => validarFechaDeCambio('2026-10-09', '2026-10-09')).not.toThrow()
      expect(() => validarFechaDeCambio('2026-09-20', '2026-10-09')).not.toThrow()
    })
    it('rechaza fecha con formato inválido', () => {
      expect(() => validarFechaDeCambio('09/10/2026', '2026-10-09')).toThrow('Fecha inválida')
    })
    it('rechaza fechas imposibles del calendario (no las normaliza)', () => {
      expect(() => validarFechaDeCambio('2026-02-31', '2026-10-09')).toThrow('Fecha inválida')
      expect(() => validarFechaDeCambio('2026-13-01', '2026-10-09')).toThrow('Fecha inválida')
      expect(() => diaAnterior('2026-02-31')).toThrow('Fecha inválida')
      expect(() => diaAnterior('2026-13-01')).toThrow('Fecha inválida')
    })
  })
})
