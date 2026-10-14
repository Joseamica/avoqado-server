// src/services/customer-display/customerDisplayDesign.validation.ts

/**
 * Valida y normaliza una escritura del diseño (spec §5.2). PURO: no toca la base ni el reloj.
 *
 * 🔴 El candado de plan es por CAMPO y no por ruta: sin `CUSTOMER_DISPLAY_PROMOS` el negocio tiene
 * que poder seguir editando su marca y sus textos, y sobre todo APAGAR lo que ya no puede usar. Un
 * gate de ruta lo dejaría encerrado con las promos prendidas y sin forma de quitarlas.
 *
 * 🔴 Los textos tienen UNA sola limpieza (`cleanText`) y UNA sola regla de largo (dentro de
 * `validateDesignDraft`, sobre el texto ya limpio). No agregues un segundo normalizador: el plan traía
 * un `normalizeText` exportado que nadie llamaba y que convertía «demasiado largo» en null, mientras la
 * validación lo rechazaba; dos respuestas para la misma entrada (revisión del plan, C8). Se quitó.
 */
export interface DesignValues {
  theme: 'LIGHT' | 'DARK'
  accentColor: string | null
  logoAssetId: string | null
  welcomeText: string | null
  thanksText: string | null
  slides: { assetId: string }[]
  slideSeconds: number
  showPromotions: boolean
}

export type DesignDraft = Partial<DesignValues>

export const FACTORY_DESIGN: DesignValues = {
  theme: 'LIGHT',
  accentColor: null,
  logoAssetId: null,
  welcomeText: null,
  thanksText: null,
  slides: [],
  slideSeconds: 8,
  showPromotions: false,
}
// Congelado a fondo (sus demás campos son primitivos): una mutación de cualquier llamador —un `push` a sus imágenes—
// cambiaría la fábrica de TODAS las terminales del proceso. Congelado, truena en el acto en vez de corromper en silencio.
Object.freeze(Object.freeze(FACTORY_DESIGN).slides)

export const MAX_TEXT_CODE_POINTS = 40
export const MAX_SLIDES = 4
/**
 * Tope de la página de la lista de dispositivos (regla «bounded queries»). Vive en este módulo PURO porque lo leen dos
 * capas: la forma HTTP lo aplica al `take` y el servicio lo vuelve a aplicar por su cuenta (el MCP no pasa por Zod).
 */
export const DEVICES_PAGE_MAX = 50

/**
 * Tope de una imagen subida (logo o promoción). Vive aquí, en el módulo PURO, por la misma razón que `DEVICES_PAGE_MAX`:
 * lo aplican DOS capas —multer en la ruta, que corta el archivo mientras lo lee, y el servicio, que lo vuelve a revisar
 * por dentro—, y dos copias del número divergen sin que nadie lo note (revisión de la Task 11, hallazgo menor 3).
 */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024

/**
 * Tope de destinos al copiar un diseño a otras terminales (spec §5.2). Vive aquí, en el módulo PURO, por la misma
 * razón que `DEVICES_PAGE_MAX` y `MAX_ASSET_BYTES`: lo aplican DOS superficies —el esquema Zod de la ruta HTTP y el
 * servicio, que lo vuelve a revisar por su cuenta porque el MCP no pasa por Zod (M5, revisión final)— y dos copias del
 * número divergen sin que nadie lo note.
 */
export const MAX_COPY_TARGETS = 20

/**
 * La forma del acento. Una sola fuente: la ficha efectiva la usa para no mandar a la tablet un color guardado que no la
 * cumpla. Sin la bandera `g` a propósito: así `test()` no guarda estado entre llamadas de módulos distintos.
 */
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/
/** `\p{Cc}` = caracteres de control, sin escribir un byte de control en este archivo. */
const CONTROL_CHARS = /\p{Cc}/gu

/** Quita caracteres de control, colapsa espacios y recorta. Puede devolver '' (quien llama decide qué significa). */
export function cleanText(raw: string): string {
  return raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
}

type Resultado = { ok: true; value: DesignValues } | { ok: false; code: string; message: string }

function mal(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message }
}

/** Sólo un objeto plano (lo que sale de un JSON) es un borrador; arreglos, fechas y primitivos no. */
function esObjetoPlano(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

export function validateDesignDraft(draft: DesignDraft, actual: DesignValues, opciones: { puedeUsarPromos: boolean }): Resultado {
  // 🔴 El borrador llega del HTTP y del MCP: un cuerpo ausente (null/undefined) hacía tronar la función (500), y un
  // arreglo o un primitivo pasaba como «sin cambios» (ok:true sobre basura). Ambos se rechazan aquí, antes de leerlo.
  if (!esObjetoPlano(draft)) return mal('INVALID_DRAFT', 'Los cambios del diseño no son válidos')

  const value: DesignValues = { ...actual, slides: [...actual.slides] }

  if (draft.theme !== undefined) {
    if (draft.theme !== 'LIGHT' && draft.theme !== 'DARK') return mal('INVALID_THEME', 'El tema sólo puede ser claro u oscuro')
    value.theme = draft.theme
  }

  if (draft.accentColor !== undefined) {
    // `typeof` antes que la regex: `test()` convierte a texto, y un arreglo ['#3FB950'] pasaría para luego
    // tronar en `toUpperCase` (un 500 en vez de un 4xx).
    if (draft.accentColor !== null && (typeof draft.accentColor !== 'string' || !HEX_COLOR.test(draft.accentColor))) {
      return mal('INVALID_ACCENT_COLOR', 'El color tiene que ir en formato #RRGGBB')
    }
    value.accentColor = draft.accentColor === null ? null : draft.accentColor.toUpperCase()
  }

  if (draft.logoAssetId !== undefined) {
    // 🔴 '' NO es «sin logo»: sin logo es null. Una cadena vacía pasaría como referencia y se guardaría (Codex r8).
    if (draft.logoAssetId !== null && (typeof draft.logoAssetId !== 'string' || draft.logoAssetId === '')) {
      return mal('INVALID_LOGO', 'El logo no es válido')
    }
    value.logoAssetId = draft.logoAssetId
  }

  for (const campo of ['welcomeText', 'thanksText'] as const) {
    const bruto = draft[campo]
    if (bruto === undefined) continue
    if (bruto === null) {
      value[campo] = null
      continue
    }
    if (typeof bruto !== 'string') return mal('INVALID_TEXT', 'El texto tiene que ser una cadena')
    const limpio = cleanText(bruto)
    // 🔴 Vacío y demasiado largo son cosas DISTINTAS: se decide sobre el texto ya limpio (la v1 miraba
    // `bruto.trim()`, que no quita controles, y llamaba «largo» a un texto vacío).
    // Y lo largo se RECHAZA, no se recorta: un texto cortado a la mitad se ve como un defecto nuestro.
    // Code points, no unidades UTF-16: un emoji es UN carácter para quien escribe.
    if ([...limpio].length > MAX_TEXT_CODE_POINTS) {
      return mal('TEXT_TOO_LONG', `El texto no puede pasar de ${MAX_TEXT_CODE_POINTS} caracteres`)
    }
    value[campo] = limpio === '' ? null : limpio
  }

  if (draft.slideSeconds !== undefined) {
    const s = draft.slideSeconds
    if (!Number.isInteger(s) || s < 5 || s > 30) return mal('INVALID_SLIDE_SECONDS', 'Cada imagen puede durar de 5 a 30 segundos')
    value.slideSeconds = s
  }

  if (draft.slides !== undefined) {
    const slides = draft.slides
    if (!Array.isArray(slides)) return mal('INVALID_SLIDES', 'Las imágenes no son válidas')
    if (slides.length > MAX_SLIDES) return mal('TOO_MANY_SLIDES', `No caben más de ${MAX_SLIDES} imágenes`)
    const ids = slides.map(s => s?.assetId)
    if (ids.some(id => typeof id !== 'string' || id === '')) return mal('INVALID_SLIDES', 'Las imágenes no son válidas')
    if (new Set(ids).size !== ids.length) return mal('DUPLICATE_SLIDE', 'Hay una imagen repetida')
    value.slides = (ids as string[]).map(assetId => ({ assetId }))
  }

  if (draft.showPromotions !== undefined) {
    if (typeof draft.showPromotions !== 'boolean') return mal('INVALID_SHOW_PROMOTIONS', 'El interruptor de promociones no es válido')
    value.showPromotions = draft.showPromotions
  }

  // 🔴 El candado de plan se aplica sobre el RESULTADO comparado con lo que YA estaba, no sobre el
  // borrador: así «quitar» y «apagar» pasan siempre, que es lo que evita que un venue que baja de
  // plan quede atrapado con promos que no puede editar.
  if (!opciones.puedeUsarPromos) {
    const yaEstaban = new Set(actual.slides.map(s => s.assetId))
    if (value.slides.some(s => !yaEstaban.has(s.assetId))) {
      return mal('FEATURE_REQUIRES_PRO', 'Las promociones en reposo son del plan PRO. Puedes quitar imágenes, pero no agregarlas.')
    }
    if (value.showPromotions && !actual.showPromotions) {
      return mal('FEATURE_REQUIRES_PRO', 'Las promociones en reposo son del plan PRO.')
    }
  }

  return { ok: true, value }
}
