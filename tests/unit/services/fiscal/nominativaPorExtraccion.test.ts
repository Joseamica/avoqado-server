/**
 * IVA por producto, bloque C3 · Tarea 3: la factura del cliente de un ticket extraído de la global, con sus PRODUCTOS REALES que quedan,
 * cuadrada al centavo con lo extraído y concordante —base, IVA y total por tratamiento— con la asignación de la extracción. Puro: ningún
 * número del PAC se escribe a mano (lo extraído sale de la misma cuenta que hace la extracción; lo facturado, de la asignación de C2).
 */
import {
  conceptosRemanentes,
  nominativaPorExtraccion,
  MOTIVO_NO_CONCUERDA,
  MOTIVO_REMANENTE_NO_TRAZABLE,
  MOTIVO_SIN_CONCEPTOS_REALES,
} from '../../../../src/services/fiscal/nominativaPorExtraccion'
import { asignacionDeReales, montosDeReales } from '../../../../src/services/fiscal/cfdiCreditNote.service'
import { conceptosDeNota } from '../../../../src/services/fiscal/cfdiPayloadBuilder'
import {
  aplicarAjustes,
  conceptoDeReal,
  cuadrarPorTasa,
  montoComercialCents,
  SIN_FILAS_D16,
  type ConceptoReal,
} from '../../../../src/services/fiscal/globalPorTratamiento'
import {
  asignacionFiscal,
  documentoDeConceptos,
  repartoDeLaDevolucion,
  resumenDeConceptos,
  unidadesDeConceptos,
  type Asignacion,
  type TratamientoDeNota,
} from '../../../../src/services/fiscal/saldoFiscal'
import { leerMontosPorRenglon } from '../../../../src/services/fiscal/entradaDocumental'
import { conceptoDesdeElPayload } from '../../../../src/services/fiscal/reglaDelPac'
import * as regla from '../../../../src/services/fiscal/reglaDelPac'
import { impuestosSatDe } from '../../../../src/services/fiscal/ivaDeRenglon'

type Bruto = Partial<Record<TratamientoDeNota, number>>
const real = (orderItemId: string, tratamiento: any, precio: string, cantidad = 1, descuentoCents = 0): ConceptoReal => ({
  orderItemId,
  productId: `p-${orderItemId}`,
  descripcion: orderItemId,
  precio,
  cantidad,
  descuentoCents,
  ivaIncluido: true,
  tratamiento,
})
const reales = [real('cafe', 'IVA_0', '50.000000', 2), real('pan', 'IVA_16', '14.500000', 4)] // $100 al 0 % + $58 al 16 %
const claves = (productId: string | null) =>
  productId === 'p-cafe' ? { satProductKey: '50201706', satUnitKey: 'H87' } : { satProductKey: '50181900', satUnitKey: 'H87' }
const cobradoDelTicket = { IVA_0: 10000, IVA_16: 5800 }
// Estos reales son IVA incluido: el ticket no tiene filas D16 (C1-43), por eso `[]` en cada llamada.
const facturado = (id: string) => montosDeReales(reales, cobradoDelTicket, [])!.get(id)!.porTratamiento // C2 v4/v6: contra lo cobrado del ticket
const conDelta = (e: any, t: string, k: 'baseCents' | 'ivaCents' | 'totalCents', d: number) => ({
  ...e,
  porTratamiento: { ...e.porTratamiento, [t]: { ...e.porTratamiento[t], [k]: e.porTratamiento[t][k] + d } },
})
/** Lo extraído: la asignación de los conceptos de la extracción (`conceptosDeNota`) cuadrados con la 6b, la misma cuenta que hace ella. */
function extraidoDe(bruto: Bruto) {
  const base = conceptosDeNota(bruto, 'G7')
  const total = Object.values(bruto).reduce((s, c) => s + (c ?? 0), 0)
  const opts = { cobradoPorTasa: bruto, filasD16: SIN_FILAS_D16 }
  const cuadre = cuadrarPorTasa(base.map(conceptoDesdeElPayload), total, opts)
  if (!cuadre.ok) throw new Error(cuadre.motivo)
  const items = aplicarAjustes(base, cuadre.ajustes, total, opts)!
  const a = asignacionFiscal(
    unidadesDeConceptos(items, () => 'extraccion'),
    documentoDeConceptos(items),
    resumenDeConceptos(items),
  ) as Asignacion
  return { brutoPorTratamiento: bruto, porTratamiento: a.porTratamiento }
}

describe('C3 · conceptosRemanentes — lo que queda, artículo por artículo', () => {
  it('🔴 el pan devuelto completo (lo facturado de él, de la asignación) ⇒ queda sólo el café', () => {
    expect(
      conceptosRemanentes(reales, { porRenglon: new Map([['pan', facturado('pan')]]), sinTrazaPorArticulo: false }, cobradoDelTicket, []),
    ).toEqual({ reales: [reales[0]] })
  })
  it('🔴 C3-P6: el pan devuelto en parte ⇒ se detiene (no se adivina qué quedó)', () => {
    expect(
      conceptosRemanentes(reales, { porRenglon: new Map([['pan', { IVA_16: 2900 }]]), sinTrazaPorArticulo: false }, cobradoDelTicket, []),
    ).toEqual({ motivo: MOTIVO_REMANENTE_NO_TRAZABLE })
  })
  it('🔴 una nota por importe del ticket ⇒ se detiene', () => {
    expect(conceptosRemanentes(reales, { porRenglon: new Map(), sinTrazaPorArticulo: true }, cobradoDelTicket, [])).toEqual({
      motivo: MOTIVO_REMANENTE_NO_TRAZABLE,
    })
  })
  it('sin devoluciones: quedan todos; un artículo acreditado que el ticket no tiene ⇒ se detiene; reales que no cuadran ⇒ sin reales', () => {
    expect(conceptosRemanentes(reales, { porRenglon: new Map(), sinTrazaPorArticulo: false }, cobradoDelTicket, [])).toEqual({ reales })
    expect(
      conceptosRemanentes(reales, { porRenglon: new Map([['otro', { IVA_16: 100 }]]), sinTrazaPorArticulo: false }, cobradoDelTicket, []),
    ).toEqual({ motivo: MOTIVO_REMANENTE_NO_TRAZABLE })
    expect(conceptosRemanentes(reales, { porRenglon: new Map(), sinTrazaPorArticulo: false }, { IVA_0: 9000, IVA_16: 5800 }, [])).toEqual({
      motivo: MOTIVO_SIN_CONCEPTOS_REALES,
    })
  })

  // M7 (controlador, medido en el reporte de la tarea): «completo» ⇔ |acreditado − facturado| ≤ |ajuste| de su tasa en la asignación de
  // los reales; esa diferencia queda registrada. El ticket del plan (C3-18): $65 − $2.50 al 16 % + 2 tortas de $58, donde el ajuste del
  // PAC deja lo facturado de cada artículo a un centavo de lo que se cobró de él.
  describe('M7 · devuelto completo por LO COBRADO (decisión A de C2), con el ajuste del PAC en la tasa', () => {
    const ticket = [real('pan', 'IVA_16', '65.000000', 1, 250), real('torta', 'IVA_16', '58.000000', 2)]
    const cobradoDe = (id: string) => montoComercialCents(ticket.filter(r => r.orderItemId === id).map(conceptoDeReal))
    const cobrado = { IVA_16: cobradoDe('pan') + cobradoDe('torta') }
    const asig = asignacionDeReales(ticket, cobrado, [])!
    /** Lo que C2 acredita del artículo con UNA nota por artículos de lo que se cobró de él (con su tolerancia (B)). */
    const notaDeC2 = (id: string) => {
      const r = repartoDeLaDevolucion(
        { salesRefundCents: cobradoDe(id), refundedItems: [{ orderItemId: id, amountCents: cobradoDe(id) }], congelado: null },
        {
          montosPorRenglon: asig.montos,
          acreditadoPorRenglon: new Map(),
          saldo: {},
          ajustePorTratamiento: asig.ajustePorTratamiento,
          ambito: 'TICKET',
        },
      ) as any
      return r.porRenglon[0].porTratamiento as Bruto
    }

    it('control — el caso existe: lo facturado de cada artículo difiere 1 ¢ de lo cobrado, y el ajuste del 16 % es de 1 ¢', () => {
      expect(Math.abs(asig.ajustePorTratamiento.IVA_16!)).toBe(1)
      expect(Math.abs(asig.montos.get('pan')!.totalCents - cobradoDe('pan'))).toBe(1)
      expect(Math.abs(asig.montos.get('torta')!.totalCents - cobradoDe('torta'))).toBe(1)
    })
    it.each(['pan', 'torta'])(
      '🔴 %s devuelto completo por lo cobrado ⇒ sale, con el centavo registrado con su signo (acreditado − facturado)',
      id => {
        const acreditado = notaDeC2(id)
        const r = conceptosRemanentes(ticket, { porRenglon: new Map([[id, acreditado]]), sinTrazaPorArticulo: false }, cobrado, [])
        expect(r).toEqual({
          reales: ticket.filter(x => x.orderItemId !== id),
          redondeo: [{ orderItemId: id, tratamiento: 'IVA_16', cents: acreditado.IVA_16! - asig.montos.get(id)!.porTratamiento.IVA_16! }],
        })
        // …y la factura del cliente sale con lo que queda, contra lo extraído (lo cobrado del ticket menos lo acreditado).
        const n = nominativaPorExtraccion({
          reales: (r as any).reales,
          filasD16: [],
          claves,
          extraido: extraidoDe({ IVA_16: cobrado.IVA_16 - acreditado.IVA_16! }),
        }) as any
        expect(n.montos.totalCents).toBe(cobrado.IVA_16 - acreditado.IVA_16!)
      },
    )
    it('🔴 sin ajuste en la tasa (el café y el pan del plan), un centavo de más o de menos ya no es redondeo ⇒ se detiene', () => {
      expect(asignacionDeReales(reales, cobradoDelTicket, [])!.ajustePorTratamiento).toEqual({})
      for (const d of [-1, 1])
        expect(
          conceptosRemanentes(
            reales,
            { porRenglon: new Map([['pan', { IVA_16: facturado('pan').IVA_16! + d }]]), sinTrazaPorArticulo: false },
            cobradoDelTicket,
            [],
          ),
        ).toEqual({ motivo: MOTIVO_REMANENTE_NO_TRAZABLE })
    })
    it('🔴 una pieza de dos (la torta) ⇒ se detiene aunque haya ajuste', () => {
      const una = Math.round(cobradoDe('torta') / 2)
      expect(
        conceptosRemanentes(ticket, { porRenglon: new Map([['torta', { IVA_16: una }]]), sinTrazaPorArticulo: false }, cobrado, []),
      ).toEqual({ motivo: MOTIVO_REMANENTE_NO_TRAZABLE })
    })
  })
})

describe('C3 · nominativaPorExtraccion — productos reales, cuadrada y concordante con la asignación de la extracción', () => {
  it('🔴 sólo el café (el pan ya se devolvió): sus claves y unidades reales, 2 piezas, $100 al 0 %; renglones, clasificación y montos de la asignación', () => {
    const r = nominativaPorExtraccion({ filasD16: [], reales: [reales[0]], claves, extraido: extraidoDe({ IVA_0: 10000 }) }) as any
    expect(r.items).toEqual([
      expect.objectContaining({
        satProductKey: '50201706',
        satUnitKey: 'H87',
        quantity: 2,
        unitPriceCents: 5000,
        taxIncluded: true,
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }],
      }),
    ])
    expect(r).toMatchObject({
      renglones: [{ orderItemId: 'cafe', tratamiento: 'IVA_0' }],
      clasificacion: 'MIXTA',
      montosPorRenglon: [{ orderItemId: 'cafe', totalCents: 10000, porTratamiento: { IVA_0: 10000 } }],
      montos: { totalCents: 10000 },
      diferencias: [],
    })
  })
  it('🔴 y al revés (el café devuelto): sólo el pan, TODO_16, sin un renglón al 0 % en la entrada (C3-3)', () => {
    const r = nominativaPorExtraccion({ filasD16: [], reales: [reales[1]], claves, extraido: extraidoDe({ IVA_16: 5800 }) }) as any
    expect(r).toMatchObject({ clasificacion: 'TODO_16', renglones: [{ orderItemId: 'pan', tratamiento: 'IVA_16' }] })
  })
  it('🔴 C3-18 (Codex): productos de $100 al 0 % contra una extracción de $90 al 0 % ⇒ se DETIENE (no es redondeo); nunca $10 de descuento con «diferencias: []», y la búsqueda no corre', () => {
    const extraido = extraidoDe({ IVA_0: 9000 }) // la extracción misma sí cuadra con la 6b: se arma ANTES de espiar
    const busqueda = jest.spyOn(regla, 'cuadrarConElPac')
    expect(nominativaPorExtraccion({ filasD16: [], reales: [real('cafe', 'IVA_0', '100.000000')], claves, extraido })).toEqual({
      motivo: MOTIVO_NO_CONCUERDA,
    })
    expect(busqueda).not.toHaveBeenCalled()
    busqueda.mockRestore()
  })
  it('🔴 C3-18: un producto con un centavo de redondeo del PAC ($65 − $2.50 al 16 %, descuento ORIGINAL) contra su extracción de $62.50 ⇒ sale, con el ajuste dentro del 16 %', () => {
    const r = nominativaPorExtraccion({
      filasD16: [],
      reales: [real('pan', 'IVA_16', '65.000000', 1, 250)],
      claves,
      extraido: extraidoDe({ IVA_16: 6250 }),
    }) as any
    expect(r.montos?.totalCents).toBe(6250)
    expect(Math.abs(r.items[0].discountCents - 250)).toBeLessThanOrEqual(1) // el ajuste es un centavo de redondeo, nunca un descuento inventado
  })
  it('🔴 C3-9: un centavo de diferencia en la base del 16 % se acepta y queda registrado con su signo', () => {
    const r = nominativaPorExtraccion({
      filasD16: [],
      reales,
      claves,
      extraido: conDelta(extraidoDe({ IVA_0: 10000, IVA_16: 5800 }), 'IVA_16', 'baseCents', -1),
    }) as any
    expect(r.diferencias).toEqual([{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1 }])
  })
  it('🔴 C3-9: negativos independientes — base, IVA y el reparto del total entre tasas fuera de 1 ¢ ⇒ soporte (nunca «Venta del ticket», C3-P2)', () => {
    const e = extraidoDe({ IVA_0: 10000, IVA_16: 5800 })
    expect(nominativaPorExtraccion({ filasD16: [], reales, claves, extraido: conDelta(e, 'IVA_16', 'baseCents', 2) })).toEqual({
      motivo: MOTIVO_NO_CONCUERDA,
    })
    expect(nominativaPorExtraccion({ filasD16: [], reales, claves, extraido: conDelta(e, 'IVA_16', 'ivaCents', -2) })).toEqual({
      motivo: MOTIVO_NO_CONCUERDA,
    })
    expect(
      nominativaPorExtraccion({
        filasD16: [],
        reales,
        claves,
        extraido: conDelta(conDelta(e, 'IVA_16', 'totalCents', 2), 'IVA_0', 'totalCents', -2),
      }),
    ).toEqual({ motivo: MOTIVO_NO_CONCUERDA })
    expect(nominativaPorExtraccion({ filasD16: [], reales, claves, extraido: extraidoDe({ IVA_0: 15800 }) })).toEqual({
      motivo: MOTIVO_NO_CONCUERDA,
    })
  })
  it('C3-3: la entrada es coherente consigo misma — su `montosPorRenglon` pasa el lector de C2 y una nota posterior por artículos la usa', () => {
    const r = nominativaPorExtraccion({ filasD16: [], reales, claves, extraido: extraidoDe(cobradoDelTicket) }) as any
    expect(r).toMatchObject({ clasificacion: 'MIXTA', montos: { totalCents: 15800 }, diferencias: [] })
    expect(r.renglones).toEqual([
      { orderItemId: 'cafe', tratamiento: 'IVA_0' },
      { orderItemId: 'pan', tratamiento: 'IVA_16' },
    ])
    const entrada = { orderId: 'o1', renglones: r.renglones, montos: r.montos, montosPorRenglon: r.montosPorRenglon } as any
    expect(leerMontosPorRenglon(entrada)).toEqual(r.montosPorRenglon)
    const nota = repartoDeLaDevolucion(
      { salesRefundCents: 10000, refundedItems: [{ orderItemId: 'cafe', amountCents: 10000 }], congelado: null },
      {
        montosPorRenglon: new Map(r.montosPorRenglon.map((m: any) => [m.orderItemId, m])),
        acreditadoPorRenglon: new Map(),
        saldo: {},
        ambito: 'FACTURA',
      },
    )
    expect(nota).toMatchObject({ modalidad: 'POR_ARTICULOS', brutoPorTratamiento: { IVA_0: 10000 } })
  })
  it('sin productos que queden ⇒ no hay factura que demostrar', () => {
    expect(nominativaPorExtraccion({ filasD16: [], reales: [], claves, extraido: extraidoDe({ IVA_0: 10000 }) })).toEqual({
      motivo: MOTIVO_SIN_CONCEPTOS_REALES,
    })
  })

  describe('F6 · sin la asignación de una extracción no hay concordancia que exigir', () => {
    it('🔴 sin `porTratamiento`: cuadra contra lo que se factura de cada tasa y no registra diferencias', () => {
      const r = nominativaPorExtraccion({ reales: [reales[0]], filasD16: [], claves, extraido: { brutoPorTratamiento: { IVA_0: 10000 } } })
      expect('motivo' in r).toBe(false)
      if ('motivo' in r) return
      expect(r.montos.totalCents).toBe(10000)
      expect(r.diferencias).toEqual([])
      expect(r.renglones).toEqual([{ orderItemId: 'cafe', tratamiento: 'IVA_0' }])
    })
    it('🔴 sin `porTratamiento` la barrera N3 sigue: productos de $100 contra $90 de su tasa ⇒ se detiene (nunca $10 de descuento inventado)', () => {
      expect(
        nominativaPorExtraccion({ reales: [reales[0]], filasD16: [], claves, extraido: { brutoPorTratamiento: { IVA_0: 9000 } } }),
      ).toEqual({ motivo: MOTIVO_NO_CONCUERDA })
    })
    it('control — con `porTratamiento` la concordancia de C3-9 se sigue exigiendo', () => {
      expect(
        nominativaPorExtraccion({
          reales: [reales[0]],
          filasD16: [],
          claves,
          extraido: conDelta(extraidoDe({ IVA_0: 10000 }), 'IVA_0', 'baseCents', 2),
        }),
      ).toEqual({ motivo: MOTIVO_NO_CONCUERDA })
    })
  })
})

// ─── Pendientes que la revisión de la Tarea 3 dejó a la Tarea 2 ────────────────────────────────────────────────────────────
describe('C3 · T2 — los frenos locales de la factura del cliente', () => {
  it('🔴 (1) el 8 % no tiene regla de la 6b: la factura del cliente se detiene ANTES de buscar centavos', () => {
    const busqueda = jest.spyOn(regla, 'cuadrarConElPac')
    expect(
      nominativaPorExtraccion({
        reales: [real('pan', 'IVA_8', '10.800000')],
        filasD16: [],
        claves,
        extraido: { brutoPorTratamiento: { IVA_8: 1080 }, porTratamiento: { IVA_8: { baseCents: 1000, ivaCents: 80, totalCents: 1080 } } },
      }),
    ).toEqual({ motivo: regla.MOTIVO_OCHO_SIN_REGLA })
    expect(busqueda).not.toHaveBeenCalled()
    busqueda.mockRestore()
  })
  it('🔴 (5) un real con tratamiento bloqueado (objeto 03) ⇒ se detiene con el motivo del catálogo; nunca lanza', () => {
    const r = () =>
      nominativaPorExtraccion({
        reales: [real('raro', 'BLOQUEADO_03', '10.000000')],
        filasD16: [],
        claves,
        extraido: extraidoDe({ IVA_16: 1000 }),
      })
    expect(r).not.toThrow()
    expect(r()).toEqual({ motivo: (impuestosSatDe('BLOQUEADO_03') as { motivo: string }).motivo })
  })
})

// Ruling T3-a (controlador, 12-oct): con IVA APARTE nunca se lee «devuelto completo» (el escritor real devuelve el NETO por artículo):
// se queda del lado seguro y se detiene. Estas pruebas fijan ese borde (pasan desde el inicio: «control —»).
describe('C3 · T2 (3) — IVA aparte', () => {
  const aparte = (orderItemId: string, precio: string) => ({ ...real(orderItemId, 'IVA_16', precio), ivaIncluido: false })
  const ticket = [aparte('pan', '50.000000'), aparte('cafe', '25.000000')]
  const cobrado = { IVA_16: Math.round(5000 * 1.16) + Math.round(2500 * 1.16) } // lo que se cobró, con el IVA sumado
  it('control — el pan devuelto por su NETO (como lo devuelve el escritor real) ⇒ MOTIVO_REMANENTE_NO_TRAZABLE', () => {
    expect(
      conceptosRemanentes(ticket, { porRenglon: new Map([['pan', { IVA_16: 5000 }]]), sinTrazaPorArticulo: false }, cobrado, []),
    ).toEqual({
      motivo: MOTIVO_REMANENTE_NO_TRAZABLE,
    })
  })
  it('control — sin devoluciones, la factura del cliente sale por lo cobrado', () => {
    const r = conceptosRemanentes(ticket, { porRenglon: new Map(), sinTrazaPorArticulo: false }, cobrado, [])
    expect(r).toEqual({ reales: ticket })
    const n = nominativaPorExtraccion({ reales: ticket, filasD16: [], claves, extraido: extraidoDe(cobrado) }) as any
    expect(n.montos.totalCents).toBe(cobrado.IVA_16)
  })
})
