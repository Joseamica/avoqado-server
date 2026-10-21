import { Prisma, ReservationChannel } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

describe('conector de pases — esquema', () => {
  // nuevo
  it('el cliente de Prisma trae los 9 modelos del conector', () => {
    const modelos = Object.values(Prisma.ModelName)
    for (const m of [
      'AggregatorConnection',
      'AggregatorProductLink',
      'AggregatorSessionLink',
      'AggregatorCapacityRule',
      'AggregatorBooking',
      'AggregatorVisit',
      'CustomerExternalIdentity',
      'AggregatorInboundEvent',
      'AggregatorOutbox',
    ]) {
      expect(modelos).toContain(m)
    }
  })

  // nuevo
  it('el prismaMock registra los 9 modelos (si no, las pruebas de servicio truenan con undefined)', () => {
    for (const k of [
      'aggregatorConnection',
      'aggregatorProductLink',
      'aggregatorSessionLink',
      'aggregatorCapacityRule',
      'aggregatorBooking',
      'aggregatorVisit',
      'customerExternalIdentity',
      'aggregatorInboundEvent',
      'aggregatorOutbox',
    ]) {
      expect((prismaMock as any)[k]?.findFirst).toBeDefined()
    }
  })

  // regresión: el conector crea reservas con channel THIRD_PARTY. En Prisma 6 los enums se exportan
  // sueltos (no cuelgan de `Prisma.`), por eso se lee `ReservationChannel` directo.
  it('ReservationChannel conserva THIRD_PARTY (contrato del conector)', () => {
    expect(Object.values(ReservationChannel)).toContain('THIRD_PARTY')
  })
})
