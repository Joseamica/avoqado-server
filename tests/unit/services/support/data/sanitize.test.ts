import { checkRendered, template } from '@/services/support/data/check'
import { safeDbText, strictDbText } from '@/services/support/data/sanitize'

const OMITTED = [
  'Corte 4111 1111 1111 1111',
  'Corte 4111/1111/1111/1111',
  'Corte 4111.1111.1111.1111',
  'Corte 41​11 11​11 1111 1111',
  'Corte ４１１１ １１１１ １１１１ １１１１',
  'Corte 41 once 11 y 11 mas 11 11 11 11 11',
  'Mesa 55 1234 5678',
  'Ana ana@correo.com',
  'Ana ana @ correo . com',
  'Luis +525512345678',
  'Paola GODE561231GR8',
  'Paola GODE 561231 GR8',
  'Juan GODE561231HDFRRN09',
  'Paquete 10 clases 2026 de 60 min', // el costo aceptado: 8 dígitos en total
  'ORD-1790121567183',
  'ORD-2221000000000-009', // un folio guardado como nombre
]
const KEPT = [
  'Corte y barba',
  'Mesa 12',
  'Clase 7:30 pm',
  'Paquete 10 clases',
  'Sala 2 piso 3 de 8 a 10',
  'Corte $850.00',
  'Flautas Coyoacán',
  'Corte $8,500.00 VIP', // ronda 2: un importe no es un RFC (mes 00)
  'Paquete $1,200.00 mes',
]
it.each(OMITTED)('«%s» → [dato omitido]', raw => expect(safeDbText(raw)).toBe('[dato omitido]'))
it.each(KEPT)('«%s» sale completo', raw => expect(safeDbText(raw)).toBe(raw))
it('cuts to 40 characters, turns line breaks into spaces, and applying it twice changes nothing', () => {
  expect(safeDbText('Corte\ny  barba ' + 'x'.repeat(60))).toHaveLength(40)
  for (const raw of [...OMITTED, ...KEPT, 'a'.repeat(90)]) expect(safeDbText(safeDbText(raw))).toBe(safeDbText(raw))
})
it('null, undefined and an empty name give an empty string', () =>
  expect([safeDbText(null), safeDbText(undefined), safeDbText('  ')]).toEqual(['', '', '']))
// el filtro estricto de la caja (casos 45 y 48)
it.each([
  'Ana $850',
  'Luis 1,200',
  'Flautas $850',
  'Caja 850',
  'Caja 8 5 0',
  'Caja 8/5/0',
  'Caja 12.5',
  'Sucursal MXN',
  'Fondo en pesos',
  'Corte 4111 1111 1111 1111',
  'Ana ana@correo.com',
  '',
  null,
])('strict: «%s» → the fallback, never [dato omitido]', raw => expect(strictDbText(raw, 'tu sucursal')).toBe('tu sucursal'))
it.each(['Ana López', 'Flautas Coyoacán', 'Sucursal 12', 'A1B2C3', 'Ochocientos Cincuenta'])('strict: «%s» passes', raw =>
  expect(strictDbText(raw, 'una persona')).toBe(raw),
)
// lo que el encargo pide probar además: dígitos de otra escritura, unión de ancho cero y separadores de renglón
it.each([
  'Corte \u0664\u0661\u0661\u0661 \u0661\u0661\u0661\u0661 \u0661\u0661\u0661\u0661 \u0661\u0661\u0661\u0661',
  'Corte 41\u200d11 11\u200d11 1111 1111',
  'Paola GODE\u0665\u0666\u0661\u0662\u0663\u0661GR8',
  'Paola gode561231gr8',
])('other scripts, joiners and lower case are still omitted: %s', raw => expect(safeDbText(raw)).toBe('[dato omitido]'))
it('line and paragraph separators become one space, and format characters disappear', () =>
  expect(safeDbText('Corte\u2028y\u2029barba\r\n\tFlau\u200dtas')).toBe('Corte y barba Flautas'))
it.each(['Caja \u0668\u0665\u0660', 'Caja \uff18\uff15\uff10', 'Caja \uff04 algo', 'Mxn caja', 'Un peso'])(
  'strict: «%s» → the fallback too',
  raw => expect(strictDbText(raw, 'tu sucursal')).toBe('tu sucursal'),
)
// Ronda de arreglos 1
// 1 · un RFC o una CURP escritos con puntos, y el RFC de una empresa con «&»
it.each(['Paola GODE.561231.GR8', 'Paola GODE561231.GR8', 'Juan GODE.051231.HDFRRN.A9', 'M&A 561231 GR8'])(
  'an RFC or CURP with dots or «&» is omitted: %s',
  raw => expect(safeDbText(raw)).toBe('[dato omitido]'),
)
// 3 · T-B31: un enlace sale como «[enlace]», con el mismo detector de la fase 1, antes de contar dígitos
it.each([
  ['Ana https://bit.ly/x', 'Ana [enlace]'],
  ['Reserva https://ejemplo.com/r/12345678 Ana', 'Reserva [enlace] Ana'],
  ['Ana ｈｔｔｐｓ：／／ejemplo.com', 'Ana [enlace]'],
  ['Ana María', 'Ana María'],
  ['Sr. Pérez', 'Sr. Pérez'],
  ['Café D.F.', 'Café D. F.'],
])('links become [enlace] and names stay: %s', (raw, shown) => {
  expect(safeDbText(raw)).toBe(shown)
  expect(safeDbText(safeDbText(raw))).toBe(shown)
})
it('a link across the 40-character cut never leaves a piece of it', () => {
  const raw = 'x'.repeat(30) + ' https://ejemplo.com/una/ruta/muy/larga'
  expect(safeDbText(raw)).toBe('x'.repeat(30) + ' [enlace]')
  expect(safeDbText(safeDbText(raw))).toBe(safeDbText(raw))
})
it.each([
  ['Ana María', 'Ana María'],
  ['Sr. Pérez', 'Sr. Pérez'],
  ['Sr.Pan', 'Sr. Pan'],
  ['Café D.F.', 'Café D. F.'],
  ['S.A. de C.V.', 'S. A. de C. V.'],
  ['Av.Juarez', 'Av. Juarez'],
  ['8.50', '8.50'],
  ['Caja 2', 'Caja 2'],
  ['v2.19.0', 'v2.19.0'], // tres grupos no son una IPv4
  ['Hnos. López', 'Hnos. López'],
])('a name with dots reads well and is a fixed point: %s', (raw, shown) => {
  expect(safeDbText(raw)).toBe(shown)
  expect(safeDbText(shown)).toBe(shown)
})
it('an email is still omitted, never half turned into [enlace]', () => {
  expect([safeDbText('ana @ cafe.com'), safeDbText('Ana ana@cafe.mx')]).toEqual(['[dato omitido]', '[dato omitido]'])
})
it('the cut never lands inside [enlace] and never leaves a new link behind', () => {
  expect(safeDbText('x'.repeat(35) + ' https://bit.ly/abc')).toBe('x'.repeat(35))
  expect(safeDbText('x'.repeat(34) + ' Av.Comercial')).toBe('x'.repeat(34) + ' Av. C')
  expect(safeDbText('x'.repeat(30) + ' Av.Comercial')).toBe('x'.repeat(30) + ' Av. Comer')
})
// Ronda de arreglos 2 · el RFC y la CURP piden una fecha posible (mes 01-12, día 01-31)
it('an RFC with an impossible month is a name, unless it has 8 or more digits', () => {
  expect(safeDbText('Paola GODE561331GR8')).toBe('Paola GODE561331GR8')
  expect(safeDbText('Paola GODE561200GR8')).toBe('Paola GODE561200GR8')
  expect(safeDbText('Paola GODE561331GR88')).toBe('[dato omitido]')
})
// Ronda de arreglos 2 · propiedad: aplicarla dos veces no cambia nada y nunca pasa de 40 (semilla fija)
it('idempotent and at most 40 code points on 3,000 seeded random names', () => {
  const pieces = [
    'a',
    'B',
    'ñ',
    'é',
    '1',
    '5',
    '0',
    '٥',
    '❶',
    '.',
    '/',
    '@',
    ' ',
    ' ',
    '-',
    '&',
    ':',
    '$',
    ',',
    '[',
    ']',
    'www.',
    'https://',
    '.com',
    '.mx',
    '.co',
    'Av.Com',
    '[enlace]',
    '\u200b',
    '\n',
    'GODE',
    '5612',
    '31',
    'GR8',
    'x'.repeat(9),
  ]
  let seed = 20261116
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
  for (let i = 0; i < 3000; i++) {
    const raw = Array.from({ length: next(25) }, () => pieces[next(pieces.length)]).join('')
    const once = safeDbText(raw)
    expect(safeDbText(once)).toBe(once)
    expect(Array.from(once).length).toBeLessThanOrEqual(40)
  }
})
// m3 · dígitos que no son \p{Nd} también cuentan; «Caja 2» y los ordinales siguen como hoy
it.each(['❶❷❸❹ ➀➁➂➃', 'Mesa ⓵⓶⓷⓸⓹⓺⓻⓼', 'Corte ❹➀➀➀ 1111'])('enclosed and dingbat digits count: %s', raw =>
  expect(safeDbText(raw)).toBe('[dato omitido]'),
)
it.each([
  ['Caja 2', 'Caja 2'],
  ['1º piso', '1o piso'],
  ['2ª sala', '2a sala'],
  ['½ pollo', '1⁄2 pollo'],
])('ordinals and fractions keep what NFKC already gave: %s', (raw, shown) => expect(safeDbText(raw)).toBe(shown))
it('strict: three dingbat digits → the fallback', () => expect(strictDbText('Caja ❽❺⓪', 'tu sucursal')).toBe('tu sucursal'))
// Ronda de arreglos 3 · un RFC escrito con dígitos encerrados o de adorno
it.each(['Paola GODE❺❻❶❷❸❶GR8', 'Paola GODE561231GR❽', 'Juan GODE⓪❺❶❷❸❶HDFRRNA❾'])(
  'an RFC or CURP in other digit glyphs is omitted: %s',
  raw => expect(safeDbText(raw)).toBe('[dato omitido]'),
)
// Ronda de arreglos 3 · un nombre que termina en guion o raya lo pierde, para no pegarse al importe que sigue
it.each([
  ['Corte -', 'Corte'],
  ['Manicure –', 'Manicure'],
  ['Corte y barba —  - ', 'Corte y barba'],
  ['Corte -x', 'Corte -x'],
])('a trailing dash goes away: %s', (raw, shown) => {
  expect(safeDbText(raw)).toBe(shown)
  expect(safeDbText(safeDbText(raw))).toBe(shown)
})
it.each(['-', '– —', ' - - '])('a name that is only dashes is omitted: «%s»', raw => expect(safeDbText(raw)).toBe('[dato omitido]'))
it('a cut that ends on a dash drops it', () => expect(safeDbText('x'.repeat(38) + ' - y más')).toBe('x'.repeat(38)))
// la propiedad otra vez, con las piezas de esta ronda
it('idempotent and at most 40 code points with the round 3 pieces', () => {
  const pieces = [
    'a',
    'Ñ',
    '5',
    '❶',
    '.',
    '..',
    '/',
    '//',
    '-',
    '–',
    ' ',
    ' ',
    'HTTPS://',
    'Http://',
    'https:/',
    'www.',
    'bit',
    '.ly',
    '.de',
    '.club',
    '[enlace]',
    '\u200b',
    'GODE',
    '❺❻',
    '1231',
    'GR8',
    'x'.repeat(9),
  ]
  let seed = 31
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
  for (let i = 0; i < 3000; i++) {
    const raw = Array.from({ length: next(25) }, () => pieces[next(pieces.length)]).join('')
    const once = safeDbText(raw)
    expect(safeDbText(once)).toBe(once)
    expect(Array.from(once).length).toBeLessThanOrEqual(40)
    expect(once).not.toMatch(/[\s\p{Pd}\u2212]$/u)
  }
})
// Ronda de arreglos 5 · T-B35: la regla de ligas es de estructura. Sin esquema, una liga necesita un punto pegado entre dos
// etiquetas: un esquema o una dirección de dígitos salen «[enlace]», y a todo otro punto pegado se le pone un espacio después.
const TZ = 'America/Mexico_City'
const NUMBER = /^[\p{Nd}\p{Nl}\p{No}]$/u
/** T-B39b: los puntos pegados que quedan (tras algo que no es espacio y ANTES de algo que no es espacio ni puntuación), salvo entre dos dígitos. */
const gluedDots = (s: string) =>
  [...s.matchAll(/(?<=(\S))\.(?=([^\s\p{P}]))/gu)].filter(([, a, b]) => !(NUMBER.test(a) && NUMBER.test(b))).map(m => m.index)
it.each([
  'Ana https://bit.ly/x',
  'Ana HTTPS://bit.ly/x',
  'Ana Http://evil.lat',
  'Ana ftp://x.y/z',
  'Ana http://localhost/x',
  'Ana whatsapp://send',
  'Ana ://bit.ly', // sin nombre de esquema tampoco queda un «://»
  'Ana 45.33.2.79/pago',
  'Ana 1.2.3.4:80/x',
  'Ana 45.33.2.79',
])('a scheme or a dotted-digit address becomes [enlace]: %s', raw => {
  expect(safeDbText(raw)).toBe('Ana [enlace]')
  expect(safeDbText('Ana [enlace]')).toBe('Ana [enlace]')
  expect(['Ana [enlace]', 'una persona']).toContain(strictDbText(raw, 'una persona'))
})
// Retoque 1 · sólo una IPv4 de verdad: cuatro grupos de 1 a 3 dígitos (lo que sobra queda como texto, sin punto pegado)
it.each([
  ['Ana 0177.0.0.1', 'Ana 0[enlace]'],
  ['Ana 1.2.3.4.5', 'Ana [enlace]. 5'],
  ['Ana 1234.1.1.1', 'Ana 1[enlace]'],
])('only four groups of 1 to 3 digits make an address: %s', (raw, shown) => {
  expect(safeDbText(raw)).toBe(shown)
  expect(safeDbText(shown)).toBe(shown)
  expect(gluedDots(shown)).toEqual([])
})
it.each([
  ['Ana cafe.com', 'Ana cafe. com'],
  ['Ana bit.ly/x', 'Ana bit. ly/x'],
  ['Ana www.cafe.com', 'Ana www. cafe. com'],
  ['Ana/cafe.com', 'Ana/cafe. com'],
  ['Ana..cafe.com', 'Ana.. cafe. com'], // T-B39b: tras otro punto no hay liga
  ['Ana cafe.com-x', 'Ana cafe. com-x'],
  ['Ana नमस्ते.com/pago', 'Ana नमस्ते. com/pago'],
  ['Ana สวัสดี.com', 'Ana สวัสดี. com'],
  ['Ana evil.fun:8080/pago', 'Ana evil. fun:8080/pago'],
  ['Ana evil.fun?r=pago', 'Ana evil. fun?r=pago'],
  ['Ana.www.cafe.zz', 'Ana. www. cafe. zz'],
  ['Ana cafe。com', 'Ana cafe. com'],
  ['Ana cafe｡com', 'Ana cafe. com'],
  ['firma.de', 'firma. de'],
])('no glued dot survives: %s', (raw, shown) => {
  expect(safeDbText(raw)).toBe(shown)
  expect(safeDbText(shown)).toBe(shown)
  expect(gluedDots(shown)).toEqual([])
})
it.each([
  ['Ma.Luisa', 'Ma. Luisa'],
  ['Abarrotes S.A.de C.V.', 'Abarrotes S. A. de C. V.'],
  ['Dr.Simi', 'Dr. Simi'],
  ['Sport.Club', 'Sport. Club'],
  ['Lic.Edu García', 'Lic. Edu García'],
  ['Sucursal No.5', 'Sucursal No. 5'],
  ['Ma.De Jesús', 'Ma. De Jesús'],
  ['Hnos.De la Cruz', 'Hnos. De la Cruz'],
  ...[
    'Ma. Luisa',
    'S. A. de C. V.',
    'Coca 2.5 L',
    'Leche 1.5L',
    'Corte $8,500.00 VIP',
    'Av. Juárez 12',
    'Promo 15.09.26',
    'Clase 2.11.26',
    'Art. 12.03.05',
    'Terreno $1.250.000',
  ].map(raw => [raw, raw]),
])('names read well: %s', (raw, shown) => {
  expect(safeDbText(raw)).toBe(shown)
  expect(safeDbText(shown)).toBe(shown)
})
it('the cut runs after the added spaces and never leaves half an [enlace] or a dot-space a second pass changes', () => {
  for (const [raw, shown] of [
    ['x'.repeat(36) + ' a.b', 'x'.repeat(36) + ' a.'], // el corte cae en el espacio agregado
    ['x'.repeat(37) + ' a.b', 'x'.repeat(37) + ' a.'], // el corte cae justo después del punto
    ['x'.repeat(35) + ' 1.2.3.4', 'x'.repeat(35)], // el corte cae dentro de «[enlace]»
  ]) {
    expect(safeDbText(raw)).toBe(shown)
    expect(safeDbText(shown)).toBe(shown)
    const t = template(TZ)
    expect(checkRendered(t.done(`${t.text(raw)} ${t.money(250)}`), TZ)).toBe(true)
  }
})
// M-3 · un invisible que no es carácter de formato se quita; ➖ y ˗ también son guiones
it.each(
  ['\u034f', '\ufe00', '\ufe0f', '\u{e0100}', '\u{e01ef}', '\u17b4', '\u17b5', '\u180b', '\u180c', '\u180d', '\u180f'].map(ch => [
    ch.codePointAt(0)!.toString(16),
    ch,
  ]),
)('an invisible that is not a format character goes away: U+%s', (_hex, ch) => {
  expect(safeDbText(`Corte -${ch}`)).toBe('Corte')
  expect(safeDbText(`Cor${ch}te`)).toBe('Corte')
})
// Ajuste 1 · los invisibles que se VEN como espacio son un espacio; un nombre de puros rellenos queda vacío, como uno de espacios
it.each(['\u115f', '\u1160', '\u3164', '\u2800'].map(ch => [ch.codePointAt(0)!.toString(16), ch]))(
  'an invisible that looks like a space becomes a space: U+%s',
  (_hex, ch) => {
    expect(safeDbText(`Ana${ch}López`)).toBe('Ana López')
    expect(safeDbText(`Corte -${ch}`)).toBe('Corte')
    expect(safeDbText(`${ch}${ch} ${ch}`)).toBe('')
  },
)
// Ajuste 2 · ─, ━ y ⁃ también son guiones
it.each(['Corte ➖', 'Corte ˗', 'Corte - ➖ ˗', 'Corte ─', 'Corte ━', 'Corte ⁃', 'Corte ─━⁃'])('dash look-alikes are dashes too: %s', raw =>
  expect(safeDbText(raw)).toBe('Corte'),
)
// M-4 · el RFC pegado necesita el \p{No}; con puntos se ve entero porque el espacio tras el punto va después
it.each(['Paola GODE ❺❻❶❷❸❶ GR8', 'Paola G.O.D.E.❺❻.❶❷.❸❶.GR8'])('an RFC in dingbat digits, spaced or dotted, is omitted: %s', raw =>
  expect(safeDbText(raw)).toBe('[dato omitido]'),
)
// M-5 · «〇» (una letra-número) cuenta como dígito
it('a letter-number digit counts', () => {
  expect(safeDbText('Mesa 5512〇〇34〇〇')).toBe('[dato omitido]')
  expect(strictDbText('Caja 〇〇〇', 'tu sucursal')).toBe('tu sucursal')
  expect(() => strictDbText('Ana', 'fondo 〇')).toThrow()
})
// la propiedad de T-B35, con las piezas de las rondas 2 y 3 y otras escrituras, «。», puertos y direcciones
it('property (T-B35): no glued dot but between digits, no «://», and every earlier invariant', () => {
  const pieces = [
    'a',
    'B',
    'Ñ',
    'é',
    'e\u0301',
    '\u0301',
    'नमस्ते',
    'สวัสดี',
    '1',
    '5',
    '0',
    '٥',
    '❶',
    '〇',
    '.',
    '..',
    '.Ana',
    '.mx/pago',
    '.5',
    '。',
    '｡',
    '/',
    '//',
    '@',
    ' ',
    ' ',
    '-',
    '–',
    '➖',
    '˗',
    '─',
    '━',
    '⁃',
    '&',
    ':',
    '?r=',
    ':8080',
    '$',
    ',',
    '[',
    ']',
    'www.',
    'https://',
    'HTTPS://',
    'ftp://',
    '://',
    'https:/',
    '.com',
    '.fun',
    '.de',
    'Ma.Luisa',
    'No.5',
    '2.5',
    '45.33.2.79',
    '1.2.3',
    '15.09.26',
    '1.2.3.4.5',
    '1234.1.1.1',
    '0177.0.0.1',
    '\u17b4',
    '\u180b',
    '\u180f',
    '[enlace]',
    '\u200b',
    '\u034f',
    '\u3164',
    '\u2800',
    '\ufe0f',
    '\n',
    'GODE',
    '❺❻',
    '5612',
    '31',
    'GR8',
    'x'.repeat(9),
  ]
  let seed = 35
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
  for (let i = 0; i < 3000; i++) {
    const raw = Array.from({ length: next(25) }, () => pieces[next(pieces.length)]).join('')
    const once = safeDbText(raw)
    expect(gluedDots(once)).toEqual([])
    expect(once).not.toMatch(/^\.[^\s\p{P}]/u) // T-B39c: tampoco al principio
    expect(once).not.toMatch(/\d{1,3}(?:\.\d{1,3}){3}/u)
    expect(once).not.toContain('://')
    expect(safeDbText(once)).toBe(once)
    expect(Array.from(once).length).toBeLessThanOrEqual(40)
    expect(once).not.toMatch(/[\s\p{Pd}\u2212\u2796\u02d7\u2500\u2501\u2043]$/u)
    if (raw.normalize('NFKC').replace(/[\s\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, '')) {
      expect(once).not.toBe('')
    }
    for (const value of [raw, once]) {
      const alone = template(TZ)
      expect(checkRendered(alone.done(alone.text(value)), TZ)).toBe(true)
      const before = template(TZ)
      expect(checkRendered(before.done(`${before.text(value)} ${before.money(250)}`), TZ)).toBe(true)
      // T-B39b: también con la puntuación de la plantilla pegada detrás
      for (const edge of [',', ':', ')', '»', '.']) {
        const after = template(TZ)
        expect(checkRendered(after.done(`Atendió ${after.text(value)}${edge} ${after.money(250)}`), TZ)).toBe(true)
      }
      // T-B39c: y con «» o «(» pegados delante
      const quoted = template(TZ)
      expect(checkRendered(quoted.done(`Atendió «${quoted.text(value)}» ${quoted.money(250)}`), TZ)).toBe(true)
      const parens = template(TZ)
      expect(checkRendered(parens.done(`Atendió (${parens.text(value)}) ${parens.money(250)}`), TZ)).toBe(true)
    }
  }
})
// T-B39b · un punto seguido de puntuación (o de otro punto) no está pegado: después de «,» «:» «)» «»» o «.» no hay liga posible.
// Una marca que se combina o un emoji NO son puntuación: ese punto sí se despega.
it.each([
  ['Abarrotes S.A., sucursal', 'Abarrotes S. A., sucursal'],
  ['Hola...adiós', 'Hola... adiós'],
  ['Tacos...', 'Tacos...'],
  ['cafe.com', 'cafe. com'],
  ['Ma.Luisa', 'Ma. Luisa'],
  ['cafe.\u0301com', 'cafe. \u0301com'],
  ['cafe.\u{1f600}com', 'cafe. \u{1f600}com'],
  ['Coca 2.5 L', 'Coca 2.5 L'],
])('a dot before punctuation is not glued (T-B39b): %s', (raw, shown) => {
  expect(safeDbText(raw)).toBe(shown)
  expect(safeDbText(shown)).toBe(shown)
  expect(gluedDots(shown)).toEqual([])
})
// T-B39c · en safeDbText el principio del valor cuenta como un «antes»: un punto al inicio, seguido de algo que no es espacio ni
// puntuación, gana su espacio (también antes de un dígito: el principio no es un dígito)
it.each([
  ['.Ana', '. Ana'],
  ['.mx/pago', '. mx/pago'],
  ['.5 litros', '. 5 litros'],
  ['..Ana', '.. Ana'],
  ['...', '...'],
  ['.', '.'],
])('a dot at the start gets its space (T-B39c): %s', (raw, shown) => {
  expect(safeDbText(raw)).toBe(shown)
  expect(safeDbText(shown)).toBe(shown)
})
