import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, clase, crearMundo, Mundo, periodoCerrado } from './_mundo'

let m: Mundo
let periodId: string
beforeAll(async () => {
  m = await crearMundo('checks')
  periodId = (await periodoCerrado(m, '2026-08-01', '2026-08-31')).id
})
afterAll(() => borrarMundo(m))

const linea = (extra: Record<string, unknown>) =>
  prisma.serviceEarning.create({
    data: {
      organizationId: m.orgId,
      venueId: m.venueId,
      periodId,
      staffId: m.ana,
      amount: new Prisma.Decimal(10),
      descriptor: {},
      ...extra,
    } as any,
  })

describe('CHECK de ServiceEarning (spec §5.6)', () => {
  it.each([
    ['SERVICE sin sourceId', { concept: 'SERVICE', sourceType: 'CLASS_SESSION' }],
    ['SERVICE sin sourceType', { concept: 'SERVICE', sourceId: 'x' }],
    ['RECONCILE sin fuente', { concept: 'RECONCILE' }],
    ['MANUAL con fuente', { concept: 'MANUAL', sourceType: 'CLASS_SESSION', sourceId: 'x' }],
    ['SERVICE negativo', { concept: 'SERVICE', sourceType: 'CLASS_SESSION', sourceId: 'x', amount: new Prisma.Decimal(-1) }],
  ])('rechaza %s', async (_n, extra) => {
    await expect(linea(extra)).rejects.toThrow()
  })
  it('acepta un MANUAL sin fuente y un RECONCILE negativo con fuente', async () => {
    await expect(linea({ concept: 'MANUAL' })).resolves.toBeDefined()
    await expect(
      linea({ concept: 'RECONCILE', sourceType: 'CLASS_SESSION', sourceId: 'x', amount: new Prisma.Decimal(-40) }),
    ).resolves.toBeDefined()
  })
})

describe('CHECK e índices de la fase 3 (spec fase 3 §6.1, §6.4, §7.1)', () => {
  it('el inicio de pago al personal es una fecha civil (DATE, sin hora ni zona)', async () => {
    const [c] = await prisma.$queryRaw<Array<{ data_type: string }>>`
      SELECT data_type FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'staffPayStartDate'`
    expect(c.data_type).toBe('date')
  })

  it('un SERVICE de comisión o de propina puede ser negativo (reverso, propina devuelta); uno de clase, no', async () => {
    const neg = (sourceType: string, sourceId: string, amount: number) =>
      linea({ concept: 'SERVICE', sourceType, sourceId: `${m.key}-${sourceId}`, amount: new Prisma.Decimal(amount) })
    await expect(neg('COMMISSION', 'c-neg', -36)).resolves.toBeDefined()
    await expect(neg('TIP', 'p-neg', -50)).resolves.toBeDefined()
    await expect(neg('CLASS_SESSION', 'k-neg', -1)).rejects.toThrow()
  })

  it('el reverso por anulación de una comisión es único por comisión y persona; los RECONCILE de clase no', async () => {
    const x = { concept: 'RECONCILE', sourceType: 'COMMISSION', sourceId: `${m.key}-c-anulada`, amount: new Prisma.Decimal(-90) }
    await linea(x)
    await expect(linea(x)).rejects.toThrow()
    const k = { concept: 'RECONCILE', sourceType: 'CLASS_SESSION', sourceId: `${m.key}-k-liq`, amount: new Prisma.Decimal(40) }
    await linea(k)
    await expect(linea(k)).resolves.toBeDefined()
  })

  it('a lo más UNA ventana de propinas abierta por organización; nunca termina antes de empezar ni sin quién la cerró', async () => {
    const ventana = (extra: Record<string, unknown> = {}) =>
      prisma.staffPayTipWindow.create({
        data: { organizationId: m.orgId, startsAt: new Date('2026-08-02T06:00:00Z'), startedById: m.owner, ...extra } as any,
      })
    await ventana()
    await expect(ventana()).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-01T06:00:00Z'), endedById: m.owner })).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-03T06:00:00Z') })).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-03T06:00:00Z'), endedById: m.owner })).resolves.toBeDefined()
  })
})

describe('CHECK de las reglas de clase (spec fase 3 §7.3)', () => {
  let tableId: string
  let rev = 0
  beforeAll(async () => {
    tableId = (await prisma.servicePayTable.create({ data: { venueId: m.venueId, name: 'Reglas', productIds: [] } })).id
  })
  const version = (reglas: Record<string, unknown>) =>
    prisma.servicePayTableVersion.create({
      data: { tableId, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: ++rev, maxCount: 10, ...reglas } as any,
    })
  const bono = (x: string) => new Prisma.Decimal(x)

  it.each([
    ['horas de suplencia sin bono', { coverBonusHours: 3 }, 'suplencia'],
    ['bono de suplencia sin horas', { coverBonusAmount: bono('100') }, 'suplencia'],
    ['suplencia con 0 horas', { coverBonusHours: 0, coverBonusAmount: bono('100') }, 'suplencia'],
    ['suplencia con 169 horas', { coverBonusHours: 169, coverBonusAmount: bono('100') }, 'suplencia'],
    ['bono de $0', { coverBonusHours: 3, coverBonusAmount: bono('0') }, 'suplencia'],
    ['bono de más de $100,000', { coverBonusHours: 3, coverBonusAmount: bono('100000.01') }, 'suplencia'],
    ['cancelación con 0 horas', { lateCancelHours: 0 }, 'cancelacion'],
    ['cancelación con 169 horas', { lateCancelHours: 169 }, 'cancelacion'],
  ])('rechaza %s', async (_n, reglas, regla) => {
    // El nombre del CHECK: que el rechazo venga de la base y no de otro error (un campo desconocido también rechazaría).
    await expect(version(reglas)).rejects.toThrow(`ServicePayTableVersion_${regla}_valida`)
  })

  it('acepta las reglas apagadas y en sus dos límites', async () => {
    await expect(version({})).resolves.toBeDefined()
    await expect(version({ coverBonusHours: 1, coverBonusAmount: bono('0.01'), lateCancelHours: 168 })).resolves.toBeDefined()
    await expect(version({ coverBonusHours: 168, coverBonusAmount: bono('100000'), lateCancelHours: 1 })).resolves.toBeDefined()
  })
})

describe('backfill de la migración de reglas de clase (spec fase 3 §7.2)', () => {
  const MIGRACIONES = path.resolve(__dirname, '../../../prisma/migrations')
  class Revertir extends Error {}

  it('estampa sólo lo vacío: con coach (original y createdAt) y canceladas (updatedAt); repetirlo no cambia nada', async () => {
    const carpeta = readdirSync(MIGRACIONES).find(d => d.endsWith('_service_pay_reglas_de_clase'))
    expect(carpeta).toBeDefined()
    const sql = readFileSync(path.join(MIGRACIONES, carpeta!, 'migration.sql'), 'utf8')
    const backfill = sql
      .split('-- BACKFILL:INICIO')[1]
      .split('-- BACKFILL:FIN')[0]
      .split(';')
      .map(s => s.trim())
      .filter(s => s.includes('UPDATE'))
    expect(backfill).toHaveLength(2)

    // `clase()` crea sin estampas: igual que una clase de antes de la migración.
    const conCoach = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z' })
    const cancelada = await clase(m, { staffId: m.sofia, inicioIso: '2026-08-05T14:00:00Z', status: 'CANCELLED' })
    const sinCoach = await clase(m, { staffId: null, inicioIso: '2026-08-06T14:00:00Z' })
    const yaEstampada = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-08-07T14:00:00Z',
      originalStaffId: m.carla,
      staffAssignedAt: '2026-08-07T12:00:00Z',
    })
    const ids = [conCoach, cancelada, sinCoach, yaEstampada]
    type Fila = {
      id: string
      createdAt: Date
      updatedAt: Date
      originalStaffId: string | null
      staffAssignedAt: Date | null
      cancelledAt: Date | null
    }
    let filas: Fila[] = []
    await prisma
      .$transaction(
        async tx => {
          // Dos veces: la segunda no cambia nada. Se revierte al final porque la base de pruebas es compartida.
          for (const s of [...backfill, ...backfill]) await tx.$executeRawUnsafe(s)
          filas = await tx.classSession.findMany({
            where: { id: { in: ids } },
            select: { id: true, createdAt: true, updatedAt: true, originalStaffId: true, staffAssignedAt: true, cancelledAt: true },
            take: ids.length,
          })
          throw new Revertir()
        },
        { timeout: 60_000 },
      )
      .catch(e => {
        if (!(e instanceof Revertir)) throw e
      })
    const de = new Map(filas.map(f => [f.id, f]))
    expect(de.get(conCoach)).toMatchObject({ originalStaffId: m.ana, staffAssignedAt: de.get(conCoach)!.createdAt, cancelledAt: null })
    expect(de.get(cancelada)).toMatchObject({ originalStaffId: m.sofia, cancelledAt: de.get(cancelada)!.updatedAt })
    expect(de.get(sinCoach)).toMatchObject({ originalStaffId: null, staffAssignedAt: null, cancelledAt: null })
    expect(de.get(yaEstampada)).toMatchObject({ originalStaffId: m.carla, staffAssignedAt: new Date('2026-08-07T12:00:00Z') })
    // Fuera de la transacción revertida no cambió nada.
    expect(await prisma.classSession.findUniqueOrThrow({ where: { id: conCoach }, select: { originalStaffId: true } })).toEqual({
      originalStaffId: null,
    })
  })
})
