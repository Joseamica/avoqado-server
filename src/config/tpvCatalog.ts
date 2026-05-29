/**
 * TPV product catalog — source of truth for the Buy TPV flow.
 *
 * Prices stored in cents (MXN) to avoid rounding errors. IVA (16%) is
 * calculated at order creation time and is NOT included in unitPriceCents.
 *
 * To add a new model: extend TPV_CATALOG with a new key. The key is the
 * external identifier used by the frontend (`?model=PAX_A910S`).
 */

export interface TpvSpecs {
  dimensions?: string // e.g. "167x76x40 mm"
  weight?: string // e.g. "380 g"
  battery?: string // e.g. "5250 mAh"
  display?: string // e.g. "5\", 720x1280 IPS"
  os?: string // e.g. "Android 8.1"
  connectivity?: string[] // e.g. ["4G LTE", "WiFi 2.4/5GHz", "Bluetooth 4.2"]
  scanner?: string // e.g. "1D/2D" or "Cámara"
  camera?: string // e.g. "2MP rear"
  printer?: string // e.g. "Térmica 58mm" or null
}

export interface TpvCatalogEntry {
  brand: string // "PAX" | "NEXGO"
  model: string // "A910S" | "N62" | "N86"
  name: string // display name
  description: string
  unitPriceCents: number // MXN, sin IVA
  image: string // public URL (frontend assumes /images/tpv/<filename>)
  features: string[] // 3-4 short bullets shown on the card
  specs: TpvSpecs // full spec sheet shown in drawer
}

export const TPV_CATALOG: Record<string, TpvCatalogEntry> = {
  PAX_A910S: {
    brand: 'PAX',
    model: 'A910S',
    name: 'PAX A910S',
    description: 'Potente TPV de bolsillo con pagos integrados',
    unitPriceCents: 400_000, // $4,000 MXN
    image: '/images/tpv/pax-a910s.png',
    features: ['Pantalla táctil 5"', 'Escáner integrado', 'Cámara para QR', 'SIM con internet 4G incluida — sin costo adicional'],
    specs: {
      dimensions: 'TBD por sales',
      weight: 'TBD',
      battery: 'TBD',
      display: '5", 720x1280',
      os: 'Android 8.1',
      connectivity: ['4G LTE', 'WiFi 2.4/5GHz', 'Bluetooth 4.2'],
      scanner: '1D/2D',
      camera: '2MP rear',
      printer: 'Térmica 58mm',
    },
  },
  NEXGO_N62: {
    brand: 'NEXGO',
    model: 'N62',
    name: 'NexGo N62',
    description: 'TPV compacto, ideal para movilidad',
    unitPriceCents: 180_000, // $1,800 MXN
    image: '/images/tpv/nexgo-n62.png',
    features: ['Pantalla compacta', 'Escáner por cámara', 'Batería extendida', 'SIM con internet 4G incluida — sin costo adicional'],
    specs: {
      dimensions: 'TBD por sales',
      weight: 'TBD',
      battery: 'TBD',
      display: 'TBD',
      os: 'Android',
      connectivity: ['4G LTE'],
      scanner: 'Cámara',
      camera: 'TBD',
    },
  },
  NEXGO_N86: {
    brand: 'NEXGO',
    model: 'N86',
    name: 'NexGo N86',
    description: 'TPV premium con pantalla grande y escáner físico',
    unitPriceCents: 300_000, // $3,000 MXN
    image: '/images/tpv/nexgo-n86.png',
    features: ['Pantalla 6"', 'Escáner físico 1D/2D', 'Cámara para QR', 'SIM con internet 4G incluida — sin costo adicional'],
    specs: {
      dimensions: 'TBD por sales',
      weight: 'TBD',
      battery: 'TBD',
      display: '6"',
      os: 'Android',
      connectivity: ['4G LTE', 'WiFi'],
      scanner: '1D/2D',
      camera: 'TBD',
    },
  },
}

export const TAX_RATE = 0.16 // 16% IVA México

export type TpvCatalogKey = keyof typeof TPV_CATALOG

export function getCatalogEntry(key: string): TpvCatalogEntry | undefined {
  return TPV_CATALOG[key]
}
