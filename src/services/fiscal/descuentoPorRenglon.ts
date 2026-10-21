/**
 * IVA por producto, bloque B3a (spec planes 6-7 §4.2, D7 lectura, D8): cuánto descuento de CUENTA le toca a cada renglón de la
 * factura. Sólo LEE lo que guardó quien calculó cada descuento (`OrderDiscount.reparto`, bloques B2 y B2c); nunca reinterpreta
 * un reparto ni decide con la cabecera A QUIÉN le toca. Lo que la cabecera trae sin constancia (filas de antes de B2, delivery,
 * descuentos de cabecera históricos de la terminal, lo que un reparto no alcanzó a colocar) es D8: con un solo IVA se reparte
 * en proporción; con IVA mezclado se bloquea con su motivo. Puro: sin base, sin reloj.
 */
import { leerReparto, repartirSinConstancia, type RepartoDescuento } from '../shared/repartoDescuento'

const centavos = (d: unknown) => Math.round(Number(d ?? 0) * 100)

/** Filas `OrderDiscount` por lectura. La consulta de la orden pide una de más para saber si hay que seguir leyendo. */
export const PAGINA_DE_DESCUENTOS = 100

/** La relación `orderDiscounts` que leen el cargador individual y la global (misma verdad en las dos). */
export const DESCUENTOS_PARA_CONCEPTOS = {
  select: { id: true, amount: true, reparto: true },
  orderBy: { id: 'asc' as const },
  take: PAGINA_DE_DESCUENTOS + 1,
}

export const MOTIVO_REPARTO_FUERA_DE_LA_CUENTA =
  'Un descuento de esta venta está guardado sobre un artículo que ya no se cobra (se quitó o se dio de cortesía); no se puede saber a qué artículo le toca. Repórtala a soporte.'
export const MOTIVO_DESCUENTOS_NO_CUADRAN =
  'Los descuentos guardados de esta venta suman más que su descuento total; no se timbró. Revisa la cuenta o repórtala a soporte.'

export type FilaDeDescuento = { amount: unknown; reparto?: unknown }

export type RenglonParaDescuento = {
  llave: string
  /** Lo que su descuento propio ya pesa dentro de `Order.discountAmount` (`descuentoPropioEnCabeceraCents`). */
  propioEnCabeceraCents: number
  /** null = el renglón no va a la factura (cortesía, D9). */
  vivo: null | { grupoIva: string; disponibleCents: number }
}

/**
 * Lo que el renglón cobra, en centavos. La cortesía guarda lo regalado: con el renglón en total 0 (móvil, importe libre) o con
 * el descuento igual al total (terminal, también sobre una línea de promoción). Las promociones guardan su total YA neto; los
 * demás, el bruto y su descuento aparte. Negativo = dato roto (descuento mayor que el renglón): lo detiene su motivo.
 */
export function netoRenglonCents(r: {
  total?: unknown
  discountAmount?: unknown
  orderPromotionId?: string | null
  isCortesia?: boolean | null
}): number {
  const total = centavos(r.total)
  if (r.isCortesia) return total === 0 ? 0 : total - centavos(r.discountAmount)
  if (r.orderPromotionId) return total
  if (total === 0) return 0
  return total - centavos(r.discountAmount)
}

/**
 * Lo que el descuento propio del renglón ya pesa dentro de `Order.discountAmount`:
 *  - la cortesía que deja el renglón en total 0 (móvil, importe libre de la terminal) baja el subtotal, no la cabecera;
 *  - la cortesía de la terminal (`compItems`, «Cobrar») suma lo regalado a la cabecera, también sobre una línea de promoción;
 *  - la promoción guarda su descuento SÓLO en el renglón (`promotion.service.ts`), nunca en la cabecera;
 *  - todo otro descuento de renglón suma a la cabecera por su fila espejo.
 */
export function descuentoPropioEnCabeceraCents(r: {
  total?: unknown
  discountAmount?: unknown
  orderPromotionId?: string | null
  isCortesia?: boolean | null
}): number {
  if (centavos(r.total) === 0) return 0
  if (r.isCortesia) return centavos(r.discountAmount)
  if (r.orderPromotionId) return 0
  return centavos(r.discountAmount)
}

/**
 * Lo que consta de una fila: un reparto v1 que no es espejo y que no suma MÁS que su fila. Si suma menos (B2: no cupo), lo
 * que falta queda sin constancia. Si suma más, o no se puede leer, la fila entera queda sin constancia.
 */
function constanciaDe(fila: FilaDeDescuento, r: RepartoDescuento | null): { renglones: Record<string, number>; sumaCents: number } | null {
  if (!r || r.espejo) return null
  const sumaCents = Object.values(r.renglones).reduce((a, b) => a + b, 0)
  return sumaCents <= centavos(fila.amount) ? { renglones: r.renglones, sumaCents } : null
}

/**
 * B4b (spec §4.9; Codex r1 P1 #3): lo que se sabe de los descuentos de la cuenta ANTES de D8. Devuelve:
 *  - `porLlave`: lo que consta por renglón;
 *  - `d8Cents`: lo que queda sin constancia y entra a D8, con la regla M1;
 *  - `quedan`: sobre qué capacidad se reparte;
 *  - `motivos`: los que la factura no deja pasar.
 * Un reparto sobre un renglón que ya no cobra, o lo guardado que suma más que la cabecera, se anotan como motivo SIN perder lo
 * demás. La factura (`descuentoDeCuentaPorRenglon`) se detiene con el primer motivo, como siempre; el reporte conserva lo que consta
 * y sólo aproxima el resto. Puro.
 *
 * Por renglón:
 *  1. lo que consta de cada fila va a sus renglones (las espejo no: ya viven en el renglón; un destino en 0 no se mira);
 *  2. lo que la cabecera trae SIN constancia = cabecera − descuentos propios que viven en ella − lo que consta;
 *  3. eso es lo que D8 repartirá sobre lo que le queda a cada renglón vivo. Lo que no tiene reparto entra ENTERO (si no cabe, D8 lo
 *     dice); lo que le FALTA a un reparto válido entra sólo hasta la capacidad que queda (M1: la cabecera de B2c es nominal, Σ
 *     filas sin tope, y lo que no cupo nunca se cobró — el cobro es LEAST(cabecera, subtotal)).
 * Si lo sin constancia sale NEGATIVO: con alguna fila con reparto (escritor nativo, coherente) es su motivo; sin ninguna (las
 * importadas de pos-sync escriben renglón y cabecera por separado) se trata como 0, igual que antes de B3a (M2).
 */
export function partesDeLaCuenta(p: { cabeceraCents: number; renglones: RenglonParaDescuento[]; filas: FilaDeDescuento[] }): {
  porLlave: Record<string, number>
  d8Cents: number
  quedan: Array<{ id: string; importeCents: number; grupoIva: string }>
  motivos: string[]
} {
  const vivos = new Map(p.renglones.flatMap(r => (r.vivo ? [[r.llave, r.vivo] as const] : [])))
  const porLlave: Record<string, number> = {}
  const motivos: string[] = []
  let constaCents = 0
  let faltaCents = 0
  let hayReparto = false
  for (const fila of p.filas) {
    const r = leerReparto(fila.reparto)
    if (r) hayReparto = true
    const c = constanciaDe(fila, r)
    if (!c) continue
    constaCents += c.sumaCents
    faltaCents += centavos(fila.amount) - c.sumaCents
    for (const [llave, cents] of Object.entries(c.renglones)) {
      if (cents === 0) continue
      if (!vivos.has(llave)) {
        if (!motivos.includes(MOTIVO_REPARTO_FUERA_DE_LA_CUENTA)) motivos.push(MOTIVO_REPARTO_FUERA_DE_LA_CUENTA)
        continue
      }
      porLlave[llave] = (porLlave[llave] ?? 0) + cents
    }
  }
  const quedan = Array.from(vivos, ([llave, v]) => ({
    id: llave,
    importeCents: v.disponibleCents - (porLlave[llave] ?? 0),
    grupoIva: v.grupoIva,
  }))
  const sinConstanciaCents = p.cabeceraCents - p.renglones.reduce((s, r) => s + r.propioEnCabeceraCents, 0) - constaCents
  if (sinConstanciaCents < 0) {
    if (hayReparto) motivos.push(MOTIVO_DESCUENTOS_NO_CUADRAN)
    return { porLlave, d8Cents: 0, quedan, motivos }
  }
  const capacidadCents = quedan.reduce((s, x) => s + Math.max(0, x.importeCents), 0)
  const falta = Math.min(faltaCents, sinConstanciaCents)
  const resto = sinConstanciaCents - falta
  return { porLlave, d8Cents: sinConstanciaCents > 0 ? resto + Math.min(falta, Math.max(0, capacidadCents - resto)) : 0, quedan, motivos }
}

/**
 * Descuento de cuenta por renglón para la FACTURA: lo que consta de cada reparto y, lo que no consta, por D8. Se detiene con el
 * primer motivo (el mismo orden de siempre: reparto fuera de la cuenta, luego descuentos que no cuadran, luego D8).
 */
export function descuentoDeCuentaPorRenglon(p: { cabeceraCents: number; renglones: RenglonParaDescuento[]; filas: FilaDeDescuento[] }): {
  porLlave: Record<string, number>
  motivos: string[]
} {
  const partes = partesDeLaCuenta(p)
  if (partes.motivos.length > 0) return { porLlave: {}, motivos: [partes.motivos[0]] }
  if (partes.d8Cents <= 0) return { porLlave: partes.porLlave, motivos: [] }
  const d8 = repartirSinConstancia(partes.d8Cents, partes.quedan)
  if (!d8.ok) return { porLlave: {}, motivos: [d8.motivo] }
  const porLlave = { ...partes.porLlave }
  for (const [llave, cents] of Object.entries(d8.porRenglon)) porLlave[llave] = (porLlave[llave] ?? 0) + cents
  return { porLlave, motivos: [] }
}
