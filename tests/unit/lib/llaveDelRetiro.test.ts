import { centavosDelRetiro, llaveDelRetiro } from '@/lib/llaveDelRetiro'

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

describe('centavosDelRetiro (H2: llave y registro salen del mismo número)', () => {
  it.each([
    [2.675, 268],
    ['26.75', 2675],
    [50, 5000],
    [0.1 + 0.2, 30],
  ])('%p → %p centavos', (amount, cents) => {
    expect(centavosDelRetiro(amount)).toBe(cents)
  })
  it.each([[0], [-5], ['abc'], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY], [0.001]])('%p → null', amount => {
    expect(centavosDelRetiro(amount)).toBeNull()
  })
})
