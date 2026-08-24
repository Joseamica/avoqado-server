import { extractStoreId, matchStaff, norm, ProdStaff } from '../../../../scripts/lib/baitStructure/identity'
import { StructureRow } from '../../../../scripts/lib/baitStructure/types'

function staff(over: Partial<ProdStaff> & { id: string; firstName: string; lastName: string }): ProdStaff {
  return { employeeCode: null, active: true, ...over }
}

function row(over: Partial<StructureRow> & { fullName: string }): StructureRow {
  return {
    employeeCode: 'X1',
    puesto: 'PROMOTOR',
    estado: 'SLP',
    ciudad: 'SLP',
    storeId: null,
    formato: null,
    storeName: null,
    supervisorCode: null,
    isVacante: false,
    ...over,
  }
}

describe('extractStoreId', () => {
  it('saca el ID del final del nombre del venue', () => {
    expect(extractStoreId('BAE RANCHO SAN PEDRO (2978)')).toBe('2978')
    expect(extractStoreId('WE JURICA (5815)')).toBe('5815')
    expect(extractStoreId('BAE LAS FLORES DEL RIO (53)')).toBe('53')
  })

  it('devuelve null cuando el venue no trae ID', () => {
    expect(extractStoreId('Cubre Descanso')).toBeNull()
    expect(extractStoreId('ACTIVACIÓN SLP')).toBeNull()
    expect(extractStoreId('BAE Luis Pasteur')).toBeNull()
  })
})

describe('norm', () => {
  it('quita acentos, puntuación y mayúsculas', () => {
    expect(norm('Ma. del Rosario Ramírez Muñoz')).toBe('MA DEL ROSARIO RAMIREZ MUNOZ')
  })
})

describe('matchStaff', () => {
  const pool = [
    staff({ id: 's1', firstName: 'Karina', lastName: 'de la Cruz' }),
    staff({ id: 's2', firstName: 'Ricardo', lastName: 'Juárez Rivera' }),
    staff({ id: 's3', firstName: 'Tirza', lastName: 'Juárez' }),
    staff({ id: 's4', firstName: 'Braulio', lastName: 'Nino' }),
  ]

  it('gana el employeeCode sobre cualquier nombre', () => {
    const conCodigo = [...pool, staff({ id: 's9', firstName: 'Otro', lastName: 'Nombre', employeeCode: 'BSCBMAR03' })]
    expect(matchStaff(row({ fullName: 'Marisol Karina de la Cruz Zermeño', employeeCode: 'BSCBMAR03' }), conCodigo)).toEqual({
      status: 'MATCHED',
      staffId: 's9',
      via: 'employeeCode',
    })
  })

  it('empareja el nombre corto de prod contra el largo del Excel', () => {
    expect(matchStaff(row({ fullName: 'Marisol Karina de la Cruz Zermeño' }), pool)).toEqual({
      status: 'MATCHED',
      staffId: 's1',
      via: 'looseName',
    })
    expect(matchStaff(row({ fullName: 'Braulio Rodrigo Niño Burgos' }), pool)).toEqual({
      status: 'MATCHED',
      staffId: 's4',
      via: 'looseName',
    })
  })

  it('no confunde dos personas que comparten apellido', () => {
    expect(matchStaff(row({ fullName: 'Tirza Guishoba Juarez Guzman' }), pool)).toEqual({
      status: 'MATCHED',
      staffId: 's3',
      via: 'looseName',
    })
  })

  it('reporta ambigüedad en vez de elegir', () => {
    const gemelos = [staff({ id: 'a', firstName: 'Ana', lastName: 'Lopez' }), staff({ id: 'b', firstName: 'Ana', lastName: 'Lopez' })]
    expect(matchStaff(row({ fullName: 'Ana Lopez' }), gemelos)).toEqual({ status: 'AMBIGUOUS', candidates: ['a', 'b'] })
  })

  it('devuelve NOT_FOUND si no hay a quién parecerse', () => {
    expect(matchStaff(row({ fullName: 'Persona Que No Existe' }), pool)).toEqual({ status: 'NOT_FOUND' })
  })

  it('empareja a un promotor real aunque su cuenta se haya dado de alta desde una terminal', () => {
    // Verificado contra producción (2026-08-23): el correo tpv-…@internal.avoqado.io NO identifica una
    // cuenta de servicio de una terminal — es simplemente cómo la plataforma da de alta a un promotor
    // sin correo propio. Karina de la Cruz (con 501 SIMs en custodia) es una de esas 42 personas reales.
    // Como ProdStaff ya no lleva email, este caso se prueba por el lado del nombre: 's1' del pool
    // (Karina de la Cruz) debe emparejar con el nombre completo del Excel sin ningún filtro que la excluya.
    expect(matchStaff(row({ fullName: 'Marisol Karina de la Cruz Zermeño' }), pool)).toEqual({
      status: 'MATCHED',
      staffId: 's1',
      via: 'looseName',
    })
  })

  it('no empareja cuando la persona en la base solo aporta un token significativo', () => {
    // "Ana Li": LI tiene 2 letras (no significativo), ANA es el único token de 3+ letras
    // "Ana Patricia Gómez Rivas": ANA, PATRICIA, GOMEZ, RIVAS
    // El guard prodTokens.length >= 2 debe rechazar porque prod solo tiene 1 token
    const unTokeno = [staff({ id: 'short', firstName: 'Ana', lastName: 'Li' })]
    expect(matchStaff(row({ fullName: 'Ana Patricia Gómez Rivas' }), unTokeno)).toEqual({ status: 'NOT_FOUND' })
  })

  it('nunca empareja contra una persona desactivada', () => {
    const conDesactivada = [staff({ id: 'inactive', firstName: 'Braulio', lastName: 'Nino', active: false })]
    expect(matchStaff(row({ fullName: 'Braulio Nino' }), conDesactivada)).toEqual({ status: 'NOT_FOUND' })
  })
})
