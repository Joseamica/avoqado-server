// src/services/fiscal/assetTypeCatalog.ts
//
// Catálogo de tipos de activo fijo con su tasa MÁXIMA anual de depreciación autorizada por la LISR
// (art. 34-35), "deducción de inversiones" en línea recta. El founder eligió: tasas oficiales por tipo
// PRECARGADAS pero EDITABLES por el contador (una autorización especial puede diferir). Este catálogo da
// el DEFAULT; el `FixedAsset.annualRate` guardado es el que manda (puede haberse ajustado).
//
// Depreciación = línea recta: deducción anual = MOI × tasa; mensual = anual / 12, por meses completos de
// uso. `moiCapCents` topa la base deducible (autos: $175,000 art. 36-II — arriba de eso no es deducible).
// LIMITACIÓN v1: base NOMINAL (sin actualización por INPC). La actualización inflacionaria del art. 31 se
// aplica en la declaración anual; el contador la ajusta ahí. Se documenta, no se asume en silencio.
//
// `satAccountGroup` = código agrupador SAT de la cuenta de activo (para el mapeo contable, slice posterior).

export interface AssetTypeDef {
  /** Clave estable (no cambiar; se guarda en `FixedAsset.assetType`). */
  key: string
  /** Etiqueta para el usuario (es-MX). */
  label: string
  /** Tasa MÁXIMA anual autorizada (fracción). Default; editable al registrar. */
  annualRate: number
  /** Referencia legal (para el tooltip/reporte). */
  satRef: string
  /** Código agrupador SAT de la cuenta de ACTIVO (depreciación acumulada = 165). */
  satAccountGroup: string
  /** Tope de base deducible en centavos (autos $175,000); null = sin tope. */
  moiCapCents: number | null
}

/** Tasas máximas LISR art. 34-35. Editables por el usuario; esto es solo el default por tipo. */
export const ASSET_TYPE_CATALOG: AssetTypeDef[] = [
  {
    key: 'CONSTRUCCION',
    label: 'Edificios y construcciones',
    annualRate: 0.05,
    satRef: 'LISR 34-I',
    satAccountGroup: '152',
    moiCapCents: null,
  },
  {
    key: 'MAQUINARIA_EQUIPO',
    label: 'Maquinaria y equipo (general)',
    annualRate: 0.1,
    satRef: 'LISR 35-XIV',
    satAccountGroup: '153',
    moiCapCents: null,
  },
  {
    key: 'EQUIPO_TRANSPORTE',
    label: 'Equipo de transporte (autos, camionetas)',
    annualRate: 0.25,
    satRef: 'LISR 34-VI',
    satAccountGroup: '154',
    moiCapCents: 175_000_00,
  },
  {
    key: 'MOBILIARIO_OFICINA',
    label: 'Mobiliario y equipo de oficina',
    annualRate: 0.1,
    satRef: 'LISR 34-III',
    satAccountGroup: '155',
    moiCapCents: null,
  },
  { key: 'EQUIPO_COMPUTO', label: 'Equipo de cómputo', annualRate: 0.3, satRef: 'LISR 34-VII', satAccountGroup: '156', moiCapCents: null },
  {
    key: 'EQUIPO_COMUNICACION',
    label: 'Equipo de comunicación',
    annualRate: 0.25,
    satRef: 'LISR 34-VI',
    satAccountGroup: '157',
    moiCapCents: null,
  },
  {
    key: 'HERRAMIENTA',
    label: 'Herramienta, dados, moldes y troqueles',
    annualRate: 0.35,
    satRef: 'LISR 34-V',
    satAccountGroup: '153',
    moiCapCents: null,
  },
  { key: 'OTROS', label: 'Otros activos fijos', annualRate: 0.1, satRef: 'LISR 35-XIV', satAccountGroup: '155', moiCapCents: null },
]

const BY_KEY = new Map(ASSET_TYPE_CATALOG.map(a => [a.key, a]))

/** Devuelve la definición del tipo, o `undefined` si la clave no existe. */
export function getAssetType(key: string): AssetTypeDef | undefined {
  return BY_KEY.get(key)
}

/** Clave válida del catálogo. */
export function isValidAssetType(key: string): boolean {
  return BY_KEY.has(key)
}

/**
 * Sugerencia "esto parece inversión, no gasto": true si el monto rebasa el umbral. NO decide solo — solo
 * SUGIERE; el usuario confirma antes de que algo se deprecie (opt-in). El umbral es configurable por local.
 */
export const DEFAULT_FIXED_ASSET_SUGGEST_THRESHOLD_CENTS = 5_000_00

export function suggestsFixedAsset(totalCents: number, thresholdCents: number = DEFAULT_FIXED_ASSET_SUGGEST_THRESHOLD_CENTS): boolean {
  return totalCents >= thresholdCents
}

/** Base depreciable efectiva = MOI topado por `moiCapCents` del tipo (autos $175k). */
export function cappedMoiCents(moiCents: number, assetType: string): number {
  const def = BY_KEY.get(assetType)
  if (!def || def.moiCapCents == null) return Math.max(0, moiCents)
  return Math.max(0, Math.min(moiCents, def.moiCapCents))
}
