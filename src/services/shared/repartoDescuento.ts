/**
 * IVA por producto, bloque B2 (spec planes 6-7 §4.1, D7, D8): cuánto le tocó a cada renglón de cada descuento.
 *
 * Quien calcula un descuento guarda su ALCANCE y su base (CUENTA) o sus pesos por renglón (DIRIGIDO). Los centavos por
 * renglón los fija `repartosDeLaOrden` para TODAS las filas de la orden a la vez, en un orden fijo y sin que un renglón
 * reciba más de lo que vale (Codex r1 #1). La factura (B3a) sólo LEE el resultado. Puro.
 *
 * Construir o leer un reparto (`aCentavos`, `nuevoReparto*`, `leerReparto`, `importesDeLasFilas`, `repartosDeLaOrden`) nunca
 * lanza: un error ahí convertiría un intent offline en cuarentena permanente. `repartirConTopes` exige centavos ENTEROS y, si
 * no, lanza un RangeError explícito — truncar en silencio movería dinero; sus llamadores de aquí siempre pasan enteros. La
 * lectura D8 (`repartirSinConstancia`) no lanza: con fracción de centavo devuelve un resultado inválido (Codex r1 P3).
 */
import { Prisma } from '@prisma/client'
import { repartirProporcional } from '../fiscal/ivaMath'

export const REPARTO_VERSION = 1 as const
export type AlcanceDeDescuento = 'CUENTA' | 'DIRIGIDO'

export type RepartoDescuento = {
  v: typeof REPARTO_VERSION
  alcance: AlcanceDeDescuento
  /** CUENTA: si las líneas de promoción entraban en la base de quien lo calculó. DIRIGIDO: null. */
  conPromociones: boolean | null
  /** CUENTA: los renglones de la base cuando el escritor usó un subconjunto; ausente = toda la cuenta. DIRIGIDO: ausente. */
  base?: string[] | null
  /** Sólo DIRIGIDO: la fila DUPLICA un descuento que ya vive en `OrderItem.discountAmount`. */
  espejo: boolean
  /**
   * `OrderItem.id` → centavos enteros. Σ = round(amount × 100) cuando cabe; si no cabe, lo que cabe. CUENTA sólo guarda los
   * renglones que recibieron algo; DIRIGIDO guarda TODOS sus destinos vivos, en 0 los que no tuvieron lugar (son su destino:
   * B2c lo usa para retirarla si ese renglón se borra o se regala).
   */
  renglones: Record<string, number>
  /** Sólo DIRIGIDO: el ámbito de un % del motor por artículo o categoría; con él, un recálculo lo re-deriva dentro (P1). */
  ambito?: Ambito | null
  /** R6: el tope del catálogo (`maxDiscountAmount`) de un % que se re-deriva, de cuenta o dirigido. Ausente = sin tope. */
  tope?: number
  /** La fila participa en D16 (la escribe el motor en B2b, aunque su reducción resulte 0). Ausente = no. */
  reduceImpuesto?: boolean
}

/** El ámbito de un % dirigido del motor: sus productos o categorías. */
export type Ambito = { productos: string[]; categorias: string[] }

export type RenglonParaReparto = {
  id: string
  total: unknown
  discountAmount: unknown
  orderPromotionId?: string | null
  /** B3a r2 N1: una cortesía aporta 0, aunque sea línea de promoción (se resuelve ANTES que la promoción). */
  isCortesia?: boolean | null
  /** El ámbito de P1: el producto del renglón y su categoría (sin producto, nunca entra a un ámbito). */
  productId?: string | null
  product?: { categoryId: string | null } | null
  /** D16 (B2b): el impuesto registrado del renglón; sin él la reducción de impuesto da 0 en silencio. */
  taxAmount?: unknown
}
export type FilaParaReparto = {
  id: string
  type: string
  value: unknown
  amount: unknown
  appliedToItemIds?: string[] | null
  reparto?: unknown
  createdAt?: Date | string | null
  /** D16 (B2b): lo que la fila restó de `Order.taxAmount`; `sincronizarRepartos` lo recalcula si participa. */
  taxReduction?: unknown
}

/** Pesos → centavos enteros (mitad hacia arriba, sin flotante). Nulo, basura o infinito ⇒ 0. */
export function aCentavos(pesos: unknown): number {
  if (pesos == null) return 0
  try {
    const d = new Prisma.Decimal(typeof pesos === 'number' ? pesos : String(pesos))
    return d.isFinite() ? d.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber() : 0
  } catch {
    return 0
  }
}

/**
 * Lo que el renglón aporta: una cortesía, 0 — primero, porque una promoción regalada después con `compItems` conserva
 * `orderPromotionId` con total 80 y `discountAmount` 80 (B3a r2 N1) —; una promoción, su total (neto); los demás, total − su
 * descuento propio (bruto). Nunca < 0.
 */
export function aportacionCents(r: RenglonParaReparto): number {
  if (r.isCortesia) return 0
  const total = aCentavos(r.total)
  return Math.max(0, r.orderPromotionId ? total : total - aCentavos(r.discountAmount))
}

/**
 * Proporcional a `peso`, sin pasar `tope`; lo que un renglón no puede tomar va a los demás con lugar. Si no cabe, lo que cabe.
 * Precondición: `montoCents` y cada `tope` son centavos enteros (ver la cabecera del módulo).
 */
export function repartirConTopes(montoCents: number, items: Array<{ peso: number; tope: number }>): number[] {
  if (!Number.isInteger(montoCents) || items.some(x => !Number.isInteger(x.tope))) {
    throw new RangeError('repartirConTopes exige centavos enteros (monto y topes)')
  }
  const partes = items.map(() => 0)
  const conLugar = (i: number) => items[i].peso > 0 && items[i].tope - partes[i] > 0
  let activos = items.map((_, i) => i).filter(conLugar)
  let restante = Math.min(
    Math.max(0, montoCents),
    activos.reduce((s, i) => s + items[i].tope, 0),
  )
  while (restante > 0 && activos.length > 0) {
    const tentativa = repartirProporcional(
      restante,
      activos.map(i => items[i].peso),
    )
    restante = 0
    activos.forEach((i, k) => {
      const toma = Math.min(items[i].tope - partes[i], tentativa[k])
      partes[i] += toma
      restante += tentativa[k] - toma
    })
    activos = activos.filter(conLugar)
  }
  return partes
}

const porId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const aObjeto = (ids: string[], partes: number[]) =>
  Object.fromEntries(ids.map((id, i) => [id, partes[i]] as const).filter(([, c]) => c > 0))

/** Una fila de CUENTA recién creada: su regla; los centavos los pone `repartosDeLaOrden` al sincronizar. */
export function nuevoRepartoDeCuenta(o: { conPromociones: boolean; base?: string[] | null; tope?: number | null }): RepartoDescuento {
  const base = o.base && o.base.length > 0 ? [...new Set(o.base)].sort(porId) : null
  return {
    v: REPARTO_VERSION,
    alcance: 'CUENTA',
    conPromociones: o.conPromociones,
    ...(base ? { base } : {}),
    espejo: false,
    renglones: {},
    ...(o.tope != null ? { tope: o.tope } : {}),
  }
}

/**
 * Una fila DIRIGIDA: el importe en proporción a los pesos de su escritor (exacto en un espejo). La sincronización lo topa.
 * Todo destino con peso se conserva, aunque el redondeo le deje 0 centavos (Codex r2 N6): es su destino.
 */
export function nuevoRepartoDirigido(
  montoPesos: unknown,
  pesosPorRenglon: Record<string, unknown>,
  o: { espejo: boolean; ambito?: Ambito | null; tope?: number | null },
): RepartoDescuento {
  const ids = Object.keys(pesosPorRenglon)
    .filter(id => aCentavos(pesosPorRenglon[id]) > 0)
    .sort(porId)
  const monto = Math.max(0, aCentavos(montoPesos))
  const partes =
    monto > 0 && ids.length > 0
      ? repartirProporcional(
          monto,
          ids.map(id => aCentavos(pesosPorRenglon[id])),
        )
      : []
  return {
    v: REPARTO_VERSION,
    alcance: 'DIRIGIDO',
    conPromociones: null,
    espejo: o.espejo,
    renglones: Object.fromEntries(ids.map((id, i) => [id, partes[i] ?? 0] as const)),
    ...(o.ambito ? { ambito: o.ambito } : {}),
    ...(o.tope != null ? { tope: o.tope } : {}),
  }
}

/** El contrato v1 con combinaciones coherentes, o null (la factura aplica D8). Nunca lanza. */
export function leerReparto(valor: unknown): RepartoDescuento | null {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return null
  const r = valor as Record<string, unknown>
  if (r.v !== REPARTO_VERSION || typeof r.espejo !== 'boolean') return null
  const base = r.base
  if (r.alcance === 'CUENTA') {
    if (typeof r.conPromociones !== 'boolean' || r.espejo) return null
    if (base != null && !(Array.isArray(base) && base.every(x => typeof x === 'string'))) return null
  } else if (r.alcance === 'DIRIGIDO') {
    if (r.conPromociones !== null || base != null) return null
  } else return null
  const listaDeTextos = (x: unknown) => Array.isArray(x) && x.every(y => typeof y === 'string')
  const ambito = r.ambito as { productos?: unknown; categorias?: unknown } | null | undefined
  if (
    ambito != null &&
    (r.alcance !== 'DIRIGIDO' || typeof ambito !== 'object' || !listaDeTextos(ambito.productos) || !listaDeTextos(ambito.categorias))
  )
    return null
  if (r.tope !== undefined && !(typeof r.tope === 'number' && Number.isFinite(r.tope) && r.tope >= 0)) return null
  if (r.reduceImpuesto !== undefined && typeof r.reduceImpuesto !== 'boolean') return null
  if (!r.renglones || typeof r.renglones !== 'object' || Array.isArray(r.renglones)) return null
  const renglones: Record<string, number> = {}
  for (const [id, c] of Object.entries(r.renglones as Record<string, unknown>)) {
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 0) return null
    renglones[id] = c
  }
  const conBase = r.alcance === 'CUENTA' && Array.isArray(base) && base.length > 0
  return {
    v: REPARTO_VERSION,
    alcance: r.alcance,
    conPromociones: r.conPromociones as boolean | null,
    ...(conBase ? { base: base as string[] } : {}),
    espejo: r.espejo,
    renglones,
    ...(ambito ? { ambito: { productos: ambito.productos as string[], categorias: ambito.categorias as string[] } } : {}),
    ...(typeof r.tope === 'number' ? { tope: r.tope } : {}),
    ...(typeof r.reduceImpuesto === 'boolean' ? { reduceImpuesto: r.reduceImpuesto } : {}),
  }
}

/** Mismo contenido, sin importar el orden de llaves ni de listas. Compara también `tope`, `reduceImpuesto` y `ambito` (preflight R-7). */
export function mismoReparto(a: RepartoDescuento | null, b: RepartoDescuento | null): boolean {
  if (!a || !b) return a === b
  const ordenada = (x?: string[] | null) => [...(x ?? [])].sort(porId)
  const igualLista = (x: string[], y: string[]) => x.length === y.length && x.every((k, i) => k === y[i])
  const ka = ordenada(Object.keys(a.renglones))
  const kb = ordenada(Object.keys(b.renglones))
  return (
    a.alcance === b.alcance &&
    a.conPromociones === b.conPromociones &&
    a.espejo === b.espejo &&
    a.tope === b.tope &&
    a.reduceImpuesto === b.reduceImpuesto &&
    !a.ambito === !b.ambito &&
    igualLista(ordenada(a.ambito?.productos), ordenada(b.ambito?.productos)) &&
    igualLista(ordenada(a.ambito?.categorias), ordenada(b.ambito?.categorias)) &&
    igualLista(ordenada(a.base), ordenada(b.base)) &&
    igualLista(ka, kb) &&
    ka.every(k => a.renglones[k] === b.renglones[k])
  )
}

export const comoJson = (r: RepartoDescuento): Prisma.InputJsonValue => r as unknown as Prisma.InputJsonValue

/**
 * La regla de HOY de los tres recalculadores para re-derivar un %, comparando el porcentaje como NÚMERO (Codex r1 #3), más
 * P1 (founder, 1-oct): una fila que su escritor declaró DIRIGIDA conserva su importe — antes un % de categoría o un 2×1
 * guardado como % se volvía % de toda la cuenta en el siguiente recálculo.
 */
export function seRecalculaComoPorcentajeDeCuenta(fila: FilaParaReparto): boolean {
  const valor = Number(fila.value ?? 0)
  return (
    (fila.appliedToItemIds?.length ?? 0) === 0 &&
    fila.type === 'PERCENTAGE' &&
    Number.isFinite(valor) &&
    valor > 0 &&
    leerReparto(fila.reparto)?.alcance !== 'DIRIGIDO'
  )
}

/** ¿El renglón está en el ámbito de un % dirigido? Con producto, sin promoción, y su producto o su categoría en la lista. */
export function enAmbito(r: RenglonParaReparto, ambito: Ambito): boolean {
  if (!r.productId || r.orderPromotionId) return false
  const categoria = r.product?.categoryId ?? null
  return ambito.productos.includes(r.productId) || (categoria !== null && ambito.categorias.includes(categoria))
}

/**
 * P1 acotado (Codex r2 N1): un % DIRIGIDO con ámbito (artículo o categoría) se re-deriva DENTRO de su ámbito — una venta sana,
 * con todo dentro del ámbito, cobra igual que hoy. Sin ámbito (extras, 2×1) se congela: hoy se re-derivaba como % de la
 * cuenta entera, que en esos casos siempre era erróneo.
 */
export function seRecalculaDentroDeSuAmbito(fila: FilaParaReparto): boolean {
  const valor = Number(fila.value ?? 0)
  const r = leerReparto(fila.reparto)
  return (
    (fila.appliedToItemIds?.length ?? 0) === 0 &&
    fila.type === 'PERCENTAGE' &&
    Number.isFinite(valor) &&
    valor > 0 &&
    r?.alcance === 'DIRIGIDO' &&
    !!r.ambito
  )
}

/**
 * R8 (founder, 2-oct): lo ya regalado no entra a la base de un %: una cortesía (`isCortesia`; la de la terminal conserva su
 * total bruto) o un renglón sin promoción cuyo descuento propio cubre todo su total. Un descuento parcial sigue en la base,
 * como hoy.
 */
export function estaRegalado(r: RenglonParaReparto): boolean {
  if (r.isCortesia) return true
  const total = aCentavos(r.total)
  return !r.orderPromotionId && total > 0 && aCentavos(r.discountAmount) >= total
}

const aPesosRedondeados = (x: number) => Math.round(x * 100) / 100

/**
 * La regla ÚNICA de los recalculadores (los tres de hoy y, desde B2c, `voidItems`, `compItems` y el vale): un % de cuenta se
 * re-deriva sobre los renglones sin promoción; un % dirigido con ámbito, sobre los renglones de su ámbito (P1); en los dos,
 * sin lo ya regalado (R8). Lo demás conserva su importe. Devuelve los importes re-derivados y la suma de todas las filas.
 */
export function importesDeLasFilas(
  renglones: RenglonParaReparto[],
  filas: FilaParaReparto[],
): { montosRederivados: Map<string, number>; descuento: number } {
  // R8 (founder, 2-oct): la base de un % —de cuenta o dentro de su ámbito— deja fuera lo ya regalado.
  const suma = (lista: RenglonParaReparto[]) => lista.filter(x => !estaRegalado(x)).reduce((s, x) => s + Number(x.total ?? 0), 0)
  const baseDeCuenta = suma(renglones.filter(x => !x.orderPromotionId))
  const montosRederivados = new Map<string, number>()
  let descuento = 0
  for (const fila of filas) {
    let base: number | null = null
    if (seRecalculaComoPorcentajeDeCuenta(fila)) base = baseDeCuenta
    else if (seRecalculaDentroDeSuAmbito(fila)) {
      const ambito = leerReparto(fila.reparto)!.ambito!
      base = suma(renglones.filter(x => enAmbito(x, ambito)))
    }
    // R6 (founder, 2-oct): el tope del catálogo vale también al recalcular, sea de cuenta o dirigido.
    const tope = leerReparto(fila.reparto)?.tope ?? null
    if (base === null) {
      descuento += Number(fila.amount)
      continue
    }
    const calculado = aPesosRedondeados((base * Number(fila.value)) / 100)
    const monto = tope === null ? calculado : Math.min(calculado, tope)
    montosRederivados.set(fila.id, monto)
    descuento += monto
  }
  return { montosRederivados, descuento: aPesosRedondeados(descuento) }
}

const cronologico = (a: FilaParaReparto, b: FilaParaReparto) => {
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
  return ta !== tb ? ta - tb : porId(a.id, b.id)
}

/**
 * El reparto final de cada fila con reparto (incluidas las espejo, intactas). Ver «Cálculo canónico» del plan B2:
 * capacidad por renglón; DIRIGIDAS primero y luego de CUENTA, cada grupo por (createdAt, id).
 */
export function repartosDeLaOrden(
  renglones: RenglonParaReparto[],
  filas: FilaParaReparto[],
  o: { rederivadas?: ReadonlySet<string> } = {},
): Map<string, RepartoDescuento> {
  return calcular(renglones, filas, o).finales
}

/** Lo que cada renglón todavía puede recibir después de todas las filas de la orden (P11 elige y topa el premio con esto). */
export function capacidadRestante(renglones: RenglonParaReparto[], filas: FilaParaReparto[]): Map<string, number> {
  return calcular(renglones, filas, {}).capacidad
}

function calcular(
  renglones: RenglonParaReparto[],
  filas: FilaParaReparto[],
  o: { rederivadas?: ReadonlySet<string> },
): { finales: Map<string, RepartoDescuento>; capacidad: Map<string, number> } {
  const capacidad = new Map(renglones.map(x => [x.id, aportacionCents(x)] as const))
  const promo = new Set(renglones.filter(x => x.orderPromotionId).map(x => x.id))
  const ordenados = [...renglones.map(x => x.id)].sort(porId)
  const finales = new Map<string, RepartoDescuento>()
  const dirigidas: Array<[FilaParaReparto, RepartoDescuento]> = []
  const deCuenta: Array<[FilaParaReparto, RepartoDescuento]> = []
  for (const fila of filas) {
    if (o.rederivadas?.has(fila.id)) {
      const previo = leerReparto(fila.reparto)
      if (previo?.alcance === 'DIRIGIDO' && previo.ambito) {
        // P1: sigue DIRIGIDA; sus pesos son los totales de los renglones de su ámbito.
        const ambito = previo.ambito
        const pesos = Object.fromEntries(renglones.filter(x => enAmbito(x, ambito)).map(x => [x.id, aCentavos(x.total)] as const))
        dirigidas.push([fila, { ...previo, renglones: pesos }])
      } else {
        // La regla del recálculo, conservando lo que el escritor declaró: su tope (R6) y su marca de D16 (B2b).
        const regla = nuevoRepartoDeCuenta({ conPromociones: false, tope: previo?.tope ?? null })
        deCuenta.push([fila, previo?.reduceImpuesto !== undefined ? { ...regla, reduceImpuesto: previo.reduceImpuesto } : regla])
      }
      continue
    }
    const actual = leerReparto(fila.reparto)
    if (!actual) continue
    if (actual.espejo) finales.set(fila.id, actual)
    else (actual.alcance === 'DIRIGIDO' ? dirigidas : deCuenta).push([fila, actual])
  }
  const dar = (fila: FilaParaReparto, r: RepartoDescuento, ids: string[], pesos: number[]) => {
    const monto = aCentavos(fila.amount)
    const tope = (id: string) => capacidad.get(id) ?? 0
    const partes = repartirConTopes(
      monto,
      ids.map((id, i) => ({ peso: pesos[i], tope: tope(id) })),
    )
    // Lo que no cupo con sus pesos (un destino se llenó, o un destino en 0 recuperó lugar) va a sus otros destinos con
    // lugar, en proporción al lugar. Si todo cupo, `resto` es 0 y sincronizar dos veces da lo mismo (idempotente).
    const resto = monto - partes.reduce((s, c) => s + c, 0)
    if (resto > 0) {
      const lugar = ids.map((id, i) => tope(id) - partes[i])
      repartirConTopes(
        resto,
        lugar.map(l => ({ peso: l, tope: l })),
      ).forEach((c, i) => (partes[i] += c))
    }
    ids.forEach((id, i) => capacidad.set(id, tope(id) - partes[i]))
    const renglones = r.alcance === 'DIRIGIDO' ? Object.fromEntries(ids.map((id, i) => [id, partes[i]] as const)) : aObjeto(ids, partes)
    finales.set(fila.id, { ...r, renglones })
  }
  for (const [fila, r] of dirigidas.sort(([a], [b]) => cronologico(a, b))) {
    const ids = Object.keys(r.renglones)
      .filter(id => capacidad.has(id))
      .sort(porId)
    dar(
      fila,
      r,
      ids,
      ids.map(id => r.renglones[id]),
    )
  }
  for (const [fila, r] of deCuenta.sort(([a], [b]) => cronologico(a, b))) {
    const base = r.base && r.base.length > 0 ? new Set(r.base) : null
    const ids = ordenados.filter(id => (base ? base.has(id) : r.conPromociones || !promo.has(id)))
    dar(
      fila,
      r,
      ids,
      ids.map(id => capacidad.get(id) ?? 0),
    )
  }
  return { finales, capacidad }
}

/** Decimal de cualquier entrada; nulo, basura o infinito ⇒ 0. Nunca lanza (ver cabecera del módulo). */
const dec = (v: unknown): Prisma.Decimal => {
  try {
    const d = new Prisma.Decimal(typeof v === 'number' ? v : String(v ?? 0))
    return d.isFinite() ? d : new Prisma.Decimal(0)
  } catch {
    return new Prisma.Decimal(0)
  }
}

/**
 * D16 (spec planes 6-7 §4.8): «aplicar antes de impuestos» es una convención de EE.UU.; en México el precio ya trae su IVA.
 * Con IVA incluido o contrato desconocido un descuento NO baja el impuesto. Con impuesto aparte baja el que se cobró en lo
 * que de verdad le tocó a cada renglón (Codex r1 #1: un 2×1 no regala el mismo % de cada renglón): Σ parte × impuesto ÷
 * total, topado al impuesto de esos renglones y al de la cabecera, en Decimal y con UN redondeo al final (Codex r1 #2).
 */
export function reduccionDeImpuestoCobrado(
  contrato: unknown,
  partes: Record<string, number>,
  renglones: Array<{ id: string; total: unknown; taxAmount?: unknown }>,
  topeCabecera?: unknown,
): number {
  if (contrato !== 'IVA_APARTE') return 0
  const renglonPorId = new Map(renglones.map(r => [r.id, r] as const))
  let suma = new Prisma.Decimal(0)
  let impuestoDelAlcance = new Prisma.Decimal(0)
  for (const [id, centavos] of Object.entries(partes)) {
    const renglon = renglonPorId.get(id)
    if (!renglon || !(centavos > 0)) continue
    const total = dec(renglon.total)
    const impuesto = dec(renglon.taxAmount)
    if (total.lte(0) || impuesto.lte(0)) continue
    suma = suma.plus(new Prisma.Decimal(centavos).div(100).mul(impuesto).div(total))
    impuestoDelAlcance = impuestoDelAlcance.plus(impuesto)
  }
  let reduccion = Prisma.Decimal.min(suma, impuestoDelAlcance)
  if (topeCabecera !== undefined) reduccion = Prisma.Decimal.min(reduccion, Prisma.Decimal.max(0, dec(topeCabecera)))
  return reduccion.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
}

/**
 * R9 (Codex r4 R4-1; entra con P12, que es quien convierte este IVA en dinero cobrado): cuánto IVA se llevan de la cabecera
 * los renglones que SALEN de la orden (se borran o se anulan). Es un DELTA —el IVA registrado de esos renglones—, no un
 * recálculo: la cabecera conserva su autoridad en todo lo demás (la de una importada no es la suma de sus renglones). Se topa a
 * la BASE de la cabecera —su impuesto de hoy más lo que restaron las filas que VUELVEN en esta transacción (Codex r5)—: nunca
 * baja de cero por un renglón, y alcanza también la cabecera que D16 ya dejó en 0 (lo que D16 restó vuelve con la fila retirada
 * y se va con el renglón). Con IVA incluido, nada: el IVA del renglón vive dentro de su precio y la cabecera no lo suma (P12).
 */
export function impuestoQueSeLlevan(
  contrato: unknown,
  cabecera: { taxAmount: unknown; reduccionesQueVuelven: unknown[] },
  salen: Array<{ taxAmount?: unknown }>,
): Prisma.Decimal {
  const cero = new Prisma.Decimal(0)
  if (contrato === 'IVA_INCLUIDO') return cero
  const delRenglon = salen.reduce((s, r) => s.plus(Prisma.Decimal.max(0, dec(r.taxAmount))), cero)
  if (delRenglon.lte(0)) return cero
  const base = cabecera.reduccionesQueVuelven.reduce<Prisma.Decimal>((s, g) => s.plus(dec(g)), dec(cabecera.taxAmount))
  return Prisma.Decimal.min(delRenglon, Prisma.Decimal.max(0, base)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
}

/**
 * Codex r5 #1: las filas cuya reducción de impuesto NO tiene garantizado volver en esta transacción — sin la marca de D16 (el
 * motor de antes de D16 restó un 16 % inventado con `estimateAverageTaxRate`, borrado en B2b T2), o marcadas en una orden que
 * ya no es IVA_APARTE (la sincronización sólo recalcula allí). Precisión de Codex r6: el recorte de B2c sí devuelve entera la
 * de una fila que RETIRA por completo, pero no la de una que recorta o deja; marcarlas todas es conservador. Con ellas R9 no
 * puede cuadrar: sumarlas a la base deja la cabecera negativa; clamparlas deja su reducción guardada para volver como deuda.
 */
export function reduccionesQueNoVuelven<T extends { taxReduction?: unknown; reparto?: unknown }>(contrato: unknown, filas: T[]): T[] {
  return filas.filter(f => !dec(f.taxReduction).isZero() && !(contrato === 'IVA_APARTE' && leerReparto(f.reparto)?.reduceImpuesto === true))
}

// ── B2c (P4, P5): los renglones que salen de la cuenta o dejan de costar ─────────────────────────────────────────────

export type RenglonQueCambia = { id: string; appliedDiscountId?: string | null; isCortesia?: boolean; discountAmount: unknown }
export type FilaParaRecorte = FilaParaReparto & { discountId?: string | null; isComp?: boolean }
export type Recorte =
  | { accion: 'NADA' }
  | { accion: 'RETIRAR'; quitaCents: number }
  | { accion: 'RECORTAR'; quitaCents: number; amountCents: number; appliedToItemIds: string[]; reparto: RepartoDescuento | null }

/**
 * B2c (P4, P5; founder 1-oct): qué le pasa a una fila cuando ciertos renglones salen de la cuenta o dejan de costar.
 * DIRIGIDA (y espejo): se recorta por la parte GUARDADA de los destinos que salen; si salen todos, se retira entera. CUENTA:
 * nada (la sincronización la re-reparte). Vieja sin reparto: sólo las dos formas de espejo que reconoce
 * `revertirDescuentoDelRenglon` —la de `buildItemDiscountRow` y la cortesía de «Cobrar» (COMP SIN `discountId`: una COMP del
 * catálogo es de cuenta, y la cortesía de su renglón es independiente)—; lo demás es D8. Nunca lanza.
 */
export function recorteDeFila(fila: FilaParaRecorte, renglones: RenglonQueCambia[]): Recorte {
  const salen = new Map(renglones.map(r => [r.id, r] as const))
  const monto = aCentavos(fila.amount)
  const reparto = leerReparto(fila.reparto)
  const ids = fila.appliedToItemIds ?? []
  const recortar = (quita: number, nuevoReparto: RepartoDescuento | null): Recorte =>
    quita >= monto
      ? { accion: 'RETIRAR', quitaCents: monto }
      : {
          accion: 'RECORTAR',
          quitaCents: quita,
          amountCents: monto - quita,
          appliedToItemIds: ids.filter(id => !salen.has(id)),
          reparto: nuevoReparto,
        }
  if (reparto?.alcance === 'DIRIGIDO') {
    const destinos = Object.keys(reparto.renglones)
    const tocados = destinos.filter(id => salen.has(id))
    if (tocados.length === 0) return { accion: 'NADA' }
    if (tocados.length === destinos.length) return { accion: 'RETIRAR', quitaCents: monto }
    const quedan = destinos.filter(id => !salen.has(id))
    const quita = tocados.reduce((s, id) => s + reparto.renglones[id], 0)
    return recortar(quita, { ...reparto, renglones: Object.fromEntries(quedan.map(id => [id, reparto.renglones[id]] as const)) })
  }
  if (reparto) return { accion: 'NADA' }
  if (ids.length === 1 && fila.discountId && salen.get(ids[0])?.appliedDiscountId === fila.discountId)
    return { accion: 'RETIRAR', quitaCents: monto }
  if (fila.isComp === true && fila.type === 'COMP' && !fila.discountId) {
    const tocados = ids.filter(id => salen.has(id))
    if (tocados.length === 0 || !tocados.every(id => salen.get(id)!.isCortesia)) return { accion: 'NADA' }
    if (tocados.length === ids.length) return { accion: 'RETIRAR', quitaCents: monto }
    const quita = tocados.reduce((s, id) => s + aCentavos(salen.get(id)!.discountAmount), 0)
    return recortar(quita, null)
  }
  return { accion: 'NADA' }
}

// ── D8: lo que no trae reparto (filas de antes de B2, cabecera de delivery). Lo consume la factura (B3a). ──────────────

/** Texto para el dueño (va en «No se pudo facturar»). Sin jerga: no dice «reparto» (pedido del autor de B3a). */
export const MOTIVO_SIN_REPARTO_IVA_MEZCLADO =
  'Esta venta tiene un descuento general y productos con IVA distinto, y no quedó registrado cuánto le descontó a cada producto; no se puede facturar desde aquí.'

export type ResultadoSinConstancia = { ok: true; porRenglon: Record<string, number> } | { ok: false; motivo: string }

/** D8: un solo IVA ⇒ proporcional (dentro de una tasa repartir no mueve impuesto); IVA mezclado ⇒ motivo. Nunca lanza. */
export function repartirSinConstancia(
  montoCents: number,
  renglones: Array<{ id: string; importeCents: number; grupoIva: string }>,
): ResultadoSinConstancia {
  // Codex r1 P3: centavos enteros o nada — ni lanzar (es lectura) ni truncar dinero en silencio.
  if (!Number.isInteger(montoCents) || renglones.some(x => !Number.isInteger(x.importeCents))) {
    return { ok: false, motivo: 'No se pudo calcular cuánto le descontó esta venta a cada producto; no se puede facturar desde aquí.' }
  }
  if (montoCents <= 0) return { ok: true, porRenglon: {} }
  if (new Set(renglones.map(x => x.grupoIva)).size > 1) return { ok: false, motivo: MOTIVO_SIN_REPARTO_IVA_MEZCLADO }
  const base = renglones.map(x => ({ id: x.id, peso: Math.max(0, x.importeCents) })).sort((a, b) => porId(a.id, b.id))
  const disponible = base.reduce((s, b) => s + b.peso, 0)
  if (disponible < montoCents) {
    return {
      ok: false,
      motivo: `El descuento ($${(montoCents / 100).toFixed(2)}) es mayor que lo que suman los productos de la venta ($${(disponible / 100).toFixed(2)}).`,
    }
  }
  const conPeso = base.filter(b => b.peso > 0)
  return {
    ok: true,
    porRenglon: aObjeto(
      conPeso.map(b => b.id),
      repartirProporcional(
        montoCents,
        conPeso.map(b => b.peso),
      ),
    ),
  }
}
