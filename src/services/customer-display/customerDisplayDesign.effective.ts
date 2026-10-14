// src/services/customer-display/customerDisplayDesign.effective.ts
import { createHash } from 'crypto'
import { recognizeStorageUrl } from './storageOrigins'
import { FACTORY_DESIGN, HEX_COLOR, type DesignValues } from './customerDisplayDesign.validation'

/**
 * Arma la ficha que ve el cliente, sobre filas YA LEÍDAS. PURO: sin base, sin red, sin reloj.
 *
 * 🔴 El orden no es cosmético: primero se revalida la PROPIEDAD de cada activo, luego se recorta por
 * la VERSIÓN que entiende el aparato, luego por el PLAN, y sólo entonces se calcula la huella.
 * Calcularla antes haría que dos tablets con distinta versión compartieran huella y una de las dos
 * nunca recibiera lo que le toca.
 */

/**
 * Los fondos REALES de cada tema en avoqado-android (`designsystem/theme/Color.kt`: `SurfaceLight` y `SurfaceDark`,
 * que `AvoqadoTheme` usa como `background` de la pantalla del cliente). El contrato vive en
 * `tests/fixtures/customer-display/theme-backgrounds.json`, que Android prueba del otro lado en F2.
 */
export const THEME_BACKGROUND = { LIGHT: '#FFFFFF', DARK: '#1C1C1E' } as const

export interface AssetRow {
  id: string
  venueId: string
  kind: 'SLIDE' | 'LOGO'
  objectPath: string
  sha256: string
}

export interface EffectiveInput {
  design: DesignValues | null
  terminal: { venueId: string; designVersion: number | null }
  venue: { logo: string | null; updatedAt: Date }
  assets: Map<string, AssetRow>
  entitlements: { slides: boolean; promotionCards: boolean }
  /** El bucket con el que escribe Firebase (`configuredStorageBucket()`, Task 2). null ⇒ no se entrega ninguna imagen. */
  bucket: string | null
}

export interface FichaEfectiva {
  schemaVersion: number
  fingerprint: string
  theme: 'LIGHT' | 'DARK'
  accent: { custom: false } | { custom: true; color: string; on: string }
  logo: { source: 'asset'; url: string; sha256: string } | { source: 'venue'; url: string; version: string } | null
  welcomeText: string | null
  thanksText: string | null
  slides: { url: string; sha256: string }[]
  slideSeconds: number
  promotionCards: { enabled: boolean }
  poweredBy: true
}

function canalesDe(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function aHex(rgb: [number, number, number]): string {
  return (
    '#' +
    rgb
      .map(v => Math.round(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

function luminancia(hex: string): number {
  const lineal = canalesDe(hex)
    .map(v => v / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * lineal[0] + 0.7152 * lineal[1] + 0.0722 * lineal[2]
}

export function contrastRatio(a: string, b: string): number {
  const [claro, oscuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x)
  return (claro + 0.05) / (oscuro + 0.05)
}

/**
 * Empuja el color del negocio lo MÍNIMO necesario para separarse del fondo de su tema: en claro se
 * mezcla con negro, en oscuro con blanco, en pasos de 5 %, hasta contraste 3.0.
 *
 * 🔴 Empujar de más rompería la marca; no empujar dejaría el acento invisible — que es el defecto
 * que ya costó una pasada en la tarjeta de sellos: sólo se ve generando el caso extremo.
 */
export function accentFor(color: string, theme: 'LIGHT' | 'DARK'): { color: string; on: string } {
  const fondo = THEME_BACKGROUND[theme]
  const destino: [number, number, number] = theme === 'LIGHT' ? [0, 0, 0] : [255, 255, 255]
  const origen = canalesDe(color)
  const conSuTexto = (elegido: string) => ({
    color: elegido,
    on: contrastRatio(elegido, '#FFFFFF') >= contrastRatio(elegido, '#000000') ? '#FFFFFF' : '#000000',
  })

  // Pasos 0 a 19 (0 % … 95 %); el paso 0 es el color tal cual, en mayúsculas.
  for (let paso = 0; paso < 20; paso++) {
    const t = paso * 0.05
    const candidato = aHex(origen.map((v, i) => v + (destino[i] - v) * t) as [number, number, number])
    if (contrastRatio(candidato, fondo) >= 3.0) return conSuTexto(candidato)
  }
  // Paso 20 (100 %): negro puro en claro (contraste 21) o blanco puro en oscuro (~17). Siempre se separa del fondo.
  return conSuTexto(aHex(destino))
}

/** La MISMA forma que produce `uploadFileToStorage` (`storage.service.ts`). Sin bucket no hay URL válida que armar. */
function urlPublica(objectPath: string, bucket: string): string {
  return `https://storage.googleapis.com/${bucket}/${objectPath}`
}

/** Serialización estable: la huella no puede depender del orden en que JS enumeró las llaves. */
function canonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor) ?? 'null'
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`
  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${canonico(v)}`).join(',')}}`
}

export function buildEffectiveDesign(input: EffectiveInput): { ficha: FichaEfectiva; assetRejected: string[] } {
  const design = input.design ?? FACTORY_DESIGN
  const assetRejected: string[] = []

  const activoValido = (id: string, kind: 'SLIDE' | 'LOGO'): AssetRow | null => {
    const fila = input.assets.get(id)
    // 🔴 Las TRES condiciones, no dos: el `kind` importa tanto como el venue. Sin él, un LOGO
    // entraría al carrusel y una imagen del carrusel podría suplantar la marca.
    if (!fila || fila.kind !== kind || fila.venueId !== input.terminal.venueId) {
      assetRejected.push(id)
      return null
    }
    return fila
  }

  const puedeCarrusel = (input.terminal.designVersion ?? 1) >= 2
  const bucket = input.bucket

  const slides = design.slides
    .map(s => activoValido(s.assetId, 'SLIDE'))
    .filter((a): a is AssetRow => a !== null)
    .flatMap(a => (bucket ? [{ url: urlPublica(a.objectPath, bucket), sha256: a.sha256 }] : []))

  const logoPropio = design.logoAssetId ? activoValido(design.logoAssetId, 'LOGO') : null
  let logo: FichaEfectiva['logo'] = null
  if (logoPropio && bucket) {
    logo = { source: 'asset', url: urlPublica(logoPropio.objectPath, bucket), sha256: logoPropio.sha256 }
  } else if (!logoPropio && recognizeStorageUrl(input.venue.logo, bucket)) {
    // El objeto legado es MUTABLE (storage.rules deja escribir ahí), así que no se puede prometer un
    // hash: viaja su versión y la tablet lo revalida (§8.1). Si no lo reconocemos, sale null y la
    // tablet muestra el nombre, igual que hoy cuando la carga falla.
    logo = { source: 'venue', url: input.venue.logo as string, version: input.venue.updatedAt.toISOString() }
  }

  // 🔴 La base no tiene CHECK sobre `accentColor`: sólo lo cuida la validación al escribir. Aquí se lee de una fila
  // guardada, y un valor que no es #RRGGBB saldría como `#NANNANNAN` hacia la tablet (su parser de color lanza).
  const acentoValido = typeof design.accentColor === 'string' && HEX_COLOR.test(design.accentColor) ? design.accentColor : null

  const ficha: Omit<FichaEfectiva, 'fingerprint'> = {
    schemaVersion: 1,
    theme: design.theme,
    accent: acentoValido ? { custom: true, ...accentFor(acentoValido, design.theme) } : { custom: false },
    logo,
    welcomeText: design.welcomeText,
    thanksText: design.thanksText,
    slides: puedeCarrusel && input.entitlements.slides ? slides : [],
    slideSeconds: design.slideSeconds,
    promotionCards: { enabled: puedeCarrusel && design.showPromotions && input.entitlements.promotionCards },
    poweredBy: true,
  }

  const fingerprint = createHash('sha256').update(canonico(ficha)).digest('hex').slice(0, 32)
  return { ficha: { ...ficha, fingerprint }, assetRejected }
}
