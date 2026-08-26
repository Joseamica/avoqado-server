import { Canvas, hexToRgb, mix, Rgb } from './pngCanvas'

/**
 * La banda superior de la tarjeta: los sellos dibujados.
 *
 * Es lo que convierte un rectángulo de color con texto en algo que se reconoce
 * como cartilla de sellos de un solo vistazo. Un cliente no lee "3 de 10": ve tres
 * círculos llenos y siete vacíos, y sabe cuánto le falta sin contar.
 *
 * Se dibuja a mano sobre un lienzo (ver `pngCanvas.ts`) en vez de con una librería
 * de imágenes, por la misma razón que el icono: el camino de emisión de
 * credenciales no debería depender de binarios nativos por plataforma.
 */

const BLANCO: Rgb = [255, 255, 255]

/** Máximo de sellos por fila antes de partir en dos. */
const MAX_POR_FILA = 10

export interface StampStripOptions {
  width: number
  height: number
  earned: number
  required: number
  bgHex: string | null | undefined
}

export function stampStripPng({ width, height, earned, required, bgHex }: StampStripOptions): Buffer {
  const bg = hexToRgb(bgHex)

  // La banda va un punto más oscura que el fondo de la tarjeta: así se distingue
  // como una zona propia en vez de fundirse con el resto.
  const bandaFondo = mix(bg, [0, 0, 0], 0.12)
  const canvas = new Canvas(width, height, bandaFondo)

  // 🔴 Saneo de entrada: un venue mal configurado (required en 0 o negativo) no
  // puede colgar la emisión de credenciales ni provocar una división entre cero.
  const total = Math.max(1, Math.min(30, Math.floor(required) || 1))
  // Ganados de más pasa de verdad: el cliente llena la cartilla y vuelve a comprar
  // antes de canjear. Se topa para no dibujar sellos que no existen.
  const llenos = Math.max(0, Math.min(total, Math.floor(earned) || 0))

  const filas = total <= MAX_POR_FILA ? 1 : 2
  const porFila = Math.ceil(total / filas)

  const celdaAncho = width / porFila
  const celdaAlto = height / filas
  const radio = Math.min(celdaAncho, celdaAlto) * 0.3
  const grosor = Math.max(1.5, radio * 0.14)

  // Vacío = contorno blanco tenue. Tiene que verse lo suficiente para que el
  // cliente cuente cuántos le faltan, sin competir con los llenos.
  const contorno = mix(bandaFondo, BLANCO, 0.55)

  for (let i = 0; i < total; i++) {
    const fila = Math.floor(i / porFila)
    const col = i % porFila
    // La última fila puede ir incompleta: se centra para que no quede coja.
    const enEstaFila = Math.min(porFila, total - fila * porFila)
    const sobra = (porFila - enEstaFila) * celdaAncho
    const cx = sobra / 2 + celdaAncho * (col + 0.5)
    const cy = celdaAlto * (fila + 0.5)

    if (i < llenos) {
      canvas.circle(cx, cy, radio, BLANCO)
    } else {
      canvas.circle(cx, cy, radio, contorno, { strokeWidth: grosor })
    }
  }

  return canvas.toPng()
}
