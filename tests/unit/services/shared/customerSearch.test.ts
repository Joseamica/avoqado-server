import {
  SEARCH_PREFILTER_CAP,
  interpretarBusquedaDeClientes,
  plegarTexto,
  sqlDeConteoDeClientes,
  sqlDeFiltrosDeClientes,
  sqlDeIdsDeClientes,
} from '@/services/shared/customerSearch'

/** C2 (Testarudo, 14-oct): «Dany no aparece». La tablet comparaba el teléfono letra por letra y sólo veía 20 clientes. */
describe('interpretarBusquedaDeClientes', () => {
  it.each<[string, unknown]>([
    ['55 4345 3965', { kind: 'PHONE', digits: '5543453965' }],
    ['5543453965', { kind: 'PHONE', digits: '5543453965' }],
    ['+5543453965', { kind: 'PHONE', digits: '5543453965' }],
    ['525543453965', { kind: 'PHONE', digits: '5543453965' }],
    ['+52 55 4345 3965', { kind: 'PHONE', digits: '5543453965' }],
    ['5215543453965', { kind: 'PHONE', digits: '5543453965' }],
    ['+52 1 55 4345 3965', { kind: 'PHONE', digits: '5543453965' }],
    ['(55) 4345-3965', { kind: 'PHONE', digits: '5543453965' }],
    ['3965', { kind: 'PHONE', digits: '3965' }],
    ['+1 415 555 0100', { kind: 'PHONE', digits: '14155550100' }],
    ['396', { kind: 'WORDS', words: ['396'] }],
    ['José', { kind: 'WORDS', words: ['jose'] }],
    ['  ana   LÓPEZ ', { kind: 'WORDS', words: ['ana', 'lopez'] }],
    ['dany@gmail.com', { kind: 'WORDS', words: ['dany@gmail.com'] }],
    ['', null],
    ['   ', null],
  ])('%p', (entrada, esperado) => {
    expect(interpretarBusquedaDeClientes(entrada)).toEqual(esperado)
  })

  it('no-string (query repetido ⇒ arreglo) es null', () => {
    expect(interpretarBusquedaDeClientes(['a', 'b'])).toBeNull()
  })

  it('acota largo y número de palabras (búsqueda hostil)', () => {
    const r = interpretarBusquedaDeClientes(`${'x '.repeat(500)}`)
    expect(r && r.kind === 'WORDS' && r.words.length).toBeLessThanOrEqual(6)
  })

  it('plegarTexto quita acentos y mayúsculas', () => {
    expect(plegarTexto('JOSÉ Ñoño Ü')).toBe('jose nono u')
  })
})

describe('sqlDeIdsDeClientes', () => {
  // 🔴 Auditoría A #9: `q.text` trae los parámetros como Postgres los recibe (`$1…`); `q.sql` los trae como `?`.
  it('🔴 teléfono: dígitos contra dígitos, SIEMPRE por negocio y con tope de 5000 (LIMIT 5001)', () => {
    const q = sqlDeIdsDeClientes('venue-A', { kind: 'PHONE', digits: '5543453965' })
    expect(q.text).toMatch(/FROM "Customer"\s+WHERE "venueId" = \$1/)
    expect(q.text).toMatch(/regexp_replace\("phone", '\[\^0-9\]', '', 'g'\) LIKE \$2/)
    expect(q.text).toMatch(/ORDER BY "createdAt" DESC, "id" DESC LIMIT \$3/)
    expect(SEARCH_PREFILTER_CAP).toBe(5000)
    expect(q.values).toEqual(['venue-A', '%5543453965%', 5001])
  })

  it('palabras: cada una en nombre, apellido o correo, plegando acentos SIN extensión (translate)', () => {
    const q = sqlDeIdsDeClientes('venue-A', { kind: 'WORDS', words: ['ana', 'lopez'] })
    expect(q.values[0]).toBe('venue-A')
    expect(q.text.match(/translate\(lower\(coalesce\("firstName", ''\)\)/g)).toHaveLength(2)
    expect(q.text).toMatch(/\) AND \(/) // las dos palabras se exigen juntas
    expect(q.text).not.toMatch(/unaccent/)
    expect(q.values).toContain('%ana%')
    expect(q.values).toContain('%lopez%')
  })

  it('escapa los comodines del texto buscado', () => {
    const q = sqlDeIdsDeClientes('venue-A', { kind: 'WORDS', words: ['50%_off!'] })
    expect(q.values).toContain('%50!%!_off!!%')
    expect(q.text).toMatch(/ESCAPE '!'/)
  })

  it('tope inyectado (pruebas): LIMIT tope + 1', () => {
    expect(sqlDeIdsDeClientes('venue-A', { kind: 'PHONE', digits: '3965' }, { tope: 2 }).values).toEqual(['venue-A', '%3965%', 3])
  })

  it('🔴 los filtros del dashboard van ANTES del tope (dentro del prefiltro)', () => {
    const q = sqlDeIdsDeClientes('venue-A', { kind: 'PHONE', digits: '3965' }, { filtros: { tags: ['vip'] } })
    expect(q.text).toMatch(/LIKE \$2 AND "tags" && \$3::text\[\]\s+ORDER BY/)
    expect(q.values).toEqual(['venue-A', '%3965%', ['vip'], 5001])
  })
})

describe('sqlDeFiltrosDeClientes (los mismos filtros que Prisma aplica sin búsqueda)', () => {
  it('grupo, etiquetas (hasSome) y saldo pendiente SIN cuentas canceladas', () => {
    const q = sqlDeFiltrosDeClientes({ customerGroupId: 'g1', tags: ['vip', 'regular'], hasPendingBalance: true })
    expect(q.text).toMatch(/^ AND "customerGroupId" = \$1 AND "tags" && \$2::text\[\] AND EXISTS \(/)
    expect(q.text).toMatch(/oc\."customerId" = "Customer"\."id"/)
    expect(q.text).toMatch(/o\."paymentStatus" IN \('PENDING', 'PARTIAL'\)/)
    expect(q.text).toMatch(/o\."remainingBalance" > 0/)
    expect(q.text).toMatch(/o\."status" NOT IN \('CANCELLED', 'DELETED'\)/)
    expect(q.values).toEqual(['g1', ['vip', 'regular']])
  })
  it('sin grupo', () => {
    expect(sqlDeFiltrosDeClientes({ noGroup: true }).text).toBe(' AND "customerGroupId" IS NULL')
  })
  it('el grupo gana a «sin grupo» (como en Prisma)', () => {
    expect(sqlDeFiltrosDeClientes({ customerGroupId: 'g1', noGroup: true }).text).toBe(' AND "customerGroupId" = $1')
  })
  it('sin filtros no agrega nada', () => {
    const q = sqlDeFiltrosDeClientes({})
    expect(q.text).toBe('')
    expect(q.values).toEqual([])
  })
})

describe('sqlDeConteoDeClientes (total EXACTO cuando la búsqueda pasa del tope)', () => {
  it('cuenta la MISMA regla y los MISMOS filtros, por negocio y sin LIMIT', () => {
    const q = sqlDeConteoDeClientes('venue-A', { kind: 'PHONE', digits: '3965' }, { tags: ['vip'] })
    expect(q.text).toMatch(/^SELECT COUNT\(\*\)::int AS "total" FROM "Customer"\s+WHERE "venueId" = \$1/)
    expect(q.text).toMatch(/LIKE \$2 AND "tags" && \$3::text\[\]/)
    expect(q.text).not.toMatch(/LIMIT|ORDER BY/)
    expect(q.values).toEqual(['venue-A', '%3965%', ['vip']])
  })
})
