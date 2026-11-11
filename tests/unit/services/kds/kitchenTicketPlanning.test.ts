/**
 * Etapa 3 del KDS (spec 2026-09-27 §1-§2): qué comandas de pantalla deben existir para una orden, y su FOLIO.
 * Pura: la misma cuenta que hará la caja antes de sincronizar tiene que dar el mismo folio aquí.
 */
import {
  FOLIO_VALIDO,
  KITCHEN_STALENESS_MS,
  originKeyFor,
  planKitchenTickets,
  type KitchenLine,
} from '@/services/kds/kitchenTicketPlanning'

const T0 = new Date('2026-09-27T12:00:00Z')
const since = new Date('2026-09-27T08:00:00Z')
// cocina (default) y barra tienen pantalla; «papel» es sólo impresora.
const routing = { defaultStationId: 'cocina', activeStationIds: new Set(['cocina', 'barra', 'papel']) }
const screens = [
  { id: 'cocina', since },
  { id: 'barra', since },
]

function linea(p: Partial<KitchenLine> & { id: string }): KitchenLine {
  return {
    productId: `prod-${p.id}`,
    categoryId: 'cat',
    productStationId: null,
    categoryStationId: null,
    productName: `P ${p.id}`,
    quantity: 1,
    modifiers: [],
    notes: null,
    externalId: null,
    sentToKitchenAt: null,
    createdAt: new Date('2026-09-27T11:59:00Z'),
    ...p,
  }
}
const venta = { id: 'ord-1', externalId: 'ext-1', tableId: null }
const mesa = { id: 'ord-2', externalId: null, tableId: 'mesa-7' }
const base = { sentUnits: new Map<string, number>(), routing, screens, stampedAt: T0, soloSinEnviar: false }

describe('planKitchenTickets', () => {
  it('a combo component shares the round folio of its wrapper and normal items', () => {
    const plans = planKitchenTickets({
      ...base,
      order: mesa,
      lines: [
        linea({ id: 'normal', externalId: 'sync:r-1:0' }),
        linea({ id: 'combo-first', externalId: 'sync:r-1:1:g:g1' }),
        linea({ id: 'combo-second', externalId: 'sync:r-1:1:g:g2' }),
      ],
    })
    expect(plans.map(p => p.sourceKey)).toEqual(['round:r-1:cocina'])
    expect(plans[0].lines.map(l => l.id)).toEqual(['normal', 'combo-first', 'combo-second'])
  })

  it('mostrador: una comanda por estación con pantalla, con el folio de la venta', () => {
    const plans = planKitchenTickets({ ...base, order: venta, lines: [linea({ id: 'a' }), linea({ id: 'b', productStationId: 'barra' })] })
    expect(plans.map(p => [p.sourceKey, p.stationId, p.lines.map(l => l.id)])).toEqual([
      ['sale:ext-1:cocina', 'cocina', ['a']],
      ['sale:ext-1:barra', 'barra', ['b']],
    ])
  })

  it('lo que va a una estación de SÓLO impresora no llega a ninguna pantalla', () => {
    expect(planKitchenTickets({ ...base, order: venta, lines: [linea({ id: 'a', categoryStationId: 'papel' })] })).toEqual([])
  })

  it('sin estación y sin default: «Sin estación» (folio :none), visible en todas', () => {
    const sinDefault = { defaultStationId: null, activeStationIds: routing.activeStationIds }
    const plans = planKitchenTickets({ ...base, routing: sinDefault, order: venta, lines: [linea({ id: 'a' })] })
    expect(plans).toEqual([expect.objectContaining({ sourceKey: 'sale:ext-1:none', stationId: null })])
  })

  it('renglones ya cubiertos, de importe libre o en cantidad 0 no se vuelven a armar', () => {
    const lines = [linea({ id: 'a' }), linea({ id: 'libre', productId: null }), linea({ id: 'cero', quantity: 0 })]
    expect(planKitchenTickets({ ...base, sentUnits: new Map([['a', 1]]), order: venta, lines })).toEqual([])
  })

  it('borrón y cuenta nueva: lo anterior a prender la pantalla, o de hace más de 12 h, no sale', () => {
    const viejo = linea({ id: 'viejo', createdAt: new Date(since.getTime() - 1000) })
    expect(planKitchenTickets({ ...base, order: venta, lines: [viejo] })).toEqual([])
    const tarde = linea({ id: 'tarde', createdAt: new Date(T0.getTime() - KITCHEN_STALENESS_MS - 1) })
    const desdeSiempre = [{ id: 'cocina', since: new Date(0) }]
    expect(planKitchenTickets({ ...base, screens: desdeSiempre, order: venta, lines: [tarde] })).toEqual([])
  })

  // 🔴 R13-3 (Codex r17 #5): la edad es la de CADA artículo, no la de la cuenta. Una cuenta de 13 h con un pedido reciente fusionado
  // (el rescate tardío de su cobro de vales ya no la descarta entera): lo viejo no sale y lo reciente sí.
  it('R13-3: cuenta de hace 13 h con un artículo reciente fusionado ⇒ sólo el reciente sale', () => {
    const desdeSiempre = [{ id: 'cocina', since: new Date(0) }]
    const viejo = linea({ id: 'vale-60', createdAt: new Date(T0.getTime() - 13 * 60 * 60 * 1000) })
    const reciente = linea({ id: 'fusionado-40', createdAt: new Date(T0.getTime() - 5 * 60 * 1000) })
    const plans = planKitchenTickets({ ...base, screens: desdeSiempre, order: venta, lines: [viejo, reciente] })
    expect(plans.map(p => p.lines.map(l => l.id))).toEqual([['fusionado-40']])
  })

  it('sin estaciones con pantalla no se planea nada', () => {
    expect(planKitchenTickets({ ...base, screens: [], order: venta, lines: [linea({ id: 'a' })] })).toEqual([])
  })

  it('los renglones sin sentToKitchenAt se reportan para sellarse', () => {
    const enviado = new Date('2026-09-27T11:59:30Z')
    const [plan] = planKitchenTickets({ ...base, order: venta, lines: [linea({ id: 'a' }), linea({ id: 'b', sentToKitchenAt: enviado })] })
    expect(plan.toStamp).toEqual(['a'])
  })

  it('al PAGAR sólo se arma lo que no se mandó a cocina: las rondas ya enviadas no se repiten', () => {
    const enviado = new Date('2026-09-27T11:00:00Z')
    const lines = [linea({ id: 'ronda', sentToKitchenAt: enviado }), linea({ id: 'nuevo' })]
    const plans = planKitchenTickets({ ...base, soloSinEnviar: true, order: mesa, lines })
    expect(plans.flatMap(p => p.lines.map(l => l.id))).toEqual(['nuevo'])
  })

  // 🔴 hz:dcc49fe5:D1 — la caja funde la pieza nueva en el mismo renglón (2 cafés ya en cocina → 3): la pantalla recibe la diferencia
  // en su PROPIA comanda (la de antes pudo terminarse y salir de la pantalla), como los envíos por tanda de Square.
  describe('cantidad que sube en un renglón que ya está en una comanda', () => {
    const enviado = new Date('2026-09-27T11:30:00Z')

    it('mostrador: 2 ya en comanda y ahora 3 ⇒ una comanda nueva de 1, con su propio folio', () => {
      const lines = [linea({ id: 'cafe', quantity: 3, sentToKitchenAt: enviado })]
      const plans = planKitchenTickets({ ...base, sentUnits: new Map([['cafe', 2]]), order: venta, lines })
      expect(plans.map(p => [p.sourceKey, p.lines.map(l => [l.id, l.quantity]), p.toStamp])).toEqual([
        [`order:ord-1:mas:${T0.getTime()}:cocina`, [['cafe', 1]], []],
      ])
    })

    it('mesa: la diferencia viaja junto con lo nuevo de ese mismo envío', () => {
      const lines = [linea({ id: 'cafe', quantity: 3, sentToKitchenAt: enviado }), linea({ id: 'pan' })]
      const plans = planKitchenTickets({ ...base, sentUnits: new Map([['cafe', 2]]), order: mesa, lines })
      expect(plans.map(p => [p.sourceKey, p.lines.map(l => [l.id, l.quantity]), p.toStamp])).toEqual([
        [
          `round:ord-2:${T0.getTime()}:cocina`,
          [
            ['cafe', 1],
            ['pan', 1],
          ],
          ['pan'],
        ],
      ])
    })

    it('al COBRAR la diferencia sí sale; la ronda enviada que no tiene comanda se sigue saltando', () => {
      const lines = [linea({ id: 'cafe', quantity: 3, sentToKitchenAt: enviado }), linea({ id: 'ronda', sentToKitchenAt: enviado })]
      const plans = planKitchenTickets({ ...base, soloSinEnviar: true, sentUnits: new Map([['cafe', 2]]), order: venta, lines })
      expect(plans.flatMap(p => p.lines.map(l => [l.id, l.quantity]))).toEqual([['cafe', 1]])
    })

    it('bajar y volver a subir (3 → 2 → 3) no manda nada otra vez; subir de más manda sólo lo que falta', () => {
      const conCantidad = (quantity: number) => [linea({ id: 'cafe', quantity, sentToKitchenAt: enviado })]
      const yaTres = new Map([['cafe', 3]])
      expect(planKitchenTickets({ ...base, sentUnits: yaTres, order: venta, lines: conCantidad(2) })).toEqual([])
      expect(planKitchenTickets({ ...base, sentUnits: yaTres, order: venta, lines: conCantidad(3) })).toEqual([])
      const [plan] = planKitchenTickets({ ...base, sentUnits: yaTres, order: venta, lines: conCantidad(5) })
      expect(plan.lines.map(l => l.quantity)).toEqual([2])
    })

    // Codex r3 #1 y #2: el folio de la tanda sale del id de la cuenta, no del `externalId` que escribe el cliente: no choca con otra
    // cuenta y siempre lo acepta el receptor de LISTO sin red, por largo que sea el identificador de la venta.
    it('el folio de la tanda usa el id de la cuenta y siempre cabe en el receptor de marcas', () => {
      const estacion = 'c'.repeat(25)
      const larga = { id: 'ord-1', externalId: 'x'.repeat(160), tableId: null }
      const lines = [linea({ id: 'cafe', quantity: 3, productStationId: estacion, sentToKitchenAt: enviado })]
      const screensLargas = [{ id: estacion, since }]
      const routingLargo = { defaultStationId: estacion, activeStationIds: new Set([estacion]) }
      const entrada = { ...base, routing: routingLargo, screens: screensLargas, order: larga, lines }
      const [nueva] = planKitchenTickets({ ...entrada, sentUnits: new Map([['cafe', 2]]) })
      expect(nueva.sourceKey).toBe(`order:ord-1:mas:${T0.getTime()}:${estacion}`)
      expect(FOLIO_VALIDO.test(nueva.sourceKey)).toBe(true)
      const [original] = planKitchenTickets({ ...entrada, sentUnits: new Map() })
      expect(FOLIO_VALIDO.test(original.sourceKey)).toBe(true)
    })

    it('la diferencia sigue la estación del producto (barra)', () => {
      const barra = [linea({ id: 'limonada', quantity: 2, productStationId: 'barra', sentToKitchenAt: enviado })]
      const [plan] = planKitchenTickets({ ...base, sentUnits: new Map([['limonada', 1]]), order: venta, lines: barra })
      expect(plan.sourceKey).toBe(`order:ord-1:mas:${T0.getTime()}:barra`)
    })

    // Codex r2 #1: no se sabe cuándo se sumó la pieza (`updatedAt` cambia con cualquier reenvío del carrito): tiene la edad de su
    // renglón, como hoy. La sumada a un renglón de más de 12 h, o anterior a prender la pantalla, no sale.
    it('la pieza sumada tiene la edad de su renglón: renglón de hace 13 h o anterior a la pantalla ⇒ no sale', () => {
      const desdeSiempre = [{ id: 'cocina', since: new Date(0) }]
      const haceTrece = new Date(T0.getTime() - 13 * 60 * 60 * 1000)
      const ya = new Map([['v', 1]])
      const viejo = [linea({ id: 'v', quantity: 2, createdAt: haceTrece, sentToKitchenAt: haceTrece })]
      expect(planKitchenTickets({ ...base, screens: desdeSiempre, sentUnits: ya, order: venta, lines: viejo })).toEqual([])
      const antesDeLaPantalla = [linea({ id: 'v', quantity: 2, sentToKitchenAt: new Date(since.getTime() - 1000) })]
      expect(planKitchenTickets({ ...base, sentUnits: ya, order: venta, lines: antesDeLaPantalla })).toEqual([])
    })

    // Codex r1 #1 y r2 #2: la preparación por producto supone una fila por renglón y estación; ahí la diferencia sigue como antes.
    it('renglón con una comanda de preparación por producto: la diferencia no se parte en otra comanda', () => {
      const cafe = [linea({ id: 'p', quantity: 3, sentToKitchenAt: enviado })]
      const conTiempos = { ...base, sentUnits: new Map([['p', 2]]), preparationLineIds: new Set(['p']), order: mesa, lines: cafe }
      expect(planKitchenTickets(conTiempos)).toEqual([])
    })
  })
})

describe('originKeyFor — el origen es el mismo en la caja y en el servidor', () => {
  it('mesa con llaves sync:<roundKey>:<idx> ⇒ round:<roundKey>', () => {
    expect(originKeyFor(linea({ id: 'a', externalId: 'sync:rk-9:0' }), mesa, T0)).toBe('round:rk-9')
    expect(originKeyFor(linea({ id: 'b', externalId: 'sync:rk-9:3' }), mesa, T0)).toBe('round:rk-9')
  })

  it('mesa sin llave (app vieja o caja de Windows) ⇒ round:<orderId>:<ms del envío o del sello>', () => {
    const enviado = new Date('2026-09-27T11:00:00Z')
    expect(originKeyFor(linea({ id: 'a', sentToKitchenAt: enviado }), mesa, T0)).toBe(`round:ord-2:${enviado.getTime()}`)
    expect(originKeyFor(linea({ id: 'b' }), mesa, T0)).toBe(`round:ord-2:${T0.getTime()}`)
  })

  it('mostrador ⇒ sale:<externalId>, o order:<id> si no hay llave', () => {
    expect(originKeyFor(linea({ id: 'a' }), venta, T0)).toBe('sale:ext-1')
    expect(originKeyFor(linea({ id: 'a' }), { id: 'ord-3', externalId: null, tableId: null }, T0)).toBe('order:ord-3')
  })
})
