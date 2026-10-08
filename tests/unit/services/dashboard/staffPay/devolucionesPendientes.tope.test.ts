// tests/unit/services/dashboard/staffPay/devolucionesPendientes.tope.test.ts — fase 3, B13 (revisión de B12 #6): pasar el tope de
// grupos destino × sede es VOLUMEN de datos, no un error de quien pregunta: 409 DEMASIADAS_PENDIENTES (nunca recorta).
import { devolucionesPendientes } from '@/services/dashboard/staffPay/devolucionesPendientes'

describe('devolucionesPendientes: el tope de grupos', () => {
  const db = (grupos: number) => ({
    organization: {
      findUnique: jest.fn().mockResolvedValue({ staffPayStartDate: new Date('2026-09-01T00:00:00Z'), servicePayPeriodicity: 'MONTHLY' }),
    },
    venue: { findMany: jest.fn().mockResolvedValue([{ id: 'a', timezone: 'America/Mexico_City' }]) },
    $queryRaw: jest.fn().mockResolvedValue(Array.from({ length: grupos }, () => ({ gd: 0, gs: 0, n: 1, total: null }))),
  })

  it('más de 5,000 grupos ⇒ 409 DEMASIADAS_PENDIENTES con texto (truena, no recorta)', async () => {
    await expect(devolucionesPendientes(db(5002) as any, { organizationId: 'o', sedes: ['a'] })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEMASIADAS_PENDIENTES',
      message: expect.stringMatching(/^Hay demasiadas devoluciones pendientes/),
    })
  })

  it('en el tope todavía contesta (sin la fila del total: vacío)', async () => {
    await expect(devolucionesPendientes(db(5001) as any, { organizationId: 'o', sedes: ['a'] })).resolves.toMatchObject({ n: 0 })
  })
})
