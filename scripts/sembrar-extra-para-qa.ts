/**
 * Siembra un caso REALISTA de horas extra para el QA en pantalla. NO limpia: la idea es que
 * quede ahí para mirarlo en el dashboard.
 *
 * Deja tres personas con situaciones distintas, para que la pantalla enseñe los tres estados
 * de la autorización de un vistazo:
 *
 *   Ana    — 4 días con extra, NADA autorizado  → todo en ámbar, "por autorizar"
 *   Beto   — 2 días, uno autorizado y otro no   → mezcla
 *   Carlos — 1 día de 4 h, autorizado completo  → infracción del art. 66 (más de 3 h)
 *
 * Para borrarlo después:  npx ts-node --transpile-only -r tsconfig-paths/register \
 *                           scripts/sembrar-extra-para-qa.ts --limpiar
 */
import 'dotenv/config'
import { DateTime } from 'luxon'

import prisma from '../src/utils/prismaClient'

const VENUE = 'cmpe64yq2001f9k92m0lbhmf4' // Restaurante El Atole
const TZ = 'America/Mexico_City'
const MARCA = 'QA horas extra' // para poder borrar exactamente lo sembrado

function hora(fecha: string, hhmm: string): Date {
  return DateTime.fromISO(`${fecha}T${hhmm}`, { zone: TZ }).toJSDate()
}

async function limpiar() {
  const borradas = await prisma.timeEntry.deleteMany({ where: { venueId: VENUE, notes: MARCA } })
  const aut = await prisma.overtimeApproval.deleteMany({ where: { venueId: VENUE, note: MARCA } })
  console.log(`🧹 borradas ${borradas.count} checadas y ${aut.count} autorizaciones`)
}

async function main() {
  if (process.argv.includes('--limpiar')) {
    await limpiar()
    return
  }

  // Se limpia antes de sembrar para poder correrlo dos veces sin duplicar.
  await limpiar()

  const gente = await prisma.staffVenue.findMany({
    where: { venueId: VENUE, active: true, staff: { active: true } },
    select: { id: true, staffId: true, staff: { select: { firstName: true, lastName: true } } },
    orderBy: { id: 'asc' },
    take: 3,
  })
  if (gente.length < 3) throw new Error(`Sólo encontré ${gente.length} personas activas en el venue`)

  // Cuadrante 09:00–17:00 de lunes a viernes para los tres.
  const weekly: Record<string, unknown> = {}
  for (const d of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) {
    weekly[d] = { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] }
  }
  for (const p of gente) {
    await prisma.staffWorkSchedule.upsert({
      where: { staffVenueId: p.id },
      create: { staffVenueId: p.id, venueId: VENUE, weekly: weekly as never },
      update: { weekly: weekly as never },
    })
  }

  const [ana, beto, carlos] = gente
  const LUN = '2026-08-24'
  const MAR = '2026-08-25'
  const MIE = '2026-08-26'
  const JUE = '2026-08-27'

  async function checada(staffId: string, fecha: string, sale: string) {
    await prisma.timeEntry.create({
      data: {
        staffId,
        venueId: VENUE,
        clockInTime: hora(fecha, '09:00'),
        clockOutTime: hora(fecha, sale),
        status: 'CLOCKED_OUT',
        notes: MARCA,
      },
    })
  }

  async function autorizar(staffVenueId: string, date: string, minutos: number, medidos: number) {
    await prisma.overtimeApproval.create({
      data: {
        staffVenueId,
        venueId: VENUE,
        date,
        minutesApproved: minutos,
        minutesMeasured: medidos,
        approvedById: gente[0].staffId,
        note: MARCA,
      },
    })
  }

  // Ana: 4 días de 2 h. Nada autorizado → 8 h "por autorizar" en ámbar.
  for (const d of [LUN, MAR, MIE, JUE]) await checada(ana.staffId, d, '19:00')

  // Beto: lunes 3 h (autorizado) y martes 1 h (sin revisar) → mezcla de estados.
  await checada(beto.staffId, LUN, '20:00')
  await checada(beto.staffId, MAR, '18:00')
  await autorizar(beto.id, LUN, 180, 180)

  // Carlos: un solo día de 4 h, autorizado completo → dispara la advertencia del art. 66
  // (más de 3 h en un día) aunque esté todo aprobado.
  await checada(carlos.staffId, MIE, '21:00')
  await autorizar(carlos.id, MIE, 240, 240)

  console.log('\n✅ Sembrado para el QA (semana del 24 al 30 de agosto de 2026):')
  console.log(`   ${ana.staff.firstName} ${ana.staff.lastName}: 8 h medidas, 0 autorizadas → todo por autorizar`)
  console.log(`   ${beto.staff.firstName} ${beto.staff.lastName}: 4 h medidas, 3 autorizadas → 1 h pendiente`)
  console.log(`   ${carlos.staff.firstName} ${carlos.staff.lastName}: 4 h en UN día, autorizadas → advertencia art. 66`)
  console.log('\n   Dashboard: http://localhost:5173  →  Asistencia  →  pestaña Nómina')
  console.log('   Rango: 24 ago 2026 – 30 ago 2026\n')
}

main()
  .catch(e => {
    console.error('FALLÓ:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
