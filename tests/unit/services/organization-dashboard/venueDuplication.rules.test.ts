import { normalizarNombreTienda, numeroDeTienda, nombreChoca } from '@/services/organization-dashboard/venueDuplication.rules'

describe('venueDuplication.rules', () => {
  it('normaliza: recorta, colapsa espacios, mayúsculas, sin acentos', () => {
    expect(normalizarNombreTienda('  bae  Lomas 4 (4120) ')).toBe('BAE LOMAS 4 (4120)')
    expect(normalizarNombreTienda('misión')).toBe('MISION')
  })

  it('numeroDeTienda toma el último paréntesis numérico', () => {
    expect(numeroDeTienda('BAE MISION SAN PEDRO (3952)')).toBe('3952')
    expect(numeroDeTienda('La Galeterie')).toBeNull()
    expect(numeroDeTienda('BAE (1) CENTRO (22)')).toBe('22')
  })

  it('nombreChoca por número de tienda', () => {
    expect(nombreChoca('BAE X (3952)', ['BAE MISION SAN PEDRO (3952)'])).toEqual({ choca: true, numero: '3952' })
  })

  it('nombreChoca por nombre normalizado', () => {
    expect(nombreChoca('bae lomas  (4120)', ['BAE LOMAS (4120)'])).toEqual({ choca: true, numero: '4120' })
    expect(nombreChoca('Tienda Centro', ['tienda centro'])).toEqual({ choca: true, numero: null })
  })

  it('no choca con otro nombre y otro número', () => {
    expect(nombreChoca('BAE NUEVA (1)', ['BAE OTRA (2)'])).toEqual({ choca: false })
  })
})
