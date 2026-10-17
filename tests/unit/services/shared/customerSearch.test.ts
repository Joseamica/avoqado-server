import {
  SEARCH_PREFILTER_CAP,
  TABLA_DE_PLEGADO_SQL,
  interpretarBusquedaDeClientes,
  plegarTexto,
  sqlDeConteoDeClientes,
  sqlDeFiltrosDeClientes,
  sqlDeIdsDeClientes,
  sqlDeSaldosPendientesDeClientes,
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

  // 🔴 BAJO-1 (full-testing, 15-oct-2026): `?search=jo%00se` respondía 500. Postgres no acepta el byte nulo en un texto
  // (22021 «invalid byte sequence for encoding UTF8: 0x00») y el valor viajaba tal cual como parámetro del SQL. Se quita
  // ANTES de interpretar y el resto se busca normal.
  describe('byte nulo (\\u0000) en el texto', () => {
    it.each<[string, unknown]>([
      ['jo\u0000se', { kind: 'WORDS', words: ['jose'] }],
      ['José\u0000 López', { kind: 'WORDS', words: ['jose', 'lopez'] }],
      ['55\u00004345\u00003965', { kind: 'PHONE', digits: '5543453965' }],
      ['\u0000', null],
      [' \u0000\u0000 ', null],
    ])('%j', (entrada, esperado) => {
      expect(interpretarBusquedaDeClientes(entrada)).toEqual(esperado)
    })

    it('ningún parámetro del SQL lleva el byte nulo', () => {
      for (const entrada of ['jo\u0000se', '55\u00004345\u00003965']) {
        const busqueda = interpretarBusquedaDeClientes(entrada)
        expect(busqueda).not.toBeNull()
        const q = sqlDeIdsDeClientes('venue-A', busqueda!)
        const conNulo = q.values.filter(v => typeof v === 'string' && v.includes('\u0000'))
        expect(conNulo).toEqual([])
      }
    })
  })
})

/**
 * 🔴 Revisión de S7, ronda 1: el texto se pliega en JS con `plegarTexto` (NFD, quita TODA marca, minúsculas) y la columna en
 * SQL con `translate(lower(col), de, a)`. Si los dos lados no pliegan igual, el nombre se busca escrito EXACTO y no aparece
 * («João» → 'joao' en JS pero 'joão' en SQL: el ILIKE de antes sí lo encontraba). Aquí se simula el lado SQL en JS bajo los
 * dos `lower()` que tenemos: el de la base local y el CI (lc_ctype C, sólo ASCII) y el de una base con locale UTF-8 (towlower
 * carácter por carácter).
 */
describe('paridad del plegado: plegarTexto (JS) ≡ translate(lower(col)) (SQL)', () => {
  const { de, a } = TABLA_DE_PLEGADO_SQL
  const traducir = (s: string) =>
    [...s]
      .map(c => {
        const i = [...de].indexOf(c)
        return i >= 0 ? [...a][i] : c
      })
      .join('')
  // lc_ctype C: lower() sólo baja A-Z.
  const lowerC = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase())
  // locale UTF-8: towlower() por carácter, que nunca devuelve más de uno (el `'İ'.toLowerCase()` de JS da dos: se deja igual).
  const lowerUtf8 = (s: string) =>
    [...s]
      .map(c => {
        const l = c.toLowerCase()
        return [...l].length === 1 ? l : c
      })
      .join('')
  const sqlC = (s: string) => traducir(lowerC(s))
  const sqlUtf8 = (s: string) => traducir(lowerUtf8(s))

  const LATINAS = Array.from({ length: 0x017f - 0x00c0 + 1 }, (_, i) => String.fromCharCode(0x00c0 + i)) // Latin-1 Supl. + Extendido-A
  const ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i))

  it('las dos cadenas de translate miden lo mismo (si no, translate BORRA los sobrantes)', () => {
    expect([...de].length).toBe([...a].length)
    expect(new Set([...de]).size).toBe([...de].length) // sin repetidos
  })

  it.each([
    ['lc_ctype C (local y CI)', sqlC],
    ['locale UTF-8', sqlUtf8],
  ])('🔴 cada letra latina (U+00C0–U+017F) y cada ASCII se pliega IGUAL en los dos lados — %s', (_, sql) => {
    const distintas = [...LATINAS, ...ASCII].filter(c => sql(c) !== plegarTexto(c)).map(c => `${c}: js=${plegarTexto(c)} sql=${sql(c)}`)
    expect(distintas).toEqual([])
  })

  it.each([['João'], ['JOÃO'], ['Conceição'], ['CONCEIÇÃO'], ['Łukasz'], ['Øyvind'], ['Ÿves'], ['José Ñoño Ü'], ['Ana López']])(
    'nombre completo %p: mismo resultado en JS y en SQL',
    nombre => {
      expect(sqlC(nombre)).toBe(plegarTexto(nombre))
      expect(sqlUtf8(nombre)).toBe(plegarTexto(nombre))
    },
  )
})

it('🔴 el rango de marcas combinantes se escribe con escapes visibles, no con caracteres invisibles', () => {
  const fuente: string = require('fs').readFileSync(
    require('path').join(__dirname, '../../../../src/services/shared/customerSearch.ts'),
    'utf8',
  )
  expect(fuente).not.toMatch(/[\u0300-\u036f]/)
  expect(fuente).toContain('\\u0300-\\u036f')
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

// ── H6 (auditoría de Codex del código, 15-oct-2026) ──────────────────────────────────────────────────────────────────────
describe('sqlDeSaldosPendientesDeClientes (cuentas por cobrar de los clientes de UNA página, agregadas en la base)', () => {
  it('cuenta y suma en SQL sólo para los ids de la página, con la MISMA regla del filtro «con saldo pendiente»', () => {
    const q = sqlDeSaldosPendientesDeClientes('venue-A', ['c1', 'c2'])
    expect(q.text).toMatch(/COUNT\(\*\)::int AS "pendientes"/)
    expect(q.text).toMatch(/SUM\(o\."remainingBalance"\)/)
    expect(q.text).toMatch(/FROM "OrderCustomer" oc JOIN "Order" o ON o\."id" = oc\."orderId"/)
    // El negocio, por el cliente (los ids ya vienen de una consulta del negocio; esto no cambia ningún valor).
    expect(q.text).toMatch(/JOIN "Customer" c ON c\."id" = oc\."customerId" AND c\."venueId" = \$1/)
    expect(q.text).toMatch(/oc\."customerId" IN \(\$2,\$3\)/)
    // La MISMA regla que `sqlDeFiltrosDeClientes` y que el `include` de antes: pendiente o parcial, saldo > 0, sin canceladas.
    expect(q.text).toMatch(
      /o\."paymentStatus" IN \('PENDING', 'PARTIAL'\) AND o\."remainingBalance" > 0 AND o\."status" NOT IN \('CANCELLED', 'DELETED'\)/,
    )
    expect(q.text).toMatch(/GROUP BY oc\."customerId"/)
    expect(q.values).toEqual(['venue-A', 'c1', 'c2'])
  })
})
