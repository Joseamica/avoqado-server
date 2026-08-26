import { WalletStampShape } from '@prisma/client'
import { ShapeFn } from './pngCanvas'
import { anillo, barra, caja, disco, poligono, soloDonde, trapecio, union } from './shapePrimitives'

/**
 * Las formas que puede tomar el sello de un negocio, dibujadas al vuelo.
 *
 * 🔴 Hay iconos por GIRO y no sólo figuras geométricas porque un círculo se ve igual
 * en la tarjeta de una cafetería que en la de un gimnasio, y eso es justo lo que
 * hace que una tarjeta parezca de plantilla. Una taza en la de un café se reconoce
 * de un vistazo, sin leer nada.
 *
 * Se generan en vez de guardarse como archivos porque el negocio elige el COLOR: un
 * juego de iconos en disco obligaría a una copia por color, o a componer imágenes en
 * runtime — que es justo la dependencia que este módulo evita.
 *
 * Todas se describen respecto al centro (0,0) con el borde cerca de radio 1, que es
 * lo que permite que el contorno y el suavizado del lienzo funcionen igual para
 * todas, sin una línea de código por icono.
 */

/**
 * Estrella de cinco puntas, punta arriba. 0.382 es la razón de la estrella regular
 * (la del pentagrama): subirla la engorda hasta parecer flor, bajarla afila las
 * puntas hasta que desaparecen al tamaño al que esto se dibuja.
 */
const ESTRELLA = poligono(
  Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 === 0 ? 1 : 0.382
    const a = ((-90 + i * 36) * Math.PI) / 180
    return [r * Math.cos(a), r * Math.sin(a)] as const
  }),
)

/** Taza con asa y platillo: cafeterías, restaurantes. */
const TAZA = union(
  trapecio(1.02, 0.72, -0.44, 0.4),
  // El asa se recorta a la derecha del cuerpo: el aro entero cruzaría la taza.
  soloDonde(anillo(0.56, -0.06, 0.32, 0.13), x => x > 0.48),
  caja(-0.78, 0.5, 0.78, 0.66, 0.08),
)

/** Tijeras: estéticas, salones, barberías. */
const TIJERAS = union(
  anillo(-0.36, 0.6, 0.3, 0.11),
  anillo(0.36, 0.6, 0.3, 0.11),
  barra(-0.36, 0.42, 0.34, -0.82, 0.15),
  barra(0.36, 0.42, -0.34, -0.82, 0.15),
)

/** Mancuerna: gimnasios, estudios. */
const PESA = union(
  caja(-0.5, -0.13, 0.5, 0.13),
  caja(-0.72, -0.48, -0.5, 0.48, 0.06),
  caja(0.5, -0.48, 0.72, 0.48, 0.06),
  caja(-0.92, -0.28, -0.72, 0.28, 0.06),
  caja(0.72, -0.28, 0.92, 0.28, 0.06),
)

/** Flor de cinco pétalos: spas, florerías, bienestar. */
const FLOR = union(
  ...Array.from({ length: 5 }, (_, i) => {
    const a = ((-90 + i * 72) * Math.PI) / 180
    return disco(0.52 * Math.cos(a), 0.52 * Math.sin(a), 0.36)
  }),
  disco(0, 0, 0.26),
)

/** Bolsa de compras: tiendas, retail. */
const BOLSA = union(
  caja(-0.62, -0.12, 0.62, 0.74, 0.1),
  soloDonde(anillo(0, -0.1, 0.34, 0.12), (_, y) => y < -0.1),
)

/**
 * Corazón por su curva implícita: (x²+y²−1)³ − x²y³ ≤ 0.
 *
 * `y` se invierte porque la curva está escrita con el eje hacia arriba y aquí crece
 * hacia abajo — sin invertirlo sale de cabeza. El 1.22 y el desplazamiento la
 * centran: la curva cruda no es simétrica en vertical (la punta baja más de lo que
 * suben los lóbulos) y sin ajuste queda pegada al borde de arriba.
 */
const CORAZON: ShapeFn = (nx, ny) => {
  const x = nx * 1.22
  const y = -ny * 1.22 + 0.16
  const t = x * x + y * y - 1
  return t * t * t - x * x * y * y * y <= 0
}

/**
 * No es un cuadrado de esquinas vivas sino una superelipse: las esquinas rectas a
 * este tamaño se ven como picos sucios y pelean con el resto de la interfaz, que es
 * de esquinas redondeadas. El 0.94 compensa que un cuadrado ocupa más área que un
 * círculo del mismo radio y se vería más pesado en la fila.
 */
const CUADRADO: ShapeFn = (nx, ny) => {
  const s = 0.94
  const x = Math.abs(nx / s)
  const y = Math.abs(ny / s)
  return x * x * x * x + y * y * y * y <= 1
}

/**
 * Cómo se dibuja un sello que TODAVÍA no se gana.
 *
 * 🔴 No es una preferencia estética: es una limitación real del contorno, y se ve en
 * cuanto se renderiza. El borde se obtiene restando la figura encogida, así que una
 * figura con piezas DELGADAS —las hojas de unas tijeras, la barra de una mancuerna—
 * pierde esas piezas al encogerse y el contorno sale partido. La mancuerna en
 * contorno se leía literalmente como `{===}`.
 *
 * Por eso las figuras compactas (círculo, estrella, corazón, cuadrado) van de
 * contorno, que es lo clásico de una cartilla de sellos; y los iconos con piezas
 * finas van rellenos en el color apagado, que además se lee mejor: un icono complejo
 * dibujado con una línea de dos píxeles es ruido, no un dibujo.
 */
export type EmptyStyle = 'outline' | 'solid'

const SHAPES: Record<WalletStampShape, { fn: ShapeFn; empty: EmptyStyle }> = {
  [WalletStampShape.CIRCLE]: { fn: (nx, ny) => nx * nx + ny * ny <= 1, empty: 'outline' },
  [WalletStampShape.SQUARE]: { fn: CUADRADO, empty: 'outline' },
  [WalletStampShape.STAR]: { fn: ESTRELLA, empty: 'outline' },
  [WalletStampShape.HEART]: { fn: CORAZON, empty: 'outline' },
  [WalletStampShape.CUP]: { fn: TAZA, empty: 'solid' },
  [WalletStampShape.SCISSORS]: { fn: TIJERAS, empty: 'solid' },
  [WalletStampShape.DUMBBELL]: { fn: PESA, empty: 'solid' },
  [WalletStampShape.FLOWER]: { fn: FLOR, empty: 'outline' },
  [WalletStampShape.BAG]: { fn: BOLSA, empty: 'outline' },
}

function resolve(shape: WalletStampShape | null | undefined) {
  return SHAPES[shape ?? WalletStampShape.CIRCLE] ?? SHAPES[WalletStampShape.CIRCLE]
}

export function stampShapeFn(shape: WalletStampShape | null | undefined): ShapeFn {
  return resolve(shape).fn
}

export function stampEmptyStyle(shape: WalletStampShape | null | undefined): EmptyStyle {
  return resolve(shape).empty
}
