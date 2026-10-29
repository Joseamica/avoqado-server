/**
 * D1 «fotocopia del ticket» (28-oct): la copia de los renglones que imprimió el cobro de UNA parte. Sólo se guarda si cuadra
 * EXACTAMENTE con lo que quedó en el pago (sin propina) y cabe en sus topes; si no, el cobro pasa igual y la parte sale como hoy.
 * Promesa: Avoqado/docs/audit/2026-10-28-parte-por-producto/promesa.md
 */
import { copiaGuardada, copiaQueCuadra, productosDeLaCopia, TOPE_BYTES_DE_LA_COPIA } from '../../../../src/services/shared/lineasDelTicket'

const cafe = { nombre: 'Café Americano', cantidad: 1, unitarioCents: 3000, totalCents: 3000 }
const agua = { nombre: 'Agua Mineral 1L', cantidad: 1, unitarioCents: 2000, totalCents: 2000 }

describe('copiaQueCuadra', () => {
  it('guarda la copia que cuadra con lo aplicado: Café $30 con «Descuento» $3 = $27', () => {
    const copia = copiaQueCuadra({ lineas: [cafe], subtotalCents: 3000, descuentoCents: 300 }, 2700)
    expect(copia).toEqual({ lineas: [cafe], subtotalCents: 3000, descuentoCents: 300 })
  })

  it('sin copia (apps viejas, TPV) no hay nada que guardar', () => {
    expect(copiaQueCuadra(undefined, 2000)).toBeNull()
    expect(copiaQueCuadra(null, 2000)).toBeNull()
  })

  it('si el servidor recortó el efectivo (otra caja cobró en medio), la copia ya no cuadra y se descarta', () => {
    expect(copiaQueCuadra({ lineas: [cafe], subtotalCents: 3000, descuentoCents: 0 }, 2500)).toBeNull()
  })

  it('sin tolerancia: un centavo de diferencia la descarta', () => {
    expect(copiaQueCuadra({ lineas: [cafe], subtotalCents: 3000, descuentoCents: 0 }, 2999)).toBeNull()
  })

  it('los renglones tienen que sumar el subtotal', () => {
    expect(copiaQueCuadra({ lineas: [cafe, agua], subtotalCents: 3000, descuentoCents: 0 }, 3000)).toBeNull()
  })

  it('rechaza importes negativos, fraccionarios o de otro tipo', () => {
    expect(copiaQueCuadra({ lineas: [{ ...cafe, totalCents: -3000 }], subtotalCents: -3000, descuentoCents: 0 }, -3000)).toBeNull()
    expect(copiaQueCuadra({ lineas: [{ ...cafe, totalCents: 30.5 }], subtotalCents: 30.5, descuentoCents: 0 }, 30)).toBeNull()
    expect(copiaQueCuadra({ lineas: [{ ...cafe, cantidad: '1' }], subtotalCents: 3000, descuentoCents: 0 }, 3000)).toBeNull()
  })

  it('respeta los topes de textos y de renglones', () => {
    const largo = 'x'.repeat(121)
    expect(copiaQueCuadra({ lineas: [{ ...cafe, nombre: largo }], subtotalCents: 3000, descuentoCents: 0 }, 3000)).toBeNull()
    expect(copiaQueCuadra({ lineas: [{ ...cafe, peso: 'y'.repeat(41) }], subtotalCents: 3000, descuentoCents: 0 }, 3000)).toBeNull()
    expect(copiaQueCuadra({ lineas: [{ ...cafe, nota: 'z'.repeat(141) }], subtotalCents: 3000, descuentoCents: 0 }, 3000)).toBeNull()
    expect(copiaQueCuadra({ lineas: [{ ...cafe, area: 'a'.repeat(61) }], subtotalCents: 3000, descuentoCents: 0 }, 3000)).toBeNull()
    const muchos = Array.from({ length: 11 }, (_, i) => `mod ${i}`)
    expect(copiaQueCuadra({ lineas: [{ ...cafe, modificadores: muchos }], subtotalCents: 3000, descuentoCents: 0 }, 3000)).toBeNull()
    const cien = Array.from({ length: 101 }, () => ({ nombre: 'P', cantidad: 1, unitarioCents: 1, totalCents: 1 }))
    expect(copiaQueCuadra({ lineas: cien, subtotalCents: 101, descuentoCents: 0 }, 101)).toBeNull()
    expect(copiaQueCuadra({ lineas: [], subtotalCents: 0, descuentoCents: 0 }, 0)).toBeNull()
  })

  it('no pasa de 8 KB serializada', () => {
    const lineas = Array.from({ length: 100 }, (_, i) => ({
      nombre: `Producto con nombre largo número ${i}`.padEnd(110, '.'),
      cantidad: 1,
      unitarioCents: 1,
      totalCents: 1,
    }))
    expect(JSON.stringify({ lineas, subtotalCents: 100, descuentoCents: 0 }).length).toBeGreaterThan(TOPE_BYTES_DE_LA_COPIA)
    expect(copiaQueCuadra({ lineas, subtotalCents: 100, descuentoCents: 0 }, 100)).toBeNull()
  })

  it('el tope es en BYTES: con acentos no se cuela una copia de más de 8 KB (Codex código r1 #3)', () => {
    const lineas = Array.from({ length: 8 }, () => ({
      nombre: 'á'.repeat(120),
      cantidad: 1,
      unitarioCents: 1,
      totalCents: 1,
      modificadores: Array.from({ length: 10 }, () => 'á'.repeat(60)),
    }))
    const json = JSON.stringify({ lineas, subtotalCents: 8, descuentoCents: 0 })
    expect(json.length).toBeLessThan(TOPE_BYTES_DE_LA_COPIA)
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(TOPE_BYTES_DE_LA_COPIA)
    expect(copiaQueCuadra({ lineas, subtotalCents: 8, descuentoCents: 0 }, 8)).toBeNull()
  })

  it('conserva peso, nota, área, cortesía, pieza de combo y modificadores, y tira campos desconocidos', () => {
    const queso = {
      nombre: 'Queso Oaxaca',
      cantidad: 1,
      unitarioCents: 42000,
      totalCents: 18270,
      peso: '0.435 kg × $420.00/kg',
      nota: 'en rebanadas',
      area: 'Salchichonería',
      modificadores: ['Sin sal'],
      inventado: '<script>',
    }
    const pieza = { nombre: 'Papas', cantidad: 1, unitarioCents: 0, totalCents: 0, pieza: true }
    const regalo = { nombre: 'Galleta', cantidad: 1, unitarioCents: 1500, totalCents: 1500, cortesia: true }
    const copia = copiaQueCuadra({ lineas: [queso, pieza, regalo], subtotalCents: 19770, descuentoCents: 1500 }, 18270)
    expect(copia?.lineas[0]).toEqual({
      nombre: 'Queso Oaxaca',
      cantidad: 1,
      unitarioCents: 42000,
      totalCents: 18270,
      peso: '0.435 kg × $420.00/kg',
      nota: 'en rebanadas',
      area: 'Salchichonería',
      modificadores: ['Sin sal'],
    })
    expect(copia?.lineas[1].pieza).toBe(true)
    expect(copia?.lineas[2].cortesia).toBe(true)
  })
})

describe('copiaGuardada', () => {
  it('lee la copia de `processorData` y descarta lo mal formado', () => {
    const copia = { lineas: [agua], subtotalCents: 2000, descuentoCents: 0 }
    expect(copiaGuardada({ lineasDelTicket: copia, otraLlave: 1 })).toEqual(copia)
    expect(copiaGuardada({ lineasDelTicket: { lineas: 'no' } })).toBeNull()
    expect(copiaGuardada(null)).toBeNull()
    expect(copiaGuardada({})).toBeNull()
  })
})

describe('productosDeLaCopia', () => {
  it('traduce a pesos en el formato del recibo, con peso, nota, área y modificadores', () => {
    const productos = productosDeLaCopia({
      lineas: [{ nombre: 'Queso', cantidad: 1, unitarioCents: 42000, totalCents: 18270, peso: '0.435 kg', nota: 'n', area: 'A',
                 modificadores: ['Sin sal'] }],
      subtotalCents: 18270,
      descuentoCents: 0,
    })
    expect(productos).toEqual([
      { name: 'Queso', quantity: 1, price: 420, totalPrice: 182.7, weightKg: null, peso: '0.435 kg', nota: 'n', area: 'A',
        modifiers: [{ name: 'Sin sal' }] },
    ])
  })

  it('conserva «Cortesía» y la pieza del combo, como el papel (Codex código r1 #1)', () => {
    const productos = productosDeLaCopia({
      lineas: [
        { nombre: 'Combo', cantidad: 1, unitarioCents: 4500, totalCents: 4500 },
        { nombre: 'Papas', cantidad: 1, unitarioCents: 0, totalCents: 0, pieza: true },
        { nombre: 'Galleta', cantidad: 1, unitarioCents: 1500, totalCents: 1500, cortesia: true },
      ],
      subtotalCents: 6000,
      descuentoCents: 1500,
    })
    expect(productos[0]).not.toHaveProperty('pieza')
    expect(productos[1].pieza).toBe(true)
    expect(productos[2].cortesia).toBe(true)
  })
})
