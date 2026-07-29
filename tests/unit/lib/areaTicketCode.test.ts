/**
 * Código de vale de área — formato + verificador (§5.1, §10).
 *
 * 🔴 ESTE ARCHIVO ES EL ESPEJO DE `AreaTicketCodeTest.kt` EN ANDROID. Si las dos
 * implementaciones del verificador difieren en un dígito, TODOS los vales se rechazan
 * en producción y nadie sabe por qué. Los ejemplos trabajados de aquí abajo son el
 * contrato: el test de Android debe reproducir exactamente los mismos números.
 */

import { areaTicketCheckDigit, buildAreaTicketCode, looksLikeAreaTicketCode, parseAreaTicketCode } from '@/lib/areaTicketCode'

describe('areaTicketCode — verificador GS1 mod-10', () => {
  it('reproduce el ejemplo trabajado del spec: datos 947000001 → verificador 5', () => {
    // d1..d9 de derecha a izquierda: 1,0,0,0,0,0,7,4,9
    // suma = 1·3 + 0 + 0 + 0 + 0 + 0 + 7·3 + 4·1 + 9·3 = 3 + 21 + 4 + 27 = 55
    // C = (10 - (55 mod 10)) mod 10 = 5
    expect(areaTicketCheckDigit('947000001')).toBe(5)
    expect(buildAreaTicketCode(47, 1)).toBe('9470000015')
  })

  it('devuelve 0 (no 10) cuando la suma es múltiplo de 10', () => {
    // El `mod 10` final es lo que evita un "verificador" de dos dígitos.
    // datos 910000004 → 4·3 + 0 + 0 + 0 + 0 + 0 + 0·3 + 1·1 + 9·3 = 12 + 1 + 27 = 40
    expect(areaTicketCheckDigit('910000004')).toBe(0)
    expect(buildAreaTicketCode(10, 4)).toBe('9100000040')
  })

  it('es estable: el mismo dato siempre produce el mismo verificador', () => {
    for (let counter = 1; counter <= 50; counter++) {
      const code = buildAreaTicketCode(10, counter)
      expect(code).toHaveLength(10)
      expect(parseAreaTicketCode(code)).not.toBeNull()
    }
  })

  it('un dígito cambiado invalida el código (que es TODO lo que promete el mod-10)', () => {
    const good = buildAreaTicketCode(47, 1234)
    // Cambia el 5º dígito por otro distinto.
    const digit = Number(good[4])
    const bad = `${good.slice(0, 4)}${(digit + 1) % 10}${good.slice(5)}`
    expect(parseAreaTicketCode(bad)).toBeNull()
  })

  it('rechaza particiones y contadores fuera de rango al acuñar', () => {
    expect(() => buildAreaTicketCode(9, 1)).toThrow(/Partición fuera de rango/)
    expect(() => buildAreaTicketCode(100, 1)).toThrow(/Partición fuera de rango/)
    expect(() => buildAreaTicketCode(47, 0)).toThrow(/Contador fuera de rango/)
    expect(() => buildAreaTicketCode(47, 1_000_000)).toThrow(/Contador fuera de rango/)
  })
})

describe('areaTicketCode — resolución del escáner (EL LARGO MANDA)', () => {
  it('un código de 10 dígitos que empieza en 9 y cuadra → VALE', () => {
    const code = buildAreaTicketCode(47, 1)
    expect(looksLikeAreaTicketCode(code)).toBe(true)
    expect(parseAreaTicketCode(code)).toMatchObject({ partition: 47, counter: 1 })
  })

  it('un EAN-8 (8 dígitos) → NO es vale, aunque empiece en 9', () => {
    // Este es el defecto que la v2 del spec introdujo: 8 dígitos colisionan con EAN-8
    // y el escáner busca producto primero, así que el vale se escondía EN SILENCIO
    // detrás de un GTIN.
    expect(looksLikeAreaTicketCode('96385074')).toBe(false)
    expect(parseAreaTicketCode('96385074')).toBeNull()
  })

  it('🔴 un producto cuyo GTIN empieza en 9 y mide 12 o 13 → NO es vale (el largo manda)', () => {
    expect(looksLikeAreaTicketCode('978020137962')).toBe(false) // 12, UPC-A
    expect(looksLikeAreaTicketCode('9780201379624')).toBe(false) // 13, EAN-13
  })

  it('un código de 10 dígitos que NO empieza en 9 → NO es vale', () => {
    expect(looksLikeAreaTicketCode('1234567890')).toBe(false)
  })

  it('texto no numérico, vacío o nulo → NO es vale, sin lanzar', () => {
    expect(looksLikeAreaTicketCode('94700000X5')).toBe(false)
    expect(looksLikeAreaTicketCode('')).toBe(false)
    expect(looksLikeAreaTicketCode(null)).toBe(false)
    expect(looksLikeAreaTicketCode(undefined)).toBe(false)
    expect(parseAreaTicketCode(null)).toBeNull()
  })

  it('tolera espacios alrededor (pistolas que agregan CR/LF o el operador que teclea)', () => {
    const code = buildAreaTicketCode(47, 1)
    expect(parseAreaTicketCode(`  ${code}  `)).toMatchObject({ code, partition: 47 })
  })

  it('rechaza una partición fuera de 10..99 aunque el verificador cuadre', () => {
    // `900000018` tiene verificador válido pero partición 00 — un código acuñado por
    // algo que no es nuestro cliente.
    const data = '900000001'
    const code = `${data}${areaTicketCheckDigit(data)}`
    expect(parseAreaTicketCode(code)).toBeNull()
  })

  it('rechaza contador 0 aunque el verificador cuadre', () => {
    const data = '947000000'
    const code = `${data}${areaTicketCheckDigit(data)}`
    expect(parseAreaTicketCode(code)).toBeNull()
  })
})
