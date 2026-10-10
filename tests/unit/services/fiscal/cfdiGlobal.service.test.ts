import { Prisma } from '@prisma/client'
import { issueGlobalForEmisor, IssueGlobalDeps, GlobalEmisor } from '@/services/fiscal/cfdiGlobal.service'

const emisor: GlobalEmisor = {
  id: 'e1',
  venueId: 'v1',
  globalPeriodicity: 'MENSUAL',
  regimenFiscal: '601', // C1 · Tarea 9: el régimen actual del emisor (la bimestral sólo con 621)
  serie: null,
  lugarExpedicion: '83000',
  csdStatus: 'ACTIVE',
  providerKeyEnc: null,
  provider: 'FACTURAPI',
  invoiceCashSales: false,
  includeOffTerminalSalesInGlobal: false, // ajuste del founder (7-oct): apagado de fábrica
}
const params = { emisorId: 'e1', now: new Date('2026-06-03T17:00:00Z'), sandbox: true }
function deps(over: Partial<IssueGlobalDeps> = {}): Partial<IssueGlobalDeps> {
  return {
    loadEmisor: jest.fn().mockResolvedValue(emisor),
    findExistingGlobal: jest.fn().mockResolvedValue(null),
    loadGlobalCandidates: jest.fn().mockResolvedValue([]),
    resolveProvider: jest.fn(),
    // Ronda 1 de la T8: avisos, candidatos fuera de ventana y la cola, en dobles (sin base).
    ultimoAvisoDelPeriodo: jest.fn().mockResolvedValue(null),
    registrarAvisoDelPeriodo: jest.fn().mockResolvedValue(undefined),
    tieneCandidatos: jest.fn().mockResolvedValue(false),
    tocarPendiente: jest.fn().mockResolvedValue(undefined),
    contarEmisores: jest.fn().mockResolvedValue(1),
    // C1 · Tarea 10: lo que queda fuera por configuración y las filas de otra periodicidad (m1 de la T9), en dobles (sin base).
    contarExcluidasPorConfiguracion: jest.fn().mockResolvedValue({}),
    globalesDeOtraPeriodicidad: jest.fn().mockResolvedValue([]),
    // C1 · Tarea 11: las complementarias de una principal y «cuántas entrarían», en dobles (sin base).
    complementariasDe: jest.fn().mockResolvedValue([]),
    contarCorregidasPendientes: jest.fn().mockResolvedValue({ n: 0, completo: true }),
    // T10, ronda 1: la guarda de «fechas apartadas en otra periodicidad» (I1) y la escritura del motivo en la fila (I2), en dobles.
    globalApartadaQueCubre: jest.fn().mockResolvedValue(null),
    persistCfdi: jest.fn().mockResolvedValue(null),
    // Ola final de C1: por defecto el RFC SÍ tiene un comercio en su global (la global no está «apagada»), en doble (sin base).
    comercioEnLaGlobal: jest.fn().mockResolvedValue(true),
    ...over,
  }
}
describe('issueGlobalForEmisor — guardas sin efectos', () => {
  it.each(['NONE', 'PENDING'])('CSD %s omite reserva y PAC', async csdStatus => {
    const d = deps({ loadEmisor: jest.fn().mockResolvedValue({ ...emisor, csdStatus }) })
    expect(await issueGlobalForEmisor(params, d)).toMatchObject({ status: 'SKIPPED' })
    expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
    expect(d.resolveProvider).not.toHaveBeenCalled()
  })
  it('emisor inexistente no toca PAC', async () => {
    await expect(issueGlobalForEmisor(params, deps({ loadEmisor: jest.fn().mockResolvedValue(null) }))).rejects.toThrow(/not found/)
  })
  it('STAMPED es idempotente, conserva periodo y cuenta mixta', async () => {
    const c = { id: 'g1', venueId: 'v1', fiscalEmisorId: 'e1', status: 'STAMPED', entrada: { excluidasPorIvaMixto: 2 } }
    const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(c) })
    expect(await issueGlobalForEmisor(params, d)).toMatchObject({
      status: 'STAMPED',
      cfdi: c,
      candidateCount: 0,
      excluidasPorIvaMixto: 2,
      excluidas: {}, // C1 (aditivo): una global v1 no trae el conteo por motivo
      period: { meses: '05', anio: 2026 },
    })
    expect(d.findExistingGlobal).toHaveBeenCalledWith('cfdi-global-e1-2026-05-04')
    expect(d.resolveProvider).not.toHaveBeenCalled()
  })
  it('no devuelve una fila de otro emisor/venue', async () => {
    await expect(
      issueGlobalForEmisor(
        params,
        deps({ findExistingGlobal: jest.fn().mockResolvedValue({ status: 'STAMPED', venueId: 'other', fiscalEmisorId: 'e1' }) }),
      ),
    ).rejects.toThrow(/not found/)
  })
})

// ── Extras y peso también en la GLOBAL (mismo defecto que la individual, Testarudo 21-sep-2026) ──
import { globalLinesFromOrder, ORDER_SELECT } from '../../../../src/services/fiscal/cfdiGlobal.service'
import { DESCUENTOS_PARA_CONCEPTOS } from '../../../../src/services/fiscal/descuentoPorRenglon'

describe('globalLinesFromOrder — la línea global cuadra con el ticket (misma verdad de dinero que la individual)', () => {
  const Dc = (n: number) => new Prisma.Decimal(n)
  const base = { id: 'o1', orderNumber: 'ORD-1', subtotal: Dc(110), taxAmount: Dc(0), total: Dc(126.5), discountAmount: Dc(0) }
  const itemP = (over: Record<string, any>) => ({
    productName: 'X',
    quantity: 1,
    unitPrice: Dc(0),
    discountAmount: Dc(0),
    taxAmount: Dc(0),
    total: Dc(0),
    weightQuantity: null,
    modifiers: [],
    product: { taxRate: Dc(0.16), objetoImp: '02', satProductKey: '90101501', satUnitKey: 'E48', category: null },
    ...over,
  })
  const pagos = (amount: number, type = 'REGULAR') => [{ method: 'CREDIT_CARD', tenderSatFormaPago: null, amount: Dc(amount), type }]
  const suma = (lines: Array<{ totalCents: number }>) => lines.reduce((s, l) => s + l.totalCents, 0)

  it('GROSS con modificador con precio (guardado por unidad): la línea vale OrderItem.total, igual que la individual', () => {
    const lines = globalLinesFromOrder({
      ...base,
      payments: pagos(110),
      items: [
        itemP({
          productName: 'CAPUCCINO',
          unitPrice: Dc(65),
          total: Dc(70),
          modifiers: [{ name: 'Deslactosada', price: Dc(5), quantity: 1 }],
        }),
        itemP({ productName: 'TOPOCHICO', unitPrice: Dc(40), total: Dc(40) }),
      ],
    } as any)
    expect(suma(lines)).toBe(11000) // 70 + 40, no 105
  })

  it('GROSS venta por peso: la línea vale lo cobrado (precio × kilos)', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(87),
      total: Dc(87),
      payments: pagos(87),
      items: [
        itemP({
          productName: 'JAMÓN',
          unitPrice: Dc(200),
          total: Dc(87),
          weightQuantity: Dc(0.435),
          product: { taxRate: Dc(0.16), objetoImp: '02', satProductKey: '50112000', satUnitKey: 'KGM', category: null },
        }),
      ],
    } as any)
    expect(suma(lines)).toBe(8700)
  })

  it('DESCUENTO de orden sin constancia sobre varios renglones del mismo IVA: la global la INCLUYE (D8, misma verdad que la individual)', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(100),
      total: Dc(90),
      discountAmount: Dc(10),
      payments: pagos(90),
      items: [itemP({ unitPrice: Dc(60), total: Dc(60) }), itemP({ unitPrice: Dc(40), total: Dc(40) })],
    } as any)
    expect(suma(lines)).toBe(9000)
  })

  it('B3a (control): con una cortesía de «Cobrar» la global suma lo cobrado', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(150),
      total: Dc(100),
      discountAmount: Dc(50),
      payments: pagos(100),
      items: [
        itemP({ unitPrice: Dc(100), total: Dc(100) }),
        itemP({ productName: 'Pan', unitPrice: Dc(50), total: Dc(50), discountAmount: Dc(50), isCortesia: true }),
      ],
    } as any)
    expect(suma(lines)).toBe(10000)
  })

  it('B3a: la global lee lo mismo que la individual (filas de descuento, liga a la promoción, marca de cortesía)', () => {
    expect(ORDER_SELECT.orderDiscounts).toBe(DESCUENTOS_PARA_CONCEPTOS)
    expect(ORDER_SELECT.items.select.orderPromotionId).toBe(true)
    expect(ORDER_SELECT.items.select.isCortesia).toBe(true)
    expect((ORDER_SELECT as any).promotions).toBeUndefined()
  })

  it('B3a: una venta con promoción entra a la global por lo cobrado', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(80),
      total: Dc(80),
      payments: pagos(80),
      items: [itemP({ unitPrice: Dc(100), total: Dc(80), discountAmount: Dc(20), orderPromotionId: 'op1' })],
    } as any)
    expect(suma(lines)).toBe(8000)
  })

  it('B3a: una venta por peso con fracción de centavo entra a la global por lo cobrado', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(69.16),
      total: Dc(69.16),
      payments: pagos(69.16),
      items: [
        itemP({
          productName: 'JAMÓN',
          unitPrice: Dc(45),
          total: Dc(69.16),
          weightQuantity: Dc(1.537),
          product: { taxRate: Dc(0.16), objetoImp: '02', satProductKey: '50112000', satUnitKey: 'KGM', category: null },
        }),
      ],
    } as any)
    expect(suma(lines)).toBe(6916)
  })

  it('BARRERA en la global: una orden cuyo documento ≠ lo cobrado se EXCLUYE (nunca se declara mal)', () => {
    const lines = globalLinesFromOrder({
      ...base,
      payments: pagos(140), // cobrados 140, pero los renglones sólo explican 135
      items: [itemP({ productName: 'CAPUCCINO', quantity: 2, unitPrice: Dc(65), total: Dc(135) })],
    } as any)
    expect(lines).toEqual([])
  })

  it('sin renglones (importe libre): una línea por lo PAGADO, no por order.total (que trae propina)', () => {
    const lines = globalLinesFromOrder({ ...base, subtotal: Dc(100), total: Dc(115), payments: pagos(100, 'FAST'), items: [] } as any)
    expect(lines).toHaveLength(1)
    expect(lines[0].totalCents).toBe(10000)
  })

  it('pagos TEST no cuentan como cobro de la global', () => {
    const lines = globalLinesFromOrder({ ...base, subtotal: Dc(100), total: Dc(100), payments: pagos(100, 'TEST'), items: [] } as any)
    expect(lines).toEqual([])
  })
})

describe('globalLinesFromOrder — sin renglones tampoco se salta las exclusiones de orden', () => {
  it('orden vacía con cargo por servicio: excluida (no se inventa una «Venta» al 16 %)', () => {
    const Dc = (n: number) => new Prisma.Decimal(n)
    const lines = globalLinesFromOrder({
      id: 'o1',
      orderNumber: 'ORD-1',
      subtotal: Dc(0),
      taxAmount: Dc(0),
      total: Dc(100),
      discountAmount: Dc(0),
      serviceChargeAmount: Dc(100),
      payments: [{ method: 'CREDIT_CARD', tenderSatFormaPago: null, amount: Dc(100), type: 'FAST' }],
      items: [],
    } as any)
    expect(lines).toEqual([])
  })
})

// ── C1 Tarea 6: cada ticket se clasifica — entra con su foto (forma de su cobro mayor y sus conceptos reales) o sale con UN motivo ──
import { filasD16DelTicket, formaPagoDelTicket, lineasDeHoy, ticketParaGlobal } from '../../../../src/services/fiscal/cfdiGlobal.service'
import { leerReparto, REPARTO_VERSION } from '../../../../src/services/shared/repartoDescuento'
import { totalSegunElPacCents } from '../../../../src/services/fiscal/reglaDelPac' // v8 (C1-44)
import {
  conceptoDeReal,
  cuadrarPorTasa,
  MOTIVOS_DE_CONFIGURACION,
  MOTIVOS_DE_IVA,
  SIN_FILAS_D16,
  sumarExcluida,
  TEXTO_EXCLUSION_GLOBAL,
  TEXTO_FORMA_DE_PAGO_SIN_CATALOGO,
  type ExcluidasPorMotivo,
  type MotivoExclusionGlobal,
} from '../../../../src/services/fiscal/globalPorTratamiento'

describe('C1 · formaPagoDelTicket (Anexo 20: la forma con la que se liquida la mayor cantidad, sumada por forma)', () => {
  const pago = (
    id: string,
    method: string,
    amount: number,
    createdAt: string,
    tenderSatFormaPago: string | null = null,
    type = 'REGULAR',
  ) => ({
    id,
    method,
    amount: new Prisma.Decimal(amount),
    createdAt: new Date(createdAt),
    tenderSatFormaPago,
    type,
  })
  it('🔴 $900 con tarjeta y $100 en efectivo al final ⇒ la de la tarjeta (antes: la del cobro más reciente)', () => {
    expect(
      formaPagoDelTicket([pago('p2', 'CASH', 100, '2026-05-15T12:05:00Z'), pago('p1', 'CREDIT_CARD', 900, '2026-05-15T12:00:00Z')]),
    ).toBe('04')
  })
  // Ronda 1 (I3): la guía del SAT habla de la forma «con la que se liquida la mayor cantidad del pago» y prevé el empate «cuando se reciban dos
  // o más formas de pago con el mismo importe» ⇒ se suma POR FORMA, no se mira el cobro suelto mayor.
  it('🔴 I3: dos tarjetas de $300 y $500 en efectivo ⇒ tarjeta (suma $600), no efectivo (el cobro suelto mayor)', () => {
    expect(
      formaPagoDelTicket([
        pago('p1', 'CREDIT_CARD', 300, '2026-05-15T12:00:00Z'),
        pago('p2', 'CREDIT_CARD', 300, '2026-05-15T12:01:00Z'),
        pago('p3', 'CASH', 500, '2026-05-15T12:02:00Z'),
      ]),
    ).toBe('04')
  })
  it('control — I3: empate de sumas ⇒ la forma con el cobro suelto mayor ($300 + $200 en tarjeta contra $500 en efectivo ⇒ efectivo)', () => {
    expect(
      formaPagoDelTicket([
        pago('p1', 'CREDIT_CARD', 300, '2026-05-15T12:00:00Z'),
        pago('p2', 'CREDIT_CARD', 200, '2026-05-15T12:01:00Z'),
        pago('p3', 'CASH', 500, '2026-05-15T12:02:00Z'),
      ]),
    ).toBe('01')
  })
  // Ronda 1 (I3): ANTES esta prueba decía «empate de importes ⇒ el cobro más antiguo, luego el menor id» y esperaba '04' en los dos casos (la
  // tarjeta era el cobro más antiguo / de menor id). Con la regla por forma, a igual suma y a igual cobro suelto mayor manda la clave SAT menor.
  it('🔴 I3: empate de sumas y de cobro suelto mayor ⇒ la clave SAT menor (ni la hora ni el id del cobro deciden)', () => {
    expect(
      formaPagoDelTicket([pago('p2', 'CASH', 50, '2026-05-15T12:05:00Z'), pago('p1', 'CREDIT_CARD', 50, '2026-05-15T12:00:00Z')]),
    ).toBe('01')
    expect(
      formaPagoDelTicket([pago('p9', 'CASH', 50, '2026-05-15T12:00:00Z'), pago('p1', 'CREDIT_CARD', 50, '2026-05-15T12:00:00Z')]),
    ).toBe('01')
    expect(
      formaPagoDelTicket([pago('p1', 'CREDIT_CARD', 50, '2026-05-15T12:00:00Z'), pago('p9', 'CASH', 50, '2026-05-15T12:05:00Z')]),
    ).toBe('01')
  })
  it('🔴 I3: dos cobros de un tipo sin forma SAT suman más que la tarjeta ⇒ «99» (la mayor cantidad no tiene forma)', () => {
    expect(
      formaPagoDelTicket([
        pago('p1', 'OTHER', 400, '2026-05-15T12:00:00Z'),
        pago('p2', 'OTHER', 400, '2026-05-15T12:01:00Z'),
        pago('p3', 'CREDIT_CARD', 500, '2026-05-15T12:02:00Z'),
      ]),
    ).toBe('99')
  })
  it('control — la mayor cantidad se cobró con un tipo de pago sin forma SAT ⇒ «99» (el ticket no entra; no se inventa la de otro cobro)', () => {
    expect(
      formaPagoDelTicket([pago('p1', 'OTHER', 900, '2026-05-15T12:00:00Z'), pago('p2', 'CREDIT_CARD', 100, '2026-05-15T12:01:00Z')]),
    ).toBe('99')
  })
  it('🔴 un tipo propio con forma SAT declarada gana sobre el método (vale de despensa = 08)', () => {
    expect(
      formaPagoDelTicket([pago('p1', 'OTHER', 900, '2026-05-15T12:00:00Z', '08'), pago('p2', 'CREDIT_CARD', 100, '2026-05-15T12:01:00Z')]),
    ).toBe('08')
  })
  it('🔴 un cobro que no es venta (TEST) no decide la forma aunque sea el mayor', () => {
    expect(
      formaPagoDelTicket([
        pago('p1', 'CASH', 900, '2026-05-15T12:00:00Z', null, 'TEST'),
        pago('p2', 'CREDIT_CARD', 100, '2026-05-15T12:01:00Z'),
      ]),
    ).toBe('04')
  })
})

describe('C1 · ticketParaGlobal — entra con su foto o sale con su motivo', () => {
  const Dc = (n: number) => new Prisma.Decimal(n)
  const prod = (ivaTratamiento: string) => ({
    taxRate: Dc(ivaTratamiento === 'IVA_16' ? 0.16 : ivaTratamiento === 'IVA_8' ? 0.08 : 0),
    objetoImp: ivaTratamiento === 'NO_OBJETO' ? '01' : '02',
    ivaTratamiento,
    satProductKey: '50000000',
    satUnitKey: 'H87',
  })
  const item = (id: string, ivaTratamiento: string, total: number, over: Record<string, any> = {}) => ({
    id,
    productId: `p-${id}`,
    ivaTratamiento: null,
    productName: id,
    quantity: 1,
    unitPrice: Dc(total),
    discountAmount: Dc(0),
    taxAmount: Dc(0),
    total: Dc(total),
    weightQuantity: null,
    modifiers: [],
    orderPromotionId: null,
    isCortesia: false,
    product: prod(ivaTratamiento),
    ...over,
  })
  const ticket = (items: any[], paid: number, over: Record<string, any> = {}) => ({
    id: 'o1',
    orderNumber: 'ORD-1',
    subtotal: Dc(paid),
    taxAmount: Dc(0),
    total: Dc(paid),
    discountAmount: Dc(0),
    serviceChargeAmount: Dc(0),
    contratoDePrecio: 'IVA_INCLUIDO',
    orderDiscounts: [],
    payments: [
      {
        id: 'pay1',
        createdAt: new Date('2026-05-15T12:00:00Z'),
        method: 'CREDIT_CARD',
        tenderSatFormaPago: null,
        amount: Dc(paid),
        type: 'REGULAR',
      },
    ],
    items,
    ...over,
  })

  it('🔴 mezclado con IVA incluido: entra con lo cobrado por tratamiento, folio, forma, renglones y sus conceptos reales', () => {
    const t = ticketParaGlobal(ticket([item('cafe', 'IVA_0', 200), item('pan', 'IVA_16', 58)], 258) as any)
    expect(t).toMatchObject({
      ok: true,
      motivoReales: null,
      orden: {
        orderId: 'o1',
        folio: 'ORD-1',
        formaPago: '04',
        paidCents: 25800,
        porTratamiento: { IVA_0: 20000, IVA_16: 5800 },
        renglones: [
          { orderItemId: 'cafe', tratamiento: 'IVA_0' },
          { orderItemId: 'pan', tratamiento: 'IVA_16' },
        ],
        conceptosReales: [
          {
            orderItemId: 'cafe',
            productId: 'p-cafe',
            descripcion: 'cafe',
            precio: '200.000000',
            cantidad: 1,
            descuentoCents: 0,
            ivaIncluido: true,
            tratamiento: 'IVA_0',
          },
          {
            orderItemId: 'pan',
            productId: 'p-pan',
            descripcion: 'pan',
            precio: '58.000000',
            cantidad: 1,
            descuentoCents: 0,
            ivaIncluido: true,
            tratamiento: 'IVA_16',
          },
        ],
      },
    })
    // Un ticket mezclado no lleva líneas de hoy: la global lo arma con `porTratamiento`.
    expect(t.ok && t.orden.lineas).toBeUndefined()
  })
  it('🔴 todo al 0 % (hoy fuera en silencio): entra', () => {
    expect(ticketParaGlobal(ticket([item('cafe', 'IVA_0', 200)], 200) as any)).toMatchObject({
      ok: true,
      orden: { porTratamiento: { IVA_0: 20000 } },
    })
  })
  it('🔴 todo-16: entra con las líneas de hoy y la forma de su cobro mayor', () => {
    expect(ticketParaGlobal(ticket([item('pan', 'IVA_16', 116)], 116) as any)).toMatchObject({
      ok: true,
      orden: { porTratamiento: { IVA_16: 11600 }, lineas: [{ totalCents: 11600, taxRate: 0.16, formaPago: '04' }] },
    })
  })
  it('🔴 todo-16 pagado con $900 de tarjeta y $100 en efectivo al final: su línea lleva la forma de la tarjeta', () => {
    const t = ticketParaGlobal(
      ticket([item('pan', 'IVA_16', 1000)], 1000, {
        payments: [
          {
            id: 'p2',
            createdAt: new Date('2026-05-15T12:05:00Z'),
            method: 'CASH',
            tenderSatFormaPago: null,
            amount: Dc(100),
            type: 'REGULAR',
          },
          {
            id: 'p1',
            createdAt: new Date('2026-05-15T12:00:00Z'),
            method: 'CREDIT_CARD',
            tenderSatFormaPago: null,
            amount: Dc(900),
            type: 'REGULAR',
          },
        ],
      }) as any,
    )
    expect(t).toMatchObject({ ok: true, orden: { formaPago: '04', paidCents: 100000, lineas: [{ formaPago: '04', totalCents: 100000 }] } })
  })
  it.each([
    ['producto por revisar (04)', [item('x', 'BLOQUEADO_04', 100)], {}, 'PRODUCTO_POR_REVISAR'],
    ['8 % sin regla comprobada', [item('x', 'IVA_8', 108)], {}, 'OCHO_SIN_REGLA'],
    [
      'mezclado con contrato desconocido',
      [item('a', 'IVA_0', 50), item('b', 'IVA_16', 50)],
      { contratoDePrecio: 'DESCONOCIDO' },
      'CONTRATO_DESCONOCIDO',
    ],
    ['mezclado con IVA aparte', [item('a', 'IVA_0', 50), item('b', 'IVA_16', 50)], { contratoDePrecio: 'IVA_APARTE' }, 'IVA_APARTE_MIXTA'],
    ['cargo por servicio', [item('b', 'IVA_16', 100)], { serviceChargeAmount: Dc(10) }, 'CARGO_POR_SERVICIO'],
    ['sin cobros elegibles', [item('b', 'IVA_16', 100)], { payments: [] }, 'SIN_PAGAR'],
    [
      'sólo un cobro de prueba (TEST)',
      [item('b', 'IVA_16', 100)],
      { payments: [{ id: 'p', createdAt: new Date(), method: 'CREDIT_CARD', tenderSatFormaPago: null, amount: Dc(100), type: 'TEST' }] },
      'SIN_PAGAR',
    ],
    [
      '🔴 su cobro mayor no tiene forma SAT',
      [item('b', 'IVA_16', 100)],
      { payments: [{ id: 'p', createdAt: new Date(), method: 'OTHER', tenderSatFormaPago: null, amount: Dc(100), type: 'REGULAR' }] },
      'FORMA_DE_PAGO_SIN_DEFINIR',
    ],
    [
      '🔴 su cobro mayor ($900) no tiene forma SAT aunque el menor ($100, tarjeta) sí: no se toma la del otro cobro',
      [item('b', 'IVA_16', 1000)],
      {
        payments: [
          {
            id: 'p1',
            createdAt: new Date('2026-05-15T12:00:00Z'),
            method: 'OTHER',
            tenderSatFormaPago: null,
            amount: Dc(900),
            type: 'REGULAR',
          },
          {
            id: 'p2',
            createdAt: new Date('2026-05-15T12:01:00Z'),
            method: 'CREDIT_CARD',
            tenderSatFormaPago: null,
            amount: Dc(100),
            type: 'REGULAR',
          },
        ],
      },
      'FORMA_DE_PAGO_SIN_DEFINIR',
    ],
    // Revisión de la T5: con un solo RFC, una venta cobrada sólo con monedero y sin comercio ES candidata; su forma sería «99» y, si fuera el
    // ticket mayor, dejaría TODA la global en VALIDATION_FAILED. Sale sola, con su motivo.
    [
      '🔴 DIGITAL_WALLET sin comercio, un RFC',
      [item('b', 'IVA_16', 100)],
      {
        payments: [
          { id: 'p', createdAt: new Date(), method: 'DIGITAL_WALLET', tenderSatFormaPago: null, amount: Dc(100), type: 'REGULAR' },
        ],
      },
      'FORMA_DE_PAGO_SIN_DEFINIR',
    ],
  ])('%s ⇒ sale con su motivo', (_n, items, over, motivo) => {
    const paid = (items as any[]).reduce((s, i) => s + Number(i.total), 0)
    expect(ticketParaGlobal(ticket(items as any[], paid, over) as any)).toMatchObject({ ok: false, motivo })
  })
  it('🔴 descuento de cuenta sin reparto con IVA mezclado ⇒ DESCUENTO_SIN_REPARTO (D8)', () => {
    expect(
      ticketParaGlobal(
        ticket([item('a', 'IVA_0', 50), item('b', 'IVA_16', 50)], 90, {
          discountAmount: Dc(10),
          orderDiscounts: [{ id: 'd1', amount: Dc(10), reparto: null }],
        }) as any,
      ),
    ).toMatchObject({ ok: false, motivo: 'DESCUENTO_SIN_REPARTO' })
  })
  it('🔴 mezclado con el descuento repartido: lo cobrado de cada tratamiento ya lleva su descuento', () => {
    const dirigido = { v: REPARTO_VERSION, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { a: 1000 } }
    const t = ticketParaGlobal(
      ticket([item('a', 'IVA_0', 50), item('b', 'IVA_16', 50)], 90, {
        subtotal: Dc(100),
        discountAmount: Dc(10),
        orderDiscounts: [{ id: 'd1', amount: Dc(10), reparto: dirigido }],
      }) as any,
    )
    expect(t).toMatchObject({ ok: true, motivoReales: null, orden: { paidCents: 9000, porTratamiento: { IVA_0: 4000, IVA_16: 5000 } } })
    expect(t.ok && t.orden.conceptosReales!.map(r => [r.orderItemId, r.descuentoCents])).toEqual([
      ['a', 1000],
      ['b', 0],
    ])
  })
  it('🔴 lo cobrado no coincide con los conceptos ⇒ NO_CUADRA', () => {
    expect(ticketParaGlobal(ticket([item('a', 'IVA_0', 50), item('b', 'IVA_16', 50)], 120) as any)).toMatchObject({
      ok: false,
      motivo: 'NO_CUADRA',
    })
  })
  it('🔴 todo-16 que no cuadra con lo cobrado ⇒ NO_CUADRA (la barrera de hoy, ahora con su motivo)', () => {
    // El renglón es coherente ($100) y B3a lo arma; lo que no cuadra es lo cobrado ($140).
    expect(ticketParaGlobal(ticket([item('a', 'IVA_16', 100)], 140) as any)).toMatchObject({
      ok: false,
      motivo: 'NO_CUADRA',
    })
  })
  it('🔴 todo es cortesía pero se cobró algo ⇒ SIN_IMPORTE', () => {
    const regalado = item('a', 'IVA_16', 50, { discountAmount: Dc(50), isCortesia: true })
    expect(ticketParaGlobal(ticket([regalado], 10, { subtotal: Dc(50), discountAmount: Dc(50) }) as any)).toMatchObject({
      ok: false,
      motivo: 'SIN_IMPORTE',
    })
  })
  it('🔴 se cobró $0 ⇒ SIN_IMPORTE (tiene cobro, pero no importe)', () => {
    expect(ticketParaGlobal(ticket([item('a', 'IVA_16', 0)], 0) as any)).toMatchObject({ ok: false, motivo: 'SIN_IMPORTE' })
  })
  it('🔴 un folio vacío no entra: perdería el NoIdentificacion sin aviso (revisión de la T4)', () => {
    expect(ticketParaGlobal(ticket([item('pan', 'IVA_16', 116)], 116, { orderNumber: '  ' }) as any)).toMatchObject({
      ok: false,
      motivo: 'OTRO',
      detalle: expect.stringMatching(/folio/i),
    })
  })
  it('🔴 sin folio, el folio es el id de la orden (igual que el `sku` de la línea)', () => {
    expect(ticketParaGlobal(ticket([item('pan', 'IVA_16', 116)], 116, { orderNumber: null }) as any)).toMatchObject({
      ok: true,
      orden: { folio: 'o1', lineas: [{ orderId: 'o1', orderNumber: null }] },
    })
  })
  it('🔴 sin renglones (importe libre): entra con lo pagado al 16 % y un concepto real «Venta» como el de la individual', () => {
    const t = ticketParaGlobal(ticket([], 100, { total: Dc(115) }) as any)
    expect(t).toMatchObject({
      ok: true,
      motivoReales: null,
      orden: {
        porTratamiento: { IVA_16: 10000 },
        renglones: [],
        lineas: [{ totalCents: 10000 }],
        conceptosReales: [
          {
            orderItemId: null,
            productId: null,
            descripcion: 'Venta',
            precio: '100.000000',
            cantidad: 1,
            descuentoCents: 0,
            ivaIncluido: true,
            tratamiento: 'IVA_16',
          },
        ],
      },
    })
  })
  it('🔴 ticket con extra: el concepto del extra trae el `orderItemId` (y el producto) del renglón del que nace', () => {
    const cap = item('cap', 'IVA_16', 70, { unitPrice: Dc(65), modifiers: [{ name: 'Deslactosada', price: Dc(5), quantity: 1 }] })
    const t = ticketParaGlobal(ticket([cap], 70) as any)
    expect(t).toMatchObject({ ok: true, motivoReales: null })
    expect(t.ok && t.orden.conceptosReales!.map(r => [r.orderItemId, r.productId, r.descripcion, r.precio])).toEqual([
      ['cap', 'p-cap', 'cap', '65.000000'],
      ['cap', 'p-cap', 'Deslactosada (cap)', '5.000000'],
    ])
  })
  it('🔴 C1-30: un ticket con un centavo de redondeo ($65 − $2.50 al 16 %): sus conceptos reales conservan el descuento ORIGINAL (250), no el ajustado', () => {
    // v8 (Codex C1-44): B3a lee `OrderItem.total` de un renglón SIN promoción como BRUTO (`cfdi.service.ts:1206`: `brutoRenglonCents = totalCents`),
    // así que el renglón es `total = 65` (= precio × cantidad) con su descuento propio 2.50 aparte; lo cobrado, 62.50, vive en la cabecera
    // (subtotal 65, descuento 2.50, total 62.50: el descuento propio también va en la cabecera, como en la prueba de B3a de la Tarea 2).
    const t = ticketParaGlobal(
      ticket([item('a', 'IVA_16', 65, { unitPrice: Dc(65), discountAmount: Dc(2.5) })], 62.5, {
        subtotal: Dc(65),
        discountAmount: Dc(2.5),
        total: Dc(62.5),
      }) as any,
    )
    expect(t).toMatchObject({
      ok: true,
      motivoReales: null,
      orden: { conceptosReales: [expect.objectContaining({ orderItemId: 'a', precio: '65.000000', descuentoCents: 250 })] },
    })
    // Los micro-valores NO se escriben a mano: se calculan con las funciones de B3a. El PAC sobre el descuento ORIGINAL queda a un centavo de lo
    // cobrado, y la ÚNICA puerta (`cuadrarPorTasa`) lo cuadra moviendo UN centavo de descuento: el ajuste que C2 y C3 recalculan donde lo usan.
    if (!t.ok) throw new Error('inalcanzable: ya se comprobó ok')
    const cobradoCents = 6250 // lo cobrado: 65.00 − 2.50
    const original = conceptoDeReal(t.orden.conceptosReales![0])
    expect(Math.abs(totalSegunElPacCents([original]) - cobradoCents)).toBe(1)
    const cuadre = cuadrarPorTasa([original], cobradoCents, { cobradoPorTasa: { IVA_16: cobradoCents }, filasD16: SIN_FILAS_D16 })
    expect(cuadre).toMatchObject({ ok: true, documento: { totalCents: cobradoCents } })
    expect(cuadre.ok && cuadre.ajustes).toHaveLength(1)
  })
  // v7 (Codex C1-43): las filas D16, con el MISMO predicado del cargador individual (`cfdi.service.ts:1759`), congeladas en la foto.
  const reparto = (renglones: Record<string, number>, reduceImpuesto?: boolean) => ({
    v: REPARTO_VERSION,
    alcance: 'DIRIGIDO',
    conPromociones: null,
    espejo: false,
    renglones,
    ...(reduceImpuesto === undefined ? {} : { reduceImpuesto }),
  })
  const filas = [
    { id: 'd1', amount: Dc(0), reparto: reparto({ pan: 0 }, true) },
    { id: 'd2', amount: Dc(0), reparto: reparto({ pan: 0 }, false) },
    { id: 'd3', amount: Dc(0), reparto: reparto({ pan: 0 }) },
    { id: 'd4', amount: Dc(0), reparto: null },
    { id: 'd5', amount: Dc(0), reparto: { basura: true } },
  ]
  it('🔴 C1-43: filasD16DelTicket cuenta exactamente lo que el cargador individual: IVA aparte y `reduceImpuesto`; con otro contrato, ninguna', () => {
    const delCargador = (o: any) =>
      o.contratoDePrecio === 'IVA_APARTE' ? o.orderDiscounts.filter((f: any) => leerReparto(f.reparto)?.reduceImpuesto === true).length : 0 // cfdi.service.ts:1759, tal cual
    for (const contratoDePrecio of ['IVA_APARTE', 'IVA_INCLUIDO', 'DESCONOCIDO']) {
      const o = { contratoDePrecio, orderDiscounts: filas }
      expect(filasD16DelTicket(o as any)).toHaveLength(delCargador(o))
    }
    expect(filasD16DelTicket({ contratoDePrecio: 'IVA_APARTE', orderDiscounts: filas } as any)).toEqual([['pan']])
  })
  it('🔴 C1-43: el ticket entra con sus filas D16 en la foto (IVA aparte con una fila D16; IVA incluido, ninguna)', () => {
    // Fila de $0: no cambia los conceptos, sólo prueba que la foto congela la fila.
    const aparte = ticket([item('pan', 'IVA_16', 100)], 116, {
      contratoDePrecio: 'IVA_APARTE',
      subtotal: Dc(100),
      taxAmount: Dc(16),
      total: Dc(116),
      orderDiscounts: [filas[0], filas[1]],
    })
    expect(ticketParaGlobal(aparte as any)).toMatchObject({ ok: true, orden: { filasD16: [['pan']] } })
    expect(ticketParaGlobal(ticket([item('pan', 'IVA_16', 116)], 116) as any)).toMatchObject({ ok: true, orden: { filasD16: [] } })
  })
  it('🔴 IVA aparte todo al 16 %: entra como hoy (línea neta) y sus conceptos reales van SIN IVA incluido', () => {
    const aparte = ticket([item('pan', 'IVA_16', 100)], 116, {
      contratoDePrecio: 'IVA_APARTE',
      subtotal: Dc(100),
      taxAmount: Dc(16),
      total: Dc(116),
    })
    expect(ticketParaGlobal(aparte as any)).toMatchObject({
      ok: true,
      motivoReales: null,
      orden: {
        porTratamiento: { IVA_16: 11600 },
        lineas: [{ totalCents: 11600, subtotalCents: 10000, priceIncludesIva: false }],
        conceptosReales: [{ precio: '100.000000', ivaIncluido: false, tratamiento: 'IVA_16' }],
      },
    })
  })

  // ── Ronda 1 (I2): «Tipos de pago» sólo sirve para un tipo PROPIO (con `tenderTypeId`); el monedero, la cripto y un OTHER suelto no están ahí. ──
  const cobro = (method: string, amount: number, tenderTypeId: string | null = null) => ({
    id: `p-${method}`,
    createdAt: new Date('2026-05-15T12:00:00Z'),
    method,
    tenderSatFormaPago: null,
    tenderTypeId,
    amount: Dc(amount),
    type: 'REGULAR',
  })
  it.each([
    ['DIGITAL_WALLET (terminal, liga de pago)', 'DIGITAL_WALLET', null],
    ['CRYPTOCURRENCY', 'CRYPTOCURRENCY', null],
    ['OTHER sin tipo de pago del catálogo', 'OTHER', null],
  ])(
    '🔴 I2: %s sin forma SAT ⇒ FORMA_DE_PAGO_SIN_DEFINIR con un texto que se puede atender (soporte), no «Tipos de pago»',
    (_n, method, tender) => {
      const t = ticketParaGlobal(ticket([item('b', 'IVA_16', 100)], 100, { payments: [cobro(method, 100, tender)] }) as any)
      expect(t).toEqual({ ok: false, motivo: 'FORMA_DE_PAGO_SIN_DEFINIR', detalle: TEXTO_FORMA_DE_PAGO_SIN_CATALOGO })
      expect(TEXTO_FORMA_DE_PAGO_SIN_CATALOGO).toMatch(/soporte/i)
      expect(TEXTO_FORMA_DE_PAGO_SIN_CATALOGO).not.toMatch(/Tipos de pago/)
    },
  )
  it('control — I2: un tipo de pago PROPIO sin forma SAT (con `tenderTypeId`) ⇒ Tipos de pago para las próximas ventas y soporte para ésta', () => {
    const t = ticketParaGlobal(ticket([item('b', 'IVA_16', 100)], 100, { payments: [cobro('OTHER', 100, 'tt-vales')] }) as any)
    expect(t).toEqual({ ok: false, motivo: 'FORMA_DE_PAGO_SIN_DEFINIR', detalle: TEXTO_EXCLUSION_GLOBAL.FORMA_DE_PAGO_SIN_DEFINIR })
    // Ajuste del controlador (ronda 1): la forma de un tipo propio se congela en cada cobro al cobrar, así que «Tipos de pago» sólo arregla las
    // PRÓXIMAS ventas; para la ya cobrada, soporte. Las dos partes, sin callejón.
    expect(TEXTO_EXCLUSION_GLOBAL.FORMA_DE_PAGO_SIN_DEFINIR).toBe(
      'La mayor parte de esta venta se cobró con un tipo de pago sin forma del SAT: asígnala en Configuración → Tipos de pago para las próximas ventas; para ésta, escríbenos a soporte.',
    )
  })
  it('🔴 I2: si la parte sin forma mezcla un tipo propio con un monedero, el texto es el de soporte (el monedero no se arregla en Tipos de pago)', () => {
    const t = ticketParaGlobal(
      ticket([item('b', 'IVA_16', 100)], 100, {
        payments: [
          { ...cobro('OTHER', 60, 'tt-vales'), id: 'pa' },
          { ...cobro('DIGITAL_WALLET', 40), id: 'pb' },
        ],
      }) as any,
    )
    expect(t).toEqual({ ok: false, motivo: 'FORMA_DE_PAGO_SIN_DEFINIR', detalle: TEXTO_FORMA_DE_PAGO_SIN_CATALOGO })
  })

  // ── Ronda 1 (I1): el nombre del concepto real sale como en la individual: `productName` del renglón, si no el nombre del producto. ──
  it('🔴 I1: la global lee el nombre del producto, como la individual (un renglón sin `productName` no se congela como «Producto»)', () => {
    expect((ORDER_SELECT.items.select.product.select as Record<string, unknown>).name).toBe(true)
  })
  it('control — I1: renglón sin `productName` ⇒ el concepto real (y su extra) llevan el nombre del producto', () => {
    const cap = item('cap', 'IVA_16', 70, {
      productName: null,
      unitPrice: Dc(65),
      modifiers: [{ name: 'Deslactosada', price: Dc(5), quantity: 1 }],
      product: { ...prod('IVA_16'), name: 'CAPUCCINO' },
    })
    const t = ticketParaGlobal(ticket([cap], 70) as any)
    expect(t.ok && t.orden.conceptosReales!.map(r => r.descripcion)).toEqual(['CAPUCCINO', 'Deslactosada (CAPUCCINO)'])
  })
  it('🔴 I1: el detalle de PRODUCTO_POR_REVISAR nombra el producto aunque el renglón no traiga `productName`', () => {
    const x = item('x', 'BLOQUEADO_04', 100, { productName: null, product: { ...prod('BLOQUEADO_04'), name: 'Pan de muerto' } })
    expect(ticketParaGlobal(ticket([x], 100) as any)).toMatchObject({
      ok: false,
      motivo: 'PRODUCTO_POR_REVISAR',
      detalle: expect.stringContaining('«Pan de muerto»'),
    })
  })
})

describe('C1 · lineasDeHoy y el envoltorio de hoy', () => {
  const Dc = (n: number) => new Prisma.Decimal(n)
  const p16 = { taxRate: Dc(0.16), objetoImp: '02', ivaTratamiento: 'IVA_16' }
  const base = { id: 'o1', orderNumber: 'ORD-1', subtotal: Dc(140), taxAmount: Dc(0), total: Dc(140), discountAmount: Dc(0) }
  const cobro = (amount: number) => [
    {
      id: 'p1',
      createdAt: new Date('2026-05-15T12:00:00Z'),
      method: 'CREDIT_CARD',
      tenderSatFormaPago: null,
      amount: Dc(amount),
      type: 'REGULAR',
    },
  ]
  it('🔴 la salida temprana dice su motivo (documento ≠ cobrado ⇒ NO_CUADRA)', () => {
    // Renglón coherente de $100 (B3a lo arma) y $140 cobrados: la barrera de hoy lo saca, ahora diciendo por qué.
    const o = {
      ...base,
      payments: cobro(140),
      items: [
        {
          id: 'i1',
          productName: 'X',
          quantity: 1,
          unitPrice: Dc(100),
          discountAmount: Dc(0),
          taxAmount: Dc(0),
          total: Dc(100),
          product: p16,
        },
      ],
    }
    expect(lineasDeHoy(o as any)).toMatchObject({ motivo: 'NO_CUADRA' })
    expect(globalLinesFromOrder(o as any)).toEqual([]) // control — el envoltorio de hoy sigue devolviendo []
  })
  it('🔴 sin cobros elegibles ⇒ SIN_PAGAR', () => {
    expect(lineasDeHoy({ ...base, payments: [], items: [] } as any)).toMatchObject({ motivo: 'SIN_PAGAR' })
  })
})

describe('C1 · motivos de exclusión (lista cerrada)', () => {
  const TODOS: MotivoExclusionGlobal[] = [
    'EFECTIVO',
    'COMERCIO_FUERA',
    'SIN_EMISOR',
    'SIN_TERMINAL',
    'SIN_PAGAR',
    'FORMA_DE_PAGO_SIN_DEFINIR',
    'PRODUCTO_POR_REVISAR',
    'DESCUENTO_SIN_REPARTO',
    'CONTRATO_DESCONOCIDO',
    'IVA_APARTE_MIXTA',
    'OCHO_SIN_REGLA',
    'CARGO_POR_SERVICIO',
    'SIN_IMPORTE',
    'NO_CUADRA',
    'CORREGIDA_DESPUES',
    'YA_EXTRAIDO',
    'OTRO',
  ]
  it('control — cada motivo tiene su texto, y YA_EXTRAIDO manda a soporte (C1-47)', () => {
    expect(Object.keys(TEXTO_EXCLUSION_GLOBAL).sort()).toEqual([...TODOS].sort())
    for (const m of TODOS) expect(TEXTO_EXCLUSION_GLOBAL[m].length).toBeGreaterThan(20)
    expect(TEXTO_EXCLUSION_GLOBAL.YA_EXTRAIDO).toMatch(/soporte/i)
    expect(MOTIVOS_DE_IVA.every(m => TODOS.includes(m))).toBe(true)
    // Ajuste del founder (7-oct): el motivo nuevo dice DÓNDE prenderlo; es de configuración (no de IVA).
    expect(TEXTO_EXCLUSION_GLOBAL.SIN_TERMINAL).toBe(
      'Se cobró fuera de la terminal y tu configuración no incluye esas ventas en la factura global. Puedes activarlo en Facturación → tu RFC.',
    )
    expect([...MOTIVOS_DE_CONFIGURACION]).toEqual(['COMERCIO_FUERA', 'EFECTIVO', 'SIN_EMISOR', 'SIN_TERMINAL'])
    expect(MOTIVOS_DE_CONFIGURACION.some(m => MOTIVOS_DE_IVA.includes(m))).toBe(false)
  })
  it('🔴 sumarExcluida cuenta por motivo', () => {
    const e: ExcluidasPorMotivo = {}
    sumarExcluida(e, 'NO_CUADRA')
    sumarExcluida(e, 'NO_CUADRA')
    expect(sumarExcluida(e, 'EFECTIVO')).toBe(e)
    expect(e).toEqual({ NO_CUADRA: 2, EFECTIVO: 1 })
  })
})

// ── C1 · Tarea 7: la entrada v2 (la foto manda; los ajustes congelados se reproducen), su lector, la llave por periodo ──
import { leerGlobal, llaveDeLaGlobal, ordenesDeLaGlobal, MOTIVO_SIN_TICKETS } from '../../../../src/services/fiscal/cfdiGlobal.service'
import {
  cuadrarLaGlobal,
  filasD16DeOrdenGlobal,
  paramsDeLaGlobal,
  sumarFilasD16,
  type PorTratamientoGlobal,
} from '../../../../src/services/fiscal/globalPorTratamiento'
import { huellaDeEntrada } from '../../../../src/services/fiscal/entradaDocumental'
import { closedPeriodFor } from '../../../../src/services/fiscal/globalPeriod'

describe('C1 · leerGlobal v2 — la foto manda; los ajustes congelados se reproducen', () => {
  const periodo = closedPeriodFor('DIARIO', new Date('2026-10-06T12:00:00Z'))
  const orden = (orderId: string, porTratamiento: any, paidCents: number, extra: Record<string, any> = {}) => {
    const renglones = [{ orderItemId: `${orderId}-i`, tratamiento: Object.keys(porTratamiento)[0] }]
    const o = {
      orderId,
      folio: `F-${orderId}`,
      formaPago: '04',
      paidCents,
      renglones,
      porTratamiento,
      conceptosReales: null as any,
      filasD16: [] as string[][],
      ...extra,
    }
    return {
      ...o,
      huella: huellaDeEntrada({
        renglones: o.renglones,
        porTratamiento: o.porTratamiento,
        lineas: (o as any).lineas ?? null,
        conceptosReales: o.conceptosReales,
        folio: o.folio,
        formaPago: o.formaPago,
        filasD16: o.filasD16,
      }),
    }
  }
  /**
   * Un ticket todo al 16 % con IVA APARTE, en su forma REAL de la captura (Tarea 6): su línea de hoy (`lineasDeHoy`) con el precio neto. Con
   * IVA incluido y sin descuento en el concepto (la forma de C1) la global suma exacto y nunca da ±1 ¢ (Tarea 3, S0 = 0 %): la «sobra» y la
   * «falta» de G6/G8 sólo nacen así. `OrdenGlobalV2` no lleva descuento de concepto: G6/G8 «a mano» no se pueden armar (ajuste del controlador).
   */
  const ordenAparte = (orderId: string, netCents: number) => {
    const g = Math.round(netCents * 1.16) // lo cobrado: B3a con IVA aparte (round(neto × 1.16))
    const sub = Math.round(g / 1.16) // la línea: groupOrderIntoGlobalLines → splitIvaIncluded
    const linea = {
      orderId,
      orderNumber: `F-${orderId}`,
      totalCents: g,
      subtotalCents: sub,
      taxCents: g - sub,
      formaPago: '04',
      priceIncludesIva: false,
      taxRate: 0.16,
      objetoImp: '02',
    }
    return orden(orderId, { IVA_16: g }, g, { lineas: [linea] })
  }
  /** «Sobra» (G6, forma real; `t7-casos.ts`): netos $10.15 y $20.15 ⇒ cobrados 1177 + 2337 = 3514; el PAC daría 3515; la 6b pone 1 ¢. */
  const ordenesDeG6 = () => [ordenAparte('g6a', 1015), ordenAparte('g6b', 2015)]
  /** «Falta» (G8, forma real; los 5 tickets de la Tarea 3): cobrados Σ 308361; el PAC da 308360 y no hay descuento que bajar. */
  const ordenesDeG8 = () => [51599, 77125, 36111, 64222, 36771].map((n, i) => ordenAparte(`g8-${i}`, n))
  const porTasa = (ordenes: any[]) =>
    ordenes.reduce<PorTratamientoGlobal>((m, o) => {
      for (const [t, c] of Object.entries(o.porTratamiento)) (m as any)[t] = ((m as any)[t] ?? 0) + (c as number)
      return m
    }, {})
  /** La fila que guarda `capturarGlobal`: con `ajustar = false`, los conceptos SIN el ajuste (aunque el cuadre haya salido bien). */
  function fila(ordenes: any[], ajustar = true) {
    const base = paramsDeLaGlobal({ lugarExpedicion: '01000' }, ordenes, periodo)
    const cobrado = ordenes.reduce((s, o) => s + o.paidCents, 0)
    const c = cuadrarLaGlobal(base.items, cobrado, {
      cobradoPorTasa: porTasa(ordenes),
      filasD16: sumarFilasD16(ordenes.map(filasD16DeOrdenGlobal)),
    })
    const params = { ...base, items: c.ok && ajustar ? c.items : base.items }
    const entrada: any = {
      version: 2,
      tipo: 'GLOBAL',
      fiscalEmisorId: 'e1',
      globalPeriod: { periodicidad: '01', meses: periodo.meses, anio: periodo.anio },
      periodo: { desde: periodo.periodStart.toISOString(), hasta: periodo.periodEnd.toISOString() },
      montos: c.montos,
      excluidas: {},
      excluidasPorIvaMixto: 0,
      ordenes,
      formaDelMezclado: 'UN_CONCEPTO',
      cuadre: c.ok ? { ok: true } : { ok: false, motivo: c.motivo },
      ajustes: c.ok && ajustar ? c.ajustes : [],
      params,
    }
    // Ronda 1 de la T11 (I2): `leerGlobal` exige la llave de la fila (una principal: no termina en `-c<n>`).
    return {
      idempotencyKey: 'cfdi-global-e1-leer',
      fiscalEmisorId: 'e1',
      globalPeriod: entrada.globalPeriod,
      entrada,
      entradaHuella: huellaDeEntrada(entrada),
      ...c.montos,
    }
  }
  /** La fila que guarda `capturarGlobal` cuando `cuadrarLaGlobal` no cuadra: conceptos originales, `ajustes: []`, el motivo. */
  function filaDiagnostica(ordenes: any[]) {
    const f = fila(ordenes)
    if (f.entrada.cuadre.ok) throw new Error('el caso debía NO cuadrar')
    return f
  }
  const rehuella = (f: any) => ((f.entradaHuella = huellaDeEntrada(f.entrada)), f)

  it('una v2 íntegra se lee, y cada ticket trae SU tramo de conceptos', () => {
    const c = fila([orden('o1', { IVA_0: 20000 }, 20000), orden('o2', { EXENTO: 4550 }, 4550)])
    expect(leerGlobal(c).version).toBe(2)
    expect(ordenesDeLaGlobal(leerGlobal(c)).map(o => [o.porTratamiento, o.conceptos.length])).toEqual([
      [{ IVA_0: 20000 }, 1],
      [{ EXENTO: 4550 }, 1],
    ])
  })
  it('🔴 con ajuste (G6 en su forma real, IVA aparte): el lector reproduce el ajuste congelado y el ticket ajustado trae su centavo', () => {
    const c = fila(ordenesDeG6())
    expect(c.entrada.ajustes).toEqual([{ indice: 1, deCents: 0, aCents: 1 }])
    expect(c.totalCents).toBe(3514) // lo cobrado
    const t = ordenesDeLaGlobal(leerGlobal(c)).find(o => o.conceptos.some(i => i.discountCents === 1))
    expect(t).toBeDefined()
    expect(t!.orderId).toBe('g6b')
  })
  it('🔴 un ajuste congelado que no se aplica a su concepto (descuento cambiado a mano) ⇒ revisión de soporte', () => {
    const c = fila(ordenesDeG6())
    c.entrada.ajustes = [{ ...c.entrada.ajustes[0], aCents: 2 }]
    rehuella(c)
    expect(() => leerGlobal(c)).toThrow(/soporte/)
  })
  it('🔴 montos que no son lo cobrado con cuadre.ok ⇒ revisión de soporte en los dos modos (incoherente)', () => {
    expect(() => leerGlobal(fila(ordenesDeG6(), false))).toThrow(/soporte/)
    expect(() => leerGlobal(fila(ordenesDeG6(), false), 'DIAGNOSTICO')).toThrow(/soporte/)
  })
  it('🔴 C1-12 / C1-40 (Codex): una captura DIAGNÓSTICA con órdenes (cuadre.ok: false, G8) se lee en modo diagnóstico —sin exigir la barrera ni lo cobrado— y NUNCA en modo para enviar', () => {
    const c = filaDiagnostica(ordenesDeG8())
    expect(c.entrada.ordenes.length).toBeGreaterThan(0)
    expect(c.entrada.montos.totalCents).not.toBe(c.entrada.ordenes.reduce((s: number, o: any) => s + o.paidCents, 0)) // justo lo que no se alcanzó
    expect(leerGlobal(c, 'DIAGNOSTICO')).toMatchObject({
      version: 2,
      cuadre: { ok: false, motivo: expect.stringMatching(/moviendo centavos/) },
    })
    expect(() => leerGlobal(c)).toThrow(/soporte/)
  })
  it('🔴 C1-40: la diagnóstica se valida por lo que guardó: con ajustes, con conceptos que no son los originales o sin motivo ⇒ revisión de soporte también en diagnóstico', () => {
    const conAjuste = filaDiagnostica(ordenesDeG8())
    conAjuste.entrada.ajustes = [{ indice: 0, deCents: 0, aCents: 1 }]
    expect(() => leerGlobal(rehuella(conAjuste), 'DIAGNOSTICO')).toThrow(/soporte/)
    const otros = filaDiagnostica(ordenesDeG8())
    otros.entrada.params.items[0] = { ...otros.entrada.params.items[0], discountCents: 1 }
    expect(() => leerGlobal(rehuella(otros), 'DIAGNOSTICO')).toThrow(/soporte/)
    const sinMotivo = filaDiagnostica(ordenesDeG8())
    sinMotivo.entrada.cuadre = { ok: false, motivo: '' }
    expect(() => leerGlobal(rehuella(sinMotivo), 'DIAGNOSTICO')).toThrow(/soporte/)
  })
  it('🔴 C1-23: la captura diagnóstica SIN órdenes se lee en diagnóstico y nunca para enviar; con otro motivo o con conceptos ⇒ soporte', () => {
    const vacia = () => {
      const f = fila([])
      f.entrada.cuadre = { ok: false, motivo: MOTIVO_SIN_TICKETS }
      f.entrada.montos = { subtotalCents: 0, taxCents: 0, totalCents: 0 }
      Object.assign(f, f.entrada.montos)
      return rehuella(f)
    }
    expect(leerGlobal(vacia(), 'DIAGNOSTICO')).toMatchObject({ ordenes: [], cuadre: { ok: false, motivo: MOTIVO_SIN_TICKETS } })
    expect(() => leerGlobal(vacia())).toThrow(/soporte/)
    const otroMotivo = vacia()
    otroMotivo.entrada.cuadre = { ok: false, motivo: 'otro' }
    expect(() => leerGlobal(rehuella(otroMotivo), 'DIAGNOSTICO')).toThrow(/soporte/)
    const conConcepto = vacia()
    conConcepto.entrada.params.items = fila([orden('o1', { IVA_0: 20000 }, 20000)]).entrada.params.items
    expect(() => leerGlobal(rehuella(conConcepto), 'DIAGNOSTICO')).toThrow(/soporte/)
  })
  it('🔴 (e) montos que suman lo cobrado pero no son el documento del PAC (subtotal e IVA repartidos distinto) ⇒ revisión de soporte', () => {
    const c = fila(ordenesDeG6())
    const otro = { ...c.entrada.montos, subtotalCents: c.entrada.montos.subtotalCents + 1, taxCents: c.entrada.montos.taxCents - 1 }
    c.entrada.montos = otro
    Object.assign(c, otro)
    expect(() => leerGlobal(rehuella(c))).toThrow(/soporte/)
  })
  it('🔴 ronda 1 (M5): `excluidas` con una llave HEREDADA (`toString`, `constructor`) no es un motivo de la lista ⇒ revisión de soporte', () => {
    for (const llave of ['toString', 'constructor', 'hasOwnProperty']) {
      const c = fila([orden('o1', { IVA_0: 20000 }, 20000)])
      c.entrada.excluidas = { [llave]: 1 }
      expect(() => leerGlobal(rehuella(c))).toThrow(/soporte/)
    }
  })
  it('🔴 C1-43: las filas D16 congeladas son parte de la foto: cambiarlas a mano ⇒ revisión de soporte', () => {
    const c = fila([orden('o1', { IVA_0: 20000 }, 20000)])
    c.entrada.ordenes[0].filasD16 = [['o1-i']]
    rehuella(c)
    expect(() => leerGlobal(c)).toThrow(/soporte/)
  })
  it('un concepto que ya no corresponde a su foto (base cambiada) o una forma que no es la del ticket mayor ⇒ revisión de soporte', () => {
    const c = fila([orden('o1', { IVA_16: 16000, IVA_0: 4000 }, 20000)])
    c.entrada.params.items[0].taxes[0].base = '137.930000'
    rehuella(c)
    expect(() => leerGlobal(c)).toThrow(/soporte/)
    const d = fila([orden('o1', { IVA_0: 20000 }, 20000)])
    d.entrada.params.payment_form = '01'
    rehuella(d)
    expect(() => leerGlobal(d)).toThrow(/soporte/)
  })
  it('🔴 revisión de la T4 (M1): un concepto mezclado con una base que el SAT no acepta nunca llega al proveedor: el lector lo rechaza', () => {
    for (const base of ['abc', '-50.000000', '50.0000001']) {
      const c = fila([orden('o1', { IVA_16: 5800, IVA_0: 20000 }, 25800)])
      c.entrada.params.items[0].taxes[0].base = base
      expect(() => leerGlobal(rehuella(c))).toThrow(/soporte/)
    }
  })
  it('🔴 (g) un ticket con forma 99 o una global con forma 99 ⇒ revisión de soporte (nunca se manda «por definir»)', () => {
    const c = fila([orden('o1', { IVA_0: 20000 }, 20000, { formaPago: '99' })])
    expect(c.entrada.params.payment_form).toBe('99')
    expect(() => leerGlobal(c)).toThrow(/soporte/)
  })
  it('🔴 (a) el periodo guardado tiene que ser un periodo cerrado de su periodicidad (inicio y fin exactos)', () => {
    const corrido = fila([orden('o1', { IVA_0: 20000 }, 20000)])
    corrido.entrada.periodo = { ...corrido.entrada.periodo, desde: new Date(periodo.periodStart.getTime() + 3_600_000).toISOString() }
    expect(() => leerGlobal(rehuella(corrido))).toThrow(/soporte/)
    const otroMes = fila([orden('o1', { IVA_0: 20000 }, 20000)])
    const mayo = closedPeriodFor('DIARIO', new Date('2026-05-10T12:00:00Z'))
    otroMes.entrada.periodo = { desde: mayo.periodStart.toISOString(), hasta: mayo.periodEnd.toISOString() }
    expect(() => leerGlobal(rehuella(otroMes))).toThrow(/soporte/)
  })
  it('🔴 C1-34 (h): los reales ORIGINALES ($65 − $2.50; el PAC daría 62.49 con ese descuento) se aceptan; unos reales que no explican lo cobrado ⇒ soporte', () => {
    const real = (precio: string, descuentoCents: number) => [
      {
        orderItemId: 'o1-i',
        productId: 'p',
        descripcion: 'X',
        precio,
        cantidad: 1,
        descuentoCents,
        ivaIncluido: true,
        tratamiento: 'IVA_16',
      },
    ]
    const linea = {
      orderId: 'o1',
      orderNumber: 'F-o1',
      totalCents: 6250,
      subtotalCents: 5388,
      taxCents: 862,
      formaPago: '04',
      priceIncludesIva: true,
      taxRate: 0.16,
      objetoImp: '02',
    }
    const ok = fila([orden('o1', { IVA_16: 6250 }, 6250, { lineas: [linea], conceptosReales: real('65.000000', 250) })])
    expect(ordenesDeLaGlobal(leerGlobal(ok))).toEqual([
      expect.objectContaining({ conceptosReales: [expect.objectContaining({ precio: '65.000000', descuentoCents: 250 })] }),
    ])
    const malos = fila([orden('o1', { IVA_16: 6250 }, 6250, { lineas: [linea], conceptosReales: real('100.000000', 250) })])
    expect(() => leerGlobal(malos)).toThrow(/soporte/)
  })
  it('🔴 llaveDeLaGlobal: dos días del mismo mes tienen llaves distintas; mensual conserva la de hoy', () => {
    const d1 = closedPeriodFor('DIARIO', new Date('2026-10-02T15:00:00Z'))
    const d2 = closedPeriodFor('DIARIO', new Date('2026-10-03T15:00:00Z'))
    expect(llaveDeLaGlobal('e1', d1)).toBe('cfdi-global-e1-2026-10-01-20261001')
    expect(llaveDeLaGlobal('e1', d2)).toBe('cfdi-global-e1-2026-10-01-20261002')
    expect(llaveDeLaGlobal('e1', closedPeriodFor('MENSUAL', new Date('2026-10-02T15:00:00Z')))).toBe('cfdi-global-e1-2026-09-04')
  })
  it('🔴 llaveDeLaGlobal: semanal y quincenal llevan el día de su inicio (hora de México); bimestral conserva la de hoy', () => {
    // Domingo 4-oct-2026 a las 23:30 en México (05:30Z del lunes): la semana cerrada es la del lunes 21-sep.
    expect(llaveDeLaGlobal('e1', closedPeriodFor('SEMANAL', new Date('2026-10-05T05:30:00Z')))).toBe('cfdi-global-e1-2026-09-02-20260921')
    expect(llaveDeLaGlobal('e1', closedPeriodFor('QUINCENAL', new Date('2026-10-20T15:00:00Z')))).toBe('cfdi-global-e1-2026-10-03-20261001')
    expect(llaveDeLaGlobal('e1', closedPeriodFor('BIMESTRAL', new Date('2026-10-02T15:00:00Z')))).toBe('cfdi-global-e1-2026-16-05')
  })
  it('🔴 ronda 1 (M5): la llave es una llave de idempotencia: AAAAMMDD en hora de México sale de las partes de la fecha, no del formato de texto de ICU', () => {
    // Los periodos se calculan ANTES de simular el formato (date-fns-tz usa Intl por dentro).
    const d1 = closedPeriodFor('DIARIO', new Date('2026-10-02T15:00:00Z')) // 1-oct
    const bordeAntes = closedPeriodFor('DIARIO', new Date('2026-10-02T03:00:00Z')) // ya 2-oct en UTC, todavía 1-oct 21:00 en México ⇒ cerró el 30-sep
    const bordeDespues = closedPeriodFor('DIARIO', new Date('2026-10-02T06:30:00Z')) // 2-oct 00:30 en México ⇒ cerró el 1-oct
    const finDeAnio = closedPeriodFor('DIARIO', new Date('2027-01-01T05:59:59Z')) // 31-dic 23:59:59 en México ⇒ cerró el 30-dic
    // Un ICU que formateara de otra manera (p. ej. «10/01/2026») no puede cambiar la llave: nacería una segunda fila para el mismo periodo.
    // `format` es un accessor en el estándar (los tipos de TS lo declaran método): se espía su `get`.
    const espiarGetter = jest.spyOn as unknown as (o: object, k: string, a: 'get') => jest.SpyInstance
    const formato = espiarGetter(Intl.DateTimeFormat.prototype, 'format', 'get').mockReturnValue(() => '10/01/2026')
    try {
      expect([d1, bordeAntes, bordeDespues, finDeAnio].map(p => llaveDeLaGlobal('e1', p))).toEqual([
        'cfdi-global-e1-2026-10-01-20261001',
        'cfdi-global-e1-2026-09-01-20260930',
        'cfdi-global-e1-2026-10-01-20261001',
        'cfdi-global-e1-2026-12-01-20261230',
      ])
    } finally {
      formato.mockRestore()
    }
  })
  it('🔴 ordenesDeLaGlobal de una v1: un item por ticket, en el mismo orden; folio = la orden, forma = la de la global', () => {
    const it16 = (unitPriceCents: number, taxIncluded: boolean) => ({
      satProductKey: '01010101',
      satUnitKey: 'ACT',
      description: 'Venta',
      quantity: 1,
      unitPriceCents,
      discountCents: 0,
      objetoImp: '02',
      taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
      taxIncluded,
    })
    const renglones = [{ orderItemId: 'a-i', tratamiento: 'IVA_16' as const }]
    const v1: any = {
      version: 1,
      tipo: 'GLOBAL',
      fiscalEmisorId: 'e1',
      globalPeriod: { periodicidad: '04', meses: '05', anio: 2026 },
      montos: { subtotalCents: 15000, taxCents: 2400, totalCents: 17400 },
      excluidasPorIvaMixto: 0,
      ordenes: [
        { orderId: 'a', huella: 'h'.repeat(64), renglones },
        { orderId: 'b', huella: 'h'.repeat(64), renglones: [{ orderItemId: 'b-i', tratamiento: 'IVA_16' }] },
      ],
      params: { items: [it16(11600, true), it16(5000, false)], payment_form: '04' },
    }
    expect(ordenesDeLaGlobal(v1).map(o => [o.orderId, o.folio, o.formaPago, o.paidCents, o.conceptos.length, o.conceptosReales])).toEqual([
      ['a', 'a', '04', 11600, 1, null],
      ['b', 'b', '04', 5800, 1, null],
    ])
  })
})

// ── C1 · Tarea 8: ningún periodo se pierde ───────────────────────────────────────────────────────────────────────────────────
import {
  emitirGlobalesPendientes,
  esLlaveViejaCorta,
  estaApagadaLaGlobal,
  periodoDeLaFila,
  periodosDeLaGlobal,
} from '../../../../src/services/fiscal/cfdiGlobal.service'
import { mismoPeriodo, periodosCerradosRecientes, MOTIVO_PERIODO_VIEJO } from '../../../../src/services/fiscal/globalPeriod'
import { BadRequestError, ConflictError } from '../../../../src/errors/AppError'
import {
  MAX_OTRAS_PERIODICIDADES,
  MOTIVO_EN_PROCESO,
  MOTIVO_ERROR_DE_LA_PASADA,
  MOTIVO_ERROR_DEL_PERIODO,
  MOTIVO_PERIODO_CUBIERTO,
  MOTIVO_PERIODO_FUERA_DE_VENTANA,
} from '../../../../src/services/fiscal/cfdiGlobal.service'
import logger from '../../../../src/config/logger'

describe('C1 · periodoDeLaFila — la identidad del periodo se demuestra, no se infiere (C1-14)', () => {
  it('v2: el periodo congelado', () => {
    const d = closedPeriodFor('DIARIO', new Date('2026-10-03T15:00:00Z'))
    expect(
      periodoDeLaFila({
        entrada: { version: 2, periodo: { desde: d.periodStart.toISOString(), hasta: d.periodEnd.toISOString() } },
        globalPeriod: { periodicidad: '01', meses: d.meses, anio: d.anio },
        idempotencyKey: 'k',
      } as any),
    ).toEqual(d)
  })
  it('control — v2 cuyo periodo guardado no es un periodo de su periodicidad (o no es de su mes) ⇒ null', () => {
    const d = closedPeriodFor('DIARIO', new Date('2026-10-03T15:00:00Z'))
    const fila = (periodo: any, gp: any = { periodicidad: '01', meses: d.meses, anio: d.anio }) =>
      periodoDeLaFila({ entrada: { version: 2, periodo }, globalPeriod: gp, idempotencyKey: 'k' } as any)
    expect(fila({ desde: new Date(d.periodStart.getTime() + 1).toISOString(), hasta: d.periodEnd.toISOString() })).toBeNull()
    expect(
      fila({ desde: d.periodStart.toISOString(), hasta: d.periodEnd.toISOString() }, { periodicidad: '01', meses: '11', anio: 2026 }),
    ).toBeNull()
    expect(
      fila({ desde: d.periodStart.toISOString(), hasta: d.periodEnd.toISOString() }, { periodicidad: '02', meses: d.meses, anio: d.anio }),
    ).toBeNull()
    expect(fila(null)).toBeNull()
  })
  it('control — 🔴 vieja diaria (llave del mes): null aunque se sepa su createdAt — no se adivina el día', () => {
    expect(
      periodoDeLaFila({
        entrada: { version: 1 },
        fiscalEmisorId: 'e1',
        globalPeriod: { periodicidad: '01', meses: '10', anio: 2026 },
        idempotencyKey: 'cfdi-global-e1-2026-10-01',
        createdAt: new Date('2026-10-02T09:15:00Z'),
      } as any),
    ).toBeNull()
  })
  it('vieja mensual: su mes, exacto', () => {
    expect(
      periodoDeLaFila({
        entrada: { version: 1 },
        fiscalEmisorId: 'e1',
        globalPeriod: { periodicidad: '04', meses: '09', anio: 2026 },
        idempotencyKey: 'cfdi-global-e1-2026-09-04',
      } as any),
    ).toEqual(closedPeriodFor('MENSUAL', new Date('2026-10-05T15:00:00Z')))
  })
  it('esLlaveViejaCorta: sólo la llave EXACTA de antes (emisor, año, mes y periodicidad corta de la propia fila)', () => {
    const vieja = (idempotencyKey: string, periodicidad = '01', fiscalEmisorId = 'e1') =>
      esLlaveViejaCorta({ idempotencyKey, fiscalEmisorId, globalPeriod: { periodicidad, meses: '10', anio: 2026 } })
    expect(vieja('cfdi-global-e1-2026-10-01')).toBe(true)
    expect(vieja('cfdi-global-e1-2026-10-02', '02')).toBe(true)
    expect(vieja('cfdi-global-e1-2026-10-03', '03')).toBe(true)
    expect(vieja('cfdi-global-e1-2026-10-01-20261003')).toBe(false) // la llave nueva (con día)
    expect(vieja('cfdi-global-e1-2026-10-04', '04')).toBe(false) // mensual: un periodo por llave
    expect(vieja('cfdi-global-e1-2026-10-01', '01', 'e2')).toBe(false) // otro emisor
    expect(vieja('cfdi-global-e1-2026-11-01')).toBe(false) // otro mes que el de su globalPeriod
    expect(vieja('cfdi-global-e1-2026-10-01', '02')).toBe(false) // otra periodicidad que la de su globalPeriod
  })
})

describe('C1 · emitirGlobalesPendientes', () => {
  const ahora = new Date('2026-10-05T15:00:00Z')
  const sep = closedPeriodFor('MENSUAL', ahora)
  /** Una global v2 sin timbrar, del periodo de septiembre (el emisor es MENSUAL), con su llave `k-<id>`. */
  const filaV2 = (id: string, updatedAt: Date, p = sep) => ({
    id,
    updatedAt,
    fiscalEmisorId: 'e1',
    idempotencyKey: `k-${id}`,
    status: 'STAMPING',
    entrada: { version: 2, periodo: { desde: p.periodStart.toISOString(), hasta: p.periodEnd.toISOString() } },
    globalPeriod: { periodicidad: p.satPeriodicidad, meses: p.meses, anio: p.anio },
  })
  it('🔴 C1-15: 11 pendientes, las 10 primeras siguen en proceso: la 11 se procesa en la pasada siguiente (cursor); una excepción a la mitad no detiene', async () => {
    const filas = Array.from({ length: 11 }, (_, i) => filaV2(`c${String(i).padStart(2, '0')}`, new Date(Date.UTC(2026, 9, 1, 0, i))))
    const emitidas: string[] = []
    const d = deps({
      loadGlobalesSinTimbrar: jest.fn(async (_e: string, cursor: any) =>
        filas
          .filter(f => !cursor || f.updatedAt > cursor.updatedAt || (+f.updatedAt === +cursor.updatedAt && f.id > cursor.id))
          .slice(0, 10),
      ),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue({ status: 'STAMPED' }),
      emitirPeriodo: jest.fn(async ({ key }: any) => {
        emitidas.push(key)
        if (key === 'k-c03') throw new Error('se cayó la base') // excepción cualquiera, no ConflictError
        if (key < 'k-c10') throw new ConflictError(MOTIVO_EN_PROCESO) // «otra corrida lo tiene en proceso»: el texto EXACTO del motor
        return { status: 'STAMPED' } as any
      }),
    })
    const p1 = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true, cursor: null }, d)
    expect(p1.resultados.map(r => r.status)).toEqual([...Array(3).fill('SKIPPED'), 'ERROR', ...Array(6).fill('SKIPPED')])
    // T10 (N1): el error crudo no se devuelve; el detalle va al logger.error.
    expect(p1.resultados[3]).toMatchObject({ reason: MOTIVO_ERROR_DEL_PERIODO, period: sep })
    expect(p1.cursor).toEqual({ updatedAt: filas[9].updatedAt, id: 'c09' })
    const p2 = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true, cursor: p1.cursor }, d)
    expect(emitidas).toContain('k-c10')
    expect(p2.resultados.map(r => r.status)).toEqual(['STAMPED'])
    expect(p2.cursor).toBeNull()
    expect((d.loadGlobalesSinTimbrar as jest.Mock).mock.calls.map(c => c[1])).toEqual([null, p1.cursor])
  })
  it('cada fila pendiente va con SU periodo y SU llave (aunque la periodicidad del emisor sea otra)', async () => {
    const dia = closedPeriodFor('DIARIO', new Date('2026-09-20T15:00:00Z'))
    // Una llave que NO es la que se calcularía hoy para ese periodo (p. ej. la de una complementaria, Tarea 11): manda la de la fila.
    const fila = { ...filaV2('d1', new Date(), dia), idempotencyKey: 'cfdi-global-e1-2026-09-01-20260919-c2' }
    const d = deps({
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([fila]),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue({ status: 'STAMPED' }),
      emitirPeriodo: jest.fn().mockResolvedValue({ status: 'STAMPED' }),
    })
    await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(d.emitirPeriodo).toHaveBeenCalledTimes(1)
    expect((d.emitirPeriodo as jest.Mock).mock.calls[0][0]).toEqual({
      emisorId: 'e1',
      now: ahora,
      sandbox: true,
      period: dia,
      key: 'cfdi-global-e1-2026-09-01-20260919-c2',
    })
  })
  it('una fila cuyo periodo no se puede demostrar (v2 corrupta, o vieja corta de otra forma) se reporta para soporte y no detiene a las demás', async () => {
    const rota = { ...filaV2('r1', new Date()), entrada: { version: 2, periodo: { desde: 'x', hasta: 'y' } } }
    const sana = filaV2('s1', new Date())
    const d = deps({
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([rota, sana]),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue({ status: 'STAMPED' }),
      emitirPeriodo: jest.fn().mockResolvedValue({ status: 'STAMPED' }),
    })
    const { resultados } = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(resultados.map(r => r.status)).toEqual(['VALIDATION_FAILED', 'STAMPED'])
    expect(resultados[0].reasons?.[0]).toMatch(/soporte/)
    expect((d.emitirPeriodo as jest.Mock).mock.calls.map(c => c[0].key)).toEqual(['k-s1'])
  })
  it('después de las pendientes, emite los periodos recientes SIN global principal, del más viejo al más nuevo', async () => {
    const emitidas: string[] = []
    const recientes = periodosCerradosRecientes('DIARIO', ahora)
    expect(recientes).toHaveLength(7)
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity: 'DIARIO', regimenFiscal: '601' }),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => (mismoPeriodo(p, recientes[2]) ? { status: 'STAMPED' } : null)),
      emitirPeriodo: jest.fn(
        async ({ period }: any) => (emitidas.push(period.periodStart.toISOString()), { status: 'STAMPED', period }) as any,
      ),
    })
    await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(emitidas).toHaveLength(6)
    expect(emitidas).toEqual([...emitidas].sort())
    expect(emitidas).not.toContain(recientes[2].periodStart.toISOString())
    // …cada uno con la llave nueva de SU día
    expect((d.emitirPeriodo as jest.Mock).mock.calls.map(c => c[0].key)).toEqual(
      [...recientes]
        .reverse()
        .filter(p => !mismoPeriodo(p, recientes[2]))
        .map(p => llaveDeLaGlobal('e1', p)),
    )
  })
  it('🔴 re-revisión T7 (b): un periodo DETENIDO (la captura lanza «revisión de soporte», o truena la base) no frena a los periodos siguientes', async () => {
    const recientes = periodosCerradosRecientes('DIARIO', ahora)
    expect(recientes).toHaveLength(7)
    const [masViejo, segundo] = [...recientes].reverse()
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity: 'DIARIO' }),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue(null),
      emitirPeriodo: jest.fn(async ({ period }: any) => {
        if (mismoPeriodo(period, masViejo)) throw new ConflictError('La entrada fiscal de esta factura requiere revisión de soporte.')
        if (mismoPeriodo(period, segundo)) throw new Error('se cayó la base')
        return { status: 'STAMPED', period } as any
      }),
    })
    const { resultados } = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    // Ronda 1 (I1): «revisión de soporte» no es «en proceso»: el periodo queda DETENIDO (con su aviso), no SKIPPED.
    expect(resultados.map(r => r.status)).toEqual(['DETENIDO', 'ERROR', 'STAMPED', 'STAMPED', 'STAMPED', 'STAMPED', 'STAMPED'])
    expect(resultados[0]).toMatchObject({ period: masViejo, reason: expect.stringMatching(/soporte/) })
    expect(resultados[1]).toMatchObject({ period: segundo, reason: MOTIVO_ERROR_DEL_PERIODO }) // T10 (N1)
  })
  it('un periodo cuya fila pendiente ya se intentó en esta pasada (aunque tronara) no se vuelve a emitir como «periodo faltante»', async () => {
    const recientes = periodosCerradosRecientes('DIARIO', ahora)
    expect(recientes).toHaveLength(7)
    const fila = { ...filaV2('d1', new Date(), recientes[1]), idempotencyKey: llaveDeLaGlobal('e1', recientes[1]) }
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity: 'DIARIO' }),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([fila]),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue(null), // aunque no la encontrara por su llave
      emitirPeriodo: jest.fn(async ({ period }: any) => {
        if (mismoPeriodo(period, recientes[1])) throw new Error('truena')
        return { status: 'NOTHING_TO_INVOICE', period } as any
      }),
    })
    const { resultados } = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(resultados).toHaveLength(7)
    expect((d.emitirPeriodo as jest.Mock).mock.calls.filter(c => mismoPeriodo(c[0].period, recientes[1]))).toHaveLength(1)
  })
  it('control — CSD inactivo: no lee pendientes ni emite nada', async () => {
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...emisor, csdStatus: 'PENDING' }),
      loadGlobalesSinTimbrar: jest.fn(),
      emitirPeriodo: jest.fn(),
    })
    const r = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(d.loadGlobalesSinTimbrar).not.toHaveBeenCalled()
    expect(d.emitirPeriodo).not.toHaveBeenCalled()
    expect(r.cursor).toBeNull()
  })
})

describe('C1 · issueGlobalForEmisor con `desde` (C1-P16 = B: sólo un periodo reciente)', () => {
  const ahora = new Date('2026-10-12T09:00:00Z')
  const diario = { ...emisor, globalPeriodicity: 'DIARIO' }
  const timbrada = { id: 'g', venueId: 'v1', fiscalEmisorId: 'e1', status: 'STAMPED', entrada: {} }
  it('🔴 un diario de hace 3 días: ese periodo con SU llave', async () => {
    const ps = periodosCerradosRecientes('DIARIO', ahora, 8)
    expect(ps).toHaveLength(8)
    const d = deps({ loadEmisor: jest.fn().mockResolvedValue(diario), findExistingGlobal: jest.fn().mockResolvedValue(timbrada) })
    const r = await issueGlobalForEmisor({ emisorId: 'e1', now: ahora, sandbox: true, desde: ps[2].periodStart.toISOString() }, d)
    expect(r).toMatchObject({ status: 'STAMPED', period: ps[2] })
    expect(d.findExistingGlobal).toHaveBeenCalledWith(llaveDeLaGlobal('e1', ps[2]))
  })
  it('🔴 hace 8 días (fuera de la ventana), a la mitad de un periodo, o una fecha que no lo es ⇒ «pídelo a soporte», sin tocar nada', async () => {
    const ps = periodosCerradosRecientes('DIARIO', ahora, 8)
    expect(ps).toHaveLength(8)
    for (const desde of [ps[7].periodStart.toISOString(), new Date(ps[2].periodStart.getTime() + 1).toISOString(), 'ayer']) {
      const d = deps({ loadEmisor: jest.fn().mockResolvedValue(diario), findExistingGlobal: jest.fn().mockResolvedValue(timbrada) })
      const p = issueGlobalForEmisor({ emisorId: 'e1', now: ahora, sandbox: true, desde }, d)
      await expect(p).rejects.toBeInstanceOf(BadRequestError)
      await expect(p).rejects.toThrow(MOTIVO_PERIODO_VIEJO)
      expect(d.findExistingGlobal).not.toHaveBeenCalled()
    }
  })
  it('control — sin `desde`, el último periodo cerrado (como siempre)', async () => {
    const d = deps({ loadEmisor: jest.fn().mockResolvedValue(diario), findExistingGlobal: jest.fn().mockResolvedValue(timbrada) })
    expect(await issueGlobalForEmisor({ emisorId: 'e1', now: ahora, sandbox: true }, d)).toMatchObject({
      period: closedPeriodFor('DIARIO', ahora),
    })
  })
})

describe('C1 · periodosDeLaGlobal (C1-P16 = B: sólo los recientes, sin paginación)', () => {
  const ahora = new Date('2026-10-05T15:00:00Z')
  it('🔴 cada periodo reciente con el estado de su global principal, el más reciente primero', async () => {
    const ps = periodosCerradosRecientes('DIARIO', ahora)
    expect(ps).toHaveLength(7)
    const filas = new Map<string, any>([
      [
        ps[0].periodStart.toISOString(),
        { id: 'g0', fiscalEmisorId: 'e1', status: 'STAMPED', protocoloIva: 1, folio: '12', lastError: null },
      ],
      [ps[1].periodStart.toISOString(), { id: 'g1', fiscalEmisorId: 'e1', status: 'CANCELLED', folio: '11', lastError: null }],
      [
        ps[2].periodStart.toISOString(),
        { id: 'g2', fiscalEmisorId: 'e1', status: 'VALIDATION_FAILED', folio: null, lastError: 'no cuadra' },
      ],
      [ps[3].periodStart.toISOString(), { id: 'g3', fiscalEmisorId: 'e1', status: 'STAMP_FAILED', folio: null, lastError: 'rechazo' }],
      [ps[4].periodStart.toISOString(), { id: 'g4', fiscalEmisorId: 'e1', status: 'CANCEL_REQUESTED', folio: '9', lastError: null }],
    ])
    // Ronda 1 (I1 b): un SIN_GLOBAL cuyo último aviso es «detenido» da ese motivo; uno ya reanudado, ninguno.
    const avisos = new Map<string, any>([
      [
        ps[5].periodStart.toISOString(),
        { action: 'CFDI_GLOBAL_PERIODO_DETENIDO', motivo: 'La entrada fiscal de esta factura requiere revisión de soporte.' },
      ],
      [ps[6].periodStart.toISOString(), { action: 'CFDI_GLOBAL_PERIODO_REANUDADO', motivo: null }],
    ])
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity: 'DIARIO' }),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => filas.get(p.periodStart.toISOString()) ?? null),
      ultimoAvisoDelPeriodo: jest.fn(async (_e: any, p: any) => avisos.get(p.periodStart.toISOString()) ?? null),
    })
    const { periodos } = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(periodos.map(p => [p.desde, p.hasta, p.meses, p.anio])).toEqual(
      ps.map(p => [p.periodStart.toISOString(), p.periodEnd.toISOString(), p.meses, p.anio]),
    )
    expect(periodos.map(p => [p.estado, p.cfdiId, p.folio, p.motivo])).toEqual([
      ['TIMBRADA', 'g0', '12', null],
      ['CANCELADA', 'g1', '11', null],
      ['SIN_TIMBRAR', 'g2', null, 'no cuadra'],
      ['SIN_TIMBRAR', 'g3', null, 'rechazo'],
      ['TIMBRADA', 'g4', '9', null], // m5: una cancelación en curso sigue timbrada
      ['SIN_GLOBAL', null, null, 'La entrada fiscal de esta factura requiere revisión de soporte.'],
      ['SIN_GLOBAL', null, null, null],
    ])
    // Sólo se busca el aviso de los SIN_GLOBAL y (T10, m1 de la T9) de los SIN_TIMBRAR (≤ 7 consultas), con las dos acciones que lo deciden.
    expect((d.ultimoAvisoDelPeriodo as jest.Mock).mock.calls.map(c => [c[1].periodStart.toISOString(), c[2]])).toEqual(
      [ps[2], ps[3], ps[5], ps[6]].map(p => [
        p.periodStart.toISOString(),
        ['CFDI_GLOBAL_PERIODO_DETENIDO', 'CFDI_GLOBAL_PERIODO_REANUDADO'],
      ]),
    )
    // T11: sólo una principal TIMBRADA (STAMPED) o CANCELADA trae «cuántas entrarían»; los demás estados, null y sin complementarias.
    expect(periodos.map(p => p.corregidasPendientes)).toEqual([
      { n: 0, completo: true },
      { n: 0, completo: true },
      null,
      null,
      null,
      null,
      null,
    ])
    expect(periodos.every(p => Array.isArray(p.complementarias) && !p.complementarias.length)).toBe(true)
  })
  it('🔴 un emisor de otro negocio no se lista', async () => {
    const d = deps({ loadEmisor: jest.fn().mockResolvedValue({ ...emisor, venueId: 'otro' }) })
    await expect(periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)).rejects.toThrow(/not found/)
  })
})

// ── Ola final de C1 (principio del founder: «apagado se VE y se EXPLICA») ──
describe('ola final — `globalApagada`: la global de Avoqado apagada para el RFC se dice, no se adivina', () => {
  const ahora = new Date('2026-10-05T15:00:00Z')
  const testarudo = { ...emisor, invoiceCashSales: true, includeOffTerminalSalesInGlobal: false } // 1 RFC, efectivo ON, interruptor de fábrica
  it('🔴 Testarudo el día de publicar (0 comercios en la global, interruptor apagado) ⇒ `globalApagada: true` en los periodos', async () => {
    const d = deps({ loadEmisor: jest.fn().mockResolvedValue(testarudo), comercioEnLaGlobal: jest.fn().mockResolvedValue(false) })
    const r = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(r.globalApagada).toBe(true)
    expect(d.comercioEnLaGlobal).toHaveBeenCalledWith('e1')
    expect(d.comercioEnLaGlobal).toHaveBeenCalledTimes(1) // una consulta por respuesta, no una por periodo
  })
  it('control — con un comercio en la global ⇒ `false`', async () => {
    const d = deps({ loadEmisor: jest.fn().mockResolvedValue(testarudo), comercioEnLaGlobal: jest.fn().mockResolvedValue(true) })
    expect((await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)).globalApagada).toBe(false)
  })
  it('control — con el interruptor de ventas fuera de la terminal ENCENDIDO ⇒ `false`, sin consultar los comercios', async () => {
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...testarudo, includeOffTerminalSalesInGlobal: true }),
      comercioEnLaGlobal: jest.fn().mockResolvedValue(false),
    })
    expect((await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)).globalApagada).toBe(false)
    expect(d.comercioEnLaGlobal).not.toHaveBeenCalled()
  })
  it('🔴 la función sola: apagada con 0 comercios en la global Y (el interruptor apagado O más de un RFC en el negocio)', async () => {
    const con = (comercio: boolean, rfcs = 1) => ({
      comercioEnLaGlobal: jest.fn().mockResolvedValue(comercio),
      contarEmisores: jest.fn().mockResolvedValue(rfcs),
    })
    const e = (interruptor: boolean) => ({ id: 'e1', venueId: 'v1', includeOffTerminalSalesInGlobal: interruptor })
    expect(await estaApagadaLaGlobal(e(false), con(false))).toBe(true)
    expect(await estaApagadaLaGlobal(e(false), con(true))).toBe(false)
    expect(await estaApagadaLaGlobal(e(true), con(false))).toBe(false)
    // Con varios RFC el interruptor no aplica (lo de fuera de la terminal es SIN_EMISOR): sin comercio, nada puede entrar.
    expect(await estaApagadaLaGlobal(e(true), con(false, 2))).toBe(true)
    expect(await estaApagadaLaGlobal(e(true), con(true, 2))).toBe(false)
    // Si quien llama ya sabe cuántos RFC hay (el listado), no se vuelve a contar.
    const ya = con(false, 1)
    expect(await estaApagadaLaGlobal(e(true), ya, false)).toBe(true)
    expect(ya.contarEmisores).not.toHaveBeenCalled()
  })
  it('🔴 agregado del coordinador: DOS RFC, interruptor ENCENDIDO y 0 comercios en la global ⇒ `globalApagada: true` (nada puede entrar)', async () => {
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...testarudo, includeOffTerminalSalesInGlobal: true }),
      contarEmisores: jest.fn().mockResolvedValue(2),
      comercioEnLaGlobal: jest.fn().mockResolvedValue(false),
    })
    expect((await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)).globalApagada).toBe(true)
    expect(d.contarEmisores).toHaveBeenCalledWith('v1')
  })
  it('control — DOS RFC, interruptor ENCENDIDO y un comercio de este RFC en la global ⇒ `false`', async () => {
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...testarudo, includeOffTerminalSalesInGlobal: true }),
      contarEmisores: jest.fn().mockResolvedValue(2),
      comercioEnLaGlobal: jest.fn().mockResolvedValue(true),
    })
    expect((await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)).globalApagada).toBe(false)
  })
})

describe('C1 · Tarea 8, ronda 1 — un periodo detenido no se pierde en silencio (I1) y la cola no se atora (m1, m2)', () => {
  const ahora = new Date('2026-10-05T15:00:00Z')
  const diario = { ...emisor, globalPeriodicity: 'DIARIO' }
  const SOPORTE = 'La entrada fiscal de esta factura requiere revisión de soporte.'
  const recientes = periodosCerradosRecientes('DIARIO', ahora, 10)
  const masViejo = recientes[6]
  afterEach(() => jest.restoreAllMocks())

  it('🔴 I1 (a): sólo «en proceso» (el texto EXACTO) es SKIPPED con warn; «revisión de soporte» y «cancelada en el PAC» salen DETENIDO con error', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger)
    const motivos = [
      MOTIVO_EN_PROCESO,
      SOPORTE,
      'Esta cuenta ya tiene una factura cancelada en el PAC; revísala antes de volver a facturar.',
      'en proceso',
    ]
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue(null),
      emitirPeriodo: jest.fn(async ({ period }: any) => {
        const i = [...recientes.slice(0, 7)].reverse().findIndex(p => mismoPeriodo(p, period))
        if (i < motivos.length) throw new ConflictError(motivos[i])
        return { status: 'NOTHING_TO_INVOICE', period } as any
      }),
    })
    const { resultados } = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(resultados.slice(0, 4).map(r => r.status)).toEqual(['SKIPPED', 'DETENIDO', 'DETENIDO', 'DETENIDO'])
    expect(warn.mock.calls.filter(c => String(c[0]).includes(MOTIVO_EN_PROCESO))).toHaveLength(1)
    expect(error.mock.calls.filter(c => String(c[0]).includes(SOPORTE))).toHaveLength(1)
    expect(error.mock.calls.filter(c => String(c[0]).includes('cancelada en el PAC'))).toHaveLength(1)
  })

  it('🔴 I1 (b): un periodo detenido deja su aviso con periodo y motivo; con el MISMO motivo no se repite; con otro, sí; «en proceso» no deja aviso', async () => {
    let ultimo: any = null
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => (mismoPeriodo(p, masViejo) ? null : { status: 'STAMPED' })),
      ultimoAvisoDelPeriodo: jest.fn(async () => ultimo),
      registrarAvisoDelPeriodo: jest.fn(async (_e: any, _p: any, action: string, data: any) => {
        ultimo = { action, motivo: data.motivo ?? null }
      }),
    })
    const motivo = jest.fn().mockRejectedValueOnce(new ConflictError(SOPORTE)).mockRejectedValueOnce(new ConflictError(SOPORTE))
    motivo.mockRejectedValueOnce(new Error('se cayó la base')).mockRejectedValueOnce(new ConflictError(MOTIVO_EN_PROCESO))
    ;(d as any).emitirPeriodo = jest.fn(() => motivo())
    for (let i = 0; i < 4; i++) await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    const avisos = (d.registrarAvisoDelPeriodo as jest.Mock).mock.calls
    expect(avisos.map(c => [c[1], c[2], c[3].motivo])).toEqual([
      [masViejo, 'CFDI_GLOBAL_PERIODO_DETENIDO', SOPORTE],
      [masViejo, 'CFDI_GLOBAL_PERIODO_DETENIDO', MOTIVO_ERROR_DEL_PERIODO], // T10 (N1): nunca el texto crudo
    ])
    expect(avisos[0][3]).toMatchObject({ status: 'DETENIDO' })
    expect(avisos[1][3]).toMatchObject({ status: 'ERROR' })
    expect((d.ultimoAvisoDelPeriodo as jest.Mock).mock.calls[0][2]).toEqual([
      'CFDI_GLOBAL_PERIODO_DETENIDO',
      'CFDI_GLOBAL_PERIODO_REANUDADO',
    ])
  })

  it('🔴 I1 (b): si un periodo detenido ya no tiene nada que facturar, queda «reanudado» (el panel deja de mostrar el motivo viejo)', async () => {
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => (mismoPeriodo(p, masViejo) ? null : { status: 'STAMPED' })),
      ultimoAvisoDelPeriodo: jest.fn().mockResolvedValue({ action: 'CFDI_GLOBAL_PERIODO_DETENIDO', motivo: SOPORTE }),
      emitirPeriodo: jest.fn(async ({ period }: any) => ({ status: 'NOTHING_TO_INVOICE', period }) as any),
    })
    await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect((d.registrarAvisoDelPeriodo as jest.Mock).mock.calls.map(c => [c[1], c[2]])).toEqual([
      [masViejo, 'CFDI_GLOBAL_PERIODO_REANUDADO'],
    ])
  })

  it('🔴 I1 (c): un periodo SIN principal que acaba de salir de la ventana y aún tiene candidatos ⇒ error + aviso «pídelo a soporte», una sola vez', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger)
    const fuera = recientes[7] // el 8.º diario: el primero que ya no revisa el job
    let avisado = false
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => (mismoPeriodo(p, fuera) ? null : { status: 'STAMPED' })),
      tieneCandidatos: jest.fn(async (_e: any, p: any) => mismoPeriodo(p, fuera)),
      ultimoAvisoDelPeriodo: jest.fn(async (_e: any, p: any, acciones: string[]) =>
        avisado && mismoPeriodo(p, fuera) && acciones.includes('CFDI_GLOBAL_PERIODO_FUERA_DE_VENTANA')
          ? { action: 'CFDI_GLOBAL_PERIODO_FUERA_DE_VENTANA', motivo: MOTIVO_PERIODO_FUERA_DE_VENTANA }
          : null,
      ),
      registrarAvisoDelPeriodo: jest.fn(async () => {
        avisado = true
      }),
    })
    const p1 = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(p1.resultados).toContainEqual(
      expect.objectContaining({ status: 'DETENIDO', period: fuera, reason: MOTIVO_PERIODO_FUERA_DE_VENTANA }),
    )
    expect(MOTIVO_PERIODO_FUERA_DE_VENTANA).toMatch(/soporte/)
    expect(error.mock.calls.filter(c => String(c[0]).includes(MOTIVO_PERIODO_FUERA_DE_VENTANA))).toHaveLength(1)
    const p2 = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(p2.resultados.filter(r => r.status === 'DETENIDO')).toEqual([])
    expect((d.registrarAvisoDelPeriodo as jest.Mock).mock.calls.map(c => [c[1], c[2], c[3].motivo])).toEqual([
      [fuera, 'CFDI_GLOBAL_PERIODO_FUERA_DE_VENTANA', MOTIVO_PERIODO_FUERA_DE_VENTANA],
    ])
    // Nunca se emite: fuera de la ventana sólo se avisa.
    expect((d.emitirPeriodo as jest.Mock | undefined)?.mock?.calls ?? []).toEqual([])
  })

  it('control — I1 (c): fuera de la ventana sin candidatos, o con principal, no avisa', async () => {
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) =>
        mismoPeriodo(p, recientes[8]) ? { status: 'STAMPED' } : p.periodStart < masViejo.periodStart ? null : { status: 'STAMPED' },
      ),
      tieneCandidatos: jest.fn(async (_e: any, p: any) => mismoPeriodo(p, recientes[8])),
    })
    await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(d.registrarAvisoDelPeriodo).not.toHaveBeenCalled()
  })

  it('🔴 m2: si leer la página de pendientes truena, el error queda en su resultado y los periodos recientes se emiten igual (el cursor no se pierde)', async () => {
    const cursor = { updatedAt: new Date('2026-10-01T00:00:00Z'), id: 'c09' }
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockRejectedValue(new Error('se cayó la base')),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue(null),
      emitirPeriodo: jest.fn(async ({ period }: any) => ({ status: 'NOTHING_TO_INVOICE', period }) as any),
    })
    // Que la pasada NO lance: se afirma su resultado (un `catch` lo vuelve un valor para que el rojo sea por aserción).
    const r: any = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true, cursor }, d).catch(e => ({
      lanzo: e.message,
    }))
    expect(r).toMatchObject({ cursor })
    // T10 (N1) y ronda 1 (m4): sin periodo, el texto genérico no habla «de este periodo».
    expect(r.resultados[0]).toMatchObject({ status: 'ERROR', reason: MOTIVO_ERROR_DE_LA_PASADA })
    expect(d.emitirPeriodo).toHaveBeenCalledTimes(7)
    expect(r.cursor).toEqual(cursor)
  })

  it('🔴 m1: cada fila pendiente se «toca» después de su intento (haya escrito o no, haya tronado o no), para que no se quede al frente de la cola', async () => {
    const sep = closedPeriodFor('MENSUAL', ahora)
    const fila = (id: string) => ({
      id,
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      attempts: 1,
      status: 'STAMP_FAILED',
      fiscalEmisorId: 'e1',
      idempotencyKey: `k-${id}`,
      entrada: { version: 2, periodo: { desde: sep.periodStart.toISOString(), hasta: sep.periodEnd.toISOString() } },
      globalPeriod: { periodicidad: sep.satPeriodicidad, meses: sep.meses, anio: sep.anio },
    })
    const filas = [fila('a'), fila('b'), { ...fila('c'), entrada: { version: 2, periodo: null } }]
    const d = deps({
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue(filas),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue({ status: 'STAMPED' }),
      emitirPeriodo: jest.fn(async ({ key }: any) => {
        if (key === 'k-a') throw new ConflictError(MOTIVO_EN_PROCESO)
        return { status: 'STAMPED' } as any
      }),
    })
    await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect((d.tocarPendiente as jest.Mock).mock.calls.map(c => c[0].id)).toEqual(['a', 'b', 'c'])
  })
})

// ── C1 · Tarea 9: la bimestral sólo con el régimen 621, comprobada contra el periodo del DOCUMENTO (Codex C1-4, C1-19) ──
import { issueGlobalForPeriod } from '../../../../src/services/fiscal/cfdiGlobal.service'
import {
  periodoDeGlobalPeriod,
  MOTIVO_BIMESTRAL_CAPTURA_DESCARTADA,
  MOTIVO_BIMESTRAL_FILA_APARTADA,
  MOTIVO_BIMESTRAL_RECHAZADA_DESCARTADA,
  MOTIVO_BIMESTRAL_SOLO_621,
} from '../../../../src/services/fiscal/globalPeriod'
import * as cfdiService from '../../../../src/services/fiscal/cfdi.service'

describe('C1 · Tarea 9 — la bimestral sólo con el régimen 621, contra el periodo del DOCUMENTO (C1-4, C1-19)', () => {
  const bimestre = periodoDeGlobalPeriod({ periodicidad: '05', meses: '17', anio: 2026 })!
  const ahora = new Date('2026-11-05T15:00:00Z')
  const pedir = (period = bimestre, key = 'k-bim') => ({ emisorId: 'e1', now: ahora, sandbox: true, period, key })
  const emisorCon = (globalPeriodicity: string, regimenFiscal: string) =>
    jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity, regimenFiscal })
  /** Una reserva que SÍ corre (si el motor llega a reservar, la prueba lo ve: «nada que facturar» en vez del motivo). */
  const reservaVacia = () => jest.fn().mockResolvedValue({ cfdi: null, fresh: true, reasons: [], empty: true, excluded: 0, excluidas: {} })
  /**
   * Ola final (m2 de la revisión de la T9): con una fila PREVIA el motor real nunca devuelve «nada que facturar» (exige `!previous`), así que ahí
   * el doble no inventa un estado imposible: si el motor llega a reservar, falla con un mensaje que dice exactamente eso.
   */
  const noDebiaReservar = () => jest.fn().mockRejectedValue(new Error('no debía reservar'))
  /** Un ticket todo al 16 % con IVA incluido y sin `lineas` (la forma de C1): cuadra exacto, sin ajustes. */
  const ticket = (orderId: string, paidCents: number) => {
    const o = {
      orderId,
      folio: `F-${orderId}`,
      formaPago: '04',
      paidCents,
      renglones: [{ orderItemId: `${orderId}-i`, tratamiento: 'IVA_16' }],
      porTratamiento: { IVA_16: paidCents },
      conceptosReales: null,
      filasD16: [] as string[][],
    }
    const huella = huellaDeEntrada({
      renglones: o.renglones,
      porTratamiento: o.porTratamiento,
      lineas: null,
      conceptosReales: o.conceptosReales,
      folio: o.folio,
      formaPago: o.formaPago,
      filasD16: o.filasD16,
    })
    return { ...o, huella }
  }
  /**
   * M6 (pre-flight): la fila de una global bimestral ENVIADA e incierta — `STAMPING`, `enviadoAt` puesto, sin fallo definitivo — con su
   * entrada v2 válida (la que guarda `capturarGlobal`: el bimestre 17 de 2026, dos tickets, `cuadre.ok`).
   */
  function filaEnviadaIncierta(key: string) {
    const ordenes = [ticket('b1', 11600), ticket('b2', 5800)]
    const cobrado = 17400
    const base = paramsDeLaGlobal({ lugarExpedicion: '83000' }, ordenes as any, bimestre)
    const c = cuadrarLaGlobal(base.items, cobrado, {
      cobradoPorTasa: { IVA_16: cobrado },
      filasD16: sumarFilasD16(ordenes.map(o => filasD16DeOrdenGlobal(o as any))),
    })
    if (!c.ok) throw new Error('el ayudante debía cuadrar')
    const entrada = {
      version: 2,
      tipo: 'GLOBAL',
      fiscalEmisorId: 'e1',
      globalPeriod: { periodicidad: '05', meses: '17', anio: 2026 },
      periodo: { desde: bimestre.periodStart.toISOString(), hasta: bimestre.periodEnd.toISOString() },
      montos: c.montos,
      excluidas: {},
      excluidasPorIvaMixto: 0,
      ordenes,
      formaDelMezclado: 'UN_CONCEPTO',
      cuadre: { ok: true },
      ajustes: c.ajustes,
      params: { ...base, items: c.items },
    }
    return {
      id: 'g-bim',
      idempotencyKey: key,
      status: 'STAMPING',
      protocoloIva: 1,
      enviadoAt: new Date('2026-11-01T12:00:00Z') as Date | null,
      falloDefinitivo: false,
      attempts: 1,
      facturapiId: null,
      uuid: null,
      venueId: 'v1',
      fiscalEmisorId: 'e1',
      globalPeriod: entrada.globalPeriod,
      entrada,
      entradaHuella: huellaDeEntrada(entrada),
      ...c.montos,
    }
  }

  it('control — el ayudante arma una fila bimestral v2 VÁLIDA (se lee para enviar, con sus dos tickets)', () => {
    const e = leerGlobal(filaEnviadaIncierta('k-bim'), 'PARA_ENVIAR')
    expect(e.version).toBe(2)
    expect(e.ordenes.map(o => o.orderId)).toEqual(['b1', 'b2'])
  })

  it('🔴 C1-19: una captura bimestral pendiente, con el emisor YA cambiado a MENSUAL y régimen 601 ⇒ no se emite', async () => {
    const d = deps({ loadEmisor: emisorCon('MENSUAL', '601'), runInTransaction: reservaVacia() })
    const r = await issueGlobalForPeriod(pedir(), d)
    expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_BIMESTRAL_SOLO_621], period: bimestre, candidateCount: 0 })
    expect(d.runInTransaction).not.toHaveBeenCalled()
    expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
  })

  it.each([
    // T10, ronda 1 (m1): el texto dice la verdad según la fila. La reservada apartó sus ventas (soporte); la diagnóstica no apartó nada.
    ['STAMPING', MOTIVO_BIMESTRAL_FILA_APARTADA],
    ['VALIDATION_FAILED', MOTIVO_BIMESTRAL_CAPTURA_DESCARTADA],
  ])(
    '🔴 C1-19: la fila bimestral PENDIENTE (%s, nunca enviada) con el emisor ya MENSUAL y 601 ⇒ no se recaptura ni se le pregunta al PAC; su motivo (el de su estado) queda en la fila',
    async (status, motivo) => {
      const fila = { ...filaEnviadaIncierta('k-bim'), status, enviadoAt: null, lastError: null }
      const conMotivo = { ...fila, lastError: motivo }
      const consultarSpy = jest.spyOn(cfdiService, 'consultarIntentoCapturado').mockResolvedValue(null)
      try {
        const d = deps({
          loadEmisor: emisorCon('MENSUAL', '601'),
          findExistingGlobal: jest.fn().mockResolvedValue(fila),
          runInTransaction: noDebiaReservar(),
          persistCfdi: jest.fn().mockResolvedValue(conMotivo),
        })
        const r = await issueGlobalForPeriod(pedir(), d)
        expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [motivo], cfdi: conMotivo, period: bimestre })
        // T10, ronda 1 (I2 b): el motivo se escribe en la fila (CAS que exige que nunca se haya enviado), sin tocar su estado.
        expect(d.persistCfdi).toHaveBeenCalledWith({ lastError: motivo }, { id: 'g-bim', status, attempts: fila.attempts, enviadoAt: null })
        expect(d.runInTransaction).not.toHaveBeenCalled()
        expect(consultarSpy).not.toHaveBeenCalled()
      } finally {
        consultarSpy.mockRestore()
      }
    },
  )

  it.each([
    // T10, ronda 2 (N3): un texto por caso; nunca «entran a la global de tu periodicidad actual» si la actual sigue siendo la bimestral.
    ['VALIDATION_FAILED con el emisor ya MENSUAL', 'VALIDATION_FAILED', 'MENSUAL', false, MOTIVO_BIMESTRAL_CAPTURA_DESCARTADA],
    ['VALIDATION_FAILED con el emisor SIGUE BIMESTRAL (601)', 'VALIDATION_FAILED', 'BIMESTRAL', false, MOTIVO_BIMESTRAL_SOLO_621],
    ['rechazada en definitiva con el emisor ya MENSUAL', 'STAMP_FAILED', 'MENSUAL', true, MOTIVO_BIMESTRAL_RECHAZADA_DESCARTADA],
    ['rechazada en definitiva con el emisor SIGUE BIMESTRAL (601)', 'STAMP_FAILED', 'BIMESTRAL', true, MOTIVO_BIMESTRAL_SOLO_621],
  ])('🔴 ronda 2 (N3): la fila bimestral que NO apartó ventas, %s ⇒ su texto', async (_n, status, periodicidad, rechazada, motivo) => {
    const fila = {
      ...filaEnviadaIncierta('k-bim'),
      status,
      falloDefinitivo: rechazada,
      enviadoAt: rechazada ? new Date('2026-11-01T12:00:00Z') : null,
      lastError: null,
    }
    const consultarSpy = jest.spyOn(cfdiService, 'consultarIntentoCapturado').mockResolvedValue(null)
    try {
      const d = deps({
        loadEmisor: emisorCon(periodicidad, '601'),
        findExistingGlobal: jest.fn().mockResolvedValue(fila),
        runInTransaction: noDebiaReservar(),
      })
      expect(await issueGlobalForPeriod(pedir(), d)).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [motivo] })
      expect(d.runInTransaction).not.toHaveBeenCalled()
    } finally {
      consultarSpy.mockRestore()
    }
  })

  it('control — T10, ronda 1 (I2 b): si la fila ya dice el motivo, no se reescribe (la pasada no la toca cada día)', async () => {
    const fila = { ...filaEnviadaIncierta('k-bim'), enviadoAt: null, lastError: MOTIVO_BIMESTRAL_FILA_APARTADA }
    const d = deps({
      loadEmisor: emisorCon('MENSUAL', '601'),
      findExistingGlobal: jest.fn().mockResolvedValue(fila),
      runInTransaction: noDebiaReservar(),
    })
    expect(await issueGlobalForPeriod(pedir(), d)).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_BIMESTRAL_FILA_APARTADA] })
    expect(d.persistCfdi).not.toHaveBeenCalled()
  })

  it('🔴 C1-19: el botón (sin `desde`) de un emisor que quedó BIMESTRAL con régimen 601 ⇒ el motivo, sin reservar', async () => {
    const d = deps({ loadEmisor: emisorCon('BIMESTRAL', '601'), runInTransaction: reservaVacia() })
    const r = await issueGlobalForEmisor({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_BIMESTRAL_SOLO_621], period: { meses: '17', anio: 2026 } })
    expect(d.runInTransaction).not.toHaveBeenCalled()
  })

  it('🔴 C1-19 en la pasada del job: la fila bimestral pendiente (periodicidad CONGELADA) con el emisor ya MENSUAL y 601 sale con su motivo', async () => {
    const fila = { ...filaEnviadaIncierta('k-bim'), enviadoAt: null, updatedAt: new Date('2026-11-02T10:00:00Z') }
    const d = deps({
      loadEmisor: emisorCon('MENSUAL', '601'),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([fila]),
      findExistingGlobal: jest.fn().mockResolvedValue(fila),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue({ id: 'ya-tiene-principal' }),
      runInTransaction: noDebiaReservar(),
    })
    const { resultados } = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true, cursor: null }, d)
    expect(resultados).toEqual([
      expect.objectContaining({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_BIMESTRAL_FILA_APARTADA], cfdi: fila }),
    ])
    expect(d.runInTransaction).not.toHaveBeenCalled()
  })

  // ── C1 · Tarea 10, m1 de la revisión de la T9: la fila bimestral PENDIENTE con el emisor que dejó de ser 621 no queda invisible ──
  it('🔴 m1 de la T9: en la pasada del job, la fila bimestral PENDIENTE deja el aviso DETENIDO con un motivo que manda a soporte, UNA vez', async () => {
    const fila = { ...filaEnviadaIncierta('k-bim'), enviadoAt: null, lastError: null, updatedAt: new Date('2026-11-02T10:00:00Z') }
    let ultimo: any = null
    const d = deps({
      loadEmisor: emisorCon('MENSUAL', '601'),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([fila]),
      findExistingGlobal: jest.fn().mockResolvedValue(fila),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue({ id: 'ya-tiene-principal' }),
      runInTransaction: noDebiaReservar(),
      ultimoAvisoDelPeriodo: jest.fn(async () => ultimo),
      registrarAvisoDelPeriodo: jest.fn(async (_e: any, _p: any, action: string, data: any) => {
        ultimo = { action, motivo: data.motivo ?? null }
      }),
    })
    for (let i = 0; i < 2; i++) await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true, cursor: null }, d)
    const avisos = (d.registrarAvisoDelPeriodo as jest.Mock).mock.calls
    expect(avisos.map(c => [c[1], c[2], c[3].motivo, c[3].status])).toEqual([
      [bimestre, 'CFDI_GLOBAL_PERIODO_DETENIDO', MOTIVO_BIMESTRAL_FILA_APARTADA, 'VALIDATION_FAILED'],
    ])
    expect(MOTIVO_BIMESTRAL_FILA_APARTADA).toMatch(/soporte/)
    expect(MOTIVO_BIMESTRAL_FILA_APARTADA).not.toMatch(/Elige otra periodicidad/)
  })

  it('🔴 m1 de la T9 + ronda 1 (I1): el panel la muestra APARTE (`otrasPeriodicidades`), nunca dentro de `periodos`, con el motivo del aviso', async () => {
    const fila = {
      ...filaEnviadaIncierta('k-bim'),
      enviadoAt: null,
      lastError: null,
      folio: null,
      updatedAt: new Date('2026-11-02T10:00:00Z'),
    }
    const d = deps({
      loadEmisor: emisorCon('MENSUAL', '601'),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue(null),
      globalesDeOtraPeriodicidad: jest.fn().mockResolvedValue([fila]),
      ultimoAvisoDelPeriodo: jest.fn(async (_e: any, p: any) =>
        p.satPeriodicidad === '05'
          ? { action: 'CFDI_GLOBAL_PERIODO_DETENIDO', motivo: MOTIVO_BIMESTRAL_FILA_APARTADA, createdAt: new Date('2026-11-03T10:00:00Z') }
          : null,
      ),
    })
    const r = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(d.globalesDeOtraPeriodicidad).toHaveBeenCalledWith('e1', '04', null) // ronda 2 (N5 b): la primera página, sin cursor
    // `periodos` vuelve al contrato de la T8: SÓLO los periodos recientes de la periodicidad de hoy, sin `desde` repetidos.
    expect(r.periodos).toHaveLength(2)
    expect(r.periodos.every(p => p.meses !== '17')).toBe(true)
    expect(new Set(r.periodos.map(p => p.desde)).size).toBe(r.periodos.length)
    expect(r.otrasPeriodicidades).toEqual({
      completo: true,
      globales: [
        {
          cfdiId: 'g-bim',
          periodicidad: 'BIMESTRAL',
          desde: bimestre.periodStart.toISOString(),
          hasta: bimestre.periodEnd.toISOString(),
          meses: '17',
          anio: 2026,
          estado: 'APARTADA',
          folio: null,
          motivo: MOTIVO_BIMESTRAL_FILA_APARTADA,
          complementariaDe: null,
        },
      ],
    })
  })

  it('🔴 ronda 1 (I1, m5 y preocupación 2 de la T11): aparte van también la diagnóstica, la rechazada en definitiva y la complementaria pendiente de una principal de otra periodicidad', async () => {
    const base = filaEnviadaIncierta('k-bim')
    const diag = { ...base, status: 'VALIDATION_FAILED', enviadoAt: null, lastError: 'no cuadra', folio: null }
    const rechazada = {
      ...base,
      id: 'g-rech',
      status: 'STAMP_FAILED',
      falloDefinitivo: true,
      lastError: 'El SAT rechazó: CFDI40147',
      folio: null,
    }
    const comp = {
      ...filaEnviadaIncierta('k-bim-c2'),
      id: 'g-bim-c2',
      enviadoAt: null,
      lastError: null,
      folio: null,
      entrada: { ...base.entrada, complementariaDe: 'g-bim' },
    }
    const d = deps({
      loadEmisor: emisorCon('MENSUAL', '601'),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue(null),
      globalesDeOtraPeriodicidad: jest.fn().mockResolvedValue([diag, rechazada, comp]),
    })
    const r = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(r.periodos.every(p => p.meses !== '17')).toBe(true)
    expect(r.otrasPeriodicidades.globales.map(g => [g.cfdiId, g.estado, g.motivo, g.complementariaDe])).toEqual([
      ['g-bim', 'DETENIDA', 'no cuadra', null],
      ['g-rech', 'RECHAZADA', 'El SAT rechazó: CFDI40147', null],
      ['g-bim-c2', 'APARTADA', MOTIVO_COMPLEMENTARIA_DEL_JOB, 'g-bim'],
    ])
    expect(r.otrasPeriodicidades.completo).toBe(true)
  })

  it('🔴 ronda 1 (I1): con más de MAX_OTRAS_PERIODICIDADES, se muestran las primeras y `completo: false`', async () => {
    const filas = Array.from({ length: MAX_OTRAS_PERIODICIDADES + 1 }, (_, i) => ({
      ...filaEnviadaIncierta(`k-bim-${i}`),
      id: `g-${i}`,
      enviadoAt: null,
      lastError: null,
      folio: null,
    }))
    const d = deps({
      loadEmisor: emisorCon('MENSUAL', '601'),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue(null),
      globalesDeOtraPeriodicidad: jest.fn().mockResolvedValue(filas),
    })
    const r = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(r.otrasPeriodicidades.globales).toHaveLength(MAX_OTRAS_PERIODICIDADES)
    expect(r.otrasPeriodicidades.completo).toBe(false)
  })

  it('control — un envío bimestral YA hecho e incierto se recupera aunque el régimen haya cambiado (la guarda no aplica a lo que ya existe ante el PAC)', async () => {
    const fila = filaEnviadaIncierta('k-bim')
    const consultarSpy = jest
      .spyOn(cfdiService, 'consultarIntentoCapturado')
      .mockResolvedValue({ status: 'valid', uuid: 'UUID-BIM', providerInvoiceId: 'fa-bim' } as any)
    const finalizarSpy = jest
      .spyOn(cfdiService, 'finalizarEmision')
      .mockResolvedValue({ status: 'STAMPED', cfdi: { ...fila, status: 'STAMPED', uuid: 'UUID-BIM' } } as any)
    try {
      const d = deps({
        loadEmisor: emisorCon('MENSUAL', '601'),
        findExistingGlobal: jest.fn().mockResolvedValue(fila),
        loadVenueSlug: jest.fn().mockResolvedValue('venue'),
        runInTransaction: noDebiaReservar(),
      })
      const r = await issueGlobalForPeriod(pedir(), d)
      expect(consultarSpy).toHaveBeenCalled()
      expect(r).toMatchObject({ status: 'STAMPED', period: bimestre, candidateCount: 2 })
      expect(d.runInTransaction).not.toHaveBeenCalled()
    } finally {
      consultarSpy.mockRestore()
      finalizarSpy.mockRestore()
    }
  })

  it('control — la fila bimestral ENVIADA que el PAC todavía no tiene sigue «en proceso»: la guarda no la disfraza de «bimestral» (lo enviado nunca se recaptura, C1-38)', async () => {
    const consultarSpy = jest.spyOn(cfdiService, 'consultarIntentoCapturado').mockResolvedValue(null)
    try {
      const d = deps({
        loadEmisor: emisorCon('MENSUAL', '601'),
        findExistingGlobal: jest.fn().mockResolvedValue(filaEnviadaIncierta('k-bim')),
        // El doble hace lo que hace el CAS real de la recaptura con una enviada INCIERTA: la pierde (sólo gana lo nunca enviado o, desde la
        // decisión A de la T11, lo rechazado en definitiva).
        runInTransaction: jest.fn().mockRejectedValue(new ConflictError(MOTIVO_EN_PROCESO)),
      })
      await expect(issueGlobalForPeriod(pedir(), d)).rejects.toThrow(MOTIVO_EN_PROCESO)
      expect(consultarSpy).toHaveBeenCalled()
    } finally {
      consultarSpy.mockRestore()
    }
  })

  it('control — con el régimen 621 la bimestral sigue su camino (llega a la reserva)', async () => {
    const d = deps({ loadEmisor: emisorCon('BIMESTRAL', '621'), runInTransaction: reservaVacia() })
    expect(await issueGlobalForPeriod(pedir(), d)).toMatchObject({ status: 'NOTHING_TO_INVOICE', period: bimestre })
    expect(d.runInTransaction).toHaveBeenCalledTimes(1)
  })

  it('control — la guarda mira el DOCUMENTO, no la configuración: un periodo MENSUAL con el emisor ya BIMESTRAL y 601 sigue su camino', async () => {
    const mayo = closedPeriodFor('MENSUAL', new Date('2026-06-03T17:00:00Z'))
    const d = deps({ loadEmisor: emisorCon('BIMESTRAL', '601'), runInTransaction: reservaVacia() })
    expect(await issueGlobalForPeriod(pedir(mayo, 'k-mayo'), d)).toMatchObject({ status: 'NOTHING_TO_INVOICE', period: mayo })
    expect(d.runInTransaction).toHaveBeenCalledTimes(1)
  })
})

// ── C1 · Tarea 10: lo que queda fuera por configuración llega al resultado; lo que se detiene sin fila deja rastro; el error crudo no sale ──
describe('C1 · Tarea 10 — `excluidas` por configuración en el resultado y el rastro de lo que se detiene', () => {
  const ahora = new Date('2026-10-05T15:00:00Z')
  const diario = { ...emisor, globalPeriodicity: 'DIARIO' }
  const recientes = periodosCerradosRecientes('DIARIO', ahora, 10)
  const masViejo = recientes[6]
  afterEach(() => jest.restoreAllMocks())
  /** Una transacción en memoria que sí corre la captura (sin candidatos: la captura vacía no lee órdenes). */
  const transaccion = () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      venue: { findUniqueOrThrow: jest.fn().mockResolvedValue({ organizationId: 'org1' }) },
      cfdi: { findUnique: jest.fn().mockResolvedValue(null) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    }
    return jest.fn(async (fn: any) => fn(tx)) as any
  }
  /** Avisos con memoria (como la base): el último por periodo. */
  const avisosEnMemoria = () => {
    const ultimos = new Map<string, any>()
    return {
      ultimoAvisoDelPeriodo: jest.fn(async (_e: any, p: any) => ultimos.get(p.periodStart.toISOString()) ?? null),
      registrarAvisoDelPeriodo: jest.fn(async (_e: any, p: any, action: string, data: any) => {
        ultimos.set(p.periodStart.toISOString(), { action, motivo: data.motivo ?? null })
      }),
    }
  }
  const soloElMasViejo = jest.fn(async (_e: string, p: any) => (mismoPeriodo(p, masViejo) ? null : { status: 'STAMPED' }))

  it('🔴 los conteos por configuración se suman a las excluidas del resultado (sin candidatos: NOTHING_TO_INVOICE con su estadística)', async () => {
    const contar = jest.fn().mockResolvedValue({ EFECTIVO: 2, SIN_TERMINAL: 3 })
    const d = deps({ contarExcluidasPorConfiguracion: contar, runInTransaction: transaccion() })
    const r = await issueGlobalForEmisor(params, d)
    expect(r).toMatchObject({ status: 'NOTHING_TO_INVOICE', candidateCount: 0, excluidasPorIvaMixto: 0 })
    expect(r.excluidas).toEqual({ EFECTIVO: 2, SIN_TERMINAL: 3 })
    // Una vez, con la misma pertenencia que los candidatos (un RFC) y sin `self` (no hay reserva), ANTES de la transacción.
    expect(contar).toHaveBeenCalledTimes(1)
    expect(contar.mock.calls[0]).toEqual([emisor, expect.objectContaining({ meses: '05', anio: 2026 }), true, undefined])
    expect(contar.mock.invocationCallOrder[0]).toBeLessThan((d.runInTransaction as jest.Mock).mock.invocationCallOrder[0])
  })

  it('🔴 con varios RFC, el conteo recibe `unSoloEmisor = false` (la misma pertenencia que los candidatos)', async () => {
    const contar = jest.fn().mockResolvedValue({ SIN_EMISOR: 1 })
    const d = deps({
      contarEmisores: jest.fn().mockResolvedValue(2),
      contarExcluidasPorConfiguracion: contar,
      runInTransaction: transaccion(),
    })
    const r = await issueGlobalForEmisor(params, d)
    expect(r.excluidas).toEqual({ SIN_EMISOR: 1 })
    expect(contar.mock.calls[0][2]).toBe(false)
    expect((d.loadGlobalCandidates as jest.Mock).mock.calls[0][2]).toBe(false)
  })

  it('🔴 un VALIDATION_FAILED SIN fila de un periodo de la pasada deja el MISMO rastro que un periodo detenido (aviso DETENIDO, sin repetir el motivo)', async () => {
    const MOTIVO = 'Una guarda del motor que no reserva nada.'
    const avisos = avisosEnMemoria()
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: soloElMasViejo,
      ...avisos,
      emitirPeriodo: jest.fn(
        async ({ period }: any) => ({ status: 'VALIDATION_FAILED', reasons: [MOTIVO], period, candidateCount: 0 }) as any,
      ),
    })
    for (let i = 0; i < 2; i++) await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(avisos.registrarAvisoDelPeriodo.mock.calls.map(c => [c[1], c[2], c[3].motivo, c[3].status])).toEqual([
      [masViejo, 'CFDI_GLOBAL_PERIODO_DETENIDO', MOTIVO, 'VALIDATION_FAILED'],
    ])
    // Y el panel lo lee como `motivo` (el mismo camino de la T8).
    const { periodos } = await periodosDeLaGlobal(
      { venueId: 'v1', emisorId: 'e1', now: ahora },
      { ...d, findGlobalDelPeriodo: jest.fn().mockResolvedValue(null) },
    )
    expect(periodos.find(p => p.desde === masViejo.periodStart.toISOString())).toMatchObject({ estado: 'SIN_GLOBAL', motivo: MOTIVO })
  })

  it('control — un VALIDATION_FAILED cuyo motivo ya quedó en su fila (`lastError` de la captura diagnóstica) no deja aviso: el panel lo lee de la fila', async () => {
    const avisos = avisosEnMemoria()
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: soloElMasViejo,
      ...avisos,
      emitirPeriodo: jest.fn(
        async ({ period }: any) =>
          ({
            status: 'VALIDATION_FAILED',
            reasons: ['no cuadra', 'otra'],
            cfdi: { id: 'g', status: 'VALIDATION_FAILED', lastError: 'no cuadra | otra' },
            period,
          }) as any,
      ),
    })
    await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(avisos.registrarAvisoDelPeriodo).not.toHaveBeenCalled()
  })

  it('🔴 un periodo detenido que vuelve a avanzar (timbrada, o diagnóstica con su motivo en la fila) queda «reanudado»: el aviso viejo no tapa a la fila', async () => {
    for (const r of [
      { status: 'STAMPED', cfdi: { id: 'g', lastError: null } },
      { status: 'VALIDATION_FAILED', reasons: ['no cuadra'], cfdi: { id: 'g', status: 'VALIDATION_FAILED', lastError: 'no cuadra' } },
    ]) {
      const avisos = avisosEnMemoria()
      await avisos.registrarAvisoDelPeriodo(null, masViejo, 'CFDI_GLOBAL_PERIODO_DETENIDO', { motivo: 'viejo' })
      avisos.registrarAvisoDelPeriodo.mockClear()
      const d = deps({
        loadEmisor: jest.fn().mockResolvedValue(diario),
        loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
        findGlobalDelPeriodo: soloElMasViejo,
        ...avisos,
        emitirPeriodo: jest.fn(async ({ period }: any) => ({ ...r, period }) as any),
      })
      await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
      expect([r.status, avisos.registrarAvisoDelPeriodo.mock.calls.map(c => c[2])]).toEqual([r.status, ['CFDI_GLOBAL_PERIODO_REANUDADO']])
    }
  })

  it('🔴 el panel: un periodo SIN_TIMBRAR cuyo último aviso es DETENIDO muestra ese motivo; si ya se reanudó, el `lastError` de su fila', async () => {
    const ps = periodosCerradosRecientes('DIARIO', ahora)
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) =>
        mismoPeriodo(p, ps[0]) || mismoPeriodo(p, ps[1])
          ? { id: 'g', fiscalEmisorId: 'e1', status: 'STAMPING', lastError: 'de la fila', updatedAt: new Date('2026-10-05T10:00:00Z') }
          : null,
      ),
      ultimoAvisoDelPeriodo: jest.fn(async (_e: any, p: any) =>
        mismoPeriodo(p, ps[0])
          ? { action: 'CFDI_GLOBAL_PERIODO_DETENIDO', motivo: 'del aviso', createdAt: new Date('2026-10-05T11:00:00Z') }
          : { action: 'CFDI_GLOBAL_PERIODO_REANUDADO', motivo: null, createdAt: new Date('2026-10-05T11:00:00Z') },
      ),
    })
    const { periodos } = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(periodos.slice(0, 2).map(p => [p.estado, p.motivo])).toEqual([
      ['SIN_TIMBRAR', 'del aviso'],
      ['SIN_TIMBRAR', 'de la fila'],
    ])
  })

  it('🔴 ronda 1 (I2): un aviso DETENIDO VIEJO no tapa un rechazo NUEVO del PAC: el panel muestra el motivo de la fila', async () => {
    const ps = periodosCerradosRecientes('DIARIO', ahora)
    // 04:00: la pasada truena (aviso con el texto genérico); 09:00: el barrido confirma el rechazo y escribe el motivo del SAT en la fila.
    const fila = {
      id: 'g',
      fiscalEmisorId: 'e1',
      status: 'STAMP_FAILED',
      falloDefinitivo: true,
      lastError: 'El SAT rechazó: CFDI40147',
      updatedAt: new Date('2026-10-05T09:00:00Z'),
    }
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => (mismoPeriodo(p, ps[0]) ? fila : null)),
      ultimoAvisoDelPeriodo: jest.fn(async (_e: any, p: any) =>
        mismoPeriodo(p, ps[0])
          ? { action: 'CFDI_GLOBAL_PERIODO_DETENIDO', motivo: MOTIVO_ERROR_DEL_PERIODO, createdAt: new Date('2026-10-05T04:00:00Z') }
          : null,
      ),
    })
    const { periodos } = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect([periodos[0].estado, periodos[0].motivo]).toEqual(['SIN_TIMBRAR', 'El SAT rechazó: CFDI40147'])
  })

  it('🔴 ronda 1 (I1): un periodo cuyas fechas siguen apartadas en una global de OTRA periodicidad no se captura: su motivo, sin reservar ni cargar candidatos', async () => {
    const apartada = { id: 'g-bim', status: 'STAMPING', enviadoAt: null }
    const d = deps({ globalApartadaQueCubre: jest.fn().mockResolvedValue(apartada), runInTransaction: transaccion() })
    const r = await issueGlobalForEmisor(params, d)
    expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_PERIODO_CUBIERTO], candidateCount: 0, excluidas: {} })
    expect(r.cfdi).toBeUndefined()
    expect((d.globalApartadaQueCubre as jest.Mock).mock.calls[0]).toEqual(['e1', expect.objectContaining({ meses: '05', anio: 2026 })])
    expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
    expect(d.runInTransaction).not.toHaveBeenCalled()
  })

  it('🔴 ronda 1 (I1 + I2 b): con su propia fila nunca enviada, el motivo queda en la fila; sin global apartada, sigue su camino', async () => {
    const propia = {
      id: 'g-may',
      venueId: 'v1',
      fiscalEmisorId: 'e1',
      status: 'STAMPING',
      protocoloIva: 1,
      enviadoAt: null,
      attempts: 1,
      lastError: null,
      entrada: null,
    }
    const persistCfdi = jest.fn().mockResolvedValue({ ...propia, lastError: MOTIVO_PERIODO_CUBIERTO })
    const d = deps({
      findExistingGlobal: jest.fn().mockResolvedValue(propia),
      globalApartadaQueCubre: jest.fn().mockResolvedValue({ id: 'g-bim' }),
      persistCfdi,
      // Si llegara a reservar (sin la guarda), lo dice en vez de tronar con un doble incompleto.
      runInTransaction: jest.fn().mockRejectedValue(new Error('llegó a reservar')),
    })
    const r = await issueGlobalForPeriod({ ...params, period: closedPeriodFor('MENSUAL', params.now), key: 'k-may' }, d).catch(e => ({
      lanzo: e.message,
    }))
    expect(r).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: [MOTIVO_PERIODO_CUBIERTO],
      cfdi: { lastError: MOTIVO_PERIODO_CUBIERTO },
    })
    expect(persistCfdi).toHaveBeenCalledWith(
      { lastError: MOTIVO_PERIODO_CUBIERTO },
      { id: 'g-may', status: 'STAMPING', attempts: 1, enviadoAt: null },
    )
    // control: sin global apartada que la cubra, el mismo periodo llega a la reserva.
    const libre = deps({ runInTransaction: transaccion() })
    expect(await issueGlobalForEmisor(params, libre)).toMatchObject({ status: 'NOTHING_TO_INVOICE' })
  })

  it('🔴 N1: un error de base (no ConflictError) guarda y devuelve el texto genérico; el detalle crudo sólo va al logger.error', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger)
    const crudo = "Invalid `prisma.order.findMany()` invocation: Can't reach database server at `db.interno:5432`"
    const avisos = avisosEnMemoria()
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([]),
      findGlobalDelPeriodo: soloElMasViejo,
      ...avisos,
      emitirPeriodo: jest
        .fn()
        .mockRejectedValue(new Prisma.PrismaClientKnownRequestError(crudo, { code: 'P1001', clientVersion: '6.19.3' })),
    })
    const { resultados } = await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    expect(resultados.find(r => r.status === 'ERROR')).toMatchObject({ reason: MOTIVO_ERROR_DEL_PERIODO, period: masViejo })
    expect(JSON.stringify(resultados)).not.toMatch(/prisma|db\.interno/i)
    expect(avisos.registrarAvisoDelPeriodo.mock.calls.map(c => [c[2], c[3].motivo, c[3].status])).toEqual([
      ['CFDI_GLOBAL_PERIODO_DETENIDO', MOTIVO_ERROR_DEL_PERIODO, 'ERROR'],
    ])
    expect(error.mock.calls.some(c => String(c[0]).includes(crudo))).toBe(true)
    // El panel muestra el texto genérico (el que guardó el aviso).
    const { periodos } = await periodosDeLaGlobal(
      { venueId: 'v1', emisorId: 'e1', now: ahora },
      { ...d, findGlobalDelPeriodo: jest.fn().mockResolvedValue(null) },
    )
    expect(periodos.find(p => p.desde === masViejo.periodStart.toISOString())?.motivo).toBe(MOTIVO_ERROR_DEL_PERIODO)
  })
})

// ── C1 · Tarea 11: la global COMPLEMENTARIA (C1-P7, C1-P12; Codex C1-24, C1-29) y la decisión A del founder (la rechazada se reintenta sola) ──
import {
  llaveDeComplementaria,
  siguienteComplementaria,
  MAX_COMPLEMENTARIAS,
  MOTIVO_COMPLEMENTARIA_DEL_JOB,
} from '../../../../src/services/fiscal/cfdiGlobal.service'
import { esLlaveComplementaria, llavePrincipalDe } from '../../../../src/services/fiscal/exclusionGlobal'
import { MOTIVO_ANIO_FUERA } from '../../../../src/services/fiscal/globalPeriod'

describe('C1 · Tarea 11 — la global complementaria (unitarias)', () => {
  const P = 'cfdi-global-e1-2026-09-04'
  const AHORA = new Date('2026-10-05T15:00:00Z')
  const PERIODO = closedPeriodFor('MENSUAL', AHORA) // septiembre de 2026, el de la llave P
  const fila = (n: number, status: string, extra: object = {}) => ({
    idempotencyKey: `${P}-c${n}`,
    status,
    falloDefinitivo: false,
    enviadoAt: null,
    ...extra,
  })
  /** Un ticket todo al 16 % con IVA incluido y sin `lineas` (la forma de C1): cuadra exacto, sin ajustes. */
  const ticket = (orderId: string, paidCents: number) => {
    const o = {
      orderId,
      folio: `F-${orderId}`,
      formaPago: '04',
      paidCents,
      renglones: [{ orderItemId: `${orderId}-i`, tratamiento: 'IVA_16' }],
      porTratamiento: { IVA_16: paidCents },
      conceptosReales: null,
      filasD16: [] as string[][],
    }
    const huella = huellaDeEntrada({
      renglones: o.renglones,
      porTratamiento: o.porTratamiento,
      lineas: null,
      conceptosReales: o.conceptosReales,
      folio: o.folio,
      formaPago: o.formaPago,
      filasD16: o.filasD16,
    })
    return { ...o, huella }
  }
  /** Una fila v2 VÁLIDA (la que guarda `capturarGlobal`: un ticket de $116, cuadre ok) con la llave, el estado y la `complementariaDe` dados. */
  function filaV2Con(o: {
    idempotencyKey: string
    complementariaDe?: string
    status?: string
    enviadoAt?: Date | null
    falloDefinitivo?: boolean
    periodo?: ReturnType<typeof closedPeriodFor>
  }) {
    const per = o.periodo ?? PERIODO
    const ordenes = [ticket('t1', 11600)]
    const base = paramsDeLaGlobal({ lugarExpedicion: '83000' }, ordenes as any, per)
    const c = cuadrarLaGlobal(base.items, 11600, {
      cobradoPorTasa: { IVA_16: 11600 },
      filasD16: sumarFilasD16(ordenes.map(x => filasD16DeOrdenGlobal(x as any))),
    })
    if (!c.ok) throw new Error('el ayudante debía cuadrar')
    const entrada = {
      version: 2,
      tipo: 'GLOBAL',
      fiscalEmisorId: 'e1',
      globalPeriod: { periodicidad: per.satPeriodicidad, meses: per.meses, anio: per.anio },
      periodo: { desde: per.periodStart.toISOString(), hasta: per.periodEnd.toISOString() },
      montos: c.montos,
      excluidas: {},
      excluidasPorIvaMixto: 0,
      ordenes,
      formaDelMezclado: 'UN_CONCEPTO',
      cuadre: { ok: true },
      ajustes: c.ajustes,
      params: { ...base, items: c.items },
      ...(o.complementariaDe ? { complementariaDe: o.complementariaDe } : {}),
    }
    return {
      id: `g-${o.idempotencyKey}`,
      idempotencyKey: o.idempotencyKey,
      status: o.status ?? 'STAMPING',
      protocoloIva: 1,
      enviadoAt: o.enviadoAt ?? null,
      falloDefinitivo: o.falloDefinitivo ?? false,
      attempts: 1,
      facturapiId: null,
      uuid: null,
      lastError: null as string | null,
      venueId: 'v1',
      fiscalEmisorId: 'e1',
      globalPeriod: entrada.globalPeriod,
      entrada,
      entradaHuella: huellaDeEntrada(entrada),
      ...c.montos,
    }
  }
  /** Una reserva que SÍ corre (si el motor llega a reservar, la prueba lo ve: «nada que facturar»). */
  const reservaVacia = () => jest.fn().mockResolvedValue({ cfdi: null, fresh: true, reasons: [], empty: true, excluded: 0, excluidas: {} })
  const pedir = (key: string, extra: Record<string, unknown> = {}) => ({
    emisorId: 'e1',
    now: AHORA,
    sandbox: true,
    period: PERIODO,
    key,
    ...extra,
  })
  const factura = { providerInvoiceId: 'pac-1', uuid: 'UUID-PAC', status: 'valid' as const, serie: 'F', folio: '9' }
  /** Espías del transporte del PAC (la consulta por identidad y la finalización); se restauran en `finally`. */
  function espias(consulta: () => Promise<any>) {
    const consultar = jest.spyOn(cfdiService, 'consultarIntentoCapturado').mockImplementation(consulta)
    const finalizar = jest
      .spyOn(cfdiService, 'finalizarEmision')
      .mockImplementation(async (c: any) => ({ status: 'STAMPED', cfdi: { ...c, status: 'STAMPED', uuid: 'UUID-PAC' } }) as any)
    return { consultar, finalizar, restaurar: () => (consultar.mockRestore(), finalizar.mockRestore()) }
  }

  it('la llave y la siguiente', () => {
    expect(llaveDeComplementaria(P, 2)).toBe(`${P}-c2`)
    expect(siguienteComplementaria(P, [])).toBe(`${P}-c2`)
    expect(siguienteComplementaria(P, [fila(2, 'STAMPED'), fila(3, 'CANCELLED')])).toBe(`${P}-c4`)
  })
  it('🔴 una sin terminar se reutiliza (nunca dos a la vez); una anulada sin enviar no cuenta como sin terminar', () => {
    expect(siguienteComplementaria(P, [fila(2, 'STAMPED'), fila(3, 'VALIDATION_FAILED')])).toBe(`${P}-c3`)
    expect(siguienteComplementaria(P, [fila(2, 'STAMP_FAILED', { falloDefinitivo: true, enviadoAt: null })])).toBe(`${P}-c3`)
  })
  it('🔴 decisión A: una ENVIADA y rechazada en definitiva cuenta como sin terminar (se reintenta ella, nunca se salta a la siguiente n)', () => {
    const rechazada = fila(2, 'STAMP_FAILED', { falloDefinitivo: true, enviadoAt: new Date('2026-10-02T10:00:00Z') })
    expect(siguienteComplementaria(P, [rechazada])).toBe(`${P}-c2`)
  })
  it('🔴 una complementaria con su cancelación en trámite es un documento timbrado: cuenta como terminada', () => {
    expect(siguienteComplementaria(P, [fila(2, 'CANCEL_REQUESTED')])).toBe(`${P}-c3`)
  })
  it('🔴 C1-29: el tope es de 20 complementarias: con 19 (c2…c20) sale la 20.ª (c21); con 20 (c2…c21), null', () => {
    const terminadas = (k: number) => Array.from({ length: k }, (_, i) => fila(i + 2, 'STAMPED'))
    expect(siguienteComplementaria(P, terminadas(MAX_COMPLEMENTARIAS - 1))).toBe(`${P}-c21`)
    expect(siguienteComplementaria(P, terminadas(MAX_COMPLEMENTARIAS))).toBeNull()
  })
  it('🔴 la llave de una complementaria se reconoce exacta, y de ella sale la de su principal (nunca de una principal)', () => {
    expect([`${P}-c2`, `${P}-c21`, 'cfdi-global-e1-2026-10-01-20261003-c2'].map(esLlaveComplementaria)).toEqual([true, true, true])
    expect(
      [P, 'cfdi-global-e1-2026-10-01-20261003', 'cfdi-global-e1-2026-10-01', `${P}-c`, `${P}-cx`, null].map(esLlaveComplementaria),
    ).toEqual([false, false, false, false, false, false])
    expect(llavePrincipalDe(`${P}-c12`)).toBe(P)
    expect(llavePrincipalDe(P)).toBeNull()
  })
  it('🔴 leerGlobal: `complementariaDe` sólo con llave `-c<n>`, y una llave `-c<n>` siempre la trae', () => {
    expect(() => leerGlobal(filaV2Con({ idempotencyKey: P, complementariaDe: 'cfdi-p' }))).toThrow(/complementaria/)
    expect(() => leerGlobal(filaV2Con({ idempotencyKey: `${P}-c2` }))).toThrow(/complementaria/)
    expect(leerGlobal(filaV2Con({ idempotencyKey: `${P}-c2`, complementariaDe: 'cfdi-p' }))).toMatchObject({ complementariaDe: 'cfdi-p' })
    expect(leerGlobal(filaV2Con({ idempotencyKey: P }))).not.toHaveProperty('complementariaDe') // control: la principal
  })

  describe('el job nunca emite una complementaria (C1-24): sin `complementariaDe` explícito sólo se recupera lo ya enviado', () => {
    it('🔴 C1-24: sin `complementariaDe` explícito (la pasada del job), una complementaria SIN ENVIAR no se captura ni se envía', async () => {
      const d = deps({
        findExistingGlobal: jest
          .fn()
          .mockResolvedValue(filaV2Con({ idempotencyKey: `${P}-c2`, complementariaDe: 'cfdi-p', status: 'VALIDATION_FAILED' })),
        runInTransaction: reservaVacia(), // si el motor llegara a reservar, la prueba lo vería
      })
      expect(await issueGlobalForPeriod(pedir(`${P}-c2`), d)).toMatchObject({
        status: 'SKIPPED',
        reason: expect.stringMatching(/una persona/),
      })
      expect(d.runInTransaction).not.toHaveBeenCalled()
      expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
    })
    it('🔴 sin fila todavía: la llave `-c<n>` sola basta para no reservar', async () => {
      const d = deps({ runInTransaction: reservaVacia() })
      expect(await issueGlobalForPeriod(pedir(`${P}-c3`), d)).toMatchObject({ status: 'SKIPPED', reason: MOTIVO_COMPLEMENTARIA_DEL_JOB })
      expect(d.runInTransaction).not.toHaveBeenCalled()
      expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
    })
    it('🔴 ENVIADA e incierta: el job sólo la consulta por su identidad y, si el PAC la tiene, la termina (sin reservar)', async () => {
      const e = espias(async () => factura)
      try {
        const enviada = filaV2Con({ idempotencyKey: `${P}-c2`, complementariaDe: 'cfdi-p', enviadoAt: new Date('2026-10-02T10:00:00Z') })
        const d = deps({
          findExistingGlobal: jest.fn().mockResolvedValue(enviada),
          loadVenueSlug: jest.fn().mockResolvedValue('venue'),
          runInTransaction: reservaVacia(),
        })
        expect(await issueGlobalForPeriod(pedir(`${P}-c2`), d)).toMatchObject({ status: 'STAMPED', period: PERIODO })
        expect(e.consultar).toHaveBeenCalledTimes(1)
        expect(e.finalizar).toHaveBeenCalledTimes(1)
        expect(d.runInTransaction).not.toHaveBeenCalled()
        expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
      } finally {
        e.restaurar()
      }
    })
    it('🔴 ENVIADA y rechazada en definitiva: el job la consulta, pero NO la recaptura (espera a la persona)', async () => {
      const e = espias(async () => null) // el PAC confirma que `key#1` no existe
      try {
        const rechazada = filaV2Con({
          idempotencyKey: `${P}-c2`,
          complementariaDe: 'cfdi-p',
          status: 'STAMP_FAILED',
          enviadoAt: new Date('2026-10-02T10:00:00Z'),
          falloDefinitivo: true,
        })
        const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(rechazada), runInTransaction: reservaVacia() })
        expect(await issueGlobalForPeriod(pedir(`${P}-c2`), d)).toMatchObject({ status: 'SKIPPED', reason: MOTIVO_COMPLEMENTARIA_DEL_JOB })
        expect(e.consultar).toHaveBeenCalledTimes(1)
        expect(d.runInTransaction).not.toHaveBeenCalled()
      } finally {
        e.restaurar()
      }
    })
    it('control — con `complementariaDe` (la persona), la complementaria sin enviar sí llega a la reserva', async () => {
      const d = deps({
        findExistingGlobal: jest
          .fn()
          .mockResolvedValue(filaV2Con({ idempotencyKey: `${P}-c2`, complementariaDe: 'cfdi-p', status: 'VALIDATION_FAILED' })),
        runInTransaction: reservaVacia(),
      })
      await issueGlobalForPeriod(pedir(`${P}-c2`, { complementariaDe: 'cfdi-p' }), d)
      expect(d.runInTransaction).toHaveBeenCalledTimes(1)
    })
    it('🔴 `complementariaDe` con una llave que no es de complementaria, o distinta a la de la fila ⇒ nada se reserva', async () => {
      const d = deps({ runInTransaction: reservaVacia() })
      await expect(issueGlobalForPeriod(pedir(P, { complementariaDe: 'cfdi-p' }), d)).rejects.toThrow(/complementaria/)
      const ajena = deps({
        findExistingGlobal: jest
          .fn()
          .mockResolvedValue(filaV2Con({ idempotencyKey: `${P}-c2`, complementariaDe: 'otra-principal', status: 'VALIDATION_FAILED' })),
        runInTransaction: reservaVacia(),
      })
      await expect(issueGlobalForPeriod(pedir(`${P}-c2`, { complementariaDe: 'cfdi-p' }), ajena)).rejects.toThrow(/soporte/)
      expect(d.runInTransaction).not.toHaveBeenCalled()
      expect(ajena.runInTransaction).not.toHaveBeenCalled()
    })
  })

  describe('🔴 decisión A del founder (7-oct): una global ENVIADA y rechazada en definitiva se reintenta sola', () => {
    it('control — ola final (O2 de la re-revisión 1 de la T7): la decisión A sólo consulta al PAC lo ENVIADO: una rechazada en definitiva con `enviadoAt: null` (anulada sin enviar) y una diagnóstica se recapturan sin preguntarle', async () => {
      const e = espias(async () => {
        throw new Error('no se debía consultar al PAC')
      })
      try {
        for (const f of [
          filaV2Con({ idempotencyKey: P, status: 'STAMP_FAILED', falloDefinitivo: true, enviadoAt: null }),
          filaV2Con({ idempotencyKey: P, status: 'VALIDATION_FAILED' }),
        ]) {
          const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(f), runInTransaction: reservaVacia() })
          await expect(issueGlobalForPeriod(pedir(P), d)).resolves.toMatchObject({ period: PERIODO })
          expect(d.runInTransaction).toHaveBeenCalledTimes(1) // se recapturó
          expect(d.resolveProvider).not.toHaveBeenCalled()
        }
        expect(e.consultar).not.toHaveBeenCalled()
      } finally {
        e.restaurar()
      }
    })
    const rechazada = () =>
      filaV2Con({ idempotencyKey: P, status: 'STAMP_FAILED', enviadoAt: new Date('2026-10-02T10:00:00Z'), falloDefinitivo: true })
    it('🔴 primero se consulta al PAC por la identidad del intento anterior: si la tiene (UUID), se finaliza sin reenviar ni recapturar', async () => {
      const e = espias(async () => factura)
      try {
        const d = deps({
          findExistingGlobal: jest.fn().mockResolvedValue(rechazada()),
          loadVenueSlug: jest.fn().mockResolvedValue('venue'),
          runInTransaction: reservaVacia(),
        })
        expect(await issueGlobalForPeriod(pedir(P), d)).toMatchObject({ status: 'STAMPED' })
        expect(e.consultar).toHaveBeenCalledTimes(1)
        expect(d.runInTransaction).not.toHaveBeenCalled()
      } finally {
        e.restaurar()
      }
    })
    it('🔴 el PAC no responde ⇒ «procesando», sin recapturar ni reenviar', async () => {
      const e = espias(async () => {
        throw new ConflictError(MOTIVO_EN_PROCESO)
      })
      try {
        const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(rechazada()), runInTransaction: reservaVacia() })
        await expect(issueGlobalForPeriod(pedir(P), d)).rejects.toThrow(MOTIVO_EN_PROCESO)
        expect(d.runInTransaction).not.toHaveBeenCalled()
        expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
      } finally {
        e.restaurar()
      }
    })
    it('🔴 el PAC confirma que no existe ⇒ se recaptura (llega a la reserva) DESPUÉS de consultar', async () => {
      const orden: string[] = []
      const e = espias(async () => (orden.push('consulta'), null))
      try {
        const d = deps({
          findExistingGlobal: jest.fn().mockResolvedValue(rechazada()),
          runInTransaction: jest.fn(async () => (orden.push('reserva'), { cfdi: null, fresh: true, reasons: [], empty: true })) as any,
        })
        await issueGlobalForPeriod(pedir(P), d)
        expect(orden).toEqual(['consulta', 'reserva'])
      } finally {
        e.restaurar()
      }
    })
  })

  describe('el año del periodo (C1-33, C1-37): el de la emisión o el anterior; la guarda va DESPUÉS de recuperar', () => {
    const nov2024 = closedPeriodFor('MENSUAL', new Date('2024-12-03T17:00:00Z'))
    const llave2024 = 'cfdi-global-e1-2024-11-04'
    it('🔴 sin fila: SKIPPED con el motivo, sin reservar ni leer candidatos', async () => {
      const d = deps({ runInTransaction: reservaVacia(), persistCfdi: jest.fn() })
      expect(await issueGlobalForPeriod({ ...pedir(llave2024), period: nov2024 }, d)).toMatchObject({
        status: 'SKIPPED',
        reason: MOTIVO_ANIO_FUERA,
        period: nov2024,
      })
      expect(d.runInTransaction).not.toHaveBeenCalled()
      expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
      expect(d.persistCfdi).not.toHaveBeenCalled()
    })
    it('🔴 C1-37: una fila NUNCA enviada conserva su estado y gana el motivo (CAS con `enviadoAt: null`)', async () => {
      const f = filaV2Con({ idempotencyKey: llave2024, status: 'VALIDATION_FAILED', periodo: nov2024 })
      const persistCfdi = jest.fn().mockResolvedValue({ ...f, lastError: MOTIVO_ANIO_FUERA })
      const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(f), runInTransaction: reservaVacia(), persistCfdi })
      expect(await issueGlobalForPeriod({ ...pedir(llave2024), period: nov2024 }, d)).toMatchObject({
        status: 'SKIPPED',
        reason: MOTIVO_ANIO_FUERA,
      })
      expect(persistCfdi).toHaveBeenCalledWith(
        { lastError: MOTIVO_ANIO_FUERA },
        { id: f.id, status: 'VALIDATION_FAILED', attempts: f.attempts, enviadoAt: null },
      )
      expect(d.runInTransaction).not.toHaveBeenCalled()
    })
    it('🔴 C1-33: un intento ya ENVIADO se recupera por su identidad aunque el año ya no se admita', async () => {
      const e = espias(async () => factura)
      try {
        const enviada = filaV2Con({ idempotencyKey: llave2024, enviadoAt: new Date('2024-12-03T18:00:00Z'), periodo: nov2024 })
        const d = deps({
          findExistingGlobal: jest.fn().mockResolvedValue(enviada),
          loadVenueSlug: jest.fn().mockResolvedValue('venue'),
          runInTransaction: reservaVacia(),
        })
        expect(await issueGlobalForPeriod({ ...pedir(llave2024), period: nov2024 }, d)).toMatchObject({ status: 'STAMPED' })
        expect(e.consultar).toHaveBeenCalledTimes(1)
      } finally {
        e.restaurar()
      }
    })
    it('🔴 una ENVIADA y rechazada de 2024 que el PAC no tiene: no se recaptura (año fuera) y su fila no se escribe (ya se envió)', async () => {
      const e = espias(async () => null)
      try {
        const f = filaV2Con({
          idempotencyKey: llave2024,
          status: 'STAMP_FAILED',
          enviadoAt: new Date('2024-12-03T18:00:00Z'),
          falloDefinitivo: true,
          periodo: nov2024,
        })
        const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(f), runInTransaction: reservaVacia(), persistCfdi: jest.fn() })
        expect(await issueGlobalForPeriod({ ...pedir(llave2024), period: nov2024 }, d)).toMatchObject({
          status: 'SKIPPED',
          reason: MOTIVO_ANIO_FUERA,
        })
        expect(d.runInTransaction).not.toHaveBeenCalled()
        expect(d.persistCfdi).not.toHaveBeenCalled()
      } finally {
        e.restaurar()
      }
    })
  })

  describe('la pasada del job y el panel', () => {
    it('🔴 decisión A: si el reintento del job vuelve a ser rechazado en definitiva, el periodo queda DETENIDO con el motivo del PAC', async () => {
      const motivoDelPac = 'CFDI40999 - El SAT rechazó el comprobante.'
      const f = filaV2Con({ idempotencyKey: P, status: 'STAMP_FAILED', enviadoAt: new Date('2026-10-02T10:00:00Z'), falloDefinitivo: true })
      const registrarAvisoDelPeriodo = jest.fn().mockResolvedValue(undefined)
      const d = deps({
        loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([f]),
        findGlobalDelPeriodo: jest.fn().mockResolvedValue(f),
        registrarAvisoDelPeriodo,
        emitirPeriodo: jest.fn(
          async ({ period }: any) =>
            ({ status: 'STAMP_FAILED', cfdi: { ...f, lastError: motivoDelPac, falloDefinitivo: true }, period }) as any,
        ),
      })
      await emitirGlobalesPendientes({ emisorId: 'e1', now: AHORA, sandbox: true }, d)
      expect(registrarAvisoDelPeriodo.mock.calls.map(c => [c[2], c[3].motivo, c[3].status])).toEqual([
        ['CFDI_GLOBAL_PERIODO_DETENIDO', motivoDelPac, 'STAMP_FAILED'],
      ])
    })
    it('control — un STAMP_FAILED incierto (no definitivo) no detiene el periodo', async () => {
      const f = filaV2Con({ idempotencyKey: P, status: 'STAMP_FAILED', enviadoAt: new Date('2026-10-02T10:00:00Z') })
      const registrarAvisoDelPeriodo = jest.fn().mockResolvedValue(undefined)
      const d = deps({
        loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([f]),
        findGlobalDelPeriodo: jest.fn().mockResolvedValue(f),
        registrarAvisoDelPeriodo,
        emitirPeriodo: jest.fn(
          async ({ period }: any) => ({ status: 'STAMP_FAILED', cfdi: { ...f, lastError: 'ETIMEDOUT' }, period }) as any,
        ),
      })
      await emitirGlobalesPendientes({ emisorId: 'e1', now: AHORA, sandbox: true }, d)
      expect(registrarAvisoDelPeriodo).not.toHaveBeenCalled()
    })
    it('🔴 el panel: complementarias y «cuántas entrarían» sólo de una principal TIMBRADA o CANCELADA (una en cancelación lista las suyas)', async () => {
      const ps = periodosCerradosRecientes('DIARIO', AHORA)
      const principal = (i: number, status: string) => ({
        id: `g${i}`,
        idempotencyKey: `k${i}`,
        fiscalEmisorId: 'e1',
        status,
        protocoloIva: 1,
        folio: `${i}`,
      })
      const filas = new Map<string, any>([
        [ps[0].periodStart.toISOString(), principal(0, 'STAMPED')],
        [ps[1].periodStart.toISOString(), principal(1, 'CANCELLED')],
        [ps[2].periodStart.toISOString(), principal(2, 'CANCEL_REQUESTED')],
        [ps[3].periodStart.toISOString(), principal(3, 'VALIDATION_FAILED')],
      ])
      const complementarias = jest.fn(async (p: any) =>
        p.id === 'g3'
          ? []
          : [
              {
                id: `${p.id}-c2`,
                idempotencyKey: `${p.idempotencyKey}-c2`,
                status: 'STAMPED',
                falloDefinitivo: false,
                enviadoAt: null,
                folio: '20',
              },
              {
                id: `${p.id}-c3`,
                idempotencyKey: `${p.idempotencyKey}-c3`,
                status: 'VALIDATION_FAILED',
                falloDefinitivo: false,
                enviadoAt: null,
                folio: null,
                lastError: 'no cuadra',
              },
            ],
      )
      const contar = jest.fn(async (_e: any, q: any) => ({
        n: q.periodStart.getTime() === ps[0].periodStart.getTime() ? 3 : 0,
        completo: true,
      }))
      const d = deps({
        loadEmisor: jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity: 'DIARIO' }),
        findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => filas.get(p.periodStart.toISOString()) ?? null),
        complementariasDe: complementarias,
        contarCorregidasPendientes: contar,
      })
      const { periodos } = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: AHORA }, d)
      expect(
        periodos.slice(0, 5).map(p => [p.estado, p.corregidasPendientes, p.complementarias.map(c => [c.cfdiId, c.folio, c.estado])]),
      ).toEqual([
        [
          'TIMBRADA',
          { n: 3, completo: true },
          [
            ['g0-c2', '20', 'TIMBRADA'],
            ['g0-c3', null, 'SIN_TIMBRAR'],
          ],
        ],
        [
          'CANCELADA',
          { n: 0, completo: true },
          [
            ['g1-c2', '20', 'TIMBRADA'],
            ['g1-c3', null, 'SIN_TIMBRAR'],
          ],
        ],
        [
          'TIMBRADA',
          null,
          [
            ['g2-c2', '20', 'TIMBRADA'],
            ['g2-c3', null, 'SIN_TIMBRAR'],
          ],
        ],
        ['SIN_TIMBRAR', null, []],
        ['SIN_GLOBAL', null, []],
      ])
      // «Cuántas entrarían» sólo donde se puede emitir la complementaria, con UNA cuenta de RFC del negocio.
      expect(contar).toHaveBeenCalledTimes(2)
      // Ronda 1 (I4): con la abierta nunca enviada (`-c3`, diagnóstica) como `self`; (m2) su motivo, y nada en la timbrada.
      expect(contar.mock.calls.map(x => (x as unknown[])[3])).toEqual(['g0-c3', 'g1-c3'])
      expect(periodos[0].complementarias[1]).toEqual({ cfdiId: 'g0-c3', folio: null, estado: 'SIN_TIMBRAR', motivo: 'no cuadra' })
      expect(periodos[0].complementarias[0]).not.toHaveProperty('motivo')
      expect(d.contarEmisores).toHaveBeenCalledTimes(1)
    })
  })

  // 🔴 Ola final (I2 de la revisión final): la guarda de lectura de la diagnóstica no deja el periodo en «revisión de soporte».
  describe('ola final (I2): una diagnóstica que ya no pasa el lector se recaptura, no se detiene', () => {
    it('🔴 su entrada ya no valida (la 6b cambió o la tocaron) ⇒ aviso en el log y RECAPTURA, sin «revisión de soporte»', async () => {
      const diag = filaV2Con({ idempotencyKey: P, status: 'VALIDATION_FAILED' })
      const yaNoValida = { ...diag, entradaHuella: 'huella-que-ya-no-corresponde' }
      expect(() => leerGlobal(yaNoValida, 'DIAGNOSTICO')).toThrow(/soporte/) // control: el lector la rechaza
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
      try {
        const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(yaNoValida), runInTransaction: reservaVacia() })
        await expect(issueGlobalForPeriod(pedir(P), d)).resolves.toMatchObject({ period: PERIODO })
        expect(d.runInTransaction).toHaveBeenCalledTimes(1) // llegó a recapturar (bajo candados, desde las órdenes)
        expect(d.loadGlobalCandidates).toHaveBeenCalledWith(expect.anything(), PERIODO, true, yaNoValida.id) // la fila es `self`
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`diagnóstica ${yaNoValida.id} .*no pasa el lector.*se recaptura`)),
        )
      } finally {
        warn.mockRestore()
      }
    })
    it('control — la diagnóstica que sí pasa el lector recaptura igual, sin aviso', async () => {
      const diag = filaV2Con({ idempotencyKey: P, status: 'VALIDATION_FAILED' })
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
      try {
        const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(diag), runInTransaction: reservaVacia() })
        await expect(issueGlobalForPeriod(pedir(P), d)).resolves.toMatchObject({ period: PERIODO })
        expect(d.runInTransaction).toHaveBeenCalledTimes(1)
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no pasa el lector'))
      } finally {
        warn.mockRestore()
      }
    })
    it('control — una RESERVADA sin enviar (STAMPING) cuya entrada no pasa el lector no cambia: la guarda es sólo para la diagnóstica', async () => {
      const reservada = { ...filaV2Con({ idempotencyKey: P, status: 'STAMPING' }), entradaHuella: 'huella-que-ya-no-corresponde' }
      const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(reservada), runInTransaction: reservaVacia() })
      // Nunca se envió: se recaptura sin leerla (T8, re-revisión de la T7 a). Lo que sí lee su entrada es el envío, en PARA_ENVIAR.
      await expect(issueGlobalForPeriod(pedir(P), d)).resolves.toMatchObject({ period: PERIODO })
      expect(d.runInTransaction).toHaveBeenCalledTimes(1)
    })
  })
})

// ── C1 · Tarea 11, ronda 1 (I1, I2, I4, m2, m4 de `task-11-review.md`) ──
describe('C1 · Tarea 11, ronda 1 — lector con llave, panel y salida temprana', () => {
  const AHORA = new Date('2026-10-05T15:00:00Z')
  it('🔴 I2: `leerGlobal` sin `idempotencyKey` en la fila es un error de PROGRAMACIÓN (nunca «revisión de soporte»), aun para una principal', () => {
    let error: unknown
    try {
      leerGlobal({ fiscalEmisorId: 'e1', entrada: { version: 2 } })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ConflictError)
    expect(String((error as Error)?.message)).toMatch(/idempotencyKey/)
  })
  it('🔴 m4: la salida temprana del motor con la llave YA timbrada lo dice (`yaTimbrada`), para no auditarla como emisión nueva', async () => {
    const c = { id: 'g1', venueId: 'v1', fiscalEmisorId: 'e1', status: 'STAMPED', idempotencyKey: 'k', entrada: {} }
    const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(c) })
    expect(await issueGlobalForEmisor(params, d)).toMatchObject({ status: 'STAMPED', yaTimbrada: true })
  })
  it('🔴 I1 + I4 + m2: el panel no ofrece complementaria de una principal HEREDADA timbrada; cuenta con la abierta SIN enviar (`self`); motivo de la no timbrada', async () => {
    const ps = periodosCerradosRecientes('DIARIO', AHORA)
    const filas = new Map<string, any>([
      [ps[0].periodStart.toISOString(), { id: 'g0', idempotencyKey: 'k0', fiscalEmisorId: 'e1', status: 'STAMPED', protocoloIva: 1 }],
      [ps[1].periodStart.toISOString(), { id: 'g1', idempotencyKey: 'k1', fiscalEmisorId: 'e1', status: 'STAMPED', protocoloIva: null }],
      [ps[2].periodStart.toISOString(), { id: 'g2', idempotencyKey: 'k2', fiscalEmisorId: 'e1', status: 'STAMPED', protocoloIva: 1 }],
    ])
    const c = (p: any, status: string, enviadoAt: Date | null, lastError: string | null) => ({
      id: `${p.id}-c2`,
      idempotencyKey: `${p.idempotencyKey}-c2`,
      status,
      falloDefinitivo: false,
      enviadoAt,
      folio: null,
      lastError,
    })
    const complementariasDe = jest.fn(async (p: any) =>
      p.id === 'g0'
        ? [c(p, 'STAMPING', null, null)] // reservada y nunca enviada: sus ventas cuentan
        : p.id === 'g2'
          ? [c(p, 'STAMP_FAILED', new Date('2026-10-02T10:00:00Z'), 'CFDI40999 rechazo')] // enviada: no se retoma su reserva
          : [],
    )
    const contar = jest.fn().mockResolvedValue({ n: 2, completo: true })
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity: 'DIARIO' }),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => filas.get(p.periodStart.toISOString()) ?? null),
      complementariasDe,
      contarCorregidasPendientes: contar,
    })
    const { periodos } = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: AHORA }, d)
    expect(periodos.slice(0, 3).map(p => p.corregidasPendientes)).toEqual([{ n: 2, completo: true }, null, { n: 2, completo: true }])
    // I4: `self` = la complementaria abierta SIN enviar (su reserva se recapturaría); la enviada no.
    expect(contar.mock.calls.map(x => x[3])).toEqual(['g0-c2', undefined])
    // m2: la no timbrada trae su motivo.
    expect(periodos[2].complementarias).toEqual([{ cfdiId: 'g2-c2', folio: null, estado: 'SIN_TIMBRAR', motivo: 'CFDI40999 rechazo' }])
  })
})

// ── C1 · Tarea 10, ronda 2: la vista previa aplica la misma guarda (N1), cuenta con `self` (N1 de la T11), la cola deja ver su aviso (N2) y
// `completo` no cuenta lo saltado (N5 b) ──
import prismaDoble from '../../../../src/utils/prismaClient'
import {
  motivoDePeriodoCubierto,
  vistaPreviaComplementaria,
  vistaPreviaPrincipal,
  MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL,
} from '../../../../src/services/fiscal/cfdiGlobal.service'

describe('C1 · Tarea 10, ronda 2', () => {
  const ahoraJunio = new Date('2026-06-03T17:00:00Z')
  const desdeMayo = '2026-05-01T06:00:00.000Z'
  afterEach(() => jest.restoreAllMocks())

  it('🔴 N1: la vista previa de la PRINCIPAL (MCP) dice el motivo de periodo cubierto, como el motor que la rechazaría', async () => {
    const d = deps({ globalApartadaQueCubre: jest.fn().mockResolvedValue({ id: 'g-bim' }) })
    const v = await vistaPreviaPrincipal({ venueId: 'v1', emisorId: 'e1', desde: desdeMayo, now: ahoraJunio }, d)
    expect(v).toMatchObject({ estado: 'SIN_GLOBAL', motivo: MOTIVO_PERIODO_CUBIERTO })
    expect((d.globalApartadaQueCubre as jest.Mock).mock.calls[0]).toEqual(['e1', expect.objectContaining({ meses: '05', anio: 2026 })])
  })

  it('control — N1: sin global que la cubra, la vista previa no inventa motivo', async () => {
    const v = await vistaPreviaPrincipal({ venueId: 'v1', emisorId: 'e1', desde: desdeMayo, now: ahoraJunio }, deps())
    expect(v.motivo).toBeNull()
  })

  it('🔴 N1 de la T11: con la principal reservada y nunca enviada, la vista previa cuenta CON `self` (sus propias ventas entrarían)', async () => {
    const reservada = { id: 'g-may', fiscalEmisorId: 'e1', status: 'STAMPING', enviadoAt: null }
    const d = deps({ findGlobalDelPeriodo: jest.fn().mockResolvedValue(reservada) })
    await vistaPreviaPrincipal({ venueId: 'v1', emisorId: 'e1', desde: desdeMayo, now: ahoraJunio }, d)
    expect((d.contarCorregidasPendientes as jest.Mock).mock.calls[0][3]).toBe('g-may')
    // control: la enviada no pasa `self` (si el PAC la tiene, sus ventas no entran a otra).
    const enviada = deps({ findGlobalDelPeriodo: jest.fn().mockResolvedValue({ ...reservada, enviadoAt: new Date() }) })
    await vistaPreviaPrincipal({ venueId: 'v1', emisorId: 'e1', desde: desdeMayo, now: ahoraJunio }, enviada)
    expect((enviada.contarCorregidasPendientes as jest.Mock).mock.calls[0][3]).toBeUndefined()
  })

  it('🔴 N1: la vista previa de la COMPLEMENTARIA también dice el motivo de periodo cubierto', async () => {
    const principal = {
      id: 'g-may',
      venueId: 'v1',
      fiscalEmisorId: 'e1',
      isGlobal: true,
      type: 'INGRESO',
      status: 'STAMPED',
      protocoloIva: 1,
      idempotencyKey: 'cfdi-global-e1-2026-05-04',
      globalPeriod: { periodicidad: '04', meses: '05', anio: 2026 },
      entrada: null,
    }
    jest.spyOn(prismaDoble.cfdi, 'findFirst').mockResolvedValue(principal as any)
    const d = deps({ globalApartadaQueCubre: jest.fn().mockResolvedValue({ id: 'g-bim' }) })
    const v = await vistaPreviaComplementaria({ venueId: 'v1', emisorId: 'e1', principalId: 'g-may', now: ahoraJunio }, d)
    expect(v.motivo).toBe(MOTIVO_PERIODO_CUBIERTO)
  })

  it('🔴 N2: una fila de la COLA que se detiene deja ver su motivo en el panel (la cola la mueve ANTES del aviso)', async () => {
    const diario = { ...emisor, globalPeriodicity: 'DIARIO' }
    const ahora = new Date('2026-10-05T15:00:00Z')
    const p = periodosCerradosRecientes('DIARIO', ahora)[2]
    // Un reloj de la prueba: cada escritura (aviso o «tocar» la fila) toma la siguiente marca, en el orden en que ocurre.
    let reloj = Date.parse('2026-10-05T15:00:00Z')
    // La fila de la cola, con su periodo demostrable (entrada v2 con `periodo`, la que lee `periodoDeLaFila`).
    const fila: any = {
      id: 'g-dia',
      idempotencyKey: 'k-dia',
      fiscalEmisorId: 'e1',
      status: 'STAMPING',
      enviadoAt: null,
      lastError: null,
      updatedAt: new Date(reloj),
      globalPeriod: { periodicidad: p.satPeriodicidad, meses: p.meses, anio: p.anio },
      entrada: { version: 2, periodo: { desde: p.periodStart.toISOString(), hasta: p.periodEnd.toISOString() } },
    }
    const ultimos = new Map<string, any>()
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(diario),
      loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([fila]),
      findGlobalDelPeriodo: jest.fn(async (_e: string, q: any) => (mismoPeriodo(q, p) ? fila : { status: 'STAMPED' })),
      emitirPeriodo: jest.fn().mockRejectedValue(new Error('se cayó la base')),
      tocarPendiente: jest.fn(async (f: any) => {
        f.updatedAt = new Date(++reloj)
      }),
      ultimoAvisoDelPeriodo: jest.fn(async (_e: any, q: any) => ultimos.get(q.periodStart.toISOString()) ?? null),
      registrarAvisoDelPeriodo: jest.fn(async (_e: any, q: any, action: string, data: any) => {
        ultimos.set(q.periodStart.toISOString(), { action, motivo: data.motivo ?? null, createdAt: new Date(++reloj) })
      }),
    })
    jest.spyOn(logger, 'error').mockImplementation(() => logger)
    await emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
    const { periodos } = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(periodos.find(x => x.desde === p.periodStart.toISOString())).toMatchObject({
      estado: 'SIN_TIMBRAR',
      motivo: MOTIVO_ERROR_DEL_PERIODO,
    })
  })

  // 🔴 Ola final (N2-bis de la re-revisión 2 de la T10): con el MISMO desenlace cada día, la deduplicación del aviso dejaba el del día 1 más
  // viejo que la fila (la cola la vuelve a mover) y el panel volvía a `motivo: null` (o al `lastError` viejo) desde la 2.ª pasada.
  describe('ola final (N2-bis): la fila de la cola detenida sigue diciendo su motivo en las pasadas siguientes', () => {
    const diario = { ...emisor, globalPeriodicity: 'DIARIO' }
    const ahora = new Date('2026-10-05T15:00:00Z')
    const p = periodosCerradosRecientes('DIARIO', ahora)[2]
    /** La cola de UNA fila con dos pasadas, el reloj de la prueba y la deduplicación REAL del aviso (`ultimoAvisoDelPeriodo` en memoria). */
    function armar(fila: any, emitirPeriodo: jest.Mock, laColaMueveLaFila = true) {
      let reloj = Date.parse('2026-10-05T15:00:00Z')
      const ultimos = new Map<string, any>()
      const registrar = jest.fn(async (_e: any, q: any, action: string, data: any) => {
        ultimos.set(q.periodStart.toISOString(), { action, motivo: data.motivo ?? null, createdAt: new Date(++reloj) })
      })
      const d = deps({
        loadEmisor: jest.fn().mockResolvedValue(diario),
        loadGlobalesSinTimbrar: jest.fn().mockResolvedValue([fila]),
        findGlobalDelPeriodo: jest.fn(async (_e: string, q: any) => (mismoPeriodo(q, p) ? fila : { status: 'STAMPED' })),
        emitirPeriodo,
        // El contrato de la ola final: «tocar» devuelve la marca con la que movió la fila (null si el intento la escribió).
        tocarPendiente: jest.fn(async (f: any) => {
          if (!laColaMueveLaFila) return null
          f.updatedAt = new Date(++reloj)
          return f.updatedAt
        }),
        ultimoAvisoDelPeriodo: jest.fn(async (_e: any, q: any) => ultimos.get(q.periodStart.toISOString()) ?? null),
        registrarAvisoDelPeriodo: registrar,
      })
      const pasada = () => emitirGlobalesPendientes({ emisorId: 'e1', now: ahora, sandbox: true }, d)
      const motivoEnElPanel = async () =>
        (await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)).periodos.find(
          x => x.desde === p.periodStart.toISOString(),
        )
      return { pasada, motivoEnElPanel, registrar }
    }
    const filaDeLaCola = (extra: object = {}): any => ({
      id: 'g-dia',
      idempotencyKey: 'k-dia',
      fiscalEmisorId: 'e1',
      status: 'STAMPING',
      enviadoAt: null,
      lastError: null,
      updatedAt: new Date('2026-10-05T15:00:00Z'),
      globalPeriod: { periodicidad: p.satPeriodicidad, meses: p.meses, anio: p.anio },
      entrada: { version: 2, periodo: { desde: p.periodStart.toISOString(), hasta: p.periodEnd.toISOString() } },
      ...extra,
    })

    it('🔴 ERROR dos días seguidos ⇒ el día 2 el panel sigue diciendo el motivo (no `null`)', async () => {
      jest.spyOn(logger, 'error').mockImplementation(() => logger)
      const { pasada, motivoEnElPanel, registrar } = armar(filaDeLaCola(), jest.fn().mockRejectedValue(new Error('se cayó la base')))
      await pasada()
      expect(await motivoEnElPanel()).toMatchObject({ estado: 'SIN_TIMBRAR', motivo: MOTIVO_ERROR_DEL_PERIODO })
      await pasada()
      expect(await motivoEnElPanel()).toMatchObject({ estado: 'SIN_TIMBRAR', motivo: MOTIVO_ERROR_DEL_PERIODO })
      expect(registrar).toHaveBeenCalledTimes(2) // un aviso por pasada en que la cola movió la fila (acotado por la página de 10)
    })

    it('🔴 la RECHAZADA en definitiva frenada por una guarda (su `lastError` no se puede escribir): el día 2 manda la guarda, no el rechazo viejo', async () => {
      const rechazada = filaDeLaCola({
        status: 'STAMP_FAILED',
        falloDefinitivo: true,
        enviadoAt: new Date('2026-10-04T10:00:00Z'),
        lastError: 'El SAT rechazó: CFDI40147',
      })
      const guarda = jest.fn(async () => ({ status: 'VALIDATION_FAILED', cfdi: rechazada, reasons: ['TEXTO DE LA GUARDA'] }))
      const { pasada, motivoEnElPanel } = armar(rechazada, guarda)
      await pasada()
      expect(await motivoEnElPanel()).toMatchObject({ motivo: 'TEXTO DE LA GUARDA' })
      await pasada()
      expect(await motivoEnElPanel()).toMatchObject({ motivo: 'TEXTO DE LA GUARDA' })
    })

    it('control — si la fila YA dice el motivo en su `lastError`, no se repite el aviso (el panel lo lee de la fila)', async () => {
      const dice = filaDeLaCola({ lastError: 'TEXTO DE LA GUARDA' })
      const guarda = jest.fn(async () => ({ status: 'VALIDATION_FAILED', cfdi: dice, reasons: ['TEXTO DE LA GUARDA'] }))
      const { pasada, motivoEnElPanel, registrar } = armar(dice, guarda)
      await pasada()
      await pasada()
      expect(registrar).toHaveBeenCalledTimes(1)
      expect(await motivoEnElPanel()).toMatchObject({ motivo: 'TEXTO DE LA GUARDA' })
    })

    it('control — si «tocar» no movió la fila (devuelve null), el aviso se sigue deduplicando: uno solo en dos pasadas', async () => {
      jest.spyOn(logger, 'error').mockImplementation(() => logger)
      const { pasada, registrar } = armar(filaDeLaCola(), jest.fn().mockRejectedValue(new Error('se cayó la base')), false)
      await pasada()
      await pasada()
      expect(registrar).toHaveBeenCalledTimes(1)
    })
  })

  // 🔴 Ola final (T1, T2 y nits de la re-revisión 2 de la T10): los textos de las guardas dicen la verdad del caso.
  describe('ola final (T1, T2, nits): los textos de las guardas dicen la verdad', () => {
    const ahora = new Date('2026-10-05T15:00:00Z')
    const dia = periodosCerradosRecientes('DIARIO', ahora)[4] // el 30 de septiembre (dentro de septiembre)
    const septiembre = closedPeriodFor('MENSUAL', ahora)
    const contenedora = (periodicidad: string, meses: string) => ({
      id: `g-${periodicidad}`,
      status: 'STAMPING',
      enviadoAt: null,
      globalPeriod: { periodicidad, meses, anio: 2026 },
    })
    const emitir = (e: object, period: any, cubre: object) =>
      issueGlobalForPeriod(
        { emisorId: 'e1', now: ahora, sandbox: true, period, key: 'k' },
        deps({ loadEmisor: jest.fn().mockResolvedValue({ ...emisor, ...e }), globalApartadaQueCubre: jest.fn().mockResolvedValue(cubre) }),
      )

    it('🔴 T1 (DIARIO→MENSUAL): la diaria vieja espera a la MENSUAL de hoy ⇒ el texto dice «de tu periodicidad actual», no «de cuando tenía otra»', async () => {
      const r = await emitir({ globalPeriodicity: 'MENSUAL' }, dia, contenedora('04', '09'))
      expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL] })
    })
    it('🔴 T1 (MENSUAL→BIMESTRAL): el mes viejo espera a la BIMESTRAL de hoy ⇒ el mismo texto', async () => {
      const r = await emitir({ globalPeriodicity: 'BIMESTRAL', regimenFiscal: '621' }, septiembre, contenedora('05', '15'))
      expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL] })
    })
    it('control — T1: la que espera es la de HOY y la que la cubre es de cuando el RFC tenía otra ⇒ el texto de siempre', async () => {
      const r = await emitir({ globalPeriodicity: 'DIARIO' }, dia, contenedora('04', '09'))
      expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_PERIODO_CUBIERTO] })
    })
    it('🔴 T1: la regla sola (la usan el motor y las dos vistas previas)', () => {
      expect(motivoDePeriodoCubierto({ globalPeriodicity: 'MENSUAL' }, contenedora('04', '09'))).toBe(MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL)
      expect(motivoDePeriodoCubierto({ globalPeriodicity: 'DIARIO' }, contenedora('04', '09'))).toBe(MOTIVO_PERIODO_CUBIERTO)
      expect(motivoDePeriodoCubierto({ globalPeriodicity: 'MENSUAL' }, { id: 'sin-periodo' })).toBe(MOTIVO_PERIODO_CUBIERTO) // sin dato: el de siempre
      expect(MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL).not.toMatch(/Otras periodicidades|tenía otra/)
    })
    it('🔴 T2: la bimestral descartada no promete lo que la ventana no cumple (lo viejo se pide a soporte)', () => {
      for (const t of [MOTIVO_BIMESTRAL_CAPTURA_DESCARTADA, MOTIVO_BIMESTRAL_RECHAZADA_DESCARTADA]) {
        expect(t).toMatch(/periodos que todavía se revisan solos/)
        expect(t).toMatch(/más viejas.*soporte/)
      }
    })
    it('🔴 nit: la vista previa de una principal HEREDADA (`protocoloIva: null`) no dice «periodo cubierto»: el motor la manda a su camino viejo, sin esa guarda', async () => {
      const heredada = { id: 'g-vieja', fiscalEmisorId: 'e1', status: 'STAMPING', enviadoAt: null, protocoloIva: null }
      const d = deps({
        findGlobalDelPeriodo: jest.fn().mockResolvedValue(heredada),
        globalApartadaQueCubre: jest.fn().mockResolvedValue(contenedora('05', '15')),
      })
      const v = await vistaPreviaPrincipal({ venueId: 'v1', emisorId: 'e1', desde: septiembre.periodStart.toISOString(), now: ahora }, d)
      expect(v.motivo).toBeNull()
      expect(d.globalApartadaQueCubre).not.toHaveBeenCalled()
    })
  })

  it('🔴 N5 b: `completo` no cuenta las filas que se saltan (sin periodo demostrable): se pide la página siguiente', async () => {
    // Bimestrales viejas (su periodo sale de `globalPeriod`) y una diaria vieja de llave corta, que no se puede demostrar y se salta.
    const valida = (i: number) => ({
      id: `g-${i}`,
      idempotencyKey: `k-${i}-05`,
      fiscalEmisorId: 'e1',
      status: 'STAMPING',
      enviadoAt: null,
      lastError: null,
      createdAt: new Date(1000 - i),
      globalPeriod: { periodicidad: '05', meses: '13', anio: 2026 },
      entrada: null,
    })
    const sinPeriodo = {
      ...valida(99),
      id: 'g-sin-periodo',
      idempotencyKey: 'k-99-01',
      globalPeriod: { periodicidad: '01', meses: '01', anio: 2026 },
    }
    const pagina1 = [...Array.from({ length: MAX_OTRAS_PERIODICIDADES }, (_, i) => valida(i)), sinPeriodo]
    const otras = jest.fn().mockResolvedValueOnce(pagina1).mockResolvedValueOnce([])
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue(emisor),
      findGlobalDelPeriodo: jest.fn().mockResolvedValue(null),
      globalesDeOtraPeriodicidad: otras,
    })
    const r = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahoraJunio }, d)
    expect(r.otrasPeriodicidades.globales).toHaveLength(MAX_OTRAS_PERIODICIDADES)
    expect(r.otrasPeriodicidades.completo).toBe(true)
    expect(otras.mock.calls[1][2]).toEqual({ createdAt: pagina1.at(-1)!.createdAt, id: 'g-sin-periodo' })
  })
})

// ── Ola final (Minor 2 de la revisión final): el `endsWith` de `globalesSinTimbrar` y `esLlaveViejaCorta` dicen lo mismo ──
import { PERIODICIDADES_CORTAS, SUFIJOS_DE_LLAVE_VIEJA_CORTA } from '../../../../src/services/fiscal/cfdiGlobal.service'

describe('ola final (Minor 2): la llave vieja corta se reconoce igual en SQL y en memoria', () => {
  const terminaComoVieja = (k: string) => SUFIJOS_DE_LLAVE_VIEJA_CORTA.some(fin => k.endsWith(fin))
  it('control — ninguna llave NUEVA (de cualquier periodicidad, ni su complementaria) termina como una vieja corta: el `where` nunca descarta una', () => {
    const ahora = new Date('2026-12-31T12:00:00Z')
    for (const periodicidad of ['DIARIO', 'SEMANAL', 'QUINCENAL', 'MENSUAL', 'BIMESTRAL'] as const)
      for (const p of periodosCerradosRecientes(periodicidad, ahora, 40)) {
        const llave = llaveDeLaGlobal('e1', p)
        expect([llave, terminaComoVieja(llave)]).toEqual([llave, false])
        expect(terminaComoVieja(llaveDeComplementaria(llave, 2))).toBe(false)
      }
  })
  it('control — toda llave vieja corta que reconoce `esLlaveViejaCorta` termina con uno de los sufijos del `where`', () => {
    for (const periodicidad of PERIODICIDADES_CORTAS) {
      const fila = {
        idempotencyKey: `cfdi-global-e1-2026-09-${periodicidad}`,
        globalPeriod: { periodicidad, meses: '09', anio: 2026 },
        fiscalEmisorId: 'e1',
      }
      expect(esLlaveViejaCorta(fila)).toBe(true)
      expect(terminaComoVieja(fila.idempotencyKey)).toBe(true)
    }
  })
})

// Ronda QA (hermanos): en el panel de periodos, una global (principal, complementaria o de otra periodicidad) que quedó EN DUDA no enseña el
// error crudo del PAC («fetch failed») como su motivo: dice que no hubo respuesta clara y que no se re-emita, y lo marca con `timbreEnDuda`.
describe('ronda QA (hermanos) — periodosDeLaGlobal con un timbre EN DUDA', () => {
  const ahora = new Date('2026-10-05T15:00:00Z')
  const enDuda = {
    status: 'STAMP_FAILED',
    protocoloIva: 1,
    enviadoAt: new Date('2026-10-04T10:00:00Z'),
    falloDefinitivo: false,
    lastError: 'fetch failed',
  }
  const TEXTO = /^No hubo respuesta clara del PAC: la factura global/
  it('🔴 la principal SIN_TIMBRAR en duda ⇒ motivo neutro y `timbreEnDuda`; una rechazada conserva su motivo y no lo trae', async () => {
    const ps = periodosCerradosRecientes('DIARIO', ahora)
    const filas = new Map<string, any>([
      [ps[0].periodStart.toISOString(), { id: 'g0', fiscalEmisorId: 'e1', folio: null, ...enDuda }],
      [
        ps[1].periodStart.toISOString(),
        { id: 'g1', fiscalEmisorId: 'e1', folio: null, ...enDuda, falloDefinitivo: true, lastError: 'CFDI40999' },
      ],
    ])
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity: 'DIARIO' }),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) => filas.get(p.periodStart.toISOString()) ?? null),
      ultimoAvisoDelPeriodo: jest.fn().mockResolvedValue(null),
    })
    const { periodos } = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(periodos[0].motivo).toMatch(TEXTO)
    expect(periodos[0]).toMatchObject({ estado: 'SIN_TIMBRAR', timbreEnDuda: true })
    expect(periodos[1]).toMatchObject({ estado: 'SIN_TIMBRAR', motivo: 'CFDI40999' })
    expect(periodos[1]).not.toHaveProperty('timbreEnDuda')
  })
  it('🔴 una complementaria en duda de una principal timbrada ⇒ motivo neutro y `timbreEnDuda`', async () => {
    const ps = periodosCerradosRecientes('DIARIO', ahora)
    const principal = {
      id: 'g0',
      fiscalEmisorId: 'e1',
      status: 'STAMPED',
      protocoloIva: 1,
      folio: '12',
      idempotencyKey: 'k',
      lastError: null,
    }
    const d = deps({
      loadEmisor: jest.fn().mockResolvedValue({ ...emisor, globalPeriodicity: 'DIARIO' }),
      findGlobalDelPeriodo: jest.fn(async (_e: string, p: any) =>
        p.periodStart.toISOString() === ps[0].periodStart.toISOString() ? principal : null,
      ),
      complementariasDe: jest.fn(async (p: any) => (p.id === 'g0' ? [{ id: 'c1', idempotencyKey: 'k-c1', folio: null, ...enDuda }] : [])),
      ultimoAvisoDelPeriodo: jest.fn().mockResolvedValue(null),
    })
    const { periodos } = await periodosDeLaGlobal({ venueId: 'v1', emisorId: 'e1', now: ahora }, d)
    expect(periodos[0].complementarias).toEqual([
      { cfdiId: 'c1', folio: null, estado: 'SIN_TIMBRAR', motivo: expect.stringMatching(TEXTO), timbreEnDuda: true },
    ])
  })
})
