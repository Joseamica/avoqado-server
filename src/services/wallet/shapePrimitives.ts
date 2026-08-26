import { ShapeFn } from './pngCanvas'

/**
 * Piezas con las que se arma un sello, en coordenadas normalizadas: el centro es
 * (0,0), el borde cae cerca de radio 1, y `y` crece hacia ABAJO como en la imagen.
 *
 * 🔴 Todo se expresa como PERTENENCIA (¿este punto está dentro?) y no como trazos.
 * Es lo que hace que el mismo icono sirva relleno y de contorno sin escribirlo dos
 * veces: el lienzo obtiene el borde restando la figura encogida, y eso sólo funciona
 * si la figura sabe contestar "dentro o fuera" en cualquier punto. Con listas de
 * líneas habría que calcular un contorno paralelo por icono, que es exactamente
 * donde salen las esquinas rotas y los grosores desiguales.
 */

/** Une piezas: el punto pertenece si cae en cualquiera de ellas. */
export function union(...piezas: ShapeFn[]): ShapeFn {
  return (x, y) => piezas.some(p => p(x, y))
}

/** Recorta: pertenece a `a` pero no a `b`. Sirve para huecos. */
export function excepto(a: ShapeFn, b: ShapeFn): ShapeFn {
  return (x, y) => a(x, y) && !b(x, y)
}

/** Limita una pieza a una franja, para quedarse con media asa o media flor. */
export function soloDonde(pieza: ShapeFn, condicion: (x: number, y: number) => boolean): ShapeFn {
  return (x, y) => pieza(x, y) && condicion(x, y)
}

export function disco(cx: number, cy: number, r: number): ShapeFn {
  return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/** Un aro: el disco de fuera menos el de dentro. */
export function anillo(cx: number, cy: number, r: number, grosor: number): ShapeFn {
  const dentro = Math.max(0, r - grosor)
  return (x, y) => {
    const d2 = (x - cx) ** 2 + (y - cy) ** 2
    return d2 <= r * r && d2 >= dentro * dentro
  }
}

export function caja(x0: number, y0: number, x1: number, y1: number, radio = 0): ShapeFn {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0]
  const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0]
  if (radio <= 0) return (x, y) => x >= ax && x <= bx && y >= ay && y <= by
  // Esquinas redondeadas: fuera de los rectángulos interiores, el punto sólo cuenta
  // si está dentro del círculo de la esquina que le toca.
  return (x, y) => {
    if (x < ax || x > bx || y < ay || y > by) return false
    const dx = Math.max(ax + radio - x, 0, x - (bx - radio))
    const dy = Math.max(ay + radio - y, 0, y - (by - radio))
    return dx * dx + dy * dy <= radio * radio
  }
}

/** Una barra entre dos puntos, con grosor y extremos redondeados. */
export function barra(x0: number, y0: number, x1: number, y1: number, grosor: number): ShapeFn {
  const dx = x1 - x0
  const dy = y1 - y0
  const largo2 = dx * dx + dy * dy
  const r = grosor / 2
  return (x, y) => {
    // Proyección del punto sobre el segmento, acotada a sus extremos.
    const t = largo2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / largo2))
    const px = x0 + t * dx
    const py = y0 + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= r * r
  }
}

/** Trapecio simétrico: útil para vasos, macetas y cuerpos que se estrechan. */
export function trapecio(anchoArriba: number, anchoAbajo: number, yArriba: number, yAbajo: number): ShapeFn {
  return (x, y) => {
    if (y < yArriba || y > yAbajo) return false
    const t = (y - yArriba) / (yAbajo - yArriba)
    const medio = (anchoArriba + (anchoAbajo - anchoArriba) * t) / 2
    return Math.abs(x) <= medio
  }
}

/** Polígono cerrado, por lanzamiento de rayo. */
export function poligono(puntos: readonly (readonly [number, number])[]): ShapeFn {
  return (px, py) => {
    let dentro = false
    for (let i = 0, j = puntos.length - 1; i < puntos.length; j = i++) {
      const [xi, yi] = puntos[i]
      const [xj, yj] = puntos[j]
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) dentro = !dentro
    }
    return dentro
  }
}
