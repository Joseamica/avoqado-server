import fs from 'fs'
import path from 'path'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'

const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../../../fixtures/delivery/uber', n), 'utf8'))

describe('uber.mapper — contacto y lineId', () => {
  it('conserva el PIN del teléfono del cliente', () => {
    const n = uberAdapter.normalizeOrder(fixture('pedido-real-uapi.json'))
    expect(n.customer?.phone).toBe('+52 33 1930 9789')
    expect(n.customer?.phonePin).toBe('481 32 632')
  })

  it('cada renglón conserva su cart_item_id como lineId', () => {
    const n = uberAdapter.normalizeOrder(fixture('pedido-con-modificadores-uapi.json'))
    expect(n.items.length).toBeGreaterThan(0)
    expect(n.items.every(i => typeof i.lineId === 'string' && i.lineId.length > 0)).toBe(true)
  })
})
