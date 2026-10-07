/**
 * IVA por producto, bloque B4b (spec planes 6-7 §4.9, D17): la composición de una orden — cuánto vale cada renglón y cada tratamiento
 * en lo que se cobró — con la MISMA reconstrucción de montos que la factura (§4.2, bloque B3a). La usan el libro de la orden (estado de
 * resultados, IVA de flujo, ISR) y la conciliación de reparto. Puro: sin base, sin reloj.
 */
import { hayBloqueados, resolverTratamiento } from './ivaDeRenglon'
import { tuplaDesdeTratamiento, type IvaTratamiento } from './ivaTratamiento'
import type { MezclaPorTratamiento, RenglonConIva } from './ivaMath'
import { descuentoPropioEnCabeceraCents, netoRenglonCents, partesDeLaCuenta, type FilaDeDescuento } from './descuentoPorRenglon'
import { repartirSinConstancia } from '../shared/repartoDescuento'

type Numero = number | { toString(): string }
const centavos = (d: unknown) => Math.round(Number(d ?? 0) * 100)

/** Un renglón para la composición: lo de siempre más lo que la factura necesita para reconstruirlo. */
export type RenglonDeMezcla = RenglonConIva & {
  id?: string | null
  total?: Numero | null
  orderPromotionId?: string | null
  isCortesia?: boolean | null
}

/** Lo de la orden que mueve la composición: la cabecera de descuento con sus filas, el contrato de precio y el origen del dato. */
export type CuentaDeMezcla = {
  discountAmount?: Numero | null
  contratoDePrecio?: string | null
  originSystem?: string | null
  orderDiscounts?: FilaDeDescuento[] | null
}

/** Lo que pesa cada renglón (centavos que cobró, ya sin descuentos), con su tratamiento y su cantidad: el libro lo usa para devoluciones por artículos. */
export type RenglonDeLaComposicion = { llave: string; tratamiento: IvaTratamiento; tasa: number; cantidad: number; cents: number }
export type ComposicionDeLaOrden = { mezcla: MezclaPorTratamiento; renglones: RenglonDeLaComposicion[]; aproximada: boolean }

/** El tratamiento del renglón (sellado > producto > IVA_16) y su tasa; un BLOQUEADO conserva la de su producto (Ruling 4b-R4). */
export function tratamientoYTasa(it: RenglonConIva): { tratamiento: IvaTratamiento; tasa: number } {
  const tratamiento = resolverTratamiento({
    selladoIva: it.ivaTratamiento,
    productoIva: it.product?.ivaTratamiento,
    tieneProducto: it.product != null,
  })
  const tasa = hayBloqueados([tratamiento]) ? Number(it.product?.taxRate ?? 0.16) : tuplaDesdeTratamiento(tratamiento, 0).taxRate
  return { tratamiento, tasa }
}

/** Lo que el renglón cobró (B3a: promoción ⇒ su total, ya neto; cortesía ⇒ 0). Sin `total` (entrada armada a mano), el importe de siempre. */
function netoCents(it: RenglonDeMezcla): number {
  if (it.total == null) return Math.round((Number(it.unitPrice) * it.quantity - Number(it.discountAmount)) * 100)
  return netoRenglonCents(it)
}

/**
 * La composición de la orden. Cada renglón pesa lo que cobró —su total con extras y peso, menos su descuento propio— menos lo que le
 * toca de los descuentos de la cuenta, con la misma reconstrucción de montos que la factura (antes del PAC; lo timbrado por tasa
 * puede diferir por centavos):
 *  - D7: lo que consta en cada reparto se respeta SIEMPRE, aunque otra parte de la cuenta no se pueda atribuir (Codex r1 P1 #3);
 *  - D8: lo que no consta, con un solo IVA, se reparte en proporción como la factura; con varios IVA no se resta de nadie (el cobro se
 *    reparte con estos pesos, que es repartirlo en proporción) y la composición queda `aproximada`.
 * También es aproximada, con varios IVA, si un renglón está roto (descuento mayor que lo que cobra) o si un reparto le pone más de lo
 * que cobra (la factura se detiene en los dos casos): ningún renglón pesa menos de 0 y lo de más no se atribuye. Con un solo IVA también
 * lo es si por eso la mezcla queda vacía (su único grupo se recortó a 0). Y SIEMPRE si es «IVA aparte» de un origen que no declara qué
 * guarda (Codex r1 P1 #5, r2 N5; sólo SoftRestaurant guarda el total con impuesto, `producer.ts:441`): una sola tasa dice a qué tasa va,
 * no cuánto impuesto se cobró. Ningún renglón se multiplica por (1 + tasa).
 */
export function mezclaDeLaOrden(items: RenglonDeMezcla[], cuenta?: CuentaDeMezcla | null): ComposicionDeLaOrden {
  const grupo = (r: { tratamiento: IvaTratamiento; tasa: number }) => `${r.tratamiento}|${r.tasa}`
  const base = items.map((it, i) => ({ it, llave: it.id ?? `#${i}`, neto: netoCents(it), cantidad: it.quantity, ...tratamientoYTasa(it) }))
  // Los renglones rotos también cuentan aquí: si mezclaban IVA, la composición es aproximada aunque en la mezcla quede uno (r2 N8).
  const variosIva = new Set(base.filter(r => r.neto !== 0).map(grupo)).size > 1
  let atribuible = true
  const ivaAparteDesconocido = cuenta?.contratoDePrecio === 'IVA_APARTE' && cuenta.originSystem !== 'POS_SOFTRESTAURANT'
  const deCuenta: Record<string, number> = {}
  if (cuenta) {
    const partes = partesDeLaCuenta({
      cabeceraCents: centavos(cuenta.discountAmount),
      renglones: base.map(r => ({
        llave: r.llave,
        propioEnCabeceraCents: descuentoPropioEnCabeceraCents(r.it),
        vivo: r.neto > 0 ? { grupoIva: grupo(r), disponibleCents: r.neto } : null,
      })),
      filas: cuenta.orderDiscounts ?? [],
    })
    for (const [llave, cents] of Object.entries(partes.porLlave)) deCuenta[llave] = (deCuenta[llave] ?? 0) + cents
    if (partes.motivos.length > 0) atribuible = false
    if (partes.d8Cents > 0) {
      const d8 = repartirSinConstancia(partes.d8Cents, partes.quedan)
      if (d8.ok) for (const [llave, cents] of Object.entries(d8.porRenglon)) deCuenta[llave] = (deCuenta[llave] ?? 0) + cents
      else atribuible = false
    }
  }
  const renglones = base.map(r => {
    const cents = r.neto - (deCuenta[r.llave] ?? 0)
    // Negativo: un renglón roto, o un reparto que le pone más de lo que cobra. Pesa 0 y lo de más no se puede atribuir.
    if (cents < 0) atribuible = false
    return { llave: r.llave, tratamiento: r.tratamiento, tasa: r.tasa, cantidad: r.cantidad, cents: Math.max(0, cents) }
  })
  const por = new Map<string, MezclaPorTratamiento[number]>()
  for (const r of renglones) {
    if (r.cents === 0) continue
    const parte = por.get(grupo(r))
    if (parte) parte.grossCents += r.cents
    else por.set(grupo(r), { tratamiento: r.tratamiento, tasa: r.tasa, grossCents: r.cents })
  }
  // Sin nada en la mezcla y algo que no se pudo atribuir (el único IVA quedó recortado a 0), tampoco consta a qué tasa va el cobro.
  return { mezcla: [...por.values()], renglones, aproximada: (!atribuible && (variosIva || por.size === 0)) || ivaAparteDesconocido }
}

/** La mezcla sin lo demás (la conciliación de reparto y las pruebas viejas). */
export const mezclaPorTratamiento = (items: RenglonDeMezcla[], cuenta?: CuentaDeMezcla | null): MezclaPorTratamiento =>
  mezclaDeLaOrden(items, cuenta).mezcla
