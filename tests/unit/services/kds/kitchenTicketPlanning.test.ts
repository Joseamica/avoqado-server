/**
 * Etapa 3 del KDS (spec 2026-09-27 §1-§2): qué comandas de pantalla deben existir para una orden, y su FOLIO.
 * Pura: la misma cuenta que hará la caja antes de sincronizar tiene que dar el mismo folio aquí.
 */
import { KITCHEN_STALENESS_MS, originKeyFor, planKitchenTickets, type KitchenLine } from '@/services/kds/kitchenTicketPlanning'

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
const base = { coveredLineIds: new Set<string>(), routing, screens, stampedAt: T0, soloSinEnviar: false }

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
    expect(planKitchenTickets({ ...base, coveredLineIds: new Set(['a']), order: venta, lines })).toEqual([])
  })

  it('borrón y cuenta nueva: lo anterior a prender la pantalla, o de hace más de 12 h, no sale', () => {
    const viejo = linea({ id: 'viejo', createdAt: new Date(since.getTime() - 1000) })
    expect(planKitchenTickets({ ...base, order: venta, lines: [viejo] })).toEqual([])
    const tarde = linea({ id: 'tarde', createdAt: new Date(T0.getTime() - KITCHEN_STALENESS_MS - 1) })
    const desdeSiempre = [{ id: 'cocina', since: new Date(0) }]
    expect(planKitchenTickets({ ...base, screens: desdeSiempre, order: venta, lines: [tarde] })).toEqual([])
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
