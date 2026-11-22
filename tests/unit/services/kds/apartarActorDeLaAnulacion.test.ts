/**
 * hz:e82938e1:D40 (Codex d40-r4 #1 y r5): quien anula se aparta al inicio de la transacción. Primero la sucursal y después el
 * empleado, el mismo orden que la limpieza de demos (sucursal → empleado); el borrado de personal (empleado → cuentas) no toca la
 * sucursal. Así ninguno de los dos borrados se traba con una anulación.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { apartarActorDeLaAnulacion } from '@/services/kds/kitchenTicketAuthoring.service'

const sql = (i: number) => String((prismaMock.$queryRaw.mock.calls[i][0] as any).join('?'))

describe('apartarActorDeLaAnulacion', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 aparta la sucursal y DESPUÉS al empleado, los dos con FOR KEY SHARE', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'x' }] as any)
    await expect(apartarActorDeLaAnulacion(prismaMock as any, 'venue-1', 'staff-1')).resolves.toBe('staff-1')
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
    expect(sql(0)).toContain('"Venue"')
    expect(sql(0)).toContain('FOR KEY SHARE')
    expect(sql(1)).toContain('"Staff"')
    expect(sql(1)).toContain('FOR KEY SHARE')
  })

  it('si el empleado ya no existe, devuelve undefined (se anula sin actor)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'venue-1' }] as any).mockResolvedValueOnce([] as any)
    await expect(apartarActorDeLaAnulacion(prismaMock as any, 'venue-1', 'borrado')).resolves.toBeUndefined()
  })

  it('sin actor no aparta nada', async () => {
    await expect(apartarActorDeLaAnulacion(prismaMock as any, 'venue-1', null)).resolves.toBeUndefined()
    await expect(apartarActorDeLaAnulacion(prismaMock as any, 'venue-1', undefined)).resolves.toBeUndefined()
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})
