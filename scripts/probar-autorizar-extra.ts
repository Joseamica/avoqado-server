/**
 * Prueba EN VIVO de la AUTORIZACIÓN de horas extra, contra la base local.
 *
 * Los tests con mock no ven lo que de verdad rompe: un campo que no está en el `select`, una
 * migración que falta, un unique que no existe. Esto ejercita la consulta real y la escritura
 * real. Siembra, mide, imprime y LIMPIA.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/probar-autorizar-extra.ts
 */
import 'dotenv/config'
import { DateTime } from 'luxon'

import { getPayrollSummary } from '../src/services/dashboard/attendancePayroll.service'
import { approveOvertime } from '../src/services/dashboard/overtimeApproval.service'
import prisma from '../src/utils/prismaClient'
import { exigirBaseLocal } from './_solo-base-local'

const VENUE = 'cmpe64yq2001f9k92m0lbhmf4' // Restaurante El Atole, America/Mexico_City
const STAFF = 'cmpe64zia001y9k92i4aaw1f4' // Ana Martínez
const MEMBRESIA = 'cmpe6503z006b9k92mz22fyvs'
const TZ = 'America/Mexico_City'

const LUNES = '2026-08-24'
const DOMINGO = '2026-08-30'
const DIAS = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27']

const sembradas: string[] = []
let fallos = 0

function hora(fecha: string, hhmm: string): Date {
  return DateTime.fromISO(`${fecha}T${hhmm}`, { zone: TZ }).toJSDate()
}

function hm(min: number) {
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

function comprobar(etiqueta: string, real: unknown, esperado: unknown) {
  const ok = JSON.stringify(real) === JSON.stringify(esperado)
  if (!ok) fallos++
  console.log(`  ${ok ? '🟢' : '🔴'} ${etiqueta}: ${JSON.stringify(real)} (esperado ${JSON.stringify(esperado)})`)
}

async function anaDelPeriodo() {
  const { rows } = await getPayrollSummary(VENUE, LUNES, DOMINGO)
  const ana = rows.find(r => r.staffVenueId === MEMBRESIA)
  if (!ana) throw new Error('Ana no salió en el resumen')
  return ana
}

async function main() {
  // 🔴 Este script BORRA autorizaciones y SOBRESCRIBE cuadrantes. Contra una base que no
  // sea la local, eso destruye datos reales (hallazgo #9 de Codex, 29-ago-2026).
  exigirBaseLocal()

  const cuadranteAntes = await prisma.staffWorkSchedule.findUnique({
    where: { staffVenueId: MEMBRESIA },
    select: { weekly: true },
  })

  // Cuadrante 09:00–17:00 de lunes a jueves.
  const weekly: Record<string, unknown> = {}
  for (const d of ['monday', 'tuesday', 'wednesday', 'thursday']) {
    weekly[d] = { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] }
  }
  await prisma.staffWorkSchedule.upsert({
    where: { staffVenueId: MEMBRESIA },
    create: { staffVenueId: MEMBRESIA, venueId: VENUE, weekly: weekly as never },
    update: { weekly: weekly as never },
  })

  // 4 días de 3 h extra = 12 h medidas.
  for (const d of DIAS) {
    const e = await prisma.timeEntry.create({
      data: {
        staffId: STAFF,
        venueId: VENUE,
        clockInTime: hora(d, '09:00'),
        clockOutTime: hora(d, '20:00'),
        status: 'CLOCKED_OUT',
      },
      select: { id: true },
    })
    sembradas.push(e.id)
  }

  console.log('\n══════ AUTORIZACIÓN DE HORAS EXTRA — contra la base ══════')

  console.log('\n1 · Sin autorizar: todo PENDIENTE, nada se paga')
  let ana = await anaDelPeriodo()
  comprobar('medidos', ana.overtimeMinutes, 720)
  comprobar('pendientes', ana.overtimePendingMinutes, 720)
  comprobar('autorizados', ana.overtimeApprovedMinutes, 0)
  comprobar('dobles', ana.overtimeDoubleMinutes, 0)
  comprobar('triples', ana.overtimeTripleMinutes, 0)
  comprobar('infracción art. 66 (4 días)', ana.hasOvertimeViolation, true)

  console.log('\n2 · Autorizo los 4 días completos → 9 h dobles + 3 h triples')
  for (const d of DIAS) {
    await approveOvertime({
      venueId: VENUE,
      staffVenueId: MEMBRESIA,
      date: d,
      minutesApproved: 180,
      approvedById: STAFF,
    })
  }
  ana = await anaDelPeriodo()
  comprobar('autorizados', ana.overtimeApprovedMinutes, 720)
  comprobar('pendientes', ana.overtimePendingMinutes, 0)
  comprobar('dobles', ana.overtimeDoubleMinutes, 540)
  comprobar('triples', ana.overtimeTripleMinutes, 180)

  console.log('\n3 · Corrijo un día a la mitad → el total baja y nada se duplica')
  await approveOvertime({
    venueId: VENUE,
    staffVenueId: MEMBRESIA,
    date: DIAS[0],
    minutesApproved: 90,
    approvedById: STAFF,
  })
  ana = await anaDelPeriodo()
  comprobar('autorizados', ana.overtimeApprovedMinutes, 630)
  comprobar('negados', ana.overtimeDeniedMinutes, 90)
  const filas = await prisma.overtimeApproval.count({ where: { staffVenueId: MEMBRESIA } })
  comprobar('filas de autorización (una por día, no acumula)', filas, 4)

  console.log('\n4 · Autorizar MÁS de lo medido se rechaza')
  try {
    await approveOvertime({
      venueId: VENUE,
      staffVenueId: MEMBRESIA,
      date: DIAS[0],
      minutesApproved: 999,
      approvedById: STAFF,
    })
    console.log('  🔴 NO rechazó')
    fallos++
  } catch (e) {
    console.log(`  🟢 rechazado: ${(e as Error).message}`)
  }

  console.log('\n5 · La checada CRECE después de autorizar → el excedente queda pendiente')
  await prisma.timeEntry.update({
    where: { id: sembradas[1] },
    data: { clockOutTime: hora(DIAS[1], '22:00') }, // de 3 h a 5 h
  })
  ana = await anaDelPeriodo()
  comprobar('medidos', ana.overtimeMinutes, 840)
  comprobar('autorizados (no hereda el excedente)', ana.overtimeApprovedMinutes, 630)
  comprobar('pendientes (las 2 h nuevas)', ana.overtimePendingMinutes, 120)
  comprobar('marcado para revisar', ana.overtimeDaysToReview, [DIAS[1]])

  console.log('\n6 · La bitácora dejó rastro')
  const rastro = await prisma.activityLog.count({
    where: { action: 'OVERTIME_APPROVED', venueId: VENUE, staffId: STAFF },
  })
  comprobar('asientos OVERTIME_APPROVED (4 altas + 1 corrección)', rastro >= 5, true)

  console.log(`\n  ${fallos === 0 ? '🟢 TODO CUADRA' : `🔴 ${fallos} COMPROBACIONES FALLARON`}`)
  if (fallos > 0) process.exitCode = 1

  // ── limpieza ────────────────────────────────────────────────────────────────────────
  await prisma.overtimeApproval.deleteMany({ where: { staffVenueId: MEMBRESIA } })
  await prisma.activityLog.deleteMany({ where: { action: 'OVERTIME_APPROVED', venueId: VENUE } })
  await prisma.timeEntry.deleteMany({ where: { id: { in: sembradas } } })
  if (cuadranteAntes) {
    await prisma.staffWorkSchedule.update({
      where: { staffVenueId: MEMBRESIA },
      data: { weekly: cuadranteAntes.weekly as never },
    })
  } else {
    await prisma.staffWorkSchedule.deleteMany({ where: { staffVenueId: MEMBRESIA } })
  }
  const quedan =
    (await prisma.timeEntry.count({ where: { id: { in: sembradas } } })) +
    (await prisma.overtimeApproval.count({ where: { staffVenueId: MEMBRESIA } }))
  console.log(`  limpieza: quedan ${quedan} filas sembradas (debe ser 0)\n`)
}

main()
  .catch(e => {
    console.error('FALLÓ:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
