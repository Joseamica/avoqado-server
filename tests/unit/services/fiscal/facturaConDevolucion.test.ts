/**
 * IVA por producto · F6 (hallazgo #6, decisión del founder del 12-oct), Tarea 1: lo PURO de facturar desde Pedidos una venta con devoluciones.
 * Ningún número del PAC a mano: lo facturado de cada artículo sale de la asignación de C2 (`asignacionDeReales`), como en C3.
 */
import { Prisma } from '@prisma/client'
import {
  devueltaCompleta,
  emitirNotasDeDevolucion,
  facturaConDevolucion,
  leerDevolucion,
  motivoDeNotaCancelada,
  motivoDevolucionIlegible,
  motivoNotaCancelada,
  motivoNotaDeOtraFactura,
  remanentesDeLaVenta,
  rutaConDevolucion,
  sqlDeNotasPendientes,
  MOTIVO_DEMASIADAS_DEVOLUCIONES,
  MOTIVO_NOTA_PENDIENTE,
  MOTIVO_NOTA_SIN_INTENTAR,
  MOTIVO_NOTA_SIN_RESPUESTA,
  type DevolucionFiscal,
} from '../../../../src/services/fiscal/facturaConDevolucion'
import { textoDeTimbreEnDuda } from '../../../../src/services/fiscal/timbreEnDuda'
import { ConflictError } from '../../../../src/errors/AppError'
import logger from '../../../../src/config/logger'
import { MOTIVO_OCHO_SIN_REGLA } from '../../../../src/services/fiscal/reglaDelPac'
import { asignacionDeReales, esDevolucionPorImporte } from '../../../../src/services/fiscal/cfdiCreditNote.service'
import { conceptoDeReal, montoComercialCents, type ConceptoReal } from '../../../../src/services/fiscal/globalPorTratamiento'
import { TOPES_POR_ORDEN } from '../../../../src/services/fiscal/librosDeOrdenes'
import { facturaDeRemanentes } from '../../../../src/services/fiscal/cfdiExtraccion.service'
import * as cfdiGlobal from '../../../../src/services/fiscal/cfdiGlobal.service'
import * as cfdiExtraccion from '../../../../src/services/fiscal/cfdiExtraccion.service'
import { MOTIVO_SIN_CONCEPTOS_REALES } from '../../../../src/services/fiscal/nominativaPorExtraccion'

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
// La venta mezclada de C3: café $100 al 0 % (2 × $50) + pan $58 al 16 % (4 × $14.50), IVA incluido, sin filas D16.
const reales = [real('cafe', 'IVA_0', '50.000000', 2), real('pan', 'IVA_16', '14.500000', 4)]
const ticket = {
  conceptosReales: reales,
  porTratamiento: { IVA_0: 10000, IVA_16: 5800 },
  filasD16: [] as string[][],
  renglones: [
    { orderItemId: 'cafe', tratamiento: 'IVA_0' as const },
    { orderItemId: 'pan', tratamiento: 'IVA_16' as const },
  ],
}
const porArticulos = (id: string, items: Array<[string, number]>): DevolucionFiscal => ({
  id,
  salesRefundCents: items.reduce((s, [, c]) => s + c, 0),
  tipo: 'ARTICULOS',
  articulos: items.map(([orderItemId, amountCents]) => ({ orderItemId, amountCents })),
})
const porImporte = (id: string, cents: number): DevolucionFiscal => ({ id, salesRefundCents: cents, tipo: 'IMPORTE', articulos: null })
const deEntrega = (id: string, cents: number): DevolucionFiscal => ({ id, salesRefundCents: cents, tipo: 'ENTREGA', articulos: null })
const ilegible = (id: string, cents: number): DevolucionFiscal => ({ id, salesRefundCents: cents, tipo: 'ILEGIBLE', articulos: null })

describe('F6 · leerDevolucion — un Payment REFUND como lo guardan la TPV y el dashboard', () => {
  it('por artículos legible ⇒ ARTICULOS, en centavos POSITIVOS de venta', () => {
    expect(
      leerDevolucion({ id: 'r1', amount: -58, processorData: { refundedItems: [{ orderItemId: 'pan', quantity: 4, amountCents: 5800 }] } }),
    ).toEqual({ id: 'r1', salesRefundCents: 5800, tipo: 'ARTICULOS', articulos: [{ orderItemId: 'pan', amountCents: 5800 }] })
  })
  it('fila vieja con `amount` en pesos por artículo ⇒ se lee igual que `refundedItemsDe`', () => {
    expect(
      leerDevolucion({ id: 'r1', amount: -58, processorData: { refundedItems: [{ orderItemId: 'pan', amount: 58 }] } }).articulos,
    ).toEqual([{ orderItemId: 'pan', amountCents: 5800 }])
  })
  it.each([
    ['importe que no es número', [{ orderItemId: 'pan', amountCents: 'x' }]],
    ['sin artículo', [{ orderItemId: '', amountCents: 5800 }]],
    ['importe negativo', [{ orderItemId: 'pan', amountCents: -5800 }]],
    ['no suman lo devuelto', [{ orderItemId: 'pan', amountCents: 5000 }]],
  ])(
    '🔴 Review Focus 2: artículos ilegibles (%s) ⇒ ILEGIBLE (nunca «por importe»: C2 los releería y rechazaría la nota)',
    (_c, refundedItems) => {
      expect(leerDevolucion({ id: 'r1', amount: -58, processorData: { refundedItems } })).toMatchObject({
        tipo: 'ILEGIBLE',
        articulos: null,
      })
    },
  )
  it('por importe (sin artículos) ⇒ IMPORTE', () => {
    expect(leerDevolucion({ id: 'r1', amount: -50, processorData: null })).toEqual({
      id: 'r1',
      salesRefundCents: 5000,
      tipo: 'IMPORTE',
      articulos: null,
    })
    expect(esDevolucionPorImporte(null, 5000)).toBe(true)
  })
  it('🔴 Review Focus 2: un ajuste de entrega con su reparto ilegible ⇒ ILEGIBLE (C2 lo detendría con REPARTO_DE_ENTREGA_INVALIDO)', () => {
    const processorData = { provenance: 'PROVIDER_ADJUSTMENT', refundedItems: [{ orderItemId: 'pan', amountCents: 5800 }] }
    expect(leerDevolucion({ id: 'r1', amount: -58, processorData }).tipo).toBe('ILEGIBLE')
    expect(esDevolucionPorImporte(processorData, 5800)).toBe(false)
  })
  it('sólo propina (venta 0) ⇒ 0 centavos de venta', () => {
    expect(leerDevolucion({ id: 'r1', amount: 0, processorData: null }).salesRefundCents).toBe(0)
  })
  it('🔴 T1-2 (revisión final): un importe que no es número ⇒ ILEGIBLE (falla cerrado), nunca IMPORTE con NaN', () => {
    expect(leerDevolucion({ id: 'r1', amount: 'abc', processorData: null })).toMatchObject({ tipo: 'ILEGIBLE', articulos: null })
  })
})

describe('F6 · rutaConDevolucion — el camino y el orden fiscal, con lo que ya se sabe sin leer los conceptos', () => {
  const venta = { paidCents: 25800, tratamientos: ['IVA_0', 'IVA_16'], ivaAparte: false, conMotivos: false }
  it('sin devoluciones ⇒ como hoy', () => {
    expect(rutaConDevolucion(venta, [])).toEqual({ caso: 'SIN_DEVOLUCION' })
  })
  it('🔴 decisión 1: lo devuelto cubre lo cobrado (por importe, por artículos o sumando varias) ⇒ TOTAL', () => {
    expect(rutaConDevolucion(venta, [porImporte('r1', 25800)])).toEqual({ caso: 'TOTAL' })
    expect(
      rutaConDevolucion(venta, [
        porArticulos('r1', [
          ['cafe', 20000],
          ['pan', 5800],
        ]),
      ]),
    ).toEqual({ caso: 'TOTAL' })
    expect(rutaConDevolucion(venta, [porImporte('r1', 20000), porArticulos('r2', [['pan', 5800]])])).toEqual({ caso: 'TOTAL' })
  })
  it('🔴 F6 D1: `devueltaCompleta` es LA regla de «devuelta completa» (la usan la ruta y el panel del reembolso): cubre lo cobrado, y sin devoluciones no', () => {
    expect(devueltaCompleta(25800, [])).toBe(false)
    expect(devueltaCompleta(25800, [porImporte('r1', 25799)])).toBe(false)
    expect(devueltaCompleta(25800, [porImporte('r1', 25800)])).toBe(true)
    expect(devueltaCompleta(25800, [porImporte('r1', 20000), porImporte('r2', 5800)])).toBe(true)
    expect(devueltaCompleta(0, [])).toBe(false) // nada cobrado y nada devuelto no es «devuelta completa»
  })
  it('🔴 TOTAL gana sobre lo ilegible, el 8 %, el IVA aparte y los motivos (el mensaje del founder es el que se ve)', () => {
    const todo = { ...venta, tratamientos: ['IVA_8'], ivaAparte: true, conMotivos: true }
    expect(rutaConDevolucion(todo, [ilegible('r1', 25800)])).toEqual({ caso: 'TOTAL' })
  })
  it('🔴 Review Focus 2 (R2): una devolución ilegible ⇒ se DETIENE antes de timbrar, con su importe en el motivo', () => {
    expect(rutaConDevolucion(venta, [porImporte('r1', 1000), ilegible('r2', 5800)])).toEqual({
      caso: 'DETENIDA',
      motivo: motivoDevolucionIlegible(5800),
    })
    expect(motivoDevolucionIlegible(5800)).toContain('$58.00')
  })
  it('🔴 decisión 2: sólo artículos ⇒ se prueban los remanentes, en el orden en que ocurrieron', () => {
    expect(rutaConDevolucion(venta, [porArticulos('r9', [['pan', 5800]]), porArticulos('r1', [['cafe', 100]])])).toEqual({
      caso: 'PROBAR_REMANENTES',
      pagos: ['r9', 'r1'],
    })
  })
  it('🔴 R1 · decisión 3 y la mezcla: CON_NOTA con el orden FISCAL — reparto fijo (artículos, entrega) primero, importes después, nunca por id', () => {
    // Ocurrieron: importe (a), artículos (z), importe (b), entrega (c).
    const r = rutaConDevolucion(venta, [
      porImporte('a', 1000),
      porArticulos('z', [['pan', 5800]]),
      porImporte('b', 500),
      deEntrega('c', 300),
    ])
    expect(r).toEqual({ caso: 'CON_NOTA', pagos: ['z', 'c', 'a', 'b'] })
  })
  it('🔴 Ruling T3-a: IVA aparte ⇒ CON_NOTA aunque todo sea por artículos', () => {
    expect(rutaConDevolucion({ ...venta, ivaAparte: true }, [porArticulos('r1', [['pan', 5800]])])).toEqual({
      caso: 'CON_NOTA',
      pagos: ['r1'],
    })
  })
  it('con motivos de la venta (p. ej. otro RFC) ⇒ CON_NOTA: la captura de siempre los dice y no se timbra', () => {
    expect(rutaConDevolucion({ ...venta, conMotivos: true }, [porArticulos('r1', [['pan', 5800]])])).toEqual({
      caso: 'CON_NOTA',
      pagos: ['r1'],
    })
  })
  it('🔴 8 % + devolución ⇒ se detiene con el motivo del 8 %', () => {
    expect(rutaConDevolucion({ ...venta, tratamientos: ['IVA_16', 'IVA_8'] }, [porImporte('r1', 100)])).toEqual({
      caso: 'DETENIDA',
      motivo: MOTIVO_OCHO_SIN_REGLA,
    })
  })
  it('más devoluciones de las que se revisan (`null`) ⇒ se detiene con su motivo', () => {
    expect(rutaConDevolucion(venta, null)).toEqual({ caso: 'DETENIDA', motivo: MOTIVO_DEMASIADAS_DEVOLUCIONES })
  })
})

describe('F6 · remanentesDeLaVenta — decisión 2 con `conceptosRemanentes` de C3', () => {
  it('🔴 el pan devuelto completo ⇒ queda el café, por lo que se cobró de él', () => {
    expect(remanentesDeLaVenta(ticket, [porArticulos('r1', [['pan', 5800]])])).toEqual({
      remanentes: [reales[0]],
      filasD16: [],
      bruto: { IVA_0: 10000 },
    })
  })
  it('el pan devuelto en dos devoluciones (dos y dos piezas) ⇒ también completo', () => {
    expect(remanentesDeLaVenta(ticket, [porArticulos('r1', [['pan', 2900]]), porArticulos('r2', [['pan', 2900]])])).toEqual({
      remanentes: [reales[0]],
      filasD16: [],
      bruto: { IVA_0: 10000 },
    })
  })
  it('🔴 decisión 3: parte del pan ⇒ `null` (no se adivina qué quedó: total + nota)', () => {
    expect(remanentesDeLaVenta(ticket, [porArticulos('r1', [['pan', 2900]])])).toBeNull()
  })
  it('una devolución que no es por artículos en la lista ⇒ `null`', () => {
    expect(remanentesDeLaVenta(ticket, [porImporte('r1', 5000)])).toBeNull()
  })
  it('un artículo que no es de la venta ⇒ `null`', () => {
    expect(remanentesDeLaVenta(ticket, [porArticulos('r1', [['otro', 5800]])])).toBeNull()
  })
  it('sin conceptos reales (no cuadran con lo cobrado) ⇒ `null`', () => {
    expect(remanentesDeLaVenta({ ...ticket, conceptosReales: null }, [porArticulos('r1', [['pan', 5800]])])).toBeNull()
  })
  it('un artículo devuelto en $0 (cortesía) no cuenta: el pan completo sigue dejando el café', () => {
    expect(
      remanentesDeLaVenta(ticket, [
        porArticulos('r1', [
          ['pan', 5800],
          ['cafe', 0],
        ]),
      ]),
    ).toEqual({
      remanentes: [reales[0]],
      filasD16: [],
      bruto: { IVA_0: 10000 },
    })
  })
  it('🔴 todos los artículos devueltos completos aunque lo devuelto quede 1 ¢ abajo de lo cobrado (M7) ⇒ TOTAL', () => {
    // El ticket M7 de C3: $65 − $2.50 al 16 % + 2 tortas de $58; el ajuste del PAC deja lo facturado de cada artículo a 1 ¢ de lo cobrado.
    const t = [real('pan', 'IVA_16', '65.000000', 1, 250), real('torta', 'IVA_16', '58.000000', 2)]
    const cobradoDe = (id: string) => montoComercialCents(t.filter(r => r.orderItemId === id).map(conceptoDeReal))
    const cobrado = { IVA_16: cobradoDe('pan') + cobradoDe('torta') }
    const asig = asignacionDeReales(t, cobrado, [])!
    const devuelto = (id: string) => Math.min(cobradoDe(id), asig.montos.get(id)!.totalCents)
    expect(devuelto('pan') + devuelto('torta')).toBe(cobrado.IVA_16 - 1) // el caso existe: la ruta lo manda a probar remanentes
    const m7 = {
      conceptosReales: t,
      porTratamiento: cobrado,
      filasD16: [] as string[][],
      renglones: [
        { orderItemId: 'pan', tratamiento: 'IVA_16' as const },
        { orderItemId: 'torta', tratamiento: 'IVA_16' as const },
      ],
    }
    expect(
      remanentesDeLaVenta(m7, [
        porArticulos('r1', [
          ['pan', devuelto('pan')],
          ['torta', devuelto('torta')],
        ]),
      ]),
    ).toBe('TOTAL')
  })
  // El ticket M7 de C3 más un café de $100 al 0 %; lo devuelto de cada artículo sale de la asignación de C2 (nunca a mano).
  const m7ConCafe = () => {
    const t = [real('pan', 'IVA_16', '65.000000', 1, 250), real('torta', 'IVA_16', '58.000000', 2), real('cafe', 'IVA_0', '50.000000', 2)]
    const cobradoDe = (id: string) => montoComercialCents(t.filter(r => r.orderItemId === id).map(conceptoDeReal))
    const cobrado = { IVA_16: cobradoDe('pan') + cobradoDe('torta'), IVA_0: cobradoDe('cafe') }
    const asig = asignacionDeReales(t, cobrado, [])!
    const devuelto = (id: string) => Math.min(cobradoDe(id), asig.montos.get(id)!.totalCents)
    expect(devuelto('pan') + devuelto('torta')).toBe(cobrado.IVA_16 - 1) // el caso existe: 1 ¢ de M7 en el 16 %
    const m7 = {
      conceptosReales: t,
      porTratamiento: cobrado,
      filasD16: [] as string[][],
      renglones: t.map(r => ({ orderItemId: r.orderItemId!, tratamiento: r.tratamiento as 'IVA_16' | 'IVA_0' })),
    }
    return { t, cobradoDe, cobrado, devuelto, m7 }
  }
  it('🔴 T1-a: M7 + un producto que queda (el café) ⇒ `bruto` sólo de la tasa con remanentes: el 1 ¢ del 16 % no se factura', () => {
    const { t, devuelto, m7 } = m7ConCafe()
    const r = remanentesDeLaVenta(m7, [
      porArticulos('r1', [
        ['pan', devuelto('pan')],
        ['torta', devuelto('torta')],
      ]),
    ])
    expect(r).toEqual({ remanentes: [t[2]], filasD16: [], bruto: { IVA_0: 10000 } })
  })
  it('T1-a: M7 + un producto que queda EN LA MISMA tasa ⇒ `bruto` es lo comercial de lo que queda (guarda)', () => {
    const { t, cobradoDe, devuelto, m7 } = m7ConCafe()
    const r = remanentesDeLaVenta(m7, [
      porArticulos('r1', [
        ['pan', devuelto('pan')],
        ['cafe', cobradoDe('cafe')],
      ]),
    ])
    expect(r).toEqual({ remanentes: [t[1]], filasD16: [], bruto: { IVA_16: cobradoDe('torta') } })
  })
  it('la venta normal (sin M7) con dos tasas que quedan ⇒ el mismo `bruto` de siempre: lo cobrado menos lo devuelto de cada tasa', () => {
    const t = [...reales, real('jugo', 'IVA_16', '30.000000')]
    const conJugo = {
      conceptosReales: t,
      porTratamiento: { IVA_0: 10000, IVA_16: 8800 },
      filasD16: [] as string[][],
      renglones: [...ticket.renglones, { orderItemId: 'jugo', tratamiento: 'IVA_16' as const }],
    }
    expect(remanentesDeLaVenta(conJugo, [porArticulos('r1', [['jugo', 3000]])])).toEqual({
      remanentes: [reales[0], reales[1]],
      filasD16: [],
      bruto: { IVA_0: 10000, IVA_16: 5800 },
    })
  })
})

describe('F6 · facturaConDevolucion — bajo el candado de la orden, con lo que ya está en la base', () => {
  const bundle = (over: Record<string, unknown> = {}) =>
    ({
      venueId: 'v1',
      paidCents: 11600,
      order: { pricesIncludeIva: true, contratoDePrecio: 'IVA_INCLUIDO', renglonesOrigen: [{ orderItemId: 'pan', tratamiento: 'IVA_16' }] },
      ...over,
    }) as any
  const txCon = (filas: unknown[]) => ({ $queryRaw: jest.fn().mockResolvedValue(filas), order: { findUnique: jest.fn() } }) as any
  const params = { orderId: 'o1', receptor: {} as any }
  const filaPorArticulos = (id: string, cents: number) => ({
    id,
    amount: -cents / 100,
    processorData: { refundedItems: [{ orderItemId: 'pan', amountCents: cents }] },
  })

  it('lee las devoluciones de ESTA venta y negocio, acotadas al tope de movimientos de una orden; sin ellas, como hoy', async () => {
    const tx = txCon([])
    expect(await facturaConDevolucion(tx, params, bundle())).toEqual({ caso: 'SIN_DEVOLUCION' })
    expect(tx.$queryRaw.mock.calls[0]).toEqual(expect.arrayContaining(['v1', 'o1', TOPES_POR_ORDEN.movimientos + 1]))
    expect(tx.order.findUnique).not.toHaveBeenCalled()
  })
  it('un reembolso sólo de propina ⇒ como hoy, sin leer la venta', async () => {
    const tx = txCon([{ id: 'r1', amount: 0, processorData: null }])
    expect(await facturaConDevolucion(tx, params, bundle())).toEqual({ caso: 'SIN_DEVOLUCION' })
    expect(tx.order.findUnique).not.toHaveBeenCalled()
  })
  it('🔴 decisión 1: lo devuelto cubre lo cobrado ⇒ TOTAL, sin leer la venta', async () => {
    const tx = txCon([{ id: 'r1', amount: -116, processorData: null }])
    expect(await facturaConDevolucion(tx, params, bundle())).toEqual({ caso: 'TOTAL' })
    expect(tx.order.findUnique).not.toHaveBeenCalled()
  })
  it('🔴 Ruling T3-a: IVA aparte con devolución por artículos ⇒ CON_NOTA, sin probar remanentes', async () => {
    const tx = txCon([filaPorArticulos('r1', 5800)])
    const conIvaAparte = bundle({ order: { pricesIncludeIva: false, contratoDePrecio: 'IVA_APARTE', renglonesOrigen: [] } })
    expect(await facturaConDevolucion(tx, params, conIvaAparte)).toEqual({ caso: 'CON_NOTA', pagos: ['r1'] })
    expect(tx.order.findUnique).not.toHaveBeenCalled()
  })
  it('🔴 T1-2 (revisión final): una devolución con importe que no es número ⇒ se DETIENE antes de timbrar con el motivo de R2 (sin «NaN»)', async () => {
    const r = await facturaConDevolucion(txCon([{ id: 'r1', amount: 'abc', processorData: null }]), params, bundle())
    expect(r).toEqual({
      caso: 'DETENIDA',
      motivo: expect.stringMatching(/^La devolución de esta venta registra artículos que no se pueden leer/),
    })
    expect((r as { motivo: string }).motivo).not.toMatch(/NaN/)
  })
  it('más devoluciones de las que se revisan ⇒ se detiene', async () => {
    const filas = Array.from({ length: TOPES_POR_ORDEN.movimientos + 1 }, (_, i) => ({ id: `r${i}`, amount: -0.01, processorData: null }))
    expect(await facturaConDevolucion(txCon(filas), params, bundle())).toEqual({ caso: 'DETENIDA', motivo: expect.any(String) })
  })
  it('sin `paidCents` (bundle armado a mano) no decide: la captura de siempre falla cerrado', async () => {
    const tx = txCon([{ id: 'r1', amount: -116, processorData: null }])
    expect(await facturaConDevolucion(tx, params, bundle({ paidCents: undefined }))).toEqual({ caso: 'SIN_DEVOLUCION' })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })
})

// T2 Minor-2 (llevado a la T3): `facturaDeRemanentes` en el camino de F6 —sin extracción ni `porTratamiento`—, directa.
describe('F6 · facturaDeRemanentes sin extracción (el camino de la decisión 2)', () => {
  const D = (n: number) => new Prisma.Decimal(n)
  const producto = (satProductKey: string, taxRate: number) => ({
    satProductKey,
    satUnitKey: 'H87',
    objetoImp: '02',
    taxRate: D(taxRate),
    category: null,
  })
  /** Un renglón de la venta como lo deja el cargador: `origen` = su `OrderItem`. */
  const renglon = (origen: string, tratamiento: string, precio: number, cantidad: number, clave: string, descuento = 0) => ({
    productName: origen,
    quantity: cantidad,
    unitPrice: D(precio),
    discountAmount: D(descuento),
    product: producto(clave, tratamiento === 'IVA_16' ? 0.16 : 0),
    origen,
    tratamiento,
  })
  const bundleDe = (items: unknown[]) =>
    ({
      venueId: 'v1',
      emisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
      paymentMethod: 'CREDIT_CARD',
      tenderSatFormaPago: null,
      metodoPago: 'PUE',
      order: { venueType: 'RESTAURANT', tipAmount: D(0), pricesIncludeIva: true, contratoDePrecio: 'IVA_INCLUIDO', paymentStatus: 'PAID', items },
    }) as any
  const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
  const params = { orderId: 'o1', receptor }

  it('arma la factura con lo que quedó (sin `extraccion`), conserva los motivos previos y no modifica `b` ni `previos`', () => {
    // El ticket del café y el pan más un jugo de $30 al 16 %; el jugo devuelto completo ⇒ quedan dos productos de dos tasas.
    const t = [...reales, real('jugo', 'IVA_16', '30.000000')]
    const conJugo = {
      conceptosReales: t,
      porTratamiento: { IVA_0: 10000, IVA_16: 8800 },
      filasD16: [] as string[][],
      renglones: [...ticket.renglones, { orderItemId: 'jugo', tratamiento: 'IVA_16' as const }],
    }
    const b = remanentesDeLaVenta(conJugo, [porArticulos('r1', [['jugo', 3000]])])
    if (!b || b === 'TOTAL') throw new Error('quedan el café y el pan')
    const venta = bundleDe([
      renglon('cafe', 'IVA_0', 50, 2, '50201706'),
      renglon('pan', 'IVA_16', 14.5, 4, '50181900'),
      renglon('jugo', 'IVA_16', 30, 1, '50202304'),
    ])
    const antes = structuredClone(b)
    const previos = ['previo']
    // Un receptor con el CP mal: la factura se arma y su motivo de validación va DESPUÉS de los previos (sin tocar `previos`).
    const r = facturaDeRemanentes({ ...params, receptor: { ...receptor, codigoPostal: '640' } }, venta, b, previos)
    expect(r.reasons).toEqual(['previo', 'El código postal del receptor debe tener 5 dígitos.'])
    expect(r.entrada).toMatchObject({
      paidCents: 15800,
      montos: { totalCents: 15800 },
      renglones: [
        { orderItemId: 'cafe', tratamiento: 'IVA_0' },
        { orderItemId: 'pan', tratamiento: 'IVA_16' },
      ],
    })
    expect(r.entrada!.params.items.map(i => [i.satProductKey, i.unitPriceCents, i.quantity])).toEqual([
      ['50201706', 5000, 2],
      ['50181900', 1450, 4],
    ])
    expect(r.entrada).not.toHaveProperty('extraccion')
    expect(b).toEqual(antes)
    expect(previos).toEqual(['previo'])
    // Un remanente que no es de la venta ⇒ sin factura; los previos van primero y el motivo de C3 sólo viaja con `entrada: null`.
    const ajeno = { ...b, remanentes: [{ ...b.remanentes[0], orderItemId: 'otro' }] }
    expect(facturaDeRemanentes(params, venta, ajeno, previos)).toEqual({ entrada: null, reasons: ['previo', MOTIVO_SIN_CONCEPTOS_REALES] })
    expect(previos).toEqual(['previo'])
  })

  it('(1 ¢ de M7) la torta devuelta por lo que se le asignó y queda el pan ⇒ la factura es lo comercial del pan, no cobrado − devuelto', () => {
    // El ticket M7 de C3 (T1): pan $65 − $2.50 + 2 tortas de $58, al 16 %; lo devuelto sale de la asignación de C2 (nunca a mano).
    const t = [real('pan', 'IVA_16', '65.000000', 1, 250), real('torta', 'IVA_16', '58.000000', 2)]
    const cobradoDe = (id: string) => montoComercialCents(t.filter(r => r.orderItemId === id).map(conceptoDeReal))
    const cobrado = { IVA_16: cobradoDe('pan') + cobradoDe('torta') }
    const torta = Math.min(cobradoDe('torta'), asignacionDeReales(t, cobrado, [])!.montos.get('torta')!.totalCents)
    expect(cobrado.IVA_16 - torta).toBe(cobradoDe('pan') + 1) // el caso existe: cobrado − devuelto = 6251
    const m7 = {
      conceptosReales: t,
      porTratamiento: cobrado,
      filasD16: [] as string[][],
      renglones: t.map(r => ({ orderItemId: r.orderItemId!, tratamiento: 'IVA_16' as const })),
    }
    const b = remanentesDeLaVenta(m7, [porArticulos('r1', [['torta', torta]])])
    if (!b || b === 'TOTAL') throw new Error('queda el pan')
    const venta = bundleDe([renglon('pan', 'IVA_16', 65, 1, '50181900', 2.5), renglon('torta', 'IVA_16', 58, 2, '50192100')])
    const r = facturaDeRemanentes(params, venta, b)
    expect(r.reasons).toEqual([])
    expect(r.entrada).toMatchObject({ paidCents: cobradoDe('pan'), montos: { totalCents: cobradoDe('pan') } }) // 6250: el 1 ¢ no se factura
  })

  // I-1 (revisión final, Ruling FINAL-1): en DESCONTADAS ni B3a ni la concordancia acotan lo que se factura; el tope es el redondeo.
  describe('🔴 I-1: la factura neta nunca sale ni 1 ¢ ARRIBA de lo que el cliente se quedó', () => {
    // El ticket M7 de C3 por la decisión 2 completa (`facturaConDevolucion`), con la foto del ticket de la global (C1) como la leería la base.
    const t = [real('pan', 'IVA_16', '65.000000', 1, 250), real('torta', 'IVA_16', '58.000000', 2)]
    const cobradoDe = (id: string) => montoComercialCents(t.filter(r => r.orderItemId === id).map(conceptoDeReal))
    const cobrado = { IVA_16: cobradoDe('pan') + cobradoDe('torta') }
    const asignado = (id: string) => asignacionDeReales(t, cobrado, [])!.montos.get(id)!.totalCents
    const m7 = {
      conceptosReales: t,
      porTratamiento: cobrado,
      filasD16: [] as string[][],
      renglones: t.map(r => ({ orderItemId: r.orderItemId!, tratamiento: 'IVA_16' as const })),
    }
    const venta = {
      ...bundleDe([renglon('pan', 'IVA_16', 65, 1, '50181900', 2.5), renglon('torta', 'IVA_16', 58, 2, '50192100')]),
      paidCents: cobrado.IVA_16,
    }
    venta.order.renglonesOrigen = t.map(r => ({ orderItemId: r.orderItemId, tratamiento: 'IVA_16' }))
    const decidir = (orderItemId: string, cents: number) => {
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValue([{ id: 'r1', amount: -cents / 100, processorData: { refundedItems: [{ orderItemId, amountCents: cents }] } }]),
        order: { findUnique: jest.fn().mockResolvedValue({ id: 'o1', orderDiscounts: [] }) },
      } as any
      return facturaConDevolucion(tx, params, venta)
    }
    beforeEach(() => jest.spyOn(cfdiGlobal, 'ticketParaGlobal').mockReturnValue({ ok: true, orden: m7, motivoReales: null } as any))
    afterEach(() => jest.restoreAllMocks())

    it('control — M7 (+1): la torta devuelta por lo que se le asignó y queda el pan ⇒ DESCONTADAS por el pan, con el 1 ¢ registrado', async () => {
      expect(asignado('torta')).toBe(cobradoDe('torta') - 1) // el caso existe
      const r = await decidir('torta', asignado('torta'))
      expect(r).toMatchObject({ caso: 'DESCONTADAS', entrada: { montos: { totalCents: cobradoDe('pan') } } })
      expect((r as any).entrada.devoluciones).toEqual({ modo: 'DESCONTADAS', pagos: ['r1'], redondeoCents: 1 })
    })
    it('🔴 M7 espejo (−1): el pan devuelto por lo que se le asignó (1 ¢ arriba de su precio) y queda la torta ⇒ CON_NOTA, nunca la factura 1 ¢ arriba', async () => {
      expect(asignado('pan')).toBe(cobradoDe('pan') + 1) // el caso existe: lo que el cliente se quedó (11599) < la torta (11600)
      expect(await decidir('pan', asignado('pan'))).toEqual({ caso: 'CON_NOTA', pagos: ['r1'] })
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[cfdi-f6]'),
        expect.objectContaining({ orderId: 'o1', redondeoCents: -1 }),
      )
    })
    it('un redondeo mayor al del PAC (> 1 ¢) tampoco se registra: CON_NOTA (tope `REDONDEO_PERMITIDO_CENTS`)', async () => {
      const original = jest.requireActual('../../../../src/services/fiscal/cfdiExtraccion.service').facturaDeRemanentes
      jest.spyOn(cfdiExtraccion, 'facturaDeRemanentes').mockImplementation((...a: any[]) => {
        const f = original(...a)
        return { ...f, entrada: { ...f.entrada, montos: { ...f.entrada.montos, totalCents: f.entrada.montos.totalCents - 1 } } }
      })
      expect(await decidir('torta', asignado('torta'))).toEqual({ caso: 'CON_NOTA', pagos: ['r1'] }) // el +1 de M7, ahora +2
    })
  })
})

describe('F6 · emitirNotasDeDevolucion — en el orden recibido, cada una con su límite, sólo cuenta la de ESTA factura, nunca lanza', () => {
  const p = { sandbox: true, staffId: 's1', presupuestoMs: 60_000 }
  const factura = { id: 'c1', venueId: 'v1' }
  const timbrada = (folio: string, originalCfdiId = 'c1') => ({
    status: 'STAMPED',
    cfdi: { serie: 'NC', folio, entrada: { originalCfdiId } },
  })
  it('🔴 timbrada contra esta factura ⇒ STAMPED con su folio; se pide con el pago, el negocio, el sandbox y quien facturó', async () => {
    const emitir = jest.fn().mockResolvedValue(timbrada('7'))
    expect(await emitirNotasDeDevolucion(factura, ['r1'], p, emitir)).toEqual([{ refundPaymentId: 'r1', status: 'STAMPED', folio: 'NC-7' }])
    expect(emitir).toHaveBeenCalledWith({ venueId: 'v1', refundPaymentId: 'r1', sandbox: true, requestedByStaffId: 's1' })
  })
  it('🔴 R3: una nota timbrada contra OTRA factura no se da por cumplida', async () => {
    const emitir = jest.fn().mockResolvedValue(timbrada('7', 'otra'))
    expect(await emitirNotasDeDevolucion(factura, ['r1'], p, emitir)).toEqual([
      { refundPaymentId: 'r1', status: 'PENDIENTE', motivo: motivoNotaDeOtraFactura('NC-7') },
    ])
  })
  it('🔴 detenida ⇒ PENDIENTE con sus motivos, y la siguiente se intenta igual (el servicio decide si debe esperar: R1)', async () => {
    const emitir = jest
      .fn()
      .mockResolvedValueOnce({ status: 'VALIDATION_FAILED', cfdi: null, reasons: ['Falta el XML.'] })
      .mockResolvedValueOnce(timbrada('8'))
    expect(await emitirNotasDeDevolucion(factura, ['r1', 'r2'], p, emitir)).toEqual([
      { refundPaymentId: 'r1', status: 'PENDIENTE', motivo: 'Falta el XML.' },
      { refundPaymentId: 'r2', status: 'STAMPED', folio: 'NC-8' },
    ])
  })
  it('🔴 lanza un error de NEGOCIO (AppError 4xx) ⇒ PENDIENTE con su texto; nunca lanza hacia la factura ya timbrada', async () => {
    const emitir = jest.fn().mockRejectedValue(new ConflictError('Primero tiene que salir la nota de artículos'))
    expect(await emitirNotasDeDevolucion(factura, ['r1'], p, emitir)).toEqual([
      { refundPaymentId: 'r1', status: 'PENDIENTE', motivo: 'Primero tiene que salir la nota de artículos' },
    ])
  })
  // Ruling T6-d: un error INTERNO (Prisma, red, en inglés) nunca llega a la pantalla: el texto de siempre, y el crudo sólo al log.
  it.each([
    [
      'Prisma',
      Object.assign(new Error('Transaction already closed: A query cannot be executed on an expired transaction.'), { code: 'P2028' }),
    ],
    ['red', new TypeError('fetch failed')],
    ['un Error suelto (aunque esté en español)', new Error('Reembolso no encontrado')],
  ])('🔴 T6-d: lanza un error interno (%s) ⇒ PENDIENTE con el texto de siempre; el crudo, sólo al log', async (_c, err) => {
    const emitir = jest.fn().mockRejectedValue(err)
    expect(await emitirNotasDeDevolucion(factura, ['r1'], p, emitir)).toEqual([
      { refundPaymentId: 'r1', status: 'PENDIENTE', motivo: MOTIVO_NOTA_PENDIENTE },
    ])
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ refundPaymentId: 'r1', error: err.message }))
  })
  it('🔴 en duda (enviada, sin respuesta clara) ⇒ PENDIENTE con «en espera de confirmación» (no «rechazada»)', async () => {
    const emitir = jest.fn().mockResolvedValue({
      status: 'STAMP_FAILED',
      cfdi: { status: 'STAMP_FAILED', protocoloIva: 1, enviadoAt: new Date(), falloDefinitivo: false, lastError: 'fetch failed' },
    })
    expect((await emitirNotasDeDevolucion(factura, ['r1'], p, emitir))[0].motivo).toBe(textoDeTimbreEnDuda('la nota de crédito'))
  })
  it('sin motivo que mostrar ⇒ el texto de siempre', async () => {
    const emitir = jest.fn().mockResolvedValue({ status: 'STAMP_FAILED', cfdi: {} })
    expect((await emitirNotasDeDevolucion(factura, ['r1'], p, emitir))[0].motivo).toBe(MOTIVO_NOTA_PENDIENTE)
  })
  it('🔴 N4: una nota que NUNCA contesta (promesa suspendida) no retiene la factura ni al job — vence, queda pendiente y no se empieza otra', async () => {
    const emitir = jest.fn(() => new Promise<never>(() => undefined))
    const inicio = Date.now()
    const r = await emitirNotasDeDevolucion(factura, ['r1', 'r2'], { ...p, presupuestoMs: 50 }, emitir as any)
    expect(Date.now() - inicio).toBeLessThan(2_000)
    expect(r).toEqual([
      { refundPaymentId: 'r1', status: 'PENDIENTE', motivo: MOTIVO_NOTA_SIN_RESPUESTA },
      { refundPaymentId: 'r2', status: 'PENDIENTE', motivo: MOTIVO_NOTA_SIN_INTENTAR },
    ])
    expect(emitir).toHaveBeenCalledTimes(1)
  })
  it('sin presupuesto no EMPIEZA ninguna nota', async () => {
    const emitir = jest.fn()
    expect(await emitirNotasDeDevolucion(factura, ['r1'], { ...p, presupuestoMs: 0 }, emitir)).toEqual([
      { refundPaymentId: 'r1', status: 'PENDIENTE', motivo: MOTIVO_NOTA_SIN_INTENTAR },
    ])
    expect(emitir).not.toHaveBeenCalled()
  })
})

describe('F6 · motivoDeNotaCancelada (R3)', () => {
  it('🔴 una nota de la marca ya cancelada ⇒ su texto con el folio; ninguna ⇒ null; busca por la llave de cada pago', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({ serie: 'NC', folio: '3', uuid: 'U' }).mockResolvedValueOnce(null)
    const db = { cfdi: { findFirst } } as any
    expect(await motivoDeNotaCancelada(db, ['r1', 'r2'])).toBe(motivoNotaCancelada('NC-3'))
    expect(await motivoDeNotaCancelada(db, ['r1'])).toBeNull()
    expect(findFirst.mock.calls[0][0].where.idempotencyKey).toEqual({ in: ['cfdi-refund-r1', 'cfdi-refund-r2'] })
  })
})

// F6 · T9 (encargo del revisor de la T7, Minor 5): el MCP reusa la consulta; un `limite` de 0 nunca puede volverla «sin LIMIT».
describe('F6 · sqlDeNotasPendientes — el límite', () => {
  it('🔴 `limite: 0` ⇒ LIMIT 0 (fallar cerrado), nunca la consulta sin tope', () => {
    const q = sqlDeNotasPendientes({ venueIds: ['v1'], limite: 0 })
    expect(q.sql).toMatch(/LIMIT \?$/)
    expect(q.values.at(-1)).toBe(0)
  })
  it('control — `limite: 20` ⇒ LIMIT 20; sin `limite` (el conteo) ⇒ sin LIMIT', () => {
    expect(sqlDeNotasPendientes({ limite: 20 }).values.at(-1)).toBe(20)
    expect(sqlDeNotasPendientes({}).sql).not.toMatch(/LIMIT/)
  })
})
