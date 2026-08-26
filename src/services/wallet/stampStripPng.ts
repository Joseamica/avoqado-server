import { WalletStampShape } from '@prisma/client'
import { Canvas, dimFillColor, hexToRgb, outlineColor, Rgb } from './pngCanvas'
import { stampEmptyStyle, stampShapeFn } from './stampShapes'

/**
 * La banda superior de la tarjeta: los sellos dibujados.
 *
 * Es lo que convierte un rectángulo de color con texto en algo que se reconoce
 * como cartilla de sellos de un solo vistazo. Un cliente no lee "3 de 10": ve tres
 * círculos llenos y siete vacíos, y sabe cuánto le falta sin contar.
 *
 * 🔴 Los colores por defecto NO son inventados: salen del tema real de
 * `avoqado-android` (`designsystem/theme/Color.kt`), que es un sistema estilo iOS
 * con superficies neutras y el verde de marca como único acento. Una paleta
 * inventada haría que la tarjeta se sienta de otro producto.
 *
 * Se dibuja a mano sobre un lienzo (ver `pngCanvas.ts`) en vez de con una librería
 * de imágenes: el camino de emisión de credenciales no debería depender de
 * binarios nativos por plataforma.
 */

/** Tokens del tema oscuro de avoqado-android. */
const SURFACE_CONTAINER_DARK = '#2C2C2E'
const AVOQADO_GREEN = '#7ADD2C'

/** Máximo de sellos por fila antes de partir en dos. */
/**
 * 🔴 A partir de 7 se parte en dos filas, no a partir de 9.
 *
 * El limitante del tamaño de un sello es el ancho de su celda, así que una fila de
 * ocho los deja diminutos en el centro de una banda medio vacía. Repartidos en dos
 * filas de cuatro salen casi el doble de grandes usando el mismo espacio — y una
 * cartilla de siete u ocho es de las más comunes ("junta 7 y el 8 va gratis").
 */
const MAX_POR_FILA = 6

export interface StampStripOptions {
  width: number
  height: number
  earned: number
  required: number
  /** Fondo de la banda. Por defecto, la superficie elevada del tema oscuro. */
  bgHex?: string | null
  /** Sellos ya ganados. Por defecto el verde de marca: es el único acento. */
  filledHex?: string | null
  /** Contorno de los que faltan. */
  emptyHex?: string | null
  /** Forma del sello. Por defecto, circulo. */
  shape?: WalletStampShape | null
}

export function stampStripPng({ width, height, earned, required, bgHex, filledHex, emptyHex, shape }: StampStripOptions): Buffer {
  const fondo = hexToRgb(bgHex, hexToRgb(SURFACE_CONTAINER_DARK))
  const lleno = hexToRgb(filledHex, hexToRgb(AVOQADO_GREEN))
  // 🔴 El contorno se DERIVA del fondo y del acento, no de un token gris fijo.
  //
  // Con un gris fijo sobre la superficie oscura el contraste era tan bajo que un
  // cliente nuevo — el que abre la tarjeta con CERO sellos — no alcanzaba a contar
  // cuántos le faltan, que es lo único que quiere saber.
  //
  // `outlineColor` mira la luminosidad del fondo para decidir en qué dirección
  // separarse de él: mezclar siempre hacia el acento funciona sobre fondo oscuro y
  // FALLA sobre fondo claro, donde el acento ya es claro y el contorno desaparece.
  // Se descubrió probando el tema claro, no leyendo el código.
  // 🔴 Dos colores distintos para el sello que falta, segun como se dibuje. Ver
  // `dimFillColor`: un icono relleno se distingue del ganado SOLO por el color, y
  // con el del contorno salia identico — la fila entera se leia como ganada.
  const estiloVacio = stampEmptyStyle(shape)
  const contorno = emptyHex ? hexToRgb(emptyHex) : estiloVacio === 'solid' ? dimFillColor(fondo, lleno) : outlineColor(fondo, lleno)

  const canvas = new Canvas(width, height, fondo)

  // 🔴 Saneo: un venue mal configurado (required en 0 o negativo) no puede colgar
  // la emisión de credenciales ni provocar una división entre cero.
  const total = Math.max(1, Math.min(24, Math.floor(required) || 1))
  // Ganados de más pasa de verdad: el cliente llena la cartilla y vuelve a comprar
  // antes de canjear.
  const llenos = Math.max(0, Math.min(total, Math.floor(earned) || 0))

  const filas = total <= MAX_POR_FILA ? 1 : 2
  const porFila = Math.ceil(total / filas)

  // 🔴 Márgenes. Sin ellos los círculos de los extremos quedan pegados al borde y
  // la banda se ve CORTADA — el defecto que se ve en cuanto abres la tarjeta y que
  // ninguna prueba de estructura detecta.
  const margenX = width * 0.07
  const margenY = height * 0.14
  const utilAncho = width - margenX * 2
  const utilAlto = height - margenY * 2

  const celdaAncho = utilAncho / porFila
  const celdaAlto = utilAlto / filas
  // 🔴 El radio lo limita el ANCHO de celda casi siempre, no el alto: una fila de
  // ocho sellos deja ~80px por sello y ~180px de altura disponible. Con el mismo
  // factor para ambos, los sellos salían diminutos en el centro de una banda medio
  // vacía — que es parte de lo que hace que una tarjeta se sienta pobre.
  //
  // Por eso el alto tiene su propio factor, más generoso: el sello aprovecha la
  // altura cuando la hay, y el ancho lo sigue frenando antes de que se toquen.
  const radio = Math.min(celdaAncho * 0.42, celdaAlto * 0.44)
  const grosor = Math.max(2, radio * 0.16)

  const forma = stampShapeFn(shape)

  for (let i = 0; i < total; i++) {
    const fila = Math.floor(i / porFila)
    const col = i % porFila
    // 🔴 La última fila puede ir incompleta, y se alinea a la IZQUIERDA en vez de
    // centrarse. Centrada se ve más balanceada como composición, pero rompe las
    // columnas: los sellos de abajo caen entre los de arriba y el cliente pierde la
    // correspondencia que usa para contar de un vistazo — que es lo único que hace
    // esta fila. Es lo mismo que hace una cartilla de cartón.
    const cx = margenX + celdaAncho * (col + 0.5)
    const cy = margenY + celdaAlto * (fila + 0.5)

    if (i < llenos) {
      canvas.shape(cx, cy, radio, lleno, forma)
    } else if (estiloVacio === 'solid') {
      // Icono con piezas finas: relleno apagado. El contorno lo partiría.
      canvas.shape(cx, cy, radio, contorno, forma)
    } else {
      canvas.shape(cx, cy, radio, contorno, forma, { strokeWidth: grosor })
    }
  }

  return canvas.toPng()
}
