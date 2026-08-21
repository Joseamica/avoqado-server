/**
 * El contrato de FORMA de `KdsOrderItem.modifiers`.
 *
 * 🔴 Por qué existe este archivo: la columna la escriben DOS productores —el POS
 * (`createKdsOrder`) y la ingesta de marketplace (`deliveryOrderIngestion`)— y hasta el
 * 2026-08-20 cada uno guardaba una forma distinta: el POS `["Sin cebolla"]`, delivery
 * `[{"name":"Extra queso","quantity":1}]`. El lector sólo hacía `JSON.parse` y reenviaba,
 * así que la diferencia llegaba entera a la cocina: Android pintaba el JSON crudo y iOS
 * fallaba el cast a `[String]` y **perdía el modificador en silencio**. Verificado en una
 * Sunmi D3 con un pedido real de Uber.
 *
 * Un modificador perdido es un platillo mal servido. Por eso el test afirma sobre la
 * salida de `listKdsOrders` —el punto EXACTO donde el cliente lee— y no sobre la escritura:
 * el test de ingesta que ya existía sí tenía un modificador en su fixture y pasaba, porque
 * afirmaba sobre `OrderItem` y nunca sobre la tabla que mira la cocina.
 */
const mockPrisma: any = {
  kdsOrder: { findMany: jest.fn() },
  // `listKdsOrders` consulta también las ventas ligadas para saber cuáles pedidos de
  // delivery falta aceptar (`needsAcceptance`). Sin este mock, la llamada revienta antes
  // de llegar a lo que este archivo prueba, que son los MODIFICADORES.
  order: { findMany: jest.fn().mockResolvedValue([]) },
}

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))

import { listKdsOrders, toKdsModifierLabels } from '../../../../src/services/mobile/kds.mobile.service'

const VENUE = 'venue_1'

const fila = (modifiers: string | null) => ({
  id: 'kds_1',
  orderNumber: '101',
  orderType: 'DINE_IN',
  orderId: 'ord_1',
  status: 'NEW',
  startedAt: null,
  completedAt: null,
  createdAt: new Date('2026-08-20T18:00:00.000Z'),
  items: [{ id: 'it_1', productName: 'Hamburguesa', quantity: 1, modifiers, notes: null }],
})

const modificadoresDe = async (guardado: string | null): Promise<string[]> => {
  mockPrisma.kdsOrder.findMany.mockResolvedValue([fila(guardado)])
  const [orden] = await listKdsOrders(VENUE)
  return orden.items[0].modifiers
}

beforeEach(() => jest.clearAllMocks())

describe('KdsOrderItem.modifiers — una sola forma para los dos productores', () => {
  it('lo que escribe el POS se lee tal cual', async () => {
    expect(await modificadoresDe('["Sin cebolla","Extra queso"]')).toEqual(['Sin cebolla', 'Extra queso'])
  })

  it('lo que escribió la ingesta de delivery se lee como texto, no como JSON', async () => {
    expect(await modificadoresDe('[{"name":"Extra queso","quantity":1}]')).toEqual(['Extra queso'])
  })

  it('un modificador repetido dice cuántos, porque la cocina tiene que preparar esa cantidad', async () => {
    expect(await modificadoresDe('[{"name":"Extra queso","quantity":3}]')).toEqual(['3x Extra queso'])
  })

  it('sin modificadores devuelve lista vacía', async () => {
    expect(await modificadoresDe(null)).toEqual([])
  })

  it('una fila corrupta NO tumba el tablero entero — se pierde ese modificador, no las 30 comandas', async () => {
    await expect(modificadoresDe('{esto no es json')).resolves.toEqual([])
  })
})

describe('toKdsModifierLabels — el normalizador que comparten ambos productores', () => {
  it('acepta la forma del POS', () => {
    expect(toKdsModifierLabels(['Sin cebolla'])).toEqual(['Sin cebolla'])
  })

  it('acepta la forma del proveedor de delivery', () => {
    expect(toKdsModifierLabels([{ name: 'Extra queso', quantity: 1 }])).toEqual(['Extra queso'])
  })

  it('descarta lo que no tiene nombre en vez de escribir "undefined" en la comanda', () => {
    expect(toKdsModifierLabels([{ name: '  ', quantity: 1 }, '', 'Bien cocido'] as any)).toEqual(['Bien cocido'])
  })

  it('null y undefined dan lista vacía', () => {
    expect(toKdsModifierLabels(null)).toEqual([])
    expect(toKdsModifierLabels(undefined)).toEqual([])
  })
})
