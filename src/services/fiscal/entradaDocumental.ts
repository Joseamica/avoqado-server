// src/services/fiscal/entradaDocumental.ts
// Plan 3 (IVA por producto), Tarea 4: la entrada documental — la FOTO CONGELADA del intento de
// facturar. Se captura UNA VEZ, en la transacción de reserva, y todo lo que sigue (el payload al PAC,
// la comparación de reenvíos, la auditoría de un intento incierto) sólo la LEE — nunca vuelve a
// resolver la orden viva ni el producto después del commit (ver `global-constraints.md`).
import { createHash } from 'crypto'
import logger from '../../config/logger'
import type { IvaTratamiento } from './ivaTratamiento'
import type { LoadedOrderBundle, IssueReceptor, RenglonParaCfdi } from './cfdi.service'
import { assembleSaleInput } from './assembleSaleInput'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import type { CfdiItemInput, CreateInvoiceParams } from './providers/fiscal-provider.interface'
import {
  asignacionFiscal,
  documentoDeConceptos,
  resumenDeConceptos,
  TRATAMIENTOS_DE_NOTA,
  unidadesDeConceptos,
  type TratamientoDeNota,
} from './saldoFiscal'

export interface EntradaDocumentalV1 {
  version: 1
  orderId: string
  fiscalEmisorId: string
  /** ID de la fila Cfdi que esta entrada sustituye, o `null` si es una emisión normal. */
  replacesCfdiId: string | null
  /** Foto congelada: lo que el contrato de precio DECÍA al capturar, no lo que diga después. */
  contratoDePrecio: string | null
  /** Foto congelada: lo que el estado de pago DECÍA al capturar, no lo que diga después. */
  paymentStatus: string | null
  clasificacion: 'TODO_16' | 'MIXTA'
  paidCents: number
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  /**
   * Un renglón por `OrderItem` REAL, con su tratamiento resuelto — esto es lo que SELLA la entrada
   * (`OrderItemSelloIva`). Los conceptos de extras no tienen `orderItemId` y no van aquí; venta sin
   * renglones (importe libre) ⇒ `[]`.
   */
  renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>
  /**
   * Los parámetros YA RESUELTOS que se le mandarán al PAC (claves SAT, receptor, forma y método de
   * pago, conceptos con sus impuestos). Nada se vuelve a resolver después de capturar. Sin
   * `externalId`: ese campo lo pone `paramsDesdeEntrada` con la llave de la versión que se envía.
   */
  params: Omit<CreateInvoiceParams, 'externalId'>
  /**
   * C2 (P4; Codex C2-4, C2-10): lo facturado de cada artículo —con sus extras, sus descuentos y el ajuste de la 6b—, por tratamiento,
   * tal como lo REPARTE el documento (`asignacionFiscal`; forma: `MontosPorRenglon`). Opcional: las entradas de antes de C2 no lo traen, y
   * una factura sin él detiene la devolución por artículos (ofrece «acreditar por importe»).
   * 🔴 Ronda 1 (M1): se LEE sólo con `leerMontosPorRenglon(e)`, que lo valida. `leerEntrada` lo deja tal como se guardó: la huella se calcula
   * sobre lo leído y se compara con la guardada (`cfdi.service.ts`, `cfdiCreditNote.service.ts`), así que quitarlo o corregirlo ahí anularía
   * la entrada entera —también la nota por importe—. Por eso es `unknown`: nadie lo usa sin pasar por la validación.
   */
  montosPorRenglon?: unknown
}

/** C2: lo facturado de cada artículo, por tratamiento (la forma VALIDADA de `EntradaDocumentalV1.montosPorRenglon`). */
export type MontosPorRenglon = Array<{
  orderItemId: string
  totalCents: number
  porTratamiento: Partial<Record<TratamientoDeNota, number>>
}>

/** La clave de un concepto SIN `origen` (importe libre, bundles armados a mano): nunca es un `OrderItem.id` y no se congela. */
const SIN_ORIGEN = '\u0000sin-origen:'

/**
 * C2 (P4; Codex C2-4, C2-10): lo facturado de cada artículo, del documento REPARTIDO con la regla del PAC (`asignacionFiscal`, T4) sobre
 * el payload tal como se manda —los descuentos ya traen el ajuste de la 6b—, nunca una suma neta propia. Los conceptos del bundle y
 * `items` van 1 a 1 y en orden (`buildCreateInvoiceParams` mapea `bundle.order.items`); cada concepto —producto y extras— lleva el
 * `OrderItem` del que nace (`origen`, C1), y los de un mismo artículo comparten clave y se suman solos. Ordenado por `orderItemId`: la foto
 * no depende del orden físico de las filas. `{ motivo }` si no se puede repartir (no van 1 a 1 —defensivo: hoy salen del mismo arreglo—,
 * o la asignación es inválida).
 */
function calcularMontosPorRenglon(conceptos: RenglonParaCfdi[], items: CfdiItemInput[]): MontosPorRenglon | { motivo: string } {
  if (conceptos.length !== items.length) return { motivo: 'los conceptos y el payload no van 1 a 1' }
  const clave = (i: number) => conceptos[i].origen ?? `${SIN_ORIGEN}${i}`
  const a = asignacionFiscal(unidadesDeConceptos(items, clave), documentoDeConceptos(items), resumenDeConceptos(items))
  if ('invalido' in a) return { motivo: a.invalido }
  return [...a.porClave]
    .filter(([k]) => !k.startsWith(SIN_ORIGEN))
    .map(([orderItemId, m]) => {
      const porTratamiento: Partial<Record<TratamientoDeNota, number>> = {}
      for (const t of TRATAMIENTOS_DE_NOTA) if (m[t]) porTratamiento[t] = m[t]!.totalCents
      return { orderItemId, totalCents: Object.values(porTratamiento).reduce((s, c) => s + c, 0), porTratamiento }
    })
    .sort((x, y) => (x.orderItemId < y.orderItemId ? -1 : x.orderItemId > y.orderItemId ? 1 : 0))
}

const esCentavos = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0

/**
 * C2: la forma de `montosPorRenglon` que se congela y que se lee (la MISMA regla en los dos lados, para que la captura nunca guarde algo
 * que el lector rechace): cada artículo es un renglón de la entrada, sin repetirse; `totalCents` y cada monto son centavos enteros ≥ 0;
 * los tratamientos son los de una nota (`TRATAMIENTOS_DE_NOTA`) y suman su `totalCents`; y todos juntos no pasan del total de la factura.
 * 🔴 Ronda 1 (M1): no se endurece sin subir la versión de la entrada. Una regla más estricta (o un tratamiento menos en
 * `TRATAMIENTOS_DE_NOTA`) le quitaría la evidencia a facturas YA timbradas: la entrada se sigue leyendo, pero sus devoluciones por
 * artículos se detendrían.
 */
function montosPorRenglonValidos(
  v: unknown,
  renglones: ReadonlyArray<{ orderItemId: string }>,
  facturaTotalCents: number,
): v is MontosPorRenglon {
  if (!Array.isArray(v)) return false
  const deLaEntrada = new Set(renglones.map(r => r.orderItemId))
  const vistos = new Set<string>()
  let suma = 0
  for (const m of v) {
    if (!esObjeto(m) || typeof m.orderItemId !== 'string' || !deLaEntrada.has(m.orderItemId) || vistos.has(m.orderItemId)) return false
    vistos.add(m.orderItemId)
    if (!esCentavos(m.totalCents) || !esObjeto(m.porTratamiento)) return false
    let delArticulo = 0
    for (const [t, c] of Object.entries(m.porTratamiento)) {
      if (!(TRATAMIENTOS_DE_NOTA as readonly string[]).includes(t) || !esCentavos(c)) return false
      delArticulo += c
    }
    if (delArticulo !== m.totalCents) return false
    suma += m.totalCents
  }
  return suma <= facturaTotalCents
}

/**
 * Arma la entrada documental de UNA orden, a partir del bundle ya cargado. Falla CERRADO —nunca
 * asume `TODO_16` ni inventa dinero— si el bundle no trae `clasificacion` o `paidCents` resueltos:
 * eso significaría sellar una factura fiscal a ciegas, sobre datos a medio construir (p.ej. un
 * bundle armado a mano por una prueba de otra tarea, sin pasar por `loadOrderForCfdiFromDb`).
 */
export function capturarEntrada(
  bundle: LoadedOrderBundle,
  receptor: IssueReceptor,
  orderId: string,
  opts: { replacesCfdiId?: string } = {},
): EntradaDocumentalV1 {
  const clasificacion = bundle.order.clasificacion
  if (clasificacion !== 'TODO_16' && clasificacion !== 'MIXTA') {
    throw new Error(
      `capturarEntrada: el bundle de la orden ${orderId} no trae "clasificacion" resuelta; no se sella una entrada fiscal a ciegas.`,
    )
  }
  if (typeof bundle.paidCents !== 'number') {
    throw new Error(
      `capturarEntrada: el bundle de la orden ${orderId} no trae "paidCents" resuelto; no se sella una entrada fiscal a ciegas.`,
    )
  }

  // El orderId hace determinista la foto; cada envío sobreescribe AMBAS identidades
  // (idempotencyKey y externalId) con la llave versionada del intento.
  const params = buildCreateInvoiceParams(
    assembleSaleInput(bundle.order, {
      receptor,
      paymentMethod: bundle.paymentMethod,
      tenderSatFormaPago: bundle.tenderSatFormaPago ?? null,
      metodoPago: bundle.metodoPago,
      serie: bundle.emisor.serie ?? undefined,
      idempotencyKey: orderId,
    }),
  )

  const renglones = (bundle.order.renglonesOrigen ?? []).map(r => ({ orderItemId: r.orderItemId, tratamiento: r.tratamiento }))
  const montos = { subtotalCents: bundle.subtotalCents, taxCents: bundle.taxCents, totalCents: bundle.totalCents }

  // C2 (P4, Codex C2-4/C2-10): lo facturado de cada artículo, del documento REPARTIDO. Es evidencia para las devoluciones «por artículos»:
  // si no se puede congelar (o no pasa la regla del lector), la factura sale igual SIN el campo y esas devoluciones se detienen y ofrecen
  // «acreditar por importe» (Tarea 9). Nada de aquí puede detener una factura.
  // Ronda 1 (M3): sólo en una captura que se timbraría. Con motivos del cargador (`VALIDATION_FAILED`) el documento no lleva el ajuste de la
  // 6b ni `montos` es el documento: no se congela nada (el reintento recaptura).
  let montosPorRenglon: MontosPorRenglon | undefined
  let sinMontos: string | null = null
  if (!bundle.unsupportedReasons?.length) {
    try {
      const m = calcularMontosPorRenglon(bundle.order.items as RenglonParaCfdi[], params.items)
      if (!Array.isArray(m)) sinMontos = m.motivo
      else if (!montosPorRenglonValidos(m, renglones, montos.totalCents)) sinMontos = 'no pasa la regla del lector'
      else montosPorRenglon = m
    } catch (e) {
      sinMontos = `error al repartir: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (sinMontos) logger.warn(`[entradaDocumental] orden ${orderId}: sin montosPorRenglon (${sinMontos})`)
  // Ronda 1 (M4): con artículos, lo congelado suma el documento; si no (p. ej. un concepto sin `origen`), se congela igual —la dirección es
  // segura: esa devolución se detiene, nunca acredita de más— y queda la señal.
  const sumaCongelada = (montosPorRenglon ?? []).reduce((s, m) => s + m.totalCents, 0)
  if (montosPorRenglon?.length && sumaCongelada !== montos.totalCents)
    logger.warn(
      `[entradaDocumental] orden ${orderId}: montosPorRenglon congelado, pero sus artículos (${sumaCongelada} ¢) no suman el total de la factura (${montos.totalCents} ¢); ¿un concepto sin origen?`,
    )

  const entrada: EntradaDocumentalV1 = {
    version: 1,
    orderId,
    fiscalEmisorId: bundle.emisor.id,
    replacesCfdiId: opts.replacesCfdiId ?? null,
    contratoDePrecio: bundle.order.contratoDePrecio ?? null,
    paymentStatus: bundle.order.paymentStatus ?? null,
    clasificacion,
    paidCents: bundle.paidCents,
    montos,
    renglones,
    params,
    ...(montosPorRenglon?.length ? { montosPorRenglon } : {}),
  }
  // Copia profunda: mutar el bundle (o el receptor) DESPUÉS de capturar nunca puede alcanzar la
  // entrada ya sellada — es la garantía de "foto congelada".
  return structuredClone(entrada)
}

/** Ordena las llaves de un valor JSON recursivamente (arrays se recorren en su mismo orden). */
function conLlavesOrdenadas(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(conLlavesOrdenadas)
  if (valor !== null && typeof valor === 'object') {
    const ordenado: Record<string, unknown> = {}
    for (const clave of Object.keys(valor as Record<string, unknown>).sort()) {
      ordenado[clave] = conLlavesOrdenadas((valor as Record<string, unknown>)[clave])
    }
    return ordenado
  }
  return valor
}

/** sha256 hex del JSON canónico de la entrada (llaves ordenadas recursivamente). */
export function huellaDeEntrada(e: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(conLlavesOrdenadas(e)))
    .digest('hex')
}

/**
 * Los `CreateInvoiceParams` completos para ESTE intento: la entrada capturada + el `externalId` de
 * la versión que se envía (`<idempotencyKey>#<attempts>`). Copia profunda: nada de lo que devuelve
 * comparte referencias con la entrada guardada.
 */
export function paramsDesdeEntrada(e: EntradaDocumentalV1, idempotencyKey: string): CreateInvoiceParams {
  return { ...structuredClone(e.params), externalId: idempotencyKey }
}

/** `true` si `v` es un objeto plano (no `null`, no arreglo) — para validar la forma mínima de `leerEntrada`. */
function esObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Valida la forma MÍNIMA de una entrada documental leída de la base (columna JSON) y la devuelve
 * tipada, o `null` si no es una `EntradaDocumentalV1` válida — filas viejas (`version` ausente o
 * distinta de 1, forma incompleta) leen `null` en vez de reventar.
 */
export function leerEntrada(json: unknown): EntradaDocumentalV1 | null {
  if (!esObjeto(json)) return null
  if (json.version !== 1) return null
  if (typeof json.orderId !== 'string') return null
  if (typeof json.fiscalEmisorId !== 'string') return null
  if (json.replacesCfdiId !== null && typeof json.replacesCfdiId !== 'string') return null
  if (json.contratoDePrecio !== null && typeof json.contratoDePrecio !== 'string') return null
  if (json.paymentStatus !== null && typeof json.paymentStatus !== 'string') return null
  if (json.clasificacion !== 'TODO_16' && json.clasificacion !== 'MIXTA') return null
  if (typeof json.paidCents !== 'number') return null
  if (!esObjeto(json.montos)) return null
  const { subtotalCents, taxCents, totalCents } = json.montos
  if (typeof subtotalCents !== 'number' || typeof taxCents !== 'number' || typeof totalCents !== 'number') return null
  if (!Array.isArray(json.renglones)) return null
  for (const r of json.renglones) {
    if (!esObjeto(r) || typeof r.orderItemId !== 'string' || typeof r.tratamiento !== 'string') return null
  }
  if (!esObjeto(json.params)) return null
  // C2 ronda 1 (M1): `montosPorRenglon` NO se valida aquí (se queda tal como se guardó, por la huella); lo valida `leerMontosPorRenglon`.

  return json as unknown as EntradaDocumentalV1
}

/**
 * C2 ronda 1 (M1): lo facturado de cada artículo de una entrada LEÍDA, validado con la misma regla de la captura. Sin el campo (facturas de
 * antes de C2, venta sin renglones, o si la captura no pudo) ⇒ `null`, sin aviso. Malformado (incluido `null`) ⇒ `null` con aviso: sólo
 * se pierde esa evidencia —la devolución por artículos se detiene y ofrece «por importe»—; la entrada sigue sirviendo para lo demás.
 */
export function leerMontosPorRenglon(e: EntradaDocumentalV1): MontosPorRenglon | null {
  if (e.montosPorRenglon === undefined) return null
  if (montosPorRenglonValidos(e.montosPorRenglon, e.renglones, e.montos.totalCents)) return e.montosPorRenglon
  logger.warn(
    `[entradaDocumental] orden ${e.orderId}: montosPorRenglon malformado; la entrada se usa, pero sin evidencia de lo facturado por artículo`,
  )
  return null
}
