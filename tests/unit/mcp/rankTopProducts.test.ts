import { rankTopProducts } from '@/mcp/tools/sales'

// `top_products` está en el catálogo CERTIFICADO del MCP (src/mcp/directory/catalog.ts): ni su comportamiento ni su salida
// cambian con las variantes. La vista por familia va en una tool nueva.
const products = [
  { id: 'a', name: 'Playera · S', type: 'REGULAR', quantity: 3, price: 299, productGroupId: 'g1', productGroupName: 'Playera' },
  { id: 'b', name: 'Playera · M', type: 'REGULAR', quantity: 4, price: 329, productGroupId: 'g1', productGroupName: 'Playera' },
  { id: 'c', name: 'Gorra', type: 'REGULAR', quantity: 5, price: 150, productGroupId: null, productGroupName: null },
]

it('🔴 dos variantes de una familia siguen siendo DOS renglones, con el nombre de cada producto', () => {
  expect(rankTopProducts(products, 10)).toEqual([
    { name: 'Gorra', unitsSold: 5, unitPrice: 150, type: 'REGULAR' },
    { name: 'Playera · M', unitsSold: 4, unitPrice: 329, type: 'REGULAR' },
    { name: 'Playera · S', unitsSold: 3, unitPrice: 299, type: 'REGULAR' },
  ])
})

it('la salida tiene exactamente name, unitsSold, unitPrice y type: ninguna llave de familia', () => {
  for (const row of rankTopProducts(products, 10)) {
    expect(Object.keys(row).sort()).toEqual(['name', 'type', 'unitPrice', 'unitsSold'])
    expect(Object.keys(row).some(k => k.startsWith('productGroup'))).toBe(false)
  }
})
