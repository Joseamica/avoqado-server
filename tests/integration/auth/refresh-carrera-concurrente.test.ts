/**
 * REFRESCO CONCURRENTE — contra el Postgres local real (av-db-25).
 *
 * Reproduce el incidente del 2026-09-02 16:07 (Sunmi D3, owner@owner.com,
 * sesión cmtkmm7sv0001q0t1z0ogtsgz): el POS despertó del background, seis
 * peticiones vencidas dispararon DOS refrescos que se SOLAPARON, y el segundo
 * recibió `reutilizado` → 401 «Tu sesión ya no es válida» → logout del cajero.
 *
 * 🔑 Lo que la evidencia de la base descartó: NADA quedó revocado — ni la
 * `Session` (`revokedAt` NULL) ni ningún grant de la familia. O sea que NO se
 * ejecutó el camino de robo (pre-chequeo `previo.consumedAt`), que sí revoca.
 * El que corrió fue el perdedor del `updateMany` condicional DENTRO de la
 * transacción, que devuelve `reutilizado` sin mirar la ventana de
 * retransmisión — aunque el ganador acababa de dejar el sucesor cifrado en la
 * fila, vigente 60 s.
 *
 * Un mock no puede probar esto: la carrera la decide Postgres al serializar
 * dos UPDATE sobre la misma fila.
 */
import prisma from '@/utils/prismaClient'
import { issueGrant, rotateGrant } from '@/services/auth/refreshGrant.service'

const SUF = `refcarrera_${Date.now()}`
let orgId: string
let venueId: string
let staffId: string
let sessionId: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `RefCarrera Org ${SUF}`, email: `${SUF}@test.local`, phone: '0000000000' },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}` },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({
    data: { email: `${SUF}@test.local`, firstName: 'Ref', lastName: 'Carrera' },
  })
  staffId = staff.id
})

afterAll(async () => {
  if (staffId) await prisma.session.deleteMany({ where: { staffId } })
  if (staffId) await prisma.staff.delete({ where: { id: staffId } }).catch(() => undefined)
  if (venueId) await prisma.venue.delete({ where: { id: venueId } }).catch(() => undefined)
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined)
  await prisma.$disconnect()
})

beforeEach(async () => {
  const session = await prisma.session.create({
    data: { staffId, venueId, authMethod: 'PASSWORD' },
  })
  sessionId = session.id
})

const enUnaSemana = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

it('dos refrescos que SE SOLAPAN devuelven el MISMO sucesor y nadie pierde la sesión', async () => {
  const familyId = `fam-${SUF}-${Math.random()}`
  await issueGrant(sessionId, familyId, 'tok-viejo', enUnaSemana())

  // Las dos peticiones que el POS mandó a la vez al despertar. Cada una trae su
  // propio candidato a sucesor, igual que en producción: el token nuevo lo
  // acuña `refreshAccessToken` ANTES de llamar a rotateGrant, así que dos
  // llamadas concurrentes nunca proponen el mismo.
  const [a, b] = await Promise.all([
    rotateGrant('tok-viejo', 'tok-nuevo-A', enUnaSemana()),
    rotateGrant('tok-viejo', 'tok-nuevo-B', enUnaSemana()),
  ])

  // Ninguna de las dos puede salir como reutilización: es el MISMO cliente
  // legítimo, con el MISMO refresh token, en la misma ventana.
  expect(a).not.toHaveProperty('reutilizado')
  expect(b).not.toHaveProperty('reutilizado')

  // Y las dos tienen que quedarse con el MISMO sucesor: si cada una guardara el
  // suyo, el aparato acabaría con un refresh token que la base no reconoce.
  const sucesorA = (a as { sucesor: string }).sucesor
  const sucesorB = (b as { sucesor: string }).sucesor
  expect(sucesorA).toBe(sucesorB)

  // La sesión sigue viva: el cajero no se quedó fuera.
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  expect(session?.revokedAt).toBeNull()

  // Y la familia entera sigue sana — nada revocado.
  const revocados = await prisma.refreshGrant.count({ where: { familyId, revokedAt: { not: null } } })
  expect(revocados).toBe(0)
})

it('el sucesor que devuelve el perdedor SIRVE de verdad para el siguiente refresco', async () => {
  const familyId = `fam2-${SUF}-${Math.random()}`
  await issueGrant(sessionId, familyId, 'tok-viejo-2', enUnaSemana())

  const [a, b] = await Promise.all([
    rotateGrant('tok-viejo-2', 'tok-nuevo-A2', enUnaSemana()),
    rotateGrant('tok-viejo-2', 'tok-nuevo-B2', enUnaSemana()),
  ])

  // El aparato se queda con el token de la respuesta que le llegó al final —
  // cualquiera de las dos. Ese token tiene que poder rotar otra vez, o el POS
  // muere en el ciclo siguiente (10 min después) en vez de ahora.
  const ultimo = (b as { sucesor?: string }).sucesor ?? (a as { sucesor: string }).sucesor
  const siguiente = await rotateGrant(ultimo, 'tok-nuevo-C2', enUnaSemana())

  expect(siguiente).not.toHaveProperty('reutilizado')
})

it('un refresh token de VERDAD reutilizado (fuera de la ventana) SIGUE revocando la familia', async () => {
  const familyId = `fam3-${SUF}-${Math.random()}`
  await issueGrant(sessionId, familyId, 'tok-robado', enUnaSemana())

  const primero = await rotateGrant('tok-robado', 'tok-legitimo', enUnaSemana())
  expect(primero).not.toHaveProperty('reutilizado')

  // El ladrón reproduce el token viejo PASADA la ventana de retransmisión: se
  // fuerza venciendo el ciphertext del sucesor, que es lo que la ventana usa.
  await prisma.refreshGrant.updateMany({
    where: { familyId, consumedAt: { not: null } },
    data: { successorEncExpiresAt: new Date(Date.now() - 1000) },
  })

  const robo = await rotateGrant('tok-robado', 'tok-del-ladron', enUnaSemana())
  expect(robo).toEqual({ reutilizado: true })

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  expect(session?.revokedAt).not.toBeNull()
  expect(session?.revokedReason).toBe('refresh_reuse_detected')
})
