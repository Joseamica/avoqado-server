import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { valorarClases } from '@/services/dashboard/staffPay/valoracion'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, clase, crearMundo, Mundo, TZ } from './_mundo'

/**
 * Asistencia verificada (Mindform, 16-nov-2026, spec D-E): «sólo quien llegó» se paga por las llegadas, y cada clase
 * dice cómo se demostró cada una (con celular, con teléfono, a mano por quién). Contra Postgres de verdad: el desglose
 * es SQL, y una prueba con dobles no prueba una consulta.
 */
let m: Mundo
const DESDE = new Date('2026-11-01T06:00:00.000Z')
const HASTA = new Date('2026-12-01T06:00:00.000Z')
const AHORA = new Date('2026-11-20T00:00:00.000Z')

async function tabla(countMode: 'ATTENDED' | 'BOOKED') {
  const t = await prisma.servicePayTable.create({ data: { venueId: m.venueId, name: `Tabla ${countMode}`, productIds: [] } })
  const v = await prisma.servicePayTableVersion.create({
    data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1, maxCount: 10, countMode },
  })
  // $100 por lugar: el conteo se lee directo en el monto.
  await prisma.servicePayTableCell.createMany({
    data: [m.hc, m.coach].flatMap(payLevelId =>
      Array.from({ length: 11 }, (_, count) => ({ versionId: v.id, payLevelId, count, amount: new Prisma.Decimal(count * 100) })),
    ),
  })
}

const valorar = async (claseId: string) =>
  (
    await valorarClases(
      prisma,
      { venueId: m.venueId, organizationId: m.orgId, tz: TZ, desde: DESDE, hasta: HASTA, ahora: AHORA },
      { limite: 50 },
    )
  ).find(c => c.classSessionId === claseId)!

beforeAll(async () => {
  m = await crearMundo('asistencia')
})
afterAll(async () => {
  await borrarMundo(m)
})

describe('«Sólo quien llegó» con desglose por método', () => {
  beforeAll(async () => {
    await tabla('ATTENDED')
  })

  it('paga sólo las llegadas y dice cómo llegó cada una; la que reservó y no vino no cuenta', async () => {
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-11-10T15:00:00.000Z',
      reservas: [
        { status: 'CHECKED_IN', checkInMethod: 'QR' },
        { status: 'COMPLETED', checkInMethod: 'QR' },
        { status: 'CHECKED_IN', checkInMethod: 'PHONE' },
        { status: 'CHECKED_IN', checkInMethod: 'STAFF', checkedInByStaffId: m.owner },
        { status: 'CHECKED_IN' }, // antes del 16-nov: sin método
        { status: 'CONFIRMED' }, // reservó y no llegó
        { status: 'NO_SHOW' },
      ],
    })
    const v = await valorar(id)
    expect(v.estado).toBe('OK')
    expect(v.countMode).toBe('ATTENDED')
    expect(v.conteo).toBe(5)
    expect(new Prisma.Decimal(v.monto!).toNumber()).toBe(500)
    expect(v.llegadas).toEqual({ qr: 2, phone: 1, staff: 1, list: 0, pass: 0, sinMetodo: 1, aMano: ['Owner QA'], corregidoA: null })
  })

  it('🔴 un grupo de 3 que llegó queda «por confirmar» y no se paga solo (fase 0b)', async () => {
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-11-11T15:00:00.000Z',
      reservas: [
        { status: 'CHECKED_IN', partySize: 3, checkInMethod: 'PHONE' },
        { status: 'CHECKED_IN', checkInMethod: 'QR' },
      ],
    })
    const v = await valorar(id)
    expect(v.estado).toBe('EXCEPCION')
    expect(v.motivo).toBe('GRUPO_POR_CONFIRMAR')
    expect(v.monto).toBeNull()
    expect(v.llegadas).toMatchObject({ phone: 3, qr: 1 })
  })

  it('con «Corregir conteo» el grupo se paga por el conteo corregido; el desglose sigue diciendo lo registrado', async () => {
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-11-12T15:00:00.000Z',
      reservas: [{ status: 'CHECKED_IN', partySize: 3, checkInMethod: 'PHONE' }],
    })
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payCountOverride: 1, overrideReason: 'llegó 1 de 3' } })
    const v = await valorar(id)
    expect(v.estado).toBe('OK')
    expect(v.conteo).toBe(1)
    expect(new Prisma.Decimal(v.monto!).toNumber()).toBe(100)
    expect(v.llegadas.phone).toBe(3)
    expect(v.llegadas.corregidoA).toBe(1)
  })

  it('Codex r2 #7: el resumen por persona suma cómo llegaron en sus clases de «sólo quien llegó»', async () => {
    const { resumenPorPersona } = await import('@/services/dashboard/staffPay/valoracion')
    const filas = await resumenPorPersona(prisma, {
      venueId: m.venueId,
      organizationId: m.orgId,
      tz: TZ,
      desde: DESDE,
      hasta: HASTA,
      ahora: AHORA,
    })
    const ana = filas.find(f => f.staffId === m.ana)!
    // Sólo las clases OK: la del grupo por confirmar no entra al resumen.
    expect(ana.llegadas).toEqual({ qr: 2, phone: 4, staff: 1, list: 0, pass: 0, sinMetodo: 1 })
  })
})
