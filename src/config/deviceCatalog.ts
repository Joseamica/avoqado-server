/**
 * Device catalog — traduce el identificador CRUDO que reporta el hardware a un nombre
 * comercial legible y a una clase de aparato (`DeviceFormFactor`).
 *
 * NO confundir con `src/config/tpvCatalog.ts`, que es el catálogo de VENTAS (precio,
 * imagen, ficha técnica) del flujo de comprar TPV. Este es de IDENTIFICACIÓN.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────────
 * El hardware no se identifica solo:
 *   · iOS reporta `"iPhone16,2"`. `UIDevice.current.model` devuelve nada más `"iPhone"`
 *     o `"iPad"` — el nombre comercial NO existe en el SDK, hay que mapearlo.
 *   · Android reporta `manufacturer: "samsung"`, `model: "SM-X710"`. Eso es una Galaxy
 *     Tab S9, pero nadie lo sabe viendo "SM-X710".
 *   · Sunmi / PAX / NexGo sí se identifican bien: "A910S", "N86", "V2_PRO".
 *
 * ── Por qué vive en el SERVER y no en la app ──────────────────────────────────────
 * Sale un iPhone nuevo → se agrega un renglón aquí y todas las apps YA INSTALADAS lo
 * nombran bien. Si el catálogo viviera en la app haría falta un release de Android *y*
 * de iOS, más revisión de App Store, nada más para ponerle nombre a un teléfono.
 * Guardamos también el identificador crudo en `Terminal.modelIdentifier` para poder
 * re-mapear hacia atrás lo que ya se registró cuando se agregue una entrada nueva.
 *
 * ── Cómo extenderlo ───────────────────────────────────────────────────────────────
 * El catálogo NO pretende ser exhaustivo y no pasa nada si le falta un modelo: el
 * fallback siempre produce algo legible (`"Samsung SM-X710"`), nunca cadena vacía ni
 * null. Para mejorar un nombre, agrega la entrada y listo — sin tocar las apps.
 * Las llaves se normalizan, así que da igual mayúsculas, espacios o guiones bajos.
 */

import { DeviceFormFactor } from '@prisma/client'

export interface DeviceCatalogEntry {
  /** Fabricante en forma presentable: "Apple", "Samsung", "Sunmi". */
  brand: string
  /** Nombre comercial: "iPhone 15 Pro Max", "Galaxy Tab S9", "PAX A910S". */
  model: string
  /** Clase de aparato. */
  formFactor: DeviceFormFactor
}

/**
 * Normaliza una pieza de llave: mayúsculas, sin espacios/guiones/underscores.
 * Así `"SM-X710"`, `"sm_x710"` y `"sm x710"` caen en la misma entrada.
 */
function normalizeKeyPart(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '')
}

/** Llave del catálogo: fabricante + identificador, ambos normalizados. */
function catalogKey(manufacturer: string, modelIdentifier: string): string {
  return `${normalizeKeyPart(manufacturer)}|${normalizeKeyPart(modelIdentifier)}`
}

/**
 * Form factor por defecto según el fabricante, para hardware POS que se identifica por
 * marca aunque el modelo exacto no esté catalogado. Un Sunmi desconocido sigue siendo
 * un POS, no un teléfono cualquiera.
 */
const MANUFACTURER_DEFAULT_FORM_FACTOR: Record<string, DeviceFormFactor> = {
  PAX: DeviceFormFactor.HANDHELD_POS,
  NEXGO: DeviceFormFactor.HANDHELD_POS,
  SUNMI: DeviceFormFactor.COUNTERTOP_POS,
  VERIFONE: DeviceFormFactor.HANDHELD_POS,
  INGENICO: DeviceFormFactor.HANDHELD_POS,
}

/** Fabricantes cuyo nombre presentable difiere del que reporta el SO. */
const MANUFACTURER_DISPLAY_NAME: Record<string, string> = {
  APPLE: 'Apple',
  SAMSUNG: 'Samsung',
  SUNMI: 'Sunmi',
  PAX: 'PAX',
  NEXGO: 'NexGo',
  XIAOMI: 'Xiaomi',
  REDMI: 'Redmi',
  MOTOROLA: 'Motorola',
  HUAWEI: 'Huawei',
  HONOR: 'Honor',
  ONEPLUS: 'OnePlus',
  OPPO: 'OPPO',
  VIVO: 'vivo',
  REALME: 'realme',
  LENOVO: 'Lenovo',
  ZTE: 'ZTE',
  TCL: 'TCL',
  NOTHING: 'Nothing',
  GOOGLE: 'Google',
  LGE: 'LG',
  ASUS: 'ASUS',
  VERIFONE: 'Verifone',
  INGENICO: 'Ingenico',
}

/** Helper para armar entradas de Apple sin repetir `brand`. */
function apple(model: string, formFactor: DeviceFormFactor): DeviceCatalogEntry {
  return { brand: 'Apple', model, formFactor }
}

const PHONE = DeviceFormFactor.PHONE
const TABLET = DeviceFormFactor.TABLET
const HANDHELD_POS = DeviceFormFactor.HANDHELD_POS
const COUNTERTOP_POS = DeviceFormFactor.COUNTERTOP_POS

/**
 * Catálogo. Llave = `catalogKey(manufacturer, modelIdentifier)`.
 *
 * Los identificadores de Apple (`utsname.machine`) son globalmente únicos y estables,
 * por eso vale la pena listarlos. Para Android sólo listamos lo que de verdad se ve en
 * campo; el resto cae al fallback, que es legible.
 */
export const DEVICE_CATALOG: Record<string, DeviceCatalogEntry> = {
  // ── Apple · iPhone ──────────────────────────────────────────────────────────────
  [catalogKey('Apple', 'iPhone12,8')]: apple('iPhone SE (2ª gen)', PHONE),
  [catalogKey('Apple', 'iPhone13,1')]: apple('iPhone 12 mini', PHONE),
  [catalogKey('Apple', 'iPhone13,2')]: apple('iPhone 12', PHONE),
  [catalogKey('Apple', 'iPhone13,3')]: apple('iPhone 12 Pro', PHONE),
  [catalogKey('Apple', 'iPhone13,4')]: apple('iPhone 12 Pro Max', PHONE),
  [catalogKey('Apple', 'iPhone14,4')]: apple('iPhone 13 mini', PHONE),
  [catalogKey('Apple', 'iPhone14,5')]: apple('iPhone 13', PHONE),
  [catalogKey('Apple', 'iPhone14,2')]: apple('iPhone 13 Pro', PHONE),
  [catalogKey('Apple', 'iPhone14,3')]: apple('iPhone 13 Pro Max', PHONE),
  [catalogKey('Apple', 'iPhone14,6')]: apple('iPhone SE (3ª gen)', PHONE),
  [catalogKey('Apple', 'iPhone14,7')]: apple('iPhone 14', PHONE),
  [catalogKey('Apple', 'iPhone14,8')]: apple('iPhone 14 Plus', PHONE),
  [catalogKey('Apple', 'iPhone15,2')]: apple('iPhone 14 Pro', PHONE),
  [catalogKey('Apple', 'iPhone15,3')]: apple('iPhone 14 Pro Max', PHONE),
  [catalogKey('Apple', 'iPhone15,4')]: apple('iPhone 15', PHONE),
  [catalogKey('Apple', 'iPhone15,5')]: apple('iPhone 15 Plus', PHONE),
  [catalogKey('Apple', 'iPhone16,1')]: apple('iPhone 15 Pro', PHONE),
  [catalogKey('Apple', 'iPhone16,2')]: apple('iPhone 15 Pro Max', PHONE),
  [catalogKey('Apple', 'iPhone17,1')]: apple('iPhone 16 Pro', PHONE),
  [catalogKey('Apple', 'iPhone17,2')]: apple('iPhone 16 Pro Max', PHONE),
  [catalogKey('Apple', 'iPhone17,3')]: apple('iPhone 16', PHONE),
  [catalogKey('Apple', 'iPhone17,4')]: apple('iPhone 16 Plus', PHONE),
  [catalogKey('Apple', 'iPhone17,5')]: apple('iPhone 16e', PHONE),

  // ── Apple · iPad ────────────────────────────────────────────────────────────────
  [catalogKey('Apple', 'iPad13,16')]: apple('iPad Air (5ª gen)', TABLET),
  [catalogKey('Apple', 'iPad13,17')]: apple('iPad Air (5ª gen)', TABLET),
  [catalogKey('Apple', 'iPad13,18')]: apple('iPad (10ª gen)', TABLET),
  [catalogKey('Apple', 'iPad13,19')]: apple('iPad (10ª gen)', TABLET),
  [catalogKey('Apple', 'iPad14,1')]: apple('iPad mini (6ª gen)', TABLET),
  [catalogKey('Apple', 'iPad14,2')]: apple('iPad mini (6ª gen)', TABLET),
  [catalogKey('Apple', 'iPad14,3')]: apple('iPad Pro 11" (4ª gen)', TABLET),
  [catalogKey('Apple', 'iPad14,4')]: apple('iPad Pro 11" (4ª gen)', TABLET),
  [catalogKey('Apple', 'iPad14,5')]: apple('iPad Pro 12.9" (6ª gen)', TABLET),
  [catalogKey('Apple', 'iPad14,6')]: apple('iPad Pro 12.9" (6ª gen)', TABLET),
  [catalogKey('Apple', 'iPad14,8')]: apple('iPad Air 11" (M2)', TABLET),
  [catalogKey('Apple', 'iPad14,9')]: apple('iPad Air 11" (M2)', TABLET),
  [catalogKey('Apple', 'iPad14,10')]: apple('iPad Air 13" (M2)', TABLET),
  [catalogKey('Apple', 'iPad14,11')]: apple('iPad Air 13" (M2)', TABLET),
  [catalogKey('Apple', 'iPad16,3')]: apple('iPad Pro 11" (M4)', TABLET),
  [catalogKey('Apple', 'iPad16,4')]: apple('iPad Pro 11" (M4)', TABLET),
  [catalogKey('Apple', 'iPad16,5')]: apple('iPad Pro 13" (M4)', TABLET),
  [catalogKey('Apple', 'iPad16,6')]: apple('iPad Pro 13" (M4)', TABLET),

  // ── Hardware POS que Avoqado vende o soporta ────────────────────────────────────
  // Ver tpvCatalog.ts para precio/ficha; aquí sólo identificación.
  [catalogKey('PAX', 'A910S')]: { brand: 'PAX', model: 'PAX A910S', formFactor: HANDHELD_POS },
  [catalogKey('PAX', 'A920')]: { brand: 'PAX', model: 'PAX A920', formFactor: HANDHELD_POS },
  [catalogKey('PAX', 'A920Pro')]: { brand: 'PAX', model: 'PAX A920 Pro', formFactor: HANDHELD_POS },
  [catalogKey('NEXGO', 'N62')]: { brand: 'NexGo', model: 'NexGo N62', formFactor: HANDHELD_POS },
  [catalogKey('NEXGO', 'N86')]: { brand: 'NexGo', model: 'NexGo N86', formFactor: HANDHELD_POS },
  [catalogKey('SUNMI', 'D3_MINI')]: { brand: 'Sunmi', model: 'Sunmi D3 Mini', formFactor: COUNTERTOP_POS },
  [catalogKey('SUNMI', 'D3')]: { brand: 'Sunmi', model: 'Sunmi D3', formFactor: COUNTERTOP_POS },
  [catalogKey('SUNMI', 'T2')]: { brand: 'Sunmi', model: 'Sunmi T2', formFactor: COUNTERTOP_POS },
  [catalogKey('SUNMI', 'T2_MINI')]: { brand: 'Sunmi', model: 'Sunmi T2 Mini', formFactor: COUNTERTOP_POS },
  [catalogKey('SUNMI', 'T3_PRO')]: { brand: 'Sunmi', model: 'Sunmi T3 Pro', formFactor: COUNTERTOP_POS },
  [catalogKey('SUNMI', 'V2')]: { brand: 'Sunmi', model: 'Sunmi V2', formFactor: HANDHELD_POS },
  [catalogKey('SUNMI', 'V2_PRO')]: { brand: 'Sunmi', model: 'Sunmi V2 Pro', formFactor: HANDHELD_POS },
  [catalogKey('SUNMI', 'V2s')]: { brand: 'Sunmi', model: 'Sunmi V2s', formFactor: HANDHELD_POS },
  [catalogKey('SUNMI', 'P2')]: { brand: 'Sunmi', model: 'Sunmi P2', formFactor: HANDHELD_POS },
  [catalogKey('SUNMI', 'P2_LITE')]: { brand: 'Sunmi', model: 'Sunmi P2 Lite', formFactor: HANDHELD_POS },
}

/**
 * Convierte `"samsung"` → `"Samsung"`, `"SM-X710"` → `"SM-X710"`.
 * Sólo capitaliza palabras que vienen todas en minúsculas o todas en mayúsculas sin
 * dígitos; deja intactos los códigos de modelo tipo `SM-X710` o `A910S`.
 */
function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map(word => {
      if (/\d/.test(word)) return word // códigos de modelo: no tocar
      if (word !== word.toLowerCase() && word !== word.toUpperCase()) return word // ya viene mezclado (CamelCase)
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}

/** Nombre presentable del fabricante. */
export function resolveBrand(manufacturer: string): string {
  const normalized = normalizeKeyPart(manufacturer)
  return MANUFACTURER_DISPLAY_NAME[normalized] ?? titleCase(manufacturer)
}

/**
 * Resuelve un dispositivo a nombre comercial + form factor.
 *
 * Orden de resolución del form factor:
 *   1. Entrada del catálogo (lo más específico).
 *   2. `formFactorHint` que mandó el cliente en `X-Device-Form-Factor` — el cliente sabe
 *      cosas que el server no puede deducir (iOS lo sabe con `userInterfaceIdiom`,
 *      Android con `smallestScreenWidthDp`).
 *   3. Default por fabricante (un Sunmi desconocido sigue siendo un POS).
 *   4. `UNKNOWN`.
 *
 * NUNCA devuelve `model` vacío. Un modelo desconocido sale como `"Samsung SM-X710"`:
 * feo pero legible, y se arregla agregando un renglón al catálogo.
 */
export function resolveDeviceModel(
  manufacturer: string | null | undefined,
  modelIdentifier: string | null | undefined,
  formFactorHint?: DeviceFormFactor | null,
): DeviceCatalogEntry {
  const rawManufacturer = (manufacturer ?? '').trim()
  const rawModel = (modelIdentifier ?? '').trim()

  const catalogued = rawManufacturer && rawModel ? DEVICE_CATALOG[catalogKey(rawManufacturer, rawModel)] : undefined
  if (catalogued) return catalogued

  const brand = rawManufacturer ? resolveBrand(rawManufacturer) : ''
  const formFactor = formFactorHint ?? MANUFACTURER_DEFAULT_FORM_FACTOR[normalizeKeyPart(rawManufacturer)] ?? DeviceFormFactor.UNKNOWN

  // Nombre: "Samsung SM-X710". Si falta una de las dos piezas, usa la que haya.
  // Si el modelo ya empieza con la marca ("PAX A910S"), no la repite.
  let model: string
  if (!rawModel) {
    model = brand || 'Dispositivo desconocido'
  } else if (!brand) {
    model = rawModel
  } else if (normalizeKeyPart(rawModel).startsWith(normalizeKeyPart(brand))) {
    model = rawModel
  } else {
    model = `${brand} ${rawModel}`
  }

  return { brand: brand || 'Desconocido', model, formFactor }
}
