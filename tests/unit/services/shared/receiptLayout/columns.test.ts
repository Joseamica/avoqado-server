import { divider, indentedLines, itemLines, twoColumnLines, wrap } from '@/services/shared/receiptLayout/columns'

describe('twoColumnLines', () => {
  it('si caben, una sola línea que llena exactamente el ancho', () => {
    expect(twoColumnLines('Subtotal:', '$1,234.50', 48)).toEqual(['Subtotal:                              $1,234.50'])
  })
  it('P1 si no caben: la etiqueta arriba y el valor debajo a la derecha — nunca recorta ni se pasa', () => {
    const r = twoColumnLines('Atendió:', 'María Guadalupe Fernández de la Garza Ortega', 32)
    expect(r).toEqual(['Atendió:', ' María Guadalupe Fernández de la', '                    Garza Ortega'])
    for (const l of r) expect(l.length).toBeLessThanOrEqual(32)
  })
})

describe('itemLines (cantidad 5 · artículo · precio 10)', () => {
  it('P1 el nombre largo se ENVUELVE bajo su columna; no se recorta', () => {
    expect(itemLines('1', 'Café americano grande con leche', '$45.00', 32)).toEqual([
      '1    Café americano       $45.00',
      '     grande con leche',
    ])
  })
  it('el encabezado ya no sale pegado: «Cant Artículo»', () => {
    expect(itemLines('Cant', 'Artículo', 'Precio', 32)).toEqual(['Cant Artículo             Precio'])
  })
  it('un precio más ancho que 10 empuja al nombre y nunca desborda', () => {
    const [l] = itemLines('2', 'Servicio', '$123,456.78', 32)
    expect(l).toBe('2    Servicio        $123,456.78')
  })
  it('la sangría del componente de combo se conserva', () => {
    expect(itemLines('', '1x Café', '', 32, 2)).toEqual(['       1x Café                  '])
  })
  it('P1 una cantidad de 5 o 6 dígitos ensancha su columna: ni se pega al nombre ni se pasa del papel', () => {
    expect(itemLines('10000', 'Artículo', '$1.00', 32)).toEqual(['10000 Artículo             $1.00'])
    expect(itemLines('123456', 'Artículo', '$1.00', 32)).toEqual(['123456 Artículo            $1.00'])
    expect(itemLines('123456', 'Café americano grande', '$1.00', 32)).toEqual(['123456 Café americano      $1.00', '       grande'])
  })
})

describe('indentedLines', () => {
  it('sangra 2 y envuelve al ancho', () => {
    expect(indentedLines('+ Leche de almendra orgánica sin azúcar añadida', 32)).toEqual([
      '  + Leche de almendra orgánica',
      '  sin azúcar añadida',
    ])
  })
})

describe('divider', () => {
  it('llena el ancho con el carácter', () => {
    expect(divider(32)).toBe('-'.repeat(32))
    expect(divider(48, '=')).toBe('='.repeat(48))
  })
})

describe('wrap (por palabra; una palabra más larga que el ancho se PARTE, nunca se pierde)', () => {
  it('envuelve por palabra', () => {
    expect(wrap('Gracias por su compra vuelva pronto', 16)).toEqual(['Gracias por su', 'compra vuelva', 'pronto'])
  })
  it('parte una palabra imposible', () => {
    expect(wrap('x'.repeat(40), 32)).toEqual(['x'.repeat(32), 'x'.repeat(8)])
  })
  it('colapsa espacios repetidos y devuelve un renglón vacío para texto vacío', () => {
    expect(wrap('  hola    mundo ', 48)).toEqual(['hola mundo'])
    expect(wrap('   ', 48)).toEqual([''])
  })
})
