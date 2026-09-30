/**
 * Etapa 3 del KDS: un pedido de Uber (una comanda, sin partir) va a la estación DEFAULT con pantalla, o a la primera
 * con pantalla; sin ninguna, sale «Sin estación». Así sólo esa pantalla puede avisarle a Uber «listo».
 */
import prisma from '@/utils/prismaClient'
import { estacionDePantallaParaReparto } from '@/services/kds/kitchenDisplayStations'

const SUF = `kdsreparto-${Date.now()}`
let orgId: string
let venueId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Reparto ${SUF}`, email: `${SUF}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}` } })).id
})

afterAll(async () => {
  if (!orgId) return
  await prisma.printStation.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('sin estaciones con pantalla ⇒ null («Sin estación»)', async () => {
  await prisma.printStation.create({ data: { venueId, name: 'Papel', isDefault: true } })
  expect(await estacionDePantallaParaReparto(venueId)).toBeNull()
})

it('con pantalla en una que no es default ⇒ esa; si la default también tiene pantalla ⇒ la default', async () => {
  const barra = await prisma.printStation.create({ data: { venueId, name: 'Barra', hasKitchenDisplay: true, displayOrder: 1 } })
  expect(await estacionDePantallaParaReparto(venueId)).toBe(barra.id)
  await prisma.printStation.updateMany({ where: { venueId, name: 'Papel' }, data: { hasKitchenDisplay: true } })
  const papel = await prisma.printStation.findFirstOrThrow({ where: { venueId, name: 'Papel' } })
  expect(await estacionDePantallaParaReparto(venueId)).toBe(papel.id)
})

it('una estación con pantalla pero apagada no cuenta', async () => {
  await prisma.printStation.updateMany({ where: { venueId }, data: { active: false } })
  expect(await estacionDePantallaParaReparto(venueId)).toBeNull()
})
