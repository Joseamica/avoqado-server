/**
 * La factura GLOBAL de prueba (pura), compartida por las pruebas de la nota a la global (C2 · Tarea 8) y de la nota de extracción (C3 · Tarea 2):
 * sus tickets con su entrada v2 de C1 (`paramsDeLaGlobal` + `cuadrarLaGlobal`) y su XML (`xmlConceptosDe` de sus conceptos), como la fila que
 * lee el cargador. Movida de `cfdiCreditNote.service.test.ts`; C3 sólo agrega la `cantidad` opcional de un artículo.
 */
import type { LoadedRefundForCreditNote } from '@/services/fiscal/cfdiCreditNote.service'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
import {
  cuadrarLaGlobal,
  paramsDeLaGlobal,
  SIN_FILAS_D16,
  type ConceptoReal,
  type PorTratamientoGlobal,
} from '@/services/fiscal/globalPorTratamiento'
import { closedPeriodFor } from '@/services/fiscal/globalPeriod'
import { xmlConceptosDe } from './xml-del-pac'

/** El periodo de las globales de prueba: mayo de 2026 (MENSUAL), como la integración de C1. */
export const PERIODO_GLOBAL = closedPeriodFor('MENSUAL', new Date('2026-06-03T17:00:00Z'))
/** `cents` es el precio de UNA pieza; `cantidad` (C3, opcional) las piezas (1 si no se da). */
export type Articulo = [
  orderItemId: string,
  cents: number,
  tratamiento: 'IVA_16' | 'IVA_0' | 'EXENTO' | 'NO_OBJETO',
  descuentoCents?: number,
  cantidad?: number,
]
/**
 * Un ticket de la entrada v2 de la global (la forma que congela C1): sus renglones, lo cobrado por tratamiento y —salvo `sinReales`— sus
 * conceptos reales (con su descuento ORIGINAL), con su huella.
 */
export function ticketGlobal(
  orderId: string,
  folio: string,
  porTratamiento: PorTratamientoGlobal,
  articulos: Articulo[],
  o: { sinReales?: boolean; formaPago?: string; lineas?: any[] } = {},
) {
  const renglones = articulos.map(([orderItemId, , tratamiento]) => ({ orderItemId, tratamiento }))
  const conceptosReales: ConceptoReal[] | null =
    o.sinReales || !articulos.length
      ? null
      : articulos.map(([orderItemId, cents, tratamiento, descuentoCents, cantidad]) => ({
          orderItemId,
          productId: null,
          descripcion: orderItemId,
          precio: (cents / 100).toFixed(2),
          cantidad: cantidad ?? 1,
          descuentoCents: descuentoCents ?? 0,
          ivaIncluido: true,
          tratamiento,
        }))
  const paidCents = Object.values(porTratamiento).reduce((s, c) => s + (c ?? 0), 0)
  const formaPago = o.formaPago ?? '04'
  const t = {
    orderId,
    folio,
    formaPago,
    paidCents,
    renglones,
    porTratamiento,
    ...(o.lineas ? { lineas: o.lineas } : {}),
    conceptosReales,
    filasD16: [] as string[][],
  }
  return {
    ...t,
    huella: huellaDeEntrada({
      renglones,
      porTratamiento,
      lineas: o.lineas ?? null,
      conceptosReales,
      folio,
      formaPago,
      filasD16: [],
    }),
  }
}
/**
 * Una global v2 timbrada con esos tickets (`paramsDeLaGlobal` + `cuadrarLaGlobal` de C1), con su XML (`xmlConceptosDe` de sus conceptos),
 * como la fila que lee el cargador: `esGlobal`, sin orden, el Público en General y la llave de la principal (o `-c2` si es complementaria).
 */
export function globalDe(
  ordenes: Array<ReturnType<typeof ticketGlobal>>,
  over: Partial<NonNullable<LoadedRefundForCreditNote['original']>> & { complementaria?: boolean } = {},
) {
  const { complementaria, ...resto } = over
  const base = paramsDeLaGlobal({ lugarExpedicion: '01000' }, ordenes, PERIODO_GLOBAL)
  const cobrado = ordenes.reduce((s, o) => s + o.paidCents, 0)
  const porTasa: PorTratamientoGlobal = {}
  for (const o of ordenes)
    for (const [t, c] of Object.entries(o.porTratamiento) as Array<[keyof PorTratamientoGlobal, number]>) porTasa[t] = (porTasa[t] ?? 0) + c
  const c = cuadrarLaGlobal(base.items, cobrado, { cobradoPorTasa: porTasa, filasD16: SIN_FILAS_D16 })
  if (!c.ok) throw new Error(`la global de prueba no cuadra: ${c.motivo}`)
  const globalPeriod = { periodicidad: PERIODO_GLOBAL.satPeriodicidad, meses: PERIODO_GLOBAL.meses, anio: PERIODO_GLOBAL.anio }
  const entrada = {
    version: 2,
    tipo: 'GLOBAL',
    fiscalEmisorId: 'e1',
    globalPeriod,
    periodo: { desde: PERIODO_GLOBAL.periodStart.toISOString(), hasta: PERIODO_GLOBAL.periodEnd.toISOString() },
    montos: c.montos,
    excluidas: {},
    excluidasPorIvaMixto: 0,
    ordenes,
    formaDelMezclado: 'UN_CONCEPTO',
    cuadre: { ok: true },
    ajustes: c.ajustes,
    params: { ...base, items: c.items },
    ...(complementaria ? { complementariaDe: 'cfdi-global-principal' } : {}),
  }
  const llave = `cfdi-global-e1-${PERIODO_GLOBAL.anio}-${PERIODO_GLOBAL.meses}-${PERIODO_GLOBAL.satPeriodicidad}`
  const xml = xmlConceptosDe(entrada.params.items as any)
  return {
    id: complementaria ? 'cfdi-global-c2' : 'cfdi-global-1',
    orderId: null,
    protocoloIva: 1,
    entrada,
    entradaHuella: huellaDeEntrada(entrada),
    uuid: complementaria ? 'UUID-GLOBAL-C2' : 'UUID-GLOBAL-1',
    serie: 'G',
    folio: '7',
    status: 'STAMPED',
    cancelStatus: null,
    subtotalCents: c.montos.subtotalCents,
    taxCents: c.montos.taxCents,
    totalCents: c.montos.totalCents,
    formaPago: '04',
    metodoPago: 'PUE' as const,
    receptorRfc: 'XAXX010101000',
    receptorNombre: 'PÚBLICO EN GENERAL',
    receptorRegimen: '616',
    receptorCp: '01000',
    receptorEmail: null,
    xmlConceptos: xml.xmlConceptos,
    taxBreakdown: xml.taxBreakdown,
    fiscalEmisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
    esGlobal: true,
    idempotencyKey: complementaria ? `${llave}-c2` : llave,
    fiscalEmisorId: 'e1',
    globalPeriod,
    ...resto,
  } as LoadedRefundForCreditNote['original']
}
/** Los tres tickets del plan: `o1` todo-16 $116; `o2` mezclado café $200 al 0 % + pan $58 al 16 % (con reales); `o3` sin artículos $50. */
export const ticketsDelPlan = (o: { sinReales?: boolean } = {}) => [
  ticketGlobal('o1', 'ORD-1', { IVA_16: 11600 }, [['o1-a', 11600, 'IVA_16']], o),
  ticketGlobal(
    'o2',
    'ORD-2',
    { IVA_16: 5800, IVA_0: 20000 },
    [
      ['o2-cafe', 20000, 'IVA_0'],
      ['o2-pan', 5800, 'IVA_16'],
    ],
    o,
  ),
  ticketGlobal('o3', 'ORD-3', { IVA_16: 5000 }, []),
]
export const originalGlobal = (
  o: { sinReales?: boolean } & Partial<NonNullable<LoadedRefundForCreditNote['original']>> & { complementaria?: boolean } = {},
) => {
  const { sinReales, ...over } = o
  return globalDe(ticketsDelPlan({ sinReales }), over)
}
/** Una global todo-16 IVA incluido de esos tickets sin artículos (el `orderId` es el folio). */
export const originalGlobalDe = (tickets: Array<[folio: string, cents: number]>) =>
  globalDe(tickets.map(([folio, cents]) => ticketGlobal(folio, folio, { IVA_16: cents }, [])))
/** Una global de un solo ticket `o1` de esos centavos al 16 %. */
export const originalGlobalDeUnTicket = (cents: number) => globalDe([ticketGlobal('o1', 'ORD-1', { IVA_16: cents }, [])])
