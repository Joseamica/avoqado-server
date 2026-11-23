/**
 * D7 (encargo a25cd7): qué registros de la terminal son dinero que el banco YA cobró y, por eso, no se rechazan por la forma de
 * dividir de la cuenta. El recorrido contra Postgres vive en `tests/integration/payments/efectivoConTarjetaEnDuda.integration.test.ts`.
 */
import { tarjetaYaCobradaPorElBanco } from '@/services/tpv/payment.tpv.service'

describe('tarjetaYaCobradaPorElBanco', () => {
  it.each(['CREDIT_CARD', 'DEBIT_CARD'] as const)('%s completada ⇒ sí', method => {
    expect(tarjetaYaCobradaPorElBanco({ method, status: 'COMPLETED' })).toBe(true)
  })

  it.each([
    ['efectivo', 'CASH', 'COMPLETED'],
    ['transferencia declarada', 'BANK_TRANSFER', 'COMPLETED'],
    ['otro', 'OTHER', 'COMPLETED'],
    ['sin método (tipo del catálogo)', undefined, 'COMPLETED'],
    ['tarjeta fallida', 'CREDIT_CARD', 'FAILED'],
    ['tarjeta pendiente', 'DEBIT_CARD', 'PENDING'],
  ] as const)('%s ⇒ no (sigue la regla de la forma de dividir)', (_nombre, method, status) => {
    expect(tarjetaYaCobradaPorElBanco({ method, status })).toBe(false)
  })
})
