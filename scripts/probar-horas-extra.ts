/**
 * Prueba EN VIVO de las horas extra, contra la base local.
 *
 * 🔴 Existe porque los tests con mock no ven lo que de verdad rompe: un campo que está en la
 * interfaz pero no en el `select` de Prisma pasa verde y llega vacío en producción. Esto
 * ejercita la consulta REAL — rejilla, descansos y reparto doble/triple incluidos.
 *
 * Siembra, mide, imprime y LIMPIA. No manda correos ni toca nada fuera de lo que creó.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/probar-horas-extra.ts
 */
import 'dotenv/config'
import { DateTime } from 'luxon'

import prisma from '../src/utils/prismaClient'
import { exigirBaseLocal, exigirBaseLocalDeVerdad } from './_solo-base-local'
import { getPayrollSummary } from '../src/services/dashboard/attendancePayroll.service'
import { approveOvertime } from '../src/services/dashboard/overtimeApproval.service'

const VENUE = 'cmpe64yq2001f9k92m0lbhmf4' // Restaurante El Atole, America/Mexico_City
const STAFF = 'cmpe64zia001y9k92i4aaw1f4' // Ana Martínez
const MEMBRESIA = 'cmpe6503z006b9k92mz22fyvs'
/** Quien firma la autorización: nadie puede autorizar sus PROPIAS horas. */
const AUTORIZA = 'cmpe64ykh00199k92lgo67j5y'

const TZ = 'America/Mexico_City'
const sembradas: string[] = []

/** Un instante en hora del NEGOCIO. */
function hora(fecha: string, hhmm: string): Date {
  return DateTime.fromISO(`${fecha}T${hhmm}`, { zone: TZ }).toJSDate()
}

async function checada(fecha: string, entra: string, sale: string, descansos: Array<[string, string]> = []) {
  const entry = await prisma.timeEntry.create({
    data: {
      staffId: STAFF,
      venueId: VENUE,
      clockInTime: hora(fecha, entra),
      clockOutTime: hora(fecha, sale),
      status: 'CLOCKED_OUT',
      breaks: {
        create: descansos.map(([a, b]) => ({ startTime: hora(fecha, a), endTime: hora(fecha, b) })),
      },
    },
    select: { id: true },
  })
  sembradas.push(entry.id)
}

function hm(min: number) {
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

async function main() {
  // 🔴 La URL no prueba dónde termina el socket: un túnel SSH deja producción en
  // localhost. Esto le pregunta al SERVIDOR (3ª auditoría de Codex, P1 #4).
  await exigirBaseLocalDeVerdad(prisma)

  // 🔴 Este script BORRA autorizaciones y SOBRESCRIBE cuadrantes. Contra una base que no
  // sea la local, eso destruye datos reales (hallazgo #9 de Codex, 29-ago-2026).
  exigirBaseLocal()

  // Lunes 2026-08-24 … domingo 2026-08-30, una semana natural completa.
  const LUNES = '2026-08-24'
  const DOMINGO = '2026-08-30'

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

  // 4 días de 3 h extra = 12 h → 9 dobles + 3 triples. El miércoles lleva 30 min de descanso
  // DENTRO de la hora extra, así que ese día debe contar 2h30 y no 3h.
  await checada(LUNES, '09:00', '20:00') // 3 h
  await checada('2026-08-25', '09:00', '20:00') // 3 h
  await checada('2026-08-26', '09:00', '20:00', [['18:00', '18:30']]) // 2h30
  await checada('2026-08-27', '09:00', '20:00') // 3 h

  // 🔴 Desde que las horas extra se AUTORIZAN, medirlas no basta para que se repartan en
  // doble y triple: sin autorización todo queda PENDIENTE. Este script se escribió antes de
  // esa decisión y salía en rojo contra código correcto (WARN del /full-testing del 29-ago).
  // Ahora autoriza lo medido para poder comprobar el reparto.
  const medidos = (await getPayrollSummary(VENUE, LUNES, DOMINGO)).rows.find(r => r.staffVenueId === MEMBRESIA)
  console.log('\n══════ HORAS EXTRA — medido contra la base ══════')
  console.log(`  sin autorizar  ${hm(medidos?.overtimePendingMinutes ?? 0)} pendientes, 0 dobles, 0 triples`)

  for (const [d, min] of [
    [LUNES, 180],
    ['2026-08-25', 180],
    ['2026-08-26', 150],
    ['2026-08-27', 180],
  ] as Array<[string, number]>) {
    // 🔴 Quien autoriza NO puede ser el dueño de las horas (separación de funciones): se usa
    // otra persona del mismo negocio.
    await approveOvertime({ venueId: VENUE, staffVenueId: MEMBRESIA, date: d, minutesApproved: min, approvedById: AUTORIZA })
  }

  const { rows } = await getPayrollSummary(VENUE, LUNES, DOMINGO)
  const ana = rows.find(r => r.staffVenueId === MEMBRESIA)

  if (!ana) {
    console.log('🔴 no salió Ana en el resumen')
  } else {
    const esperado = 180 + 180 + 150 + 180 // 690 min = 11 h 30 m
    console.log(`  total          ${hm(ana.overtimeMinutes)}   (esperado ${hm(esperado)})`)
    // Avoqado ya no reparte en doble y triple ni dictamina el art. 66 (31-ago-2026): entrega
    // los minutos agrupados por semana y la nómina del negocio aplica la ley.
    console.log(`  autorizados    ${hm(ana.overtimeApprovedMinutes)}`)
    console.log(`  pendientes     ${hm(ana.overtimePendingMinutes)}`)
    console.log(`  semanas        ${ana.overtimeWeeks.length}`)
    for (const w of ana.overtimeWeeks) {
      console.log(
        `    ${w.weekStart}→${w.weekEnd}  ${hm(w.minutosTotal)}  ` +
          `${hm(w.minutosTotal)}  parcial=${w.parcial}`,
      )
    }

    // 🔴 El veredicto se juzga sobre lo que Avoqado sí afirma: cuánto MIDIÓ el reloj y que la
    // semana lo recoja entero. El reparto por tarifa se retiró el 31-ago-2026 — comprobarlo
    // aquí sería fijar una regla legal que este sistema ya no aplica.
    const ok =
      ana.overtimeMinutes === esperado &&
      ana.overtimeWeeks.reduce((t, w) => t + w.minutosTotal, 0) === ana.overtimeApprovedMinutes
    console.log(`\n  ${ok ? '🟢 CUADRA' : '🔴 NO CUADRA'}`)
    if (!ok) process.exitCode = 1
  }

  // ── limpieza ────────────────────────────────────────────────────────────────────────
  await prisma.overtimeApproval.deleteMany({ where: { staffVenueId: MEMBRESIA } })
  await prisma.activityLog.deleteMany({ where: { action: 'OVERTIME_APPROVED', venueId: VENUE } })
  await prisma.timeEntry.deleteMany({ where: { id: { in: sembradas } } }) // los breaks caen por cascade
  if (cuadranteAntes) {
    await prisma.staffWorkSchedule.update({
      where: { staffVenueId: MEMBRESIA },
      data: { weekly: cuadranteAntes.weekly as never },
    })
  } else {
    await prisma.staffWorkSchedule.deleteMany({ where: { staffVenueId: MEMBRESIA } })
  }
  const quedan = await prisma.timeEntry.count({ where: { id: { in: sembradas } } })
  console.log(`  limpieza: quedan ${quedan} checadas sembradas (debe ser 0)\n`)
}

main()
  .catch(e => {
    console.error('FALLÓ:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
