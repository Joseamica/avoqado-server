import prisma from '@/utils/prismaClient'
import { fichaDeLaInvitada } from '@/services/reservation/fichaDeInvitada'
import { borrarMundo, crearMundo, Mundo } from './_mundo'

/**
 * D7 (founder 16-nov, «A · crearla siempre»): contra Postgres de verdad, porque la búsqueda por teléfono es SQL (los dígitos sin
 * formato) y crear sin duplicar usa `skipDuplicates` sobre `@@unique([venueId, phone])`.
 */
let m: Mundo
const enTx = (guestName: string, guestPhone: string) =>
  prisma.$transaction(tx => fichaDeLaInvitada(tx, m.venueId, { guestName, guestPhone }))

beforeAll(async () => {
  m = await crearMundo('ficha-invitada')
})
afterAll(async () => {
  if (!m) return
  await prisma.customer.deleteMany({ where: { venueId: m.venueId } })
  await borrarMundo(m)
})

it('sin ficha ⇒ la crea; la siguiente reserva de la misma invitada (otro formato) la reusa; otra persona con ese número no', async () => {
  const primera = await enTx('Ana Ruiz', '55 1234 5678')
  expect(primera).toMatchObject({ creada: true })
  expect(await prisma.customer.findUniqueOrThrow({ where: { id: primera!.customerId } })).toMatchObject({
    phone: '+525512345678',
    firstName: 'Ana',
    lastName: 'Ruiz',
  })

  expect(await enTx('ana', '+52 55-1234-5678')).toEqual({ customerId: primera!.customerId, creada: false })
  // Mamá agenda a su hija con su número: no se liga a la ficha de Ana ni se crea otra.
  expect(await enTx('Sofía Ruiz', '5512345678')).toBeNull()
  expect(await prisma.customer.count({ where: { venueId: m.venueId } })).toBe(1)
})

it('dos reservas de la misma invitada al mismo tiempo ⇒ una sola ficha', async () => {
  const [a, b] = await Promise.all([enTx('Carla Paz', '5598765432'), enTx('Carla Paz', '55 9876 5432')])
  expect(a?.customerId).toBeTruthy()
  expect(b?.customerId).toBe(a?.customerId)
  expect(await prisma.customer.count({ where: { venueId: m.venueId, phone: '+525598765432' } })).toBe(1)
})
