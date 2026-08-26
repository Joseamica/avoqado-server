/**
 * Los sellos que FALTAN se tienen que poder contar. Sobre cualquier tema.
 *
 * Es el único dato que un cliente nuevo busca en su tarjeta: cuántos le faltan. Y
 * ya se rompió DOS veces, en direcciones opuestas:
 *
 * 1. Con un gris fijo del tema, el contorno desaparecía sobre el fondo OSCURO.
 * 2. Al cambiarlo por "mezcla el fondo hacia el acento", desapareció sobre el fondo
 *    CLARO — el acento de casi cualquier negocio ya es un color vivo y claro, así
 *    que mezclar hacia él produce otro tono claro.
 *
 * 🔴 Por eso esta prueba mide CONTRASTE y no compara contra un color concreto. Un
 * test que dijera `expect(contorno).toBe('#4F7C2D')` pasaría feliz con la fórmula
 * rota del caso 2 en cuanto alguien actualizara el valor esperado.
 */
import { outlineColor, dimFillColor, hexToRgb, Rgb } from '../../../../src/services/wallet/pngCanvas'

/** Luminosidad percibida, 0 a 1 (Rec. 709). */
function lum(c: Rgb): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255
}

/** Contraste de WCAG entre dos colores: de 1 (idénticos) a 21 (negro sobre blanco). */
function contraste(a: Rgb, b: Rgb): number {
  const canal = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const rel = (c: Rgb) => 0.2126 * canal(c[0]) + 0.7152 * canal(c[1]) + 0.0722 * canal(c[2])
  const [x, y] = [rel(a) + 0.05, rel(b) + 0.05]
  return x > y ? x / y : y / x
}

const FONDOS = [
  ['tema oscuro (default)', '#2C2C2E'],
  ['tema claro', '#F2F2F7'],
  ['tema carbón', '#141416'],
  ['blanco puro', '#FFFFFF'],
  ['negro puro', '#000000'],
  ['un fondo a medio camino', '#808080'],
]

const ACENTOS = [
  ['verde de marca', '#7ADD2C'],
  ['un acento claro (amarillo)', '#FFD60A'],
  ['un acento oscuro (vino)', '#5A1A2B'],
  ['un acento saturado (rosa)', '#FF2D55'],
]

describe('contorno de los sellos que faltan', () => {
  for (const [nombreFondo, fondo] of FONDOS) {
    for (const [nombreAcento, acento] of ACENTOS) {
      it(`se distingue del ${nombreFondo} con ${nombreAcento}`, () => {
        const bg = hexToRgb(fondo)
        const contorno = outlineColor(bg, hexToRgb(acento))

        // 2.2: el mismo mínimo que aplica `outlineColor`. Es lo que hace falta
        // para que una línea de 2-3 píxeles se lea como una figura contable — no
        // el 3.0 que WCAG pide para texto, porque un círculo grande se distingue
        // con menos contraste que una letra.
        expect(contraste(contorno, bg)).toBeGreaterThanOrEqual(2.2)
      })
    }
  }

  it('🔴 sobre fondo CLARO el contorno se OSCURECE, no se aclara', () => {
    // La regresión exacta que ya ocurrió. Con la fórmula vieja el contorno salía
    // MÁS claro que el fondo y se perdía.
    const fondo = hexToRgb('#F2F2F7')
    const contorno = outlineColor(fondo, hexToRgb('#7ADD2C'))

    expect(lum(contorno)).toBeLessThan(lum(fondo))
  })

  it('sobre fondo OSCURO el contorno se aclara', () => {
    const fondo = hexToRgb('#1C1C1E')
    const contorno = outlineColor(fondo, hexToRgb('#7ADD2C'))

    expect(lum(contorno)).toBeGreaterThan(lum(fondo))
  })

  it('el color del NEGOCIO sigue presente en los sellos que faltan', () => {
    // No es cosmético: si el contorno fuera un gris neutro, la marca sólo se vería
    // en los sellos ya ganados — y un cliente nuevo no vería ni un rastro de ella.
    const contorno = outlineColor(hexToRgb('#1C1C1E'), hexToRgb('#FF2D55'))

    // Rojo dominante, como el acento.
    expect(contorno[0]).toBeGreaterThan(contorno[1])
    expect(contorno[0]).toBeGreaterThan(contorno[2])
  })
})

/**
 * El sello RELLENO y apagado — el que usan los iconos con piezas finas, porque en
 * contorno se parten.
 *
 * 🔴 Este juego de pruebas nace de un defecto que ya ocurrió y que ninguna prueba de
 * estructura habría visto: la taza, las tijeras y la mancuerna salían con el MISMO
 * color ganadas y sin ganar, así que la fila entera se leía como completa. La causa
 * es sutil: a un sello de contorno sólo se le pide contraste contra el FONDO, porque
 * su forma ya lo distingue del ganado. A uno relleno hay que pedirle además
 * contraste contra el ACENTO, que es lo único que lo separa de "ya lo tengo".
 */
describe('relleno apagado de un sello sin ganar', () => {
  for (const [nombreFondo, fondo] of FONDOS) {
    for (const [nombreAcento, acento] of ACENTOS) {
      it(`se distingue del sello GANADO sobre ${nombreFondo} con ${nombreAcento}`, () => {
        const bg = hexToRgb(fondo)
        const ac = hexToRgb(acento)
        const apagado = dimFillColor(bg, ac)

        // Contra el sello ganado: es lo que se rompió, y 1.7 es el PISO que el
        // algoritmo garantiza incluso cediendo con colores difíciles.
        expect(contraste(apagado, ac)).toBeGreaterThanOrEqual(1.7)
        // Y contra el fondo, o no se vería que ahí falta un sello.
        expect(contraste(apagado, bg)).toBeGreaterThanOrEqual(1.7)
      })
    }
  }

  it('🔴 con colores normales la separación es HOLGADA, no la mínima', () => {
    // El piso de 1.7 es la red de seguridad para paletas difíciles. Con los temas
    // que un negocio realmente elige, la separación tiene que dejar la cartilla
    // legible de un vistazo — no "cumplir" y seguir costando distinguirla, que es
    // lo que pasaba antes: 1.76 entre dos verdes rellenos se mide, no se ve.
    for (const [fondo, acento] of [
      ['#2C2C2E', '#7ADD2C'],
      ['#F2F2F7', '#7ADD2C'],
      ['#FFFFFF', '#FFD60A'],
      ['#000000', '#5A1A2B'],
    ]) {
      const bg = hexToRgb(fondo)
      const ac = hexToRgb(acento)
      expect(contraste(dimFillColor(bg, ac), ac)).toBeGreaterThanOrEqual(2.5)
    }
  })

  it('🔴 NUNCA devuelve el acento tal cual', () => {
    // El defecto exacto: `outlineColor` sí puede devolverlo —y para un trazo está
    // bien— pero relleno deja la cartilla ilegible.
    const bg = hexToRgb('#2C2C2E')
    const ac = hexToRgb('#7ADD2C')

    expect(dimFillColor(bg, ac)).not.toEqual(ac)
  })
})
