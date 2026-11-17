import { prismaMock } from '@tests/__helpers__/setup'
import { fichaDeLaInvitada } from '@/services/reservation/fichaDeInvitada'

/**
 * D7 (founder 16-nov, «A · crearla siempre»): recepción reserva a una «invitada nueva» con nombre y teléfono y la reserva quedaba
 * sin ficha: esa alumna no podía llegar con el QR del kiosco. Ahora se busca su ficha por el teléfono COMPLETO y, si no hay, se
 * crea. Candado contra el teléfono compartido (Codex r8–r11): si la ficha de ese número es de OTRA persona (otro nombre), no se liga.
 */
const V = 'venue-1'
const candidatas = (filas: Array<{ id: string; phone: string; firstName: string | null }>) =>
  (prismaMock.$queryRaw as jest.Mock).mockResolvedValue(filas)

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.customer.createMany.mockResolvedValue({ count: 1 })
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'c-nueva' } as any)
})

describe('fichaDeLaInvitada', () => {
  it('sin ficha con ese número ⇒ la crea con el teléfono canónico y el nombre partido, y la recupera por el teléfono exacto', async () => {
    candidatas([])
    const r = await fichaDeLaInvitada(prismaMock as any, V, { guestName: ' Ana  Ruiz López ', guestPhone: '55 1234 5678' })
    expect(r).toEqual({ customerId: 'c-nueva', creada: true })
    expect(prismaMock.customer.createMany).toHaveBeenCalledWith({
      data: [{ venueId: V, phone: '+525512345678', firstName: 'Ana', lastName: 'Ruiz López' }],
      skipDuplicates: true,
    })
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({ where: { venueId: V, phone: '+525512345678' }, select: { id: true } })
  })

  it('ya existe su ficha (mismo nombre, sin importar acentos ni mayúsculas) ⇒ la liga, no crea otra', async () => {
    candidatas([{ id: 'c-ana', phone: '55 1234 5678', firstName: 'ÁNA' }])
    const r = await fichaDeLaInvitada(prismaMock as any, V, { guestName: 'Ana Ruiz', guestPhone: '+525512345678' })
    expect(r).toEqual({ customerId: 'c-ana', creada: false })
    expect(prismaMock.customer.createMany).not.toHaveBeenCalled()
  })

  it('🔴 la ficha de ese número es de OTRA persona (mamá agenda a su hija) ⇒ no se liga ni se crea', async () => {
    candidatas([{ id: 'c-mama', phone: '+525512345678', firstName: 'Laura' }])
    expect(await fichaDeLaInvitada(prismaMock as any, V, { guestName: 'Sofía Ruiz', guestPhone: '5512345678' })).toBeNull()
    expect(prismaMock.customer.createMany).not.toHaveBeenCalled()
  })

  it('otra lada con los mismos 10 dígitos no es su ficha ⇒ se crea la suya', async () => {
    candidatas([{ id: 'c-usa', phone: '+15512345678', firstName: 'Ana' }])
    expect(await fichaDeLaInvitada(prismaMock as any, V, { guestName: 'Ana', guestPhone: '5512345678' })).toEqual({
      customerId: 'c-nueva',
      creada: true,
    })
  })

  it('una ficha sin nombre con ese número ⇒ se liga (no hay con qué decir que es otra persona)', async () => {
    candidatas([{ id: 'c-sin-nombre', phone: '+525512345678', firstName: null }])
    expect(await fichaDeLaInvitada(prismaMock as any, V, { guestName: 'Ana', guestPhone: '5512345678' })).toEqual({
      customerId: 'c-sin-nombre',
      creada: false,
    })
  })

  // Codex r3 #6: con el tope lleno su ficha podría estar más abajo; crear otra la duplicaría.
  it('🔴 la búsqueda llena su tope (21 con esos 10 dígitos) ⇒ ni liga ni crea', async () => {
    candidatas(Array.from({ length: 21 }, (_, i) => ({ id: `c-${i}`, phone: `+1551234567${i % 10}`, firstName: 'X' })))
    expect(await fichaDeLaInvitada(prismaMock as any, V, { guestName: 'Ana', guestPhone: '5512345678' })).toBeNull()
    expect(prismaMock.customer.createMany).not.toHaveBeenCalled()
  })

  it('sin teléfono, uno que no se entiende o uno válido de menos de 10 dígitos (+298) ⇒ nada (como hoy)', async () => {
    expect(await fichaDeLaInvitada(prismaMock as any, V, { guestName: 'Ana', guestPhone: null })).toBeNull()
    expect(await fichaDeLaInvitada(prismaMock as any, V, { guestName: 'Ana', guestPhone: '123' })).toBeNull()
    expect(await fichaDeLaInvitada(prismaMock as any, V, { guestName: 'Ana', guestPhone: '+298211234' })).toBeNull()
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.customer.createMany).not.toHaveBeenCalled()
  })
})
