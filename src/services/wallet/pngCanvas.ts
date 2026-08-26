import { deflateSync } from 'zlib'

/**
 * Primitivas para escribir PNG a mano, compartidas por el icono y la banda de sellos.
 *
 * Existen porque el camino de emisión de credenciales no debería depender de una
 * librería de imágenes: un `.pkpass` necesita PNG obligatoriamente, y meter `sharp`
 * (binarios nativos por plataforma) para pintar círculos y cuadros de color sería
 * pagar un precio alto por algo que `zlib` ya permite.
 */

export type Rgb = [number, number, number]

/**
 * Pertenencia de un punto a una forma, en coordenadas normalizadas: el centro es
 * (0,0) y el borde cae cerca de radio 1. `y` crece hacia ABAJO, como en la imagen.
 */
export type ShapeFn = (nx: number, ny: number) => boolean

/** Verde de marca de Avoqado, para negocios sin color propio configurado. */
export const FALLBACK_RGB: Rgb = [122, 221, 44]

/** Tabla de CRC-32 del estándar PNG. */
const CRC_TABLE: number[] = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/**
 * CRC-32 propio en vez de `zlib.crc32`: esa función llegó tarde a la rama 20 de
 * Node y el `package.json` declara `node: 20.x`. Un servidor con un Node 20
 * anterior fallaría en runtime justo al emitir un pase.
 */
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([len, typeAndData, crc])
}

/** `#7ADD2C` / `7ADD2C` → [122, 221, 44]. Cualquier otra cosa cae al respaldo. */
export function hexToRgb(hex: string | null | undefined, fallback: Rgb = FALLBACK_RGB): Rgb {
  if (!hex) return fallback
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return fallback
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Mezcla dos colores. `t` va de 0 (todo `a`) a 1 (todo `b`). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)]
}

/**
 * Empaqueta un búfer de píxeles RGB (3 bytes por píxel, sin relleno) como PNG.
 * Color tipo 2, 8 bits, sin entrelazado, filtro 0 en cada renglón.
 */
export function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 2 // RGB verdadero
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // Cada renglón del PNG empieza con su byte de filtro; el búfer de píxeles no
  // lo trae, así que hay que intercalarlo.
  const rowSize = 1 + width * 3
  const raw = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0
    pixels.copy(raw, y * rowSize + 1, y * width * 3, (y + 1) * width * 3)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Lienzo de píxeles RGB con lo mínimo para dibujar una banda de sellos. */
/** Luminosidad percibida, 0 a 1. Coeficientes de Rec. 709. */
function luminosidad(c: Rgb): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255
}

/** Contraste de WCAG entre dos colores: 1 = idénticos, 21 = negro sobre blanco. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const canal = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const rel = (c: Rgb) => 0.2126 * canal(c[0]) + 0.7152 * canal(c[1]) + 0.0722 * canal(c[2])
  const x = rel(a) + 0.05
  const y = rel(b) + 0.05
  return x > y ? x / y : y / x
}

/**
 * El color del contorno de un sello que AUN NO se gana.
 *
 * 🔴 Este cálculo ya se rompió DOS veces, en direcciones opuestas, y las dos veces
 * el síntoma fue el mismo: un cliente nuevo —con CERO sellos— no puede contar
 * cuántos le faltan, que es el único dato que busca en su tarjeta.
 *
 *   1. Un gris fijo del tema desaparecía sobre el fondo OSCURO.
 *   2. "Mezcla el fondo hacia el acento" desaparecía sobre el fondo CLARO: el
 *      acento de casi cualquier negocio ya es un color vivo y claro.
 *
 * Y un tercer caso lo destapó la prueba de contraste, no el ojo: mirar sólo la
 * luminosidad del FONDO no basta. Un acento oscuro —un vino, un azul marino— sobre
 * un fondo oscuro tampoco se separa, por mucho que la dirección sea la correcta.
 *
 * Por eso aquí no hay una constante de mezcla: se elige la dirección con la que hay
 * espacio (hacia blanco si el fondo es oscuro, hacia negro si es claro) y se empuja
 * el acento por ella lo MÍNIMO necesario para alcanzar contraste. Conservar el tono
 * del negocio importa: si el contorno fuera gris neutro, la marca sólo se vería en
 * los sellos ya ganados, y un cliente nuevo no vería ni rastro de ella.
 */
export function outlineColor(fondo: Rgb, acento: Rgb): Rgb {
  // 2.2 es el mínimo con el que una línea de 2-3 píxeles todavía se lee como una
  // figura contable. No es el 3.0 que WCAG pide para texto: un círculo grande se
  // distingue con menos contraste que una letra.
  const MINIMO = 2.2
  const extremo: Rgb = luminosidad(fondo) < 0.5 ? [255, 255, 255] : [0, 0, 0]

  for (let t = 0; t <= 1; t += 0.05) {
    const candidato = mix(acento, extremo, t)
    if (contrastRatio(candidato, fondo) >= MINIMO) return candidato
  }
  // Inalcanzable en la práctica: en el extremo puro el contraste es máximo. Está
  // por si alguien baja el umbral hasta un valor imposible.
  return extremo
}

/**
 * El color de un sello NO ganado cuando se dibuja RELLENO (los iconos con piezas
 * finas, que en contorno se parten).
 *
 * 🔴 Es una funcion distinta de `outlineColor` y no una duplicacion: los dos colores
 * tienen que cumplir cosas distintas, y confundirlos deja la cartilla inservible.
 *
 * Un sello de CONTORNO ya se distingue del ganado por su FORMA —uno es una linea,
 * el otro una mancha— asi que a su color solo se le pide verse contra el fondo, y
 * quedarse en el acento puro es correcto. Un sello RELLENO se distingue del ganado
 * UNICAMENTE por el color: si sale igual, la fila entera se ve ganada y el cliente
 * no puede contar cuantos lleva. Paso exactamente eso con la taza, las tijeras y la
 * mancuerna, y no lo habria visto ninguna prueba de estructura.
 *
 * Por eso este color arranca en el FONDO y se acerca al acento lo justo: queda
 * visible contra el fondo y, por construccion, lejos del acento puro.
 */
export function dimFillColor(fondo: Rgb, acento: Rgb): Rgb {
  // 🔴 2.5 contra el sello ganado, no 1.7. Con 1.7 los numeros "cumplian" y la
  // cartilla seguia siendo dificil de leer: dos verdes rellenos a 1.76 de distancia
  // se distinguen midiendolos, no mirandolos. Se ve al renderizar el tema claro.
  //
  // Se intenta el objetivo bueno primero y se va cediendo: asi un negocio con
  // colores comodos obtiene mucha separacion, y uno con colores dificiles obtiene
  // la mejor posible — pero NUNCA el acento tal cual, que es el defecto que dejaba
  // la fila entera pareciendo ganada.
  for (const objetivo of [2.5, 2.0, 1.7]) {
    // 1) El camino natural: partir del FONDO y acercarse al acento lo justo. Da un
    //    tono apagado, emparentado con la marca y lejos del acento por construccion.
    for (let t = 0.15; t <= 1; t += 0.05) {
      const c = mix(fondo, acento, t)
      if (contrastRatio(c, fondo) >= 1.7 && contrastRatio(c, acento) >= objetivo) return c
    }

    // 2) Cuando el acento apenas contrasta con el fondo —un verde lima sobre casi
    //    blanco— NO HAY HUECO entre los dos y el camino de arriba no encuentra nada.
    //    Se sale del par empujando el acento hacia el extremo opuesto al fondo.
    const extremo: Rgb = luminosidad(fondo) < 0.5 ? [255, 255, 255] : [0, 0, 0]
    for (let t = 0.1; t <= 1; t += 0.05) {
      const c = mix(acento, extremo, t)
      if (contrastRatio(c, acento) >= objetivo && contrastRatio(c, fondo) >= 1.7) return c
    }
  }

  // Inalcanzable con colores reales: en el extremo puro el contraste es maximo.
  return outlineColor(fondo, acento)
}

export class Canvas {
  readonly pixels: Buffer

  constructor(
    readonly width: number,
    readonly height: number,
    fill: Rgb,
  ) {
    this.pixels = Buffer.alloc(width * height * 3)
    for (let i = 0; i < width * height; i++) {
      this.pixels[i * 3] = fill[0]
      this.pixels[i * 3 + 1] = fill[1]
      this.pixels[i * 3 + 2] = fill[2]
    }
  }

  private blend(x: number, y: number, color: Rgb, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return
    const i = (y * this.width + x) * 3
    const a = Math.min(1, alpha)
    this.pixels[i] = Math.round(this.pixels[i] * (1 - a) + color[0] * a)
    this.pixels[i + 1] = Math.round(this.pixels[i + 1] * (1 - a) + color[1] * a)
    this.pixels[i + 2] = Math.round(this.pixels[i + 2] * (1 - a) + color[2] * a)
  }

  /**
   * Dibuja un círculo (relleno o de contorno) con bordes suaves.
   *
   * 🔴 El suavizado NO es un lujo: sin él, un círculo de 30 píxeles se ve como una
   * escalera, y una tarjeta con diez escaleras parece rota, no minimalista. Se hace
   * muestreando 3×3 subpuntos por píxel y promediando cuántos caen dentro — más
   * barato que cualquier alternativa y suficiente a este tamaño.
   */
  circle(cx: number, cy: number, radius: number, color: Rgb, opts: { strokeWidth?: number } = {}): void {
    const stroke = opts.strokeWidth ?? 0
    const inner = stroke > 0 ? radius - stroke : 0
    const x0 = Math.max(0, Math.floor(cx - radius - 1))
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius + 1))
    const y0 = Math.max(0, Math.floor(cy - radius - 1))
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius + 1))
    const S = 3
    const step = 1 / S

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let hits = 0
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const px = x + (sx + 0.5) * step
            const py = y + (sy + 0.5) * step
            const d = Math.hypot(px - cx, py - cy)
            if (d <= radius && (stroke === 0 || d >= inner)) hits++
          }
        }
        if (hits > 0) this.blend(x, y, color, hits / (S * S))
      }
    }
  }

  /**
   * Dibuja cualquier forma centrada, rellena o de contorno, con bordes suaves.
   *
   * La forma se describe con una funcion de PERTENENCIA en coordenadas normalizadas
   * —el centro es (0,0) y el borde cae cerca de radio 1— en vez de con una lista de
   * lineas. Eso es lo que permite que el contorno salga gratis: el borde de grosor
   * `stroke` es "esta dentro de la forma pero NO dentro de la misma forma encogida",
   * y encoger es dividir el punto entre la escala. Con listas de lineas habria que
   * calcular un poligono paralelo por forma, que es donde salen las esquinas rotas.
   *
   * 🔴 El suavizado no es un lujo: sin el, una estrella de 30 pixeles se ve como una
   * escalera, y una tarjeta con diez escaleras parece rota, no minimalista.
   */
  shape(cx: number, cy: number, radius: number, color: Rgb, inside: ShapeFn, opts: { strokeWidth?: number } = {}): void {
    const stroke = opts.strokeWidth ?? 0
    // Escala de la forma interior. Con `stroke` >= radio no queda hueco: es relleno.
    const innerScale = stroke > 0 && stroke < radius ? (radius - stroke) / radius : 0
    const x0 = Math.max(0, Math.floor(cx - radius - 1))
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius + 1))
    const y0 = Math.max(0, Math.floor(cy - radius - 1))
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius + 1))
    const S = 3
    const step = 1 / S

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let hits = 0
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const nx = (x + (sx + 0.5) * step - cx) / radius
            const ny = (y + (sy + 0.5) * step - cy) / radius
            if (!inside(nx, ny)) continue
            if (innerScale > 0 && inside(nx / innerScale, ny / innerScale)) continue
            hits++
          }
        }
        if (hits > 0) this.blend(x, y, color, hits / (S * S))
      }
    }
  }

  /**
   * Dibuja una imagen ya abierta, centrada y escalada a un cuadro de `size`.
   *
   * 🔴 El escalado promedia el AREA de origen de cada pixel destino, no toma el mas
   * cercano. Un sello sube a 512 px y se dibuja a ~60: tomando el pixel mas cercano
   * se tiran 8 de cada 9 y el icono sale con los bordes rotos, que es exactamente
   * como se ve una imagen "pixeleada" — y el negocio culparia a su archivo, no al
   * escalado.
   *
   * `opacity` es lo que convierte el sello ganado en el que FALTA: la misma imagen,
   * compuesta mas debil contra el fondo. Asi el negocio sube UN archivo y no dos,
   * que es lo que Loyalz obliga a hacer.
   */
  drawImage(
    img: { width: number; height: number; pixels: Buffer },
    cx: number,
    cy: number,
    size: number,
    opts: { opacity?: number } = {},
  ): void {
    const opacity = opts.opacity ?? 1
    if (img.width <= 0 || img.height <= 0 || size <= 0 || opacity <= 0) return

    // Se respeta la proporcion: un sello alargado no se deforma para llenar el
    // cuadro, se centra dentro de el.
    const escala = size / Math.max(img.width, img.height)
    const destW = Math.max(1, Math.round(img.width * escala))
    const destH = Math.max(1, Math.round(img.height * escala))
    const x0 = Math.round(cx - destW / 2)
    const y0 = Math.round(cy - destH / 2)

    for (let dy = 0; dy < destH; dy++) {
      // Franja de origen que corresponde a esta fila destino.
      const sy0 = Math.floor((dy * img.height) / destH)
      const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * img.height) / destH))
      for (let dx = 0; dx < destW; dx++) {
        const sx0 = Math.floor((dx * img.width) / destW)
        const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * img.width) / destW))

        let r = 0
        let g = 0
        let b = 0
        let a = 0
        let n = 0
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            const i = (sy * img.width + sx) * 4
            const al = img.pixels[i + 3] / 255
            // 🔴 El color se promedia PONDERADO por su alfa. Sin eso, los pixeles
            // transparentes —que suelen venir en negro— ensucian el borde con un
            // halo oscuro alrededor de todo el icono.
            r += img.pixels[i] * al
            g += img.pixels[i + 1] * al
            b += img.pixels[i + 2] * al
            a += al
            n++
          }
        }
        if (!n || a <= 0) continue
        this.blend(x0 + dx, y0 + dy, [r / a, g / a, b / a], (a / n) * opacity)
      }
    }
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.pixels)
  }
}
