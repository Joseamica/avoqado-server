/**
 * Siembra una clase que EMPIEZA EN 10 MINUTOS, con gente apuntada, para probar el kiosco
 * en un aparato real.
 *
 * Existe porque la lista del kiosco la manda el reloj: se abre sola 20 minutos antes de la
 * clase y se cierra pasada la tolerancia. Sin una clase dentro de esa ventana, el kiosco
 * enseña la pantalla de reposo y parece roto cuando en realidad está correcto.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/seed-kiosk-demo-class.ts
 *   npx ts-node -r tsconfig-paths/register scripts/seed-kiosk-demo-class.ts --limpiar
 *
 * 🔴 Sólo corre contra una base LOCAL. Sembrar datos falsos en producción sería meter
 * clientes inventados en la operación de un negocio real, así que aborta antes de tocar
 * nada si la conexión no es a localhost.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const TAG = 'kioskdemo_'

/** El venue de demostración. Se puede pasar otro por argumento. */
const DEFAULT_VENUE = 'cmpe65dfn06gr9k922yfpjnv1'

const NOMBRES: Array<[string, string, string]> = [
  ['Ana', 'Gómez', '5215512340001'],
  ['Regina', 'Ortiz', '5215512340002'],
  ['Paulina', 'Vega', '5215512340003'],
  ['Sofía', 'Ramírez', '5215512340004'],
]

function assertLocal() {
  const url = process.env.DATABASE_URL ?? ''
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url)
  if (!isLocal) {
    console.error('🔴 DATABASE_URL no apunta a localhost. Este script NO siembra datos falsos fuera de tu máquina.')
    process.exit(1)
  }
}

async function limpiar(venueId: string) {
  await prisma.reservation.deleteMany({ where: { id: { startsWith: TAG } } })
  await prisma.classSession.deleteMany({ where: { id: { startsWith: TAG } } })
  await prisma.customer.deleteMany({ where: { id: { startsWith: TAG } } })
  console.log('🧹 Datos de demostración borrados.')
}

async function main() {
  assertLocal()
  const venueId = process.argv.find(a => a.startsWith('cm')) ?? DEFAULT_VENUE

  if (process.argv.includes('--limpiar')) {
    await limpiar(venueId)
    return
  }

  await limpiar(venueId) // idempotente: correrlo dos veces no duplica la clase

  const product = await prisma.product.findFirst({ where: { venueId, type: 'CLASS' }, select: { id: true, name: true } })
  if (!product) throw new Error(`El venue ${venueId} no tiene productos de tipo CLASS`)

  const staff = await prisma.classSession.findFirst({
    where: { venueId, assignedStaffId: { not: null } },
    select: { assignedStaffId: true },
    orderBy: { startsAt: 'desc' },
  })

  const now = new Date()
  const startsAt = new Date(now.getTime() + 10 * 60_000) // dentro de la ventana
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000)

  const session = await prisma.classSession.create({
    data: {
      id: TAG + 'session', venueId, productId: product.id,
      startsAt, endsAt, duration: 60, capacity: 8,
      assignedStaffId: staff?.assignedStaffId ?? null, status: 'SCHEDULED',
    },
  })

  for (const [i, [first, last, phone]] of NOMBRES.entries()) {
    const customer = await prisma.customer.create({
      data: { id: `${TAG}c${i}`, venueId, firstName: first, lastName: last, phone, marketingConsent: false },
    })
    await prisma.reservation.create({
      data: {
        id: `${TAG}r${i}`, venueId, customerId: customer.id, productId: product.id,
        classSessionId: session.id, startsAt, endsAt, blockedEndsAt: endsAt, duration: 60,
        partySize: 1, status: 'CONFIRMED', channel: 'WEB',
        confirmationCode: `KIOSK-000${i + 1}`,
      },
    })
  }

  const hora = startsAt.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: 'numeric', minute: '2-digit' })
  console.log(`\n✅ ${product.name} a las ${hora} · ${NOMBRES.length} personas apuntadas`)
  console.log('   La lista del kiosco debe abrirse SOLA (la ventana ya está abierta).')
  console.log(`\n   Para el respaldo, teclea uno de estos teléfonos: ${NOMBRES.map(n => n[2].slice(-10)).join(' · ')}`)
  console.log('   Para limpiar:  npx ts-node -r tsconfig-paths/register scripts/seed-kiosk-demo-class.ts --limpiar\n')
}

main()
  .catch(e => { console.error('💥', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
