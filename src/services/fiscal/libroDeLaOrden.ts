/**
 * IVA por producto, bloque B4b (spec planes 6-7 §4.9, D17, H20; Codex B4b r1 P1 #1, #2, #4; r2 N1, N2, N3, N8): el libro de UNA
 * orden. Se abre con su composición y registra sus movimientos —cobros y devoluciones de CUALQUIER periodo, en orden (createdAt,
 * id)— dándole a cada uno su parte de base e IVA por tratamiento, con signo (una devolución resta). Por grupo lleva lo vendido, lo
 * asignado de los cobros (sólo crece), lo devuelto y la base y el IVA anotados, con base + IVA = asignado − devuelto siempre, y los
 * dos ≥ 0 mientras a la orden le quede saldo (Codex r3 R3-1): un cobro nunca resta y una devolución nunca suma. Las reglas de cada
 * movimiento, en su rama. Puro.
 */
import { repartirProporcional, splitIvaIncluded, type DesgloseDeCobro } from './ivaMath'
import type { IvaTratamiento } from './ivaTratamiento'
import { desgloseCongelado } from './deliveryFiscalDelta'
import type { ComposicionDeLaOrden } from './mezclaDeOrden'
import { repartirConTopes } from '../shared/repartoDescuento'
import { parteDeUnidades } from '../shared/parteDeUnidades'

/** Un cobro o una devolución de la orden; el monto con signo (una devolución viene negativa). */
export type MovimientoDelLibro = { id: string; type: string | null; amountCents: number; processorData?: unknown }
/**
 * La parte de UN movimiento, con signo (una devolución resta), y si se tuvo que aproximar. `congeladoRechazado` sólo aparece cuando
 * un ajuste del proveedor traía un congelado válido que no cabía (respuesta 13; lo cuenta el comprobador de la Tarea 8).
 */
export type ParteDelLibro = DesgloseDeCobro & { aproximada: boolean; congeladoRechazado?: true }
export type Libro = { registrar(mov: MovimientoDelLibro): ParteDelLibro }

type Grupo = { tratamiento: IvaTratamiento; tasa: number; vendido: number; asignado: number; devuelto: number; base: number; iva: number }
type Linea = { g: number; cents: number; cantidad: number; devueltoCents: number; devueltoCantidad: number }
type Articulo = { llave: string; cents: number; cantidad: number | null }
type Entrada = [IvaTratamiento, { baseCents: number; ivaCents: number }]

const saldo = (g: Grupo) => g.asignado - g.devuelto
const nuevoGrupo = (tratamiento: IvaTratamiento, tasa: number, vendido: number): Grupo => ({
  tratamiento,
  tasa,
  vendido,
  asignado: 0,
  devuelto: 0,
  base: 0,
  iva: 0,
})

/**
 * Los artículos de una devolución por artículos (`refundedItems`, como lo escribe `issueRefund`: `quantity` y `amountCents`; en
 * filas viejas, `amount` en pesos y sin cantidad): `null` si no es por artículos; 'INVALIDOS' si alguno no está en la orden o no
 * trae importe. Si lo devuelto suma más que la devolución, se reparte dentro de lo devuelto; si suma menos, `resto` va por importe.
 */
function articulosDevueltos(
  processorData: unknown,
  devolucionCents: number,
  lineas: Map<string, Linea>,
): null | 'INVALIDOS' | { lista: Articulo[]; resto: number } {
  const items = (processorData as { refundedItems?: unknown } | null | undefined)?.refundedItems
  if (!Array.isArray(items) || items.length === 0) return null
  const lista: Articulo[] = []
  for (const x of items) {
    const e = (x ?? {}) as { orderItemId?: unknown; quantity?: unknown; amountCents?: unknown; amount?: unknown }
    const cents = Number.isInteger(e.amountCents)
      ? (e.amountCents as number)
      : typeof e.amount === 'number'
        ? Math.round(e.amount * 100)
        : NaN
    if (typeof e.orderItemId !== 'string' || !lineas.has(e.orderItemId) || !(cents >= 0)) return 'INVALIDOS'
    const cantidad = Number.isInteger(e.quantity) && (e.quantity as number) > 0 ? (e.quantity as number) : null
    lista.push({ llave: e.orderItemId, cents, cantidad })
  }
  const suma = lista.reduce((s, a) => s + a.cents, 0)
  if (suma <= devolucionCents) return { lista, resto: devolucionCents - suma }
  const escalado = repartirProporcional(
    devolucionCents,
    lista.map(a => a.cents),
  )
  return { lista: lista.map((a, i) => ({ ...a, cents: escalado[i] })), resto: 0 }
}

export function abrirLibro(comp: ComposicionDeLaOrden): Libro {
  const grupos = comp.mezcla.map(m => nuevoGrupo(m.tratamiento, m.tasa, m.grossCents))
  // Sin renglones que pesen: si todos los renglones (recortados a 0) comparten tratamiento y tasa, el cobro va a ESA tasa con vendido 0
  // (T3-I1: un 0 % roto no inventa IVA); con el importe libre (sin renglones) o renglones de varios tratamientos, al 16 %, como siempre.
  if (grupos.length === 0) {
    const r0 = comp.renglones[0]
    const unica = r0 !== undefined && comp.renglones.every(r => r.tratamiento === r0.tratamiento && r.tasa === r0.tasa)
    grupos.push(unica ? nuevoGrupo(r0.tratamiento, r0.tasa, 0) : nuevoGrupo('IVA_16', 0.16, 0))
  }
  const variosIva = grupos.length > 1
  const lineas = new Map<string, Linea>(
    comp.renglones.map(r => [
      r.llave,
      {
        g: grupos.findIndex(x => x.tratamiento === r.tratamiento && x.tasa === r.tasa),
        cents: r.cents,
        cantidad: r.cantidad,
        devueltoCents: 0,
        devueltoCantidad: 0,
      },
    ]),
  )
  let cobrado = 0
  // Codex r2 N8: la incertidumbre del saldo se hereda. Desde que un movimiento de la orden se aproximó, toda devolución siguiente
  // también, aunque caiga en otro mes. La composición aproximada cuenta desde el principio, sin importar cuántos grupos queden.
  let incierto = comp.aproximada

  return {
    registrar(mov) {
      const parte: ParteDelLibro = { netCents: 0, taxCents: 0, taxByRate: {}, porTratamiento: {}, aproximada: comp.aproximada }
      const anotar = (g: Grupo, base: number, iva: number) => {
        if (base === 0 && iva === 0) return
        g.base += base
        g.iva += iva
        parte.netCents += base
        parte.taxCents += iva
        if (iva !== 0) parte.taxByRate[String(g.tasa)] = (parte.taxByRate[String(g.tasa)] ?? 0) + iva
        const acc = (parte.porTratamiento[g.tratamiento] ??= { baseCents: 0, ivaCents: 0 })
        acc.baseCents += base
        acc.ivaCents += iva
      }

      // ── Cobro (una venta con monto negativo es legado: abajo se trata como devolución por importe) ──
      if (mov.type !== 'REFUND' && mov.amountCents >= 0) {
        if (mov.amountCents === 0) return parte
        // Codex r1 P1 #4 y r2 N3: lo cobrado ACUMULADO se reparte con lo vendido, y cada grupo recibe sólo lo que le FALTA para su
        // meta. Lo asignado nunca baja y al pagar todo es exactamente lo vendido. La parte es la diferencia del desglose de lo asignado.
        cobrado += mov.amountCents
        const meta = repartirProporcional(
          cobrado,
          grupos.map(g => g.vendido),
        )
        const falta = grupos.map((g, i) => Math.max(0, meta[i] - g.asignado))
        const toca = repartirConTopes(
          mov.amountCents,
          falta.map(f => ({ peso: f, tope: f })),
        )
        grupos.forEach((g, i) => {
          if (toca[i] === 0) return
          const antes = splitIvaIncluded(g.asignado, g.tasa)
          g.asignado += toca[i]
          const despues = splitIvaIncluded(g.asignado, g.tasa)
          anotar(g, despues.netCents - antes.netCents, despues.taxCents - antes.taxCents)
        })
        return parte
      }

      const devolucionCents = Math.abs(mov.amountCents)
      const esAjuste =
        mov.type === 'REFUND' && (mov.processorData as { provenance?: unknown } | null | undefined)?.provenance === 'PROVIDER_ADJUSTMENT'
      const congelado = esAjuste ? desgloseCongelado(mov.processorData, devolucionCents) : null
      const entradas = congelado ? (Object.entries(congelado.porTratamiento) as Entrada[]) : []
      // Cabe si cada tratamiento existe en la orden y, salvo que vacíe su grupo (regla B), su base y su IVA están entre 0 y lo anotado.
      const cabe =
        congelado !== null &&
        entradas.every(([t, v]) => {
          const g = grupos.find(x => x.tratamiento === t)
          if (!g) return false
          if (v.baseCents + v.ivaCents === saldo(g)) return true
          return v.baseCents >= 0 && v.ivaCents >= 0 && v.baseCents <= g.base && v.ivaCents <= g.iva
        })

      // ── Ajuste del proveedor con reparto congelado que cabe: el congelado tal cual (spec) ──
      if (cabe) {
        for (const [t, v] of entradas) {
          const g = grupos.find(x => x.tratamiento === t)!
          const laVacia = v.baseCents + v.ivaCents === saldo(g)
          g.devuelto += v.baseCents + v.ivaCents
          // Respuesta 8 (regla B): si deja su grupo en cero con otro reparto de centavos, se lleva lo anotado (mismo bruto). T3 M1
          // (revisión final): sólo con lo anotado no negativo; tras devolver de más puede quedar `{ base 13, iva −3 }` y llevárselo
          // SUMARÍA IVA, así que entonces va tal cual (mismo bruto, nada positivo).
          if (laVacia && g.base >= 0 && g.iva >= 0) anotar(g, -g.base, -g.iva)
          else anotar(g, -v.baseCents, -v.ivaCents)
        }
        // Codex r3 R3-3: si la orden ya traía un saldo estimado, lo que el congelado consume también lo es.
        parte.aproximada = comp.aproximada || incierto
        return parte
      }

      // ── Devolución por artículos y/o por importe. Un ajuste del proveedor sin reparto válido, o cuyo congelado no cabe en la orden,
      //    entra aquí y es aproximado SIEMPRE: no se sabe qué IVA declaró el proveedor (r2 N8, r3 R3-3) ──
      const ajusteSinReparto = esAjuste
      // Respuesta 13 (Codex r4 R4-1): un congelado válido que no cabe se reparte por lo que QUEDA; sus artículos no se usan.
      const congeladoRechazado = congelado !== null
      if (congeladoRechazado) parte.congeladoRechazado = true
      let sinAtribuir = false
      let excede = false
      const quita = grupos.map(() => 0)
      const disponible = (i: number) => (i < 0 ? 0 : Math.max(0, saldo(grupos[i]) - quita[i]))
      let sobra = devolucionCents
      const articulos = mov.type === 'REFUND' && !congeladoRechazado ? articulosDevueltos(mov.processorData, devolucionCents, lineas) : null
      if (articulos === 'INVALIDOS') sinAtribuir = true
      else if (articulos) {
        sobra = articulos.resto
        if (articulos.resto > 0) sinAtribuir = true
        for (const a of articulos.lista) {
          const l = lineas.get(a.llave)!
          const leQueda = Math.max(0, l.cents - l.devueltoCents)
          // Codex r2 N2: el tope es lo que cobraron LAS UNIDADES devueltas (la regla del escritor, sobre lo cobrado y no sobre el bruto).
          const tope =
            a.cantidad === null ? leQueda : Math.min(leQueda, parteDeUnidades(l.cents, l.cantidad, l.devueltoCantidad, a.cantidad))
          const cabe = Math.min(a.cents, tope, disponible(l.g))
          if (l.g >= 0) quita[l.g] += cabe
          l.devueltoCents += cabe
          if (a.cantidad !== null) l.devueltoCantidad += a.cantidad
          if (cabe < a.cents) {
            sobra += a.cents - cabe
            sinAtribuir = true
          }
        }
      }
      if (sobra > 0) {
        // Respuesta 3 del controlador: en proporción a lo que QUEDA de cada tasa, con tope en 0.
        const queda = grupos.map((_, i) => disponible(i))
        const deLoQueQueda = Math.min(
          sobra,
          queda.reduce((s, x) => s + x, 0),
        )
        if (deLoQueQueda > 0) repartirProporcional(deLoQueQueda, queda).forEach((c, i) => (quita[i] += c))
        const fuera = sobra - deLoQueQueda
        if (fuera > 0) {
          // A la orden ya no le queda nada: lo de más se reparte con lo vendido (no se pierde dinero) y se dice, con una o con varias
          // tasas (Codex r4 R4-3): devolver más de lo cobrado es un dato roto.
          excede = true
          repartirProporcional(
            fuera,
            grupos.map(g => g.vendido),
          ).forEach((c, i) => (quita[i] += c))
        }
      }
      grupos.forEach((g, i) => {
        if (quita[i] === 0) return
        const deLoQueQueda = Math.min(quita[i], Math.max(0, saldo(g)))
        const deMas = quita[i] - deLoQueQueda // sólo si a la orden ya no le quedaba nada (`fuera`)
        g.devuelto += quita[i]
        if (deLoQueQueda > 0) {
          // Codex r2 N1, r3 R3-1 (respuesta 11 con la respuesta 12): el IVA de su propio monto, como su nota de crédito, ACOTADO
          // para que ni la base ni el IVA del grupo queden negativos. La que vacía el grupo se lleva exactamente lo anotado (los dos
          // topes coinciden), así devolver todo deja cero.
          // T3 M1 (revisión final): tras devolver de más y volver a cobrar, `g.iva` puede ser negativo y el tope de arriba también; el
          // piso en 0 hace que ninguna devolución SUME IVA. Con `g.iva < 0`, `g.base > saldo ≥ deLoQueQueda`: la base absorbe el monto
          // sin quedar negativa, y base + IVA sigue siendo `deLoQueQueda`.
          const deSuMonto = splitIvaIncluded(deLoQueQueda, g.tasa).taxCents
          const iva = Math.max(0, Math.min(Math.max(deSuMonto, Math.max(0, deLoQueQueda - g.base)), Math.min(g.iva, deLoQueQueda)))
          anotar(g, -(deLoQueQueda - iva), -iva)
        }
        if (deMas > 0) {
          const s = splitIvaIncluded(deMas, g.tasa)
          anotar(g, -s.netCents, -s.taxCents)
        }
      })
      parte.aproximada = comp.aproximada || ajusteSinReparto || excede || (variosIva && sinAtribuir) || incierto
      if (parte.aproximada) incierto = true
      return parte
    },
  }
}

/** Abre el libro y registra los movimientos en el orden dado; la parte de cada uno, por id. */
export function libroDeLaOrden(comp: ComposicionDeLaOrden, movimientos: MovimientoDelLibro[]): Map<string, ParteDelLibro> {
  const libro = abrirLibro(comp)
  return new Map(movimientos.map(m => [m.id, libro.registrar(m)]))
}
