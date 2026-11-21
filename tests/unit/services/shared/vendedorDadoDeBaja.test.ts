/**
 * D13 «C»: las dos salidas del vendedor dado de baja y lo que NO las abre. La regla completa vive contra Postgres real en
 * tests/integration/payments/vendedorDadoDeBaja.integration.test.ts; aquí sólo lo que la base real no deja provocar.
 */
import { validarVendedor } from '@/services/shared/vendedorDadoDeBaja'
import { prismaMock } from '../../../__helpers__/setup'

const activa = (staffId: string) => ({ id: `sv-${staffId}`, staffId, venueId: 'v1', active: true, staff: {} })

describe('validarVendedor (D13)', () => {
  beforeEach(() => prismaMock.staffVenue.findFirst.mockReset())

  it('🔴 una caída de la base al validar la sesión sube tal cual: nunca se vuelve el 400 de hoy (Codex r1 #5)', async () => {
    const caida = new Error('Timed out fetching a new connection from the connection pool')
    prismaMock.staffVenue.findFirst
      .mockResolvedValueOnce(null) // la vendedora no está activa
      .mockResolvedValueOnce({ id: 'sv-beto' }) // pero sí dada de baja aquí
      .mockRejectedValueOnce(caida) // y la base cae al validar la sesión
    await expect(validarVendedor('beto', 'v1', undefined, { sesion: 'ana', deLaCola: true })).rejects.toBe(caida)
  })

  it('la vendedora activa pasa como hoy, sin salida', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce(activa('beto'))
    await expect(validarVendedor('beto', 'v1', undefined, { sesion: 'ana', deLaCola: true })).resolves.toEqual({
      staffId: 'beto',
      deBaja: null,
    })
  })

  it('una sesión que tampoco vale deja el 400 de hoy (no se inventa a quién ponerle la venta)', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'sv-beto' }).mockResolvedValueOnce(null)
    await expect(validarVendedor('beto', 'v1', undefined, { sesion: 'ana', deLaCola: true })).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('la cuenta a su nombre basta, sin consultar la membresía', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce(null)
    await expect(validarVendedor('beto', 'v1', undefined, { sesion: 'ana', deLaCola: false, laCuentaEsSuya: true })).resolves.toEqual({
      staffId: 'beto',
      deBaja: { staffId: 'beto', caso: 'ORDEN_DEL_VENDEDOR', vendedor: 'beto' },
    })
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledTimes(1)
  })
})
