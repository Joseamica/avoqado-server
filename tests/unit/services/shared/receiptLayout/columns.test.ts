import { divider, threeColumns, twoColumns, wrap } from '@/services/shared/receiptLayout/columns'

describe('twoColumns (puerto de ESCPOSPrinter.printTwoColumns)', () => {
  it('llena exactamente el ancho, con el valor pegado a la derecha', () => {
    const l = twoColumns('Subtotal:', '$1,234.50', 48)
    expect(l).toHaveLength(48)
    expect(l.startsWith('Subtotal:')).toBe(true)
    expect(l.endsWith('$1,234.50')).toBe(true)
  })
  it('recorta la izquierda cuando no cabe, dejando SIEMPRE un espacio', () => {
    expect(twoColumns('x'.repeat(60), '$5.00', 32)).toBe('x'.repeat(26) + ' ' + '$5.00')
  })
})

describe('threeColumns (cantidad 4 · artículo · precio 10)', () => {
  it('en 32 columnas el nombre se recorta a 17 y siempre queda un espacio antes del precio', () => {
    const l = threeColumns('1', 'Café americano grande con leche', '$45.00', 32)
    expect(l).toBe('1   ' + 'Café americano gr' + ' ' + '    $45.00')
    expect(l).toHaveLength(32)
  })
  it('un precio más ancho que 10 empuja al nombre y nunca desborda el ancho', () => {
    const l = threeColumns('2', 'Servicio', '$123,456.78', 32)
    expect(l).toHaveLength(32)
    expect(l.endsWith('$123,456.78')).toBe(true)
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
