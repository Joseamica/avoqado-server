import { TRATAMIENTOS_OFRECIDOS_V1, tratamientoDesdeTupla, trasladoSatDe, tuplaDesdeTratamiento } from '@/services/fiscal/ivaTratamiento'

describe('ivaTratamiento — derivación desde la tupla vieja', () => {
  it.each([
    [0.16, '02', 'IVA_16'],
    ['0.1600', '02', 'IVA_16'],
    [0.08, '02', 'IVA_8'],
    [0, '02', 'IVA_0'],
    ['0.0000', '02', 'IVA_0'],
    [0.16, '01', 'NO_OBJETO'],
    [0, '01', 'NO_OBJETO'],
    [0.16, '03', 'BLOQUEADO_03'],
    [0.16, '04', 'BLOQUEADO_04'],
  ])('taxRate %p + objetoImp %p ⇒ %p', (tasa, objeto, esperado) => {
    expect(tratamientoDesdeTupla(tasa, objeto)).toBe(esperado)
  })

  it('una tasa que el SAT no admite con objeto 02 es contradicción (null)', () => {
    expect(tratamientoDesdeTupla(0.1, '02')).toBeNull()
    expect(tratamientoDesdeTupla(0.15, '02')).toBeNull()
  })

  it('un objetoImp desconocido es contradicción (null)', () => {
    expect(tratamientoDesdeTupla(0.16, '05')).toBeNull()
  })

  it('EXENTO nunca se deriva de una tupla (sólo se elige)', () => {
    const derivados = [0, 0.08, 0.16].flatMap(t => ['01', '02', '03', '04'].map(o => tratamientoDesdeTupla(t, o)))
    expect(derivados).not.toContain('EXENTO')
  })
})

describe('ivaTratamiento — tupla desde el tratamiento', () => {
  it.each([
    ['IVA_16', 0.16, '02'],
    ['IVA_8', 0.08, '02'],
    ['IVA_0', 0, '02'],
    ['EXENTO', 0, '02'],
    ['NO_OBJETO', 0, '01'],
  ] as const)('%s ⇒ (%p, %p)', (t, tasa, objeto) => {
    expect(tuplaDesdeTratamiento(t, 0.16)).toEqual({ taxRate: tasa, objetoImp: objeto })
  })

  it('los bloqueados conservan la tasa que tenía la fila', () => {
    expect(tuplaDesdeTratamiento('BLOQUEADO_04', 0.16)).toEqual({ taxRate: 0.16, objetoImp: '04' })
    expect(tuplaDesdeTratamiento('BLOQUEADO_03', 0)).toEqual({ taxRate: 0, objetoImp: '03' })
  })

  it('ida y vuelta: todo tratamiento derivable regresa a sí mismo', () => {
    for (const t of ['IVA_16', 'IVA_8', 'IVA_0', 'NO_OBJETO', 'BLOQUEADO_03', 'BLOQUEADO_04'] as const) {
      const { taxRate, objetoImp } = tuplaDesdeTratamiento(t, 0.16)
      expect(tratamientoDesdeTupla(taxRate, objetoImp)).toBe(t)
    }
  })
})

describe('ivaTratamiento — traslado SAT (CFDI 4.0, Anexo 20)', () => {
  it('tasa 0 y exento son los dos ObjetoImp 02 pero con traslado distinto', () => {
    expect(trasladoSatDe('IVA_0')).toEqual({
      objetoImp: '02',
      traslado: { tipoFactor: 'Tasa', tasaOCuota: '0.000000' },
      timbrable: true,
    })
    expect(trasladoSatDe('EXENTO')).toEqual({ objetoImp: '02', traslado: { tipoFactor: 'Exento' }, timbrable: true })
  })

  it('16 y 8 son Tasa con su cuota', () => {
    expect(trasladoSatDe('IVA_16').traslado).toEqual({ tipoFactor: 'Tasa', tasaOCuota: '0.160000' })
    expect(trasladoSatDe('IVA_8').traslado).toEqual({ tipoFactor: 'Tasa', tasaOCuota: '0.080000' })
  })

  it('no objeto va sin traslado; los bloqueados no se timbran', () => {
    expect(trasladoSatDe('NO_OBJETO')).toEqual({ objetoImp: '01', traslado: null, timbrable: true })
    expect(trasladoSatDe('BLOQUEADO_04').timbrable).toBe(false)
    expect(trasladoSatDe('BLOQUEADO_03').timbrable).toBe(false)
  })

  it('la pantalla v1 ofrece sólo 16, 0 y exento', () => {
    expect(TRATAMIENTOS_OFRECIDOS_V1).toEqual(['IVA_16', 'IVA_0', 'EXENTO'])
  })
})
