import { llaveDelRetiro } from '@/lib/llaveDelRetiro'

describe('llaveDelRetiro', () => {
  it.each([
    ['loc-1', 5000, 'pay-out:loc-1:500000'],
    ['loc-1', '5000', 'pay-out:loc-1:500000'],
    ['loc-1', 0.1 + 0.2, 'pay-out:loc-1:30'],
  ])('(%s, %p) → %s', (id, amount, esperado) => {
    expect(llaveDelRetiro(id, amount)).toBe(esperado)
  })

  it.each([
    [undefined, 5000],
    ['loc-1', 0],
    ['loc-1', 'abc'],
    ['', 5000],
    ['x'.repeat(65), 5000],
  ])('(%p, %p) → centinela', (id, amount) => {
    expect(llaveDelRetiro(id as any, amount)).toBe('pay-out:sin-llave')
  })
})
