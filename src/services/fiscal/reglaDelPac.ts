/**
 * IVA por producto, bloque B3a (Codex r1 #4, r2, r3): el total que calcula el PAC (Facturapi) para una factura individual, con
 * la regla MEDIDA en el sandbox (Tarea 1b, `docs/superpowers/reports/2026-10-01-iva-b3a-regla-del-pac-sandbox.md`: 19 de 20
 * facturas al dígito + 3 predichas fuera de muestra). Por concepto todo va a 6 decimales; con IVA incluido el PAC le quita el IVA
 * al precio YA redondeado y, sin descuento, deduce el importe del total (`T − traslado`, con el traslado corregido por la Tarea 6b:
 * `max(r6(Bq·t), T − Bq)`, sandbox discriminante 45 de 45). Por documento, subtotal y descuento a centavos, y el IVA se resume POR TASA, cada grupo redondeado a centavos (un concepto de base 0 no entra al resumen). Puro.
 */
import { Prisma } from '@prisma/client'
import type { CfdiItemInput } from './providers/fiscal-provider.interface'

export type TrasladoParaElPac = { factor: 'Tasa'; tasa: number } | { factor: 'Exento' } | null
export type ConceptoParaElPac = {
  precio: Prisma.Decimal
  cantidad: number
  descuentoCents: number
  ivaIncluido: boolean
  traslado: TrasladoParaElPac
  /** Sólo desempata: el mismo resultado con los renglones en cualquier orden. No entra a la cuenta. */
  nombre?: string
  /**
   * C1 (D4): parte de un concepto de la global con varias tasas. Su descuento no se mueve: Facturapi restaría un descuento de CADA
   * base (variante 4, 1-oct; reconfirmado en el sandbox el 7-oct, G5). Cuenta igual para el documento.
   */
  ajustable?: false
}

/** B3a Tarea 6b (founder, 5-oct): lo que dirá el XML, en centavos: SubTotal, Descuento, la suma del IVA de cada tasa y Total. */
export type DocumentoSegunElPac = { subtotalCents: number; descuentoCents: number; ivaCents: number; totalCents: number }
export type AjusteAlCobro = { indice: number; deCents: number; aCents: number }
export type CuadreConElPac =
  | { ok: true; conceptos: ConceptoParaElPac[]; ajustes: AjusteAlCobro[]; documento: DocumentoSegunElPac }
  | { ok: false; motivo: string }

/** B3a Tarea 6b v4, límite DECLARADO: un producto no lineal (IVA incluido con tasa) mueve hasta 5 centavos, solo o en pareja… */
export const MAX_CENTAVOS_NO_LINEAL = 5
/** …o entra en un trío de 1 centavo cada uno, los tres en el mismo sentido. Los lineales no tienen tope: sólo cuenta su suma. */
export const MAX_NO_LINEALES = 3
/**
 * Límites OPERATIVOS (no fiscales). Cuentan los REPRESENTANTES de no lineales que se prueban (hasta `MAX_NO_LINEALES` por clase
 * idéntica ante el PAC), que es lo que cuesta, no las clases (revisión Men-1; el nombre `…CLASES…` y la opción `maxClases` se
 * conservan por el contrato aprobado). Hasta aquí se prueban parejas…
 * Costo medido (5-oct, `costo-6b-men1.ts`, función real, mejor de 3, esta Mac con load ≈ 55 sobre 10 núcleos), peor caso sin
 * ajuste posible: 60 representantes + una pieza al 0 % (sin la poda de F2) ≈ 111 ms; 20 clases × 3 ≈ 105 ms; sin la pieza al
 * 0 % ≈ 38 ms; con más de 60 representantes ya no hay parejas (≈ 26 ms con 180). Sólo fuera del cargador (bloque C, que mezcla
 * IVA incluido con IVA aparte de la misma tasa): ≈ 215 ms.
 */
export const MAX_CLASES_PAREJAS = 60
/** …y hasta aquí, tríos (25 representantes + pieza al 0 %: ≈ 28 ms en la misma medición). */
export const MAX_CLASES_TRIOS = 25
/**
 * B3a ronda final F2 (Codex final #2): cuánto puede diferir la suma POR CONCEPTO de lo cobrado y aun así llegar a
 * `cuadrarConElPac` cuando el documento trae algún concepto no lineal; con todo lineal manda `cotaDeRedondeoCents` (ajuste 2). Es
 * redondeo legítimo: D16 redondea una vez el IVA que baja (NET $100.02 con $1.04 de cuenta: por concepto
 * $114.82, cobrado $114.81). Más que esto es error de armado y el cargador se detiene con su motivo: la búsqueda no tiene tope en
 * los lineales y convertiría ese error en un descuento que nadie dio. La cota es también la del trabajo SÍNCRONO: con IVA incluido
 * el PAC se separa de la suma por concepto a lo más 1 ¢ (tres redondeos de documento), así que la búsqueda ve ≤ 7 ¢.
 * Medido (5-oct, `costo-final-f2.ts`, función real, mejor de 3, esta Mac con load ≈ 10 sobre 10 núcleos), peor caso 60
 * representantes + pieza al 0 % con capacidad: k = 7 ⇒ 81 ms, igual que el peor caso ya declarado sin diferencia (`costo-6b-men1.ts`:
 * 81 ms a esta carga, 111 ms a load ≈ 55; repetido con load ≈ 14: 82 ms). Con k = 8 ya son 95 ms y con k = 10, 110 ms. Con IVA
 * aparte todo es lineal: 61 conceptos ≈ 1 ms aun con k = 600.
 */
export const MAX_CENTAVOS_DE_REDONDEO = 6

/** B3a (Codex r3 R3-2; Tarea 6b): el 8 % de la frontera no tiene una regla comprobada en el sandbox; nunca se ajusta. */
export const MOTIVO_OCHO_SIN_REGLA =
  'Esta venta lleva productos al 8 % (frontera) y todavía no está comprobado cómo redondea el SAT esa tasa, así que no se puede asegurar que la factura dé exactamente lo cobrado. Factúrala con tu contador.'
/** B3a (Tarea 1b, caso E): un importe que cae justo en medio centavo; el sandbox lo redondeó de una forma que no se explica. */
export const MOTIVO_MEDIO_CENTAVO_SIN_REGLA =
  'Un producto de esta venta tiene un importe que cae justo en medio centavo; no está comprobado cómo lo redondea el SAT, así que no se timbró. Factúrala con tu contador.'

/** B3a Tarea 6b (Codex 6b r1 #2): un concepto que el SAT no acepta (Anexo 20). Pasa con cantidades enormes de precios de centavos. */
export const MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT =
  'Un producto de esta venta saldría en la factura con un descuento o un impuesto que el SAT no acepta (pasa con cantidades muy grandes de precios de centavos); no se timbró. Factúrala con tu contador.'
/** B3a Tarea 6b v4: se alcanzó el límite operativo de la búsqueda sin encontrar el ajuste; no se afirma que no exista. */
export const MOTIVO_BUSQUEDA_LIMITADA =
  'Esta venta tiene demasiados productos distintos con IVA incluido para revisar todas las combinaciones de centavos de descuento, y no encontramos un ajuste; no se timbró. Repórtala a soporte.'

/** B3a Tarea 6b (founder, 5-oct): no encontramos cómo cuadrarla moviendo centavos de descuento. Nunca se timbra distinto. */
export function motivoNoCuadra(pacCents: number, cobradoCents: number): string {
  const p = (c: number) => `$${(c / 100).toFixed(2)}`
  return `Con el redondeo que usa el SAT, esta factura saldría por ${p(pacCents)} y se cobraron ${p(cobradoCents)}, y no encontramos cómo cuadrarla moviendo centavos de descuento sin cambiar precios. No se timbró: factúrala con tu contador o repórtala a soporte.`
}

const D = Prisma.Decimal
const cero = new D(0)
const a6 = (d: Prisma.Decimal) => d.toDecimalPlaces(6, D.ROUND_HALF_UP)
const a2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, D.ROUND_HALF_UP)
const tasaDe = (c: ConceptoParaElPac) => new D(c.traslado?.factor === 'Tasa' ? c.traslado.tasa : 0)
const importeBruto = (c: ConceptoParaElPac) => c.precio.mul(new D(String(c.cantidad)))

/** Un concepto como lo calcula el PAC: importe, descuento y la base y el traslado de su IVA, todo a 6 decimales. */
export function conceptoSegunElPac(c: ConceptoParaElPac): {
  importe: Prisma.Decimal
  descuento: Prisma.Decimal
  base: Prisma.Decimal
  traslado: Prisma.Decimal
} {
  const t = tasaDe(c)
  const q = new D(String(c.cantidad))
  const desc = new D(c.descuentoCents).div(100)
  if (!c.ivaIncluido || t.isZero()) {
    const importe = a6(importeBruto(c))
    const base = importe.minus(desc)
    return { importe, descuento: desc, base, traslado: a6(base.mul(t)) }
  }
  const divisor = t.plus(1)
  const total = a6(importeBruto(c))
  const baseBruta = a6(a6(c.precio.div(divisor)).mul(q)) // el valor unitario YA redondeado × cantidad
  const base = baseBruta.minus(a6(desc.div(divisor)))
  const traslado = a6(base.mul(t))
  if (desc.isZero()) {
    // B3a Tarea 6b, sandbox discriminante (45 de 45 conceptos): sin descuento el renglón suma EXACTO el total. Si a `Bq + r6(Bq·t)`
    // le falta para llegar a T, el PAC lo suma al traslado y la Base pasa a r6(traslado / t); si le sobra, sale del importe.
    const trasladoExacto = D.max(traslado, total.minus(baseBruta))
    const baseExacta = trasladoExacto.eq(traslado) ? base : a6(trasladoExacto.div(t))
    return { importe: total.minus(trasladoExacto), descuento: cero, base: baseExacta, traslado: trasladoExacto }
  }
  return { importe: baseBruta, descuento: a6(baseBruta.minus(total.minus(desc).minus(traslado))), base, traslado }
}

/** Lo que el SAT acepta de un concepto (Anexo 20): descuento entre 0 y el importe, base y traslado no negativos, sin impuesto con tasa 0. */
export function conceptoValidoAnteElSat(c: ConceptoParaElPac, x = conceptoSegunElPac(c)): boolean {
  const sinImpuestoSiTasaCero = !tasaDe(c).isZero() || x.traslado.isZero()
  return (
    !x.descuento.isNegative() && x.descuento.lte(x.importe) && !x.base.isNegative() && !x.traslado.isNegative() && sinImpuestoSiTasaCero
  )
}

// Aritmética entera en millonésimas de peso (los valores del PAC traen 6 decimales): sumas exactas y rápidas.
type Aporte = { imp: number; desc: number; iva: number }
const micro = (d: Prisma.Decimal) => d.mul(1_000_000).toNumber()
const aCentavos = (m: number) => Math.floor((m + 5_000) / 10_000) // mitad hacia arriba; las sumas nunca son negativas
function aporteDe(c: ConceptoParaElPac, x = conceptoSegunElPac(c)): Aporte {
  // Exento no suma impuesto; un concepto de base 0 sale sin traslado y no entra al resumen.
  const iva = c.traslado?.factor === 'Tasa' && !x.base.isZero() ? micro(x.traslado) : 0
  return { imp: micro(x.importe), desc: micro(x.descuento), iva }
}
type Sumas = { imp: number; desc: number; ivaPorTasa: Map<string, number> }
const sumar = (s: Sumas, c: ConceptoParaElPac, a: Aporte, signo: 1 | -1): Sumas => {
  const ivaPorTasa = new Map(s.ivaPorTasa)
  if (c.traslado?.factor === 'Tasa' && !tasaDe(c).isZero()) {
    const k = tasaDe(c).toFixed(6)
    ivaPorTasa.set(k, (ivaPorTasa.get(k) ?? 0) + signo * a.iva)
  }
  return { imp: s.imp + signo * a.imp, desc: s.desc + signo * a.desc, ivaPorTasa }
}
function cerrar(s: Sumas): DocumentoSegunElPac {
  const subtotalCents = aCentavos(s.imp)
  const descuentoCents = aCentavos(s.desc)
  const ivaCents = Array.from(s.ivaPorTasa.values()).reduce((t, v) => t + aCentavos(v), 0)
  return { subtotalCents, descuentoCents, ivaCents, totalCents: subtotalCents - descuentoCents + ivaCents }
}
const sumasDe = (conceptos: ConceptoParaElPac[], aportes: Aporte[]): Sumas =>
  conceptos.reduce((s, c, i) => sumar(s, c, aportes[i], 1), { imp: 0, desc: 0, ivaPorTasa: new Map<string, number>() })

export function documentoSegunElPac(conceptos: ConceptoParaElPac[]): DocumentoSegunElPac {
  return cerrar(
    sumasDe(
      conceptos,
      conceptos.map(c => aporteDe(c)),
    ),
  )
}

export function totalSegunElPacCents(conceptos: ConceptoParaElPac[]): number {
  return documentoSegunElPac(conceptos).totalCents
}

/** Zona prohibida (caso E): con IVA incluido, `precio × cantidad` a menos de 0.00001 de un medio centavo. */
function caeEnMedioCentavo(c: ConceptoParaElPac): boolean {
  if (!c.ivaIncluido) return false
  const centavos = importeBruto(c).mul(100)
  return centavos.minus(centavos.floor()).minus(0.5).abs().lt(0.001)
}

/**
 * Lineal = el descuento entra exacto y su efecto en el IVA es exacto: tasa 0/exento/sin traslado, o IVA aparte (un centavo de
 * descuento baja el traslado exactamente 0.16 ¢, aun con importe fraccionario de la venta por peso: Codex 6b r3 R3-2).
 */
const esLineal = (c: ConceptoParaElPac) => tasaDe(c).isZero() || !c.ivaIncluido

/**
 * B3a ronda final, ajuste 2: la cota de la barrera previa a `cuadrarConElPac` para ESTE documento, en centavos. Todo lineal (IVA
 * aparte, tasa 0, exento, sin traslado) ⇒ un centavo por cada redondeo legítimo, nunca menos que `MAX_CENTAVOS_DE_REDONDEO`: el de
 * cada concepto y el de cada fila de descuento que participa en D16 (`filasD16`: `sincronizarRepartos` redondea la reducción de
 * impuesto UNA VEZ POR FILA, Codex final r2). Ahí la búsqueda cuesta ≈ 1 ms a cualquier diferencia (`costo-final-f2.ts`). Con algún
 * no lineal (IVA incluido con tasa; D16 no aplica), la cota medida. El cargador la usa y el bloque C la reutiliza tal cual.
 */
export function cotaDeRedondeoCents(conceptos: ConceptoParaElPac[], filasD16: number): number {
  return conceptos.every(esLineal) ? Math.max(MAX_CENTAVOS_DE_REDONDEO, conceptos.length + filasD16) : MAX_CENTAVOS_DE_REDONDEO
}

/** Todo lo que distingue a un concepto ante el PAC y ante el lector: tratamiento, modo de precio, nombre, precio, cantidad, descuento. */
const claveFiscal = (c: ConceptoParaElPac, conNombre = true) =>
  [
    !c.traslado ? 'N' : c.traslado.factor === 'Exento' ? 'E' : `T${tasaDe(c).toFixed(6)}`,
    c.ivaIncluido ? 'i' : 'a',
    conNombre ? (c.nombre ?? '') : '',
    c.precio.toFixed(6).padStart(24, '0'),
    new D(String(c.cantidad)).toFixed(6).padStart(24, '0'),
    String(c.descuentoCents).padStart(12, '0'),
  ].join('|')

type Movimiento = { i: number; d: number; aporte: Aporte }
type Solucion = { costo: number; tocados: number; centavosConIva: number; rangos: string; movidas: Array<[number, number]> }

/**
 * B3a Tarea 6b v4 (founder, 5-oct: «la factura siempre coincide con el ticket»; Codex 6b r1-r3). Si el PAC no daría lo cobrado,
 * busca un ajuste de descuentos en centavos enteros:
 *  - los productos LINEALES (tasa 0/exento/sin traslado, o IVA aparte) cuentan sólo por la suma de su grupo: se despeja, sin tope,
 *    y se reparte en rueda (un centavo por producto y vuelta);
 *  - los NO LINEALES (IVA incluido con tasa) se prueban solos y en parejas hasta 5 centavos cada uno, o en tríos de 1 centavo en el
 *    mismo sentido (límite DECLARADO; `maxCentavos` sólo lo amplía la medición fuera de línea);
 *  - nunca negativo, nunca hasta el importe (base 0), y todo concepto que resulta, válido ante el SAT.
 * Gana el de menor costo (centavos movidos), luego menos productos tocados entre las combinaciones probadas, luego menos centavos
 * en productos con IVA, luego el orden de preferencia (con descuento, mayor importe, clave fiscal): no depende del orden de
 * captura. El 8 % y la zona del medio centavo no se ajustan. Puro.
 */
export function cuadrarConElPac(
  conceptos: ConceptoParaElPac[],
  cobradoCents: number,
  o: { desbloqueado: boolean; maxClases?: number; maxCentavos?: number },
): CuadreConElPac {
  const calc = conceptos.map(c => conceptoSegunElPac(c))
  if (conceptos.some((c, i) => !conceptoValidoAnteElSat(c, calc[i]))) return { ok: false, motivo: MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT }
  const aportes = conceptos.map((c, i) => aporteDe(c, calc[i]))
  const sumas = sumasDe(conceptos, aportes)
  const documento = cerrar(sumas)
  const ocho = conceptos.some(c => c.traslado?.factor === 'Tasa' && c.traslado.tasa === 0.08)
  if (ocho && (o.desbloqueado || documento.totalCents !== cobradoCents)) return { ok: false, motivo: MOTIVO_OCHO_SIN_REGLA }
  if (conceptos.some(caeEnMedioCentavo)) return { ok: false, motivo: MOTIVO_MEDIO_CENTAVO_SIN_REGLA }
  if (documento.totalCents === cobradoCents) return { ok: true, conceptos, ajustes: [], documento }

  const importe = conceptos.map(c => a2(importeBruto(c)).mul(100).toNumber())
  const clave = conceptos.map(c => claveFiscal(c))
  const preferencia = conceptos
    .map((_, i) => i)
    .sort(
      (a, b) =>
        Number(conceptos[b].descuentoCents > 0) - Number(conceptos[a].descuentoCents > 0) ||
        importe[b] - importe[a] ||
        (clave[a] < clave[b] ? -1 : clave[a] > clave[b] ? 1 : a - b),
    )
  const rango: number[] = []
  preferencia.forEach((i, k) => (rango[i] = k))

  // Grupos lineales por tasa ('0' = sin IVA que mover), en orden de preferencia; los no lineales, por clase aritmética.
  const lineales = new Map<string, number[]>()
  const noLineales: number[] = []
  for (const i of preferencia) {
    // C1 (D4): lo no ajustable (una parte de un concepto con varias bases) no entra a ningún grupo lineal, a ninguna clase de no
    // lineales ni a ninguna `capacidad`; sigue en aportes, sumas, documento, residuo y tasasConIva (cuenta para el total).
    if (conceptos[i].ajustable === false) continue
    if (!esLineal(conceptos[i])) noLineales.push(i)
    else lineales.set(tasaDe(conceptos[i]).toFixed(6), [...(lineales.get(tasaDe(conceptos[i]).toFixed(6)) ?? []), i])
  }
  const porClase = new Map<string, number>()
  const representantes = noLineales.filter(i => {
    const k = claveFiscal(conceptos[i], false)
    porClase.set(k, (porClase.get(k) ?? 0) + 1)
    return (porClase.get(k) ?? 0) <= MAX_NO_LINEALES // idénticos ante el PAC: basta con los mejor colocados
  })
  const opciones = new Map<number, Movimiento[]>()
  for (const i of representantes) {
    const ops: Movimiento[] = []
    const maxCentavos = o.maxCentavos ?? MAX_CENTAVOS_NO_LINEAL
    for (let d = -maxCentavos; d <= maxCentavos; d++) {
      const aCents = conceptos[i].descuentoCents + d
      if (d === 0 || aCents < 0 || aCents >= importe[i]) continue
      const nuevo = { ...conceptos[i], descuentoCents: aCents }
      const x = conceptoSegunElPac(nuevo)
      if (x.base.isZero() || !conceptoValidoAnteElSat(nuevo, x)) continue
      const a = aporteDe(nuevo, x)
      ops.push({ i, d, aporte: { imp: a.imp - aportes[i].imp, desc: a.desc - aportes[i].desc, iva: a.iva - aportes[i].iva } })
    }
    opciones.set(i, ops)
  }
  const capacidad = (g: number[]): [number, number] => [
    -g.reduce((s, i) => s + conceptos[i].descuentoCents, 0),
    g.reduce((s, i) => s + importe[i] - 1 - conceptos[i].descuentoCents, 0),
  ]
  // Reparto lineal: de un centavo en un centavo, en rueda, en orden de preferencia (cualquier reparto da el mismo documento).
  const enRueda = (g: number[], s: number): Array<[number, number]> | null => {
    const delta = new Map<number, number>()
    for (let falta = Math.abs(s); falta > 0; ) {
      const antes = falta
      for (const i of g) {
        if (falta === 0) break
        const aCents = conceptos[i].descuentoCents + (delta.get(i) ?? 0) + Math.sign(s)
        if (aCents < 0 || aCents >= importe[i]) continue
        delta.set(i, (delta.get(i) ?? 0) + Math.sign(s))
        falta--
      }
      if (falta === antes) return null
    }
    return Array.from(delta)
  }
  const sinIva = lineales.get(new D(0).toFixed(6)) ?? []
  const conIvaLineal = Array.from(lineales).find(([t]) => !new D(t).isZero())
  const capSinIva = capacidad(sinIva)
  const capConIva = conIvaLineal ? capacidad(conIvaLineal[1]) : ([0, 0] as [number, number])
  const tasaLineal = conIvaLineal ? Number(conIvaLineal[0]) : 0
  const soloIncluidoSinLineales = conceptos.every(c => c.ivaIncluido) && lineales.size === 0
  // F2 con su residuo (Codex 6b r3 R3-1): con IVA incluido, el ajuste neto queda a menos de 1.5 ¢ del residuo
  // Σ [r6(precio × cantidad) − importe cobrado en centavos], más una millonésima por concepto de holgura.
  const residuo = conceptos.reduce((t, c, i) => t + micro(importeBruto(c).toDecimalPlaces(6, D.ROUND_HALF_UP)) - importe[i] * 10_000, 0)
  const netoMin = Math.ceil((residuo - 15_000 - conceptos.length) / 10_000)
  const netoMax = Math.floor((residuo + 15_000 + conceptos.length) / 10_000)
  const netoPosible = (neto: number) => !soloIncluidoSinLineales || (neto >= netoMin && neto <= netoMax)

  // En la búsqueda hay a lo sumo UNA tasa con IVA (el 8 % ya salió arriba): las sumas son tres números y cada prueba cuesta O(1).
  const tasasConIva = new Set(conceptos.filter(c => !tasaDe(c).isZero()).map(c => tasaDe(c).toFixed(6)))
  if (tasasConIva.size > 1) return { ok: false, motivo: motivoNoCuadra(documento.totalCents, cobradoCents) }
  const ivaBase = Array.from(sumas.ivaPorTasa.values()).reduce((t, v) => t + v, 0)
  const conIva = conceptos.map(c => !tasaDe(c).isZero())
  const totalDe = (imp: number, desc: number, iva: number) => aCentavos(imp) - aCentavos(desc) + aCentavos(iva)
  const ivaPorCentavoLineal = Math.round(tasaLineal * 10_000) // IVA aparte: un centavo de descuento baja el IVA exacto (1600 millonésimas al 16 %)

  let mejor = null as Solucion | null // con el tipo completo: TS no sigue las asignaciones hechas dentro de `probar`
  const mejora = (s: Solucion) => {
    if (!mejor) return true
    const diferencia = [s.costo - mejor.costo, s.tocados - mejor.tocados, s.centavosConIva - mejor.centavosConIva].find(v => v !== 0)
    return diferencia !== undefined ? diferencia < 0 : s.rangos < mejor.rangos
  }

  const probar = (movs: Movimiento[]) => {
    let imp = sumas.imp
    let desc = sumas.desc
    let iva = ivaBase
    let costoNl = 0
    let ivaNl = 0
    for (const m of movs) {
      imp += m.aporte.imp
      desc += m.aporte.desc
      iva += m.aporte.iva
      costoNl += Math.abs(m.d)
      if (conIva[m.i]) ivaNl += Math.abs(m.d)
    }
    if (mejor && costoNl > mejor.costo) return
    // El grupo lineal con IVA (IVA aparte): h(s) = total con s centavos ahí − lo cobrado; baja 1 o 2 por centavo (monótona). El costo
    // |s| + |h(s)| sólo tiene mínimos en los bordes de sus tramos: los extremos factibles por AMBAS capacidades, el 0 y el cambio de
    // signo de h (Codex 6b r3 R3-3). Se prueban esos puntos; con el grupo sin IVA, s0 = h(s) se despeja.
    const h = (s: number) => totalDe(imp, desc + 10_000 * s, iva - ivaPorCentavoLineal * s) - cobradoCents
    const [lo, hi] = capConIva
    const primeroHasta = (k: number) => {
      let a = lo
      let b = hi + 1
      while (a < b) {
        const m = Math.floor((a + b) / 2)
        if (h(m) <= k) b = m
        else a = m + 1
      }
      return a // el primer s con h(s) ≤ k, o hi + 1
    }
    const puntos = !conIvaLineal
      ? [0]
      : [
          lo,
          hi,
          0,
          primeroHasta(0) - 1,
          primeroHasta(0),
          ...(sinIva.length ? [primeroHasta(capSinIva[1]), primeroHasta(capSinIva[0] - 1) - 1] : []),
        ]
    for (const s of puntos.length === 1 ? puntos : new Set(puntos)) {
      if (s < lo || s > hi) continue
      const s0 = h(s) // el grupo sin IVA: cada centavo baja el total exactamente 1
      if (s0 !== 0 && (sinIva.length === 0 || s0 < capSinIva[0] || s0 > capSinIva[1])) continue
      const costo = costoNl + Math.abs(s) + Math.abs(s0)
      if (mejor && costo > mejor.costo) continue
      const enConIva = s ? enRueda(conIvaLineal![1], s) : []
      const enSinIva = s0 ? enRueda(sinIva, s0) : []
      if (!enConIva || !enSinIva) continue
      const movidas: Array<[number, number]> = [...movs.map(m => [m.i, m.d] as [number, number]), ...enConIva, ...enSinIva]
      const rangos = movidas
        .map(([i, d]) => `${String(rango[i]).padStart(6, '0')}:${d}`)
        .sort()
        .join(';')
      const sol = { costo, tocados: movidas.length, centavosConIva: ivaNl + Math.abs(s), rangos, movidas }
      if (mejora(sol)) mejor = sol
    }
  }
  probar([])
  // Revisión Men-1: el límite cuenta los REPRESENTANTES que se prueban (hasta 3 por clase), que es lo que cuesta, no las clases.
  const parejas = representantes.length <= (o.maxClases ?? MAX_CLASES_PAREJAS)
  const trios = representantes.length <= (o.maxClases ?? MAX_CLASES_TRIOS)
  const R = representantes
  for (let x = 0; x < R.length; x++) {
    for (const a of opciones.get(R[x])!) {
      if (netoPosible(a.d)) probar([a])
      if (!parejas) continue
      for (let y = x + 1; y < R.length; y++) {
        for (const b of opciones.get(R[y])!) {
          if (mejor && Math.abs(a.d) + Math.abs(b.d) > mejor.costo) continue
          if (netoPosible(a.d + b.d)) probar([a, b])
          // Tríos (límite declarado): de 1 centavo cada uno y en el mismo sentido.
          if (!trios || Math.abs(a.d) !== 1 || b.d !== a.d || !netoPosible(3 * a.d) || (mejor && mejor.costo < 3)) continue
          for (let z = y + 1; z < R.length; z++) {
            for (const c of opciones.get(R[z])!) if (c.d === a.d) probar([a, b, c])
          }
        }
      }
    }
  }
  const elegida = mejor
  const completa = R.length === 0 || (parejas && trios)
  if (!elegida) return { ok: false, motivo: completa ? motivoNoCuadra(documento.totalCents, cobradoCents) : MOTIVO_BUSQUEDA_LIMITADA }
  const nuevos = new Map<number, ConceptoParaElPac>(
    elegida.movidas.map(([i, d]) => [i, { ...conceptos[i], descuentoCents: conceptos[i].descuentoCents + d }]),
  )
  const resultado = conceptos.map((c, i) => nuevos.get(i) ?? c)
  const ajustes = Array.from(nuevos.keys())
    .sort((p, q) => p - q)
    .map(i => ({ indice: i, deCents: conceptos[i].descuentoCents, aCents: nuevos.get(i)!.descuentoCents }))
  return confirmarCuadre(resultado, ajustes, cobradoCents, documento.totalCents)
}

/**
 * B3a Tarea 6b (revisión Men-2): el resultado de la búsqueda se vuelve a calcular DESDE CERO antes de darlo por bueno —el
 * documento según el PAC tiene que dar lo cobrado y cada concepto tiene que ser válido ante el SAT—. La búsqueda suma por atajos
 * (deltas en millonésimas); esto la respalda donde no hay barrera del motor (el bloque C la reutiliza tal cual).
 */
export function confirmarCuadre(
  conceptos: ConceptoParaElPac[],
  ajustes: AjusteAlCobro[],
  cobradoCents: number,
  pacCents: number,
): CuadreConElPac {
  if (conceptos.some(c => !conceptoValidoAnteElSat(c))) return { ok: false, motivo: MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT }
  const documento = documentoSegunElPac(conceptos)
  if (documento.totalCents !== cobradoCents) return { ok: false, motivo: motivoNoCuadra(pacCents, cobradoCents) }
  return { ok: true, conceptos, ajustes, documento }
}

/** El concepto tal como se mandó al PAC (`CreateInvoiceParams.items`): lo comparan el motor, la sustitución, la nota y la medición. */
export function conceptoDesdeElPayload(
  i: Pick<
    CfdiItemInput,
    'description' | 'unitPriceCents' | 'unitPriceDecimal' | 'quantity' | 'discountCents' | 'taxIncluded' | 'objetoImp' | 'taxes'
  >,
): ConceptoParaElPac {
  // C1: un concepto con varias bases o con más de un traslado de IVA no es UN concepto de la 6b: leerlo con el primer traslado lo
  // sumaría mal en silencio.
  if (i.taxes.some(t => t.base !== undefined) || i.taxes.filter(t => t.type === 'IVA' && !t.withholding).length > 1)
    throw new Error('conceptoDesdeElPayload: un concepto con varias tasas se lee con conceptosDesdeElPayload')
  const iva = i.taxes.find(t => t.type === 'IVA' && !t.withholding)
  return {
    // Revisión Men-3: la MISMA condición y conversión que el proveedor (`facturapi.provider.ts`: `!= null ? Number(…)`).
    precio: i.unitPriceDecimal != null ? new D(Number(i.unitPriceDecimal)) : new D(i.unitPriceCents).div(100),
    cantidad: i.quantity,
    descuentoCents: i.discountCents,
    ivaIncluido: i.taxIncluded === true,
    traslado: i.objetoImp !== '02' || !iva ? null : iva.factor === 'Exento' ? { factor: 'Exento' } : { factor: 'Tasa', tasa: iva.rate },
    nombre: i.description,
  }
}

/**
 * C1 (D4): un concepto de la global con varias tasas (precio = Σ bases, sin descuento) como lo suma el PAC: una parte por base, sin
 * IVA incluido y no ajustable. Medido el 1-oct (variantes 2, 3 y 5): el importe del concepto es el precio y cada traslado,
 * r6(base × tasa). Cualquier otro concepto, como `conceptoDesdeElPayload` (6b).
 */
export function conceptosDesdeElPayload(i: Parameters<typeof conceptoDesdeElPayload>[0]): ConceptoParaElPac[] {
  if (!i.taxes.some(t => t.base !== undefined)) return [conceptoDesdeElPayload(i)]
  return i.taxes
    .filter(t => t.type === 'IVA' && !t.withholding)
    .map(t => ({
      precio: new D(t.base!),
      cantidad: 1,
      descuentoCents: 0,
      ivaIncluido: false,
      traslado: t.factor === 'Exento' ? { factor: 'Exento' as const } : { factor: 'Tasa' as const, tasa: t.rate },
      nombre: i.description,
      ajustable: false as const,
    }))
}

/** C1: lo que el SAT acepta de un concepto con varias tasas: cantidad 1, sin descuento, ≥ 2 traslados distintos, bases > 0 a 6 decimales que suman el precio, cada parte válida. */
export function conceptoMultitasaValido(i: Parameters<typeof conceptoDesdeElPayload>[0] & { quantity: number }): boolean {
  const ts = i.taxes.filter(t => t.type === 'IVA' && !t.withholding)
  if (i.quantity !== 1 || i.discountCents !== 0 || i.taxIncluded || i.objetoImp !== '02' || ts.length < 2 || ts.length !== i.taxes.length)
    return false
  if (!ts.every(t => typeof t.base === 'string' && /^\d+\.\d{6}$/.test(t.base) && new D(t.base).gt(0))) return false
  if (new Set(ts.map(t => `${t.factor}:${t.rate}`)).size !== ts.length) return false
  const precio = i.unitPriceDecimal ? new D(i.unitPriceDecimal) : new D(i.unitPriceCents).div(100)
  if (!ts.reduce((s, t) => s.plus(t.base!), cero).equals(precio)) return false
  return conceptosDesdeElPayload(i).every(c => conceptoValidoAnteElSat(c))
}

/** C1/C2: el resumen de traslados del documento como lo escribirá el PAC, en centavos y con la forma de `Cfdi.taxBreakdown`. */
export type TrasladoDelResumen = { tipoFactor: 'Tasa' | 'Exento'; tasa: string | null; baseCents: number; importeCents: number | null }
export function resumenSegunElPac(conceptos: ConceptoParaElPac[]): TrasladoDelResumen[] {
  const grupos = new Map<string, { tipoFactor: 'Tasa' | 'Exento'; tasa: string | null; base: Prisma.Decimal; importe: Prisma.Decimal }>()
  for (const c of conceptos) {
    if (!c.traslado) continue
    const x = conceptoSegunElPac(c)
    if (x.base.isZero()) continue // un concepto de base 0 sale sin traslado y no entra al resumen (igual que en `aporteDe`)
    const tasa = c.traslado.factor === 'Exento' ? null : new D(c.traslado.tasa).toFixed(6)
    const k = tasa ?? 'Exento'
    const g = grupos.get(k) ?? { tipoFactor: c.traslado.factor, tasa, base: cero, importe: cero }
    grupos.set(k, { ...g, base: g.base.plus(x.base), importe: g.importe.plus(x.traslado) })
  }
  const enCentavos = (d: Prisma.Decimal) => a2(d).mul(100).toNumber() // mitad hacia arriba, como `aCentavos` sobre millonésimas
  return [...grupos.values()].map(g => ({
    tipoFactor: g.tipoFactor,
    tasa: g.tasa,
    baseCents: enCentavos(g.base),
    importeCents: g.tipoFactor === 'Exento' ? null : enCentavos(g.importe),
  }))
}
