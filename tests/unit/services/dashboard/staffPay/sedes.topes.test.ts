// tests/unit/services/dashboard/staffPay/sedes.topes.test.ts — fase 3, B13 ronda 1 (R1, R2): los topes de volumen de la pantalla de
// sedes son 409 con texto en español (ruling de B12 #6: volumen de datos, no un error de quien pregunta), nunca un 400 ni un
// `Error` crudo que sale como 500. Truenan, no recortan.
import { prismaMock } from '@tests/__helpers__/setup'
import { estadoSedes } from '@/services/dashboard/staffPay/sedes.service'
import { TOPE_VENTANAS, ventanasDeSedes } from '@/services/dashboard/staffPay/rangos'

describe('estadoSedes: más de 500 sedes en la organización (R2)', () => {
  it('⇒ 409 DEMASIADAS_SEDES con texto, sin pedir permisos ni leer nada más', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City' } as any)
    prismaMock.venue.findMany.mockResolvedValue(
      Array.from({ length: 501 }, (_, i) => ({
        id: `v${String(i).padStart(3, '0')}`,
        name: `S${i}`,
        timezone: 'America/Mexico_City',
      })) as any,
    )
    await expect(estadoSedes({ userId: 'u1', venueId: 'v000' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEMASIADAS_SEDES',
      message: 'Esta organización tiene más de 500 sedes: no se pueden mostrar todas; contacta a Avoqado.',
    })
    expect(prismaMock.venue.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'o1' }, take: 501 }))
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

describe('ventanasDeSedes: más ventanas que el tope (R1)', () => {
  it('⇒ 409 STAFF_PAY_DEMASIADAS_VENTANAS con texto (antes un Error crudo: 500)', async () => {
    const d = new Date('2026-01-01T00:00:00Z')
    const db = {
      staffPayVenueWindow: {
        findMany: jest.fn().mockResolvedValue(Array.from({ length: TOPE_VENTANAS + 1 }, () => ({ venueId: 'v', desde: d, hasta: d }))),
      },
    }
    await expect(ventanasDeSedes(db as any, 'o1', ['v'])).rejects.toMatchObject({
      statusCode: 409,
      code: 'STAFF_PAY_DEMASIADAS_VENTANAS',
      message: 'Esta organización tiene demasiadas fechas de activación de sedes para leerlas; pide ayuda a Avoqado.',
    })
  })
})
