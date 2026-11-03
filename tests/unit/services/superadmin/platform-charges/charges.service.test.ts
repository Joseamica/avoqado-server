import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  createCharge,
  generateAllActive,
  listCharges,
  pauseCharge,
  resumeCharge,
  updateCharge,
} from '@/services/superadmin/platform-charges/charges.service'
import type { ChargeConceptInput, ChargeInput } from '@/services/superadmin/platform-charges/charges.service'
import { addDays, calendarDayToDb } from '@/services/superadmin/platform-charges/schedule'
import type { ChargeConcept } from '@/services/superadmin/platform-charges/types'

/**
 * «Por cobrar» — cobros recurrentes y su generador (spec 2026-11-02-por-cobrar-superadmin §3.3 y §3.4).
 *
 * Es dinero y fechas, así que esta suite se corre también con `TZ=UTC` y con otras zonas (la zona se fija ANTES de que
 * arranque Jest). Las ocurrencias se prueban contra un doble en memoria de `platformChargeOccurrence` (`instalarOcurrencias`):
 * lo que se afirma es el ESTADO final de las filas (qué se conservó, qué se borró, qué se regeneró), no la forma exacta de cada
 * llamada a Prisma. El doble se niega a operar sin `chargeId`, así que ninguna prueba puede pasar con una operación que cruce
 * cobros. Que la fila de verdad bloquee a la otra transacción lo prueba la integración contra Postgres (tarea posterior).
 */

const mockLogAction = logAction as jest.Mock
const mockLoggerError = (logger as unknown as { error: jest.Mock }).error

const AHORA = new Date('2026-11-02T18:00:00.000Z') // 12:00 en CDMX · lunes 2-nov-2026
const AHORA_TARDE = new Date('2026-11-03T03:30:00.000Z') // 21:30 del 2-nov en CDMX, pero en UTC ya es 3-nov

const RENTA: ChargeConcept = {
  description: 'Renta de terminal',
  amountCents: 50000,
  ivaMode: 'WITHOUT_IVA',
  satProductKey: '81112401',
  satUnitKey: 'E48',
}
const LICENCIA: ChargeConcept = {
  description: 'Licencia',
  amountCents: 49900,
  ivaMode: 'WITH_IVA',
  satProductKey: '43232611',
  satUnitKey: 'E48',
}
/** $500 sin IVA + $499 con IVA, a mano: A=50000, B=49900 → subtotal 93017, IVA 14883, total 107900 (= 58000 + 49900). */
const TOTALES_MIXTOS = { subtotalCents: 93017, taxCents: 14883, totalCents: 107900 }

const PERFIL_DE_LA_ORG = { id: 'perfil-1', customerType: 'ORGANIZATION', organizationId: 'org-1', venueId: null }

function entrada(over: Partial<ChargeInput> = {}): ChargeInput {
  return {
    customerType: 'ORGANIZATION',
    organizationId: 'org-1',
    customerName: 'Estética Luna',
    billingTaxProfileId: 'perfil-1',
    frequency: 'WEEKLY',
    anchorDate: '2026-10-03',
    concepts: [RENTA, LICENCIA],
    invoiceMode: 'AUTOMATIC',
    ...over,
  }
}

/** Un cobro semanal (lunes) de la organización org-1, con su ancla el 5-oct. */
function cobro(over: Record<string, unknown> = {}) {
  return {
    id: 'cobro-1',
    customerType: 'ORGANIZATION',
    organizationId: 'org-1',
    venueId: null,
    customerName: 'Estética Luna',
    billingTaxProfileId: 'perfil-1',
    frequency: 'WEEKLY',
    anchorDate: calendarDayToDb('2026-10-05'),
    concepts: [RENTA, LICENCIA],
    invoiceMode: 'AUTOMATIC',
    pausedAt: null,
    createdById: 'staff-0',
    createdAt: new Date('2026-10-05T15:00:00.000Z'),
    updatedAt: new Date('2026-10-05T15:00:00.000Z'),
    ...over,
  }
}

/** El cobro que `findUnique` relee dentro del candado, y el `update` que lo devuelve ya cambiado. */
function dadoElCobro(row: ReturnType<typeof cobro> = cobro()) {
  prismaMock.platformCharge.findUnique.mockResolvedValue(row)
  prismaMock.platformCharge.update.mockImplementation(async ({ data }: any) => ({ ...row, ...data }))
  return row
}

// ── Doble en memoria de las ocurrencias ───────────────────────────────────────────────────────────────────────────────────

interface Fila {
  id: string
  chargeId: string
  dueDate: Date
  concepts: unknown
  subtotalCents: number
  taxCents: number
  totalCents: number
  invoiceMode: string
  status: string
  paidAt: Date | null
  paidById: string | null
  skippedAt: Date | null
  skippedById: string | null
  invoiceSeq: number
}

function fila(dueDate: string, over: Partial<Fila> = {}): Fila {
  return {
    id: `o-${dueDate}`,
    chargeId: 'cobro-1',
    dueDate: calendarDayToDb(dueDate),
    concepts: [RENTA, LICENCIA],
    ...TOTALES_MIXTOS,
    invoiceMode: 'AUTOMATIC',
    status: 'PENDING',
    paidAt: null,
    paidById: null,
    skippedAt: null,
    skippedById: null,
    invoiceSeq: 0,
    ...over,
  }
}

/** ¿La fila cumple el `where` de Prisma? Sólo entiende lo que el servicio usa: igualdad, `in`, `gt`, `gte`, `lt` y `lte`. */
function cumple(f: Fila, where: Record<string, any>): boolean {
  if (where.chargeId === undefined) throw new Error('el doble exige chargeId: ninguna operación puede cruzar cobros')
  return Object.entries(where).every(([campo, condicion]) => {
    const valor = (f as any)[campo]
    if (condicion === null || typeof condicion !== 'object' || condicion instanceof Date) {
      return valor instanceof Date ? valor.getTime() === condicion.getTime() : valor === condicion
    }
    return Object.entries(condicion as Record<string, any>).every(([operador, limite]) => {
      if (operador === 'in') return limite.includes(valor)
      if (operador === 'gt') return valor > limite
      if (operador === 'gte') return valor >= limite
      if (operador === 'lt') return valor < limite
      if (operador === 'lte') return valor <= limite
      throw new Error(`el doble no conoce el operador ${operador}`)
    })
  })
}

/** Instala `createMany` (con `skipDuplicates` sobre la llave única `[chargeId, dueDate]`), `deleteMany`, `updateMany`, `update` por id y `findFirst`. */
function instalarOcurrencias(inicial: Fila[]): Fila[] {
  const filas = [...inicial]
  let n = 0
  const ocurrencias = prismaMock.platformChargeOccurrence
  ocurrencias.createMany.mockImplementation(async ({ data, skipDuplicates }: any) => {
    let count = 0
    for (const d of data) {
      const existe = filas.some(f => f.chargeId === d.chargeId && f.dueDate.getTime() === d.dueDate.getTime())
      if (existe) {
        if (skipDuplicates) continue
        throw new Error('Unique constraint failed on the fields: (chargeId, dueDate)')
      }
      filas.push({
        id: `nueva-${++n}`,
        status: 'PENDING',
        paidAt: null,
        paidById: null,
        skippedAt: null,
        skippedById: null,
        invoiceSeq: 0,
        ...d,
      })
      count++
    }
    return { count }
  })
  ocurrencias.deleteMany.mockImplementation(async ({ where }: any) => {
    const borrar = filas.filter(f => cumple(f, where))
    for (const f of borrar) filas.splice(filas.indexOf(f), 1)
    return { count: borrar.length }
  })
  ocurrencias.updateMany.mockImplementation(async ({ where, data }: any) => {
    const tocar = filas.filter(f => cumple(f, where))
    for (const f of tocar) Object.assign(f, data)
    return { count: tocar.length }
  })
  ocurrencias.update.mockImplementation(async ({ where, data }: any) => {
    const f = filas.find(x => x.id === where.id)
    if (!f) throw new Error(`el doble no encuentra la fila ${where.id}`)
    Object.assign(f, data)
    return f
  })
  ocurrencias.findFirst.mockImplementation(async ({ where, orderBy }: any) => {
    const halladas = filas.filter(f => cumple(f, where))
    if (orderBy?.dueDate === 'asc') halladas.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
    if (orderBy?.dueDate === 'desc') halladas.sort((a, b) => b.dueDate.getTime() - a.dueDate.getTime())
    return halladas[0] ?? null
  })
  return filas
}

interface Factura {
  id: string
  platformChargeOccurrenceId: string
  status: string
}

/**
 * Instala `platformCfdi.findFirst` sobre una lista de facturas. Entiende lo que el servicio pregunta —la fecha y `status in`— y se
 * niega a operar sin la fecha: ninguna prueba puede pasar con una consulta que mire las facturas de todas.
 */
function instalarFacturas(facturas: Factura[]) {
  prismaMock.platformCfdi.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.platformChargeOccurrenceId === undefined) throw new Error('el doble exige la fecha: ninguna consulta puede cruzar fechas')
    return (
      facturas.find(
        f => f.platformChargeOccurrenceId === where.platformChargeOccurrenceId && (!where.status?.in || where.status.in.includes(f.status)),
      ) ?? null
    )
  })
}

const dia = (d: Date) => d.toISOString().slice(0, 10)
/** `['2026-11-02:PENDING', …]` por fecha: el estado final de las filas, legible. */
const resumen = (filas: Fila[]) =>
  [...filas].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime()).map(f => `${dia(f.dueDate)}:${f.status}`)
const porDia = (filas: Fila[]) => Object.fromEntries(filas.map(f => [dia(f.dueDate), f]))

// ── Traza de lo que pasa dentro y fuera de la transacción ─────────────────────────────────────────────────────────────────

/** Anota en orden cada paso que importa. Se llama DESPUÉS de instalar los dobles: envuelve lo que haya. */
function trazar(): string[] {
  const eventos: string[] = []
  const anotar = (mock: jest.Mock, nombre: string) => {
    const original = mock.getMockImplementation()
    mock.mockImplementation(async (...args: unknown[]) => {
      eventos.push(nombre)
      return original?.(...args)
    })
  }
  anotar(prismaMock.$queryRaw, 'candado')
  anotar(prismaMock.billingTaxProfile.findUnique, 'leer perfil')
  anotar(prismaMock.platformCharge.create, 'crear cobro')
  anotar(prismaMock.platformCharge.findUnique, 'leer cobro')
  anotar(prismaMock.platformCharge.update, 'actualizar cobro')
  anotar(prismaMock.platformChargeOccurrence.findFirst, 'revisar marcadas')
  anotar(prismaMock.platformCfdi.findFirst, 'revisar factura')
  anotar(prismaMock.platformChargeOccurrence.update, 'actualizar fecha')
  anotar(prismaMock.platformChargeOccurrence.deleteMany, 'borrar futuras')
  anotar(prismaMock.platformChargeOccurrence.createMany, 'crear fechas')
  anotar(prismaMock.platformChargeOccurrence.updateMany, 'omitir vencidas')
  mockLogAction.mockImplementation(() => {
    eventos.push('bitácora')
  })
  prismaMock.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
    eventos.push('tx:inicio')
    try {
      return await callback(prismaMock)
    } finally {
      eventos.push('tx:fin')
    }
  })
  return eventos
}

const dentroDeLaTransaccion = (eventos: string[]) => eventos.slice(eventos.indexOf('tx:inicio') + 1, eventos.indexOf('tx:fin'))

function ningunaEscritura() {
  expect(prismaMock.platformCharge.create).not.toHaveBeenCalled()
  expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
  expect(prismaMock.platformChargeOccurrence.createMany).not.toHaveBeenCalled()
  expect(prismaMock.platformChargeOccurrence.deleteMany).not.toHaveBeenCalled()
  expect(prismaMock.platformChargeOccurrence.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
  expect(mockLogAction).not.toHaveBeenCalled()
}

beforeEach(() => {
  for (const fn of [
    prismaMock.$queryRaw,
    prismaMock.billingTaxProfile.findUnique,
    prismaMock.platformCharge.create,
    prismaMock.platformCharge.update,
    prismaMock.platformCharge.findUnique,
    prismaMock.platformCharge.findMany,
    prismaMock.platformCharge.count,
    prismaMock.platformChargeOccurrence.createMany,
    prismaMock.platformChargeOccurrence.deleteMany,
    prismaMock.platformChargeOccurrence.updateMany,
    prismaMock.platformChargeOccurrence.findFirst,
    prismaMock.platformChargeOccurrence.update,
    prismaMock.platformCfdi.findFirst,
    mockLogAction,
    mockLoggerError,
  ]) {
    fn.mockReset()
  }
  // El candado devuelve la fila que se pidió, sea cual sea el id.
  prismaMock.$queryRaw.mockImplementation(async (_partes: unknown, id: string) => [{ id }])
  prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PERFIL_DE_LA_ORG)
  prismaMock.platformCharge.create.mockImplementation(async ({ data }: any) => ({
    id: 'cobro-nuevo',
    ...data,
    pausedAt: null,
    createdAt: AHORA,
    updatedAt: AHORA,
  }))
  prismaMock.platformChargeOccurrence.createMany.mockResolvedValue({ count: 0 })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — createCharge (NEW)', () => {
  it('con ancla hace 30 días genera desde el ancla hasta hoy+7, con la foto de conceptos, totales y modo', async () => {
    const creado = await createCharge(entrada({ anchorDate: '2026-10-03' }), 'staff-1', AHORA)

    expect(creado.id).toBe('cobro-nuevo')
    expect(prismaMock.platformCharge.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.platformCharge.create).toHaveBeenCalledWith({
      data: {
        customerType: 'ORGANIZATION',
        organizationId: 'org-1',
        venueId: null,
        customerName: 'Estética Luna',
        billingTaxProfileId: 'perfil-1',
        frequency: 'WEEKLY',
        anchorDate: new Date('2026-10-03T00:00:00.000Z'),
        concepts: [RENTA, LICENCIA],
        invoiceMode: 'AUTOMATIC',
        createdById: 'staff-1',
      },
    })
    expect(prismaMock.platformChargeOccurrence.createMany).toHaveBeenCalledTimes(1)
    const { data, skipDuplicates } = prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0]
    expect(skipDuplicates).toBe(true)
    // 3-oct + 7·k hasta el 9-nov (hoy 2-nov + 7): seis fechas, las de antes de hoy quedan vencidas.
    expect(data.map((d: any) => d.dueDate.toISOString())).toEqual([
      '2026-10-03T00:00:00.000Z',
      '2026-10-10T00:00:00.000Z',
      '2026-10-17T00:00:00.000Z',
      '2026-10-24T00:00:00.000Z',
      '2026-10-31T00:00:00.000Z',
      '2026-11-07T00:00:00.000Z',
    ])
    for (const d of data) {
      expect(d).toEqual({
        chargeId: 'cobro-nuevo',
        dueDate: expect.any(Date),
        concepts: [RENTA, LICENCIA],
        ...TOTALES_MIXTOS,
        invoiceMode: 'AUTOMATIC',
      })
    }
  })

  it.each([
    ['MONTHLY', '2026-10-31', ['2026-10-31']], // el 30-nov queda fuera de la ventana
    ['BIWEEKLY', '2026-10-20', ['2026-10-20', '2026-11-05']], // días fijos 5 y 20
  ] as const)('respeta la periodicidad %s', async (frequency, anchorDate, fechas) => {
    await createCharge(entrada({ frequency, anchorDate }), 'staff-1', AHORA)

    const { data } = prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0]
    expect(data.map((d: any) => dia(d.dueDate))).toEqual(fechas)
  })

  it('la foto lleva el modo de factura del cobro (MANUAL) y los totales de cada concepto sin IVA', async () => {
    await createCharge(
      entrada({ invoiceMode: 'MANUAL', billingTaxProfileId: undefined, concepts: [RENTA], anchorDate: '2026-11-02' }),
      'staff-1',
      AHORA,
    )

    const { data } = prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0]
    expect(data.map((d: any) => dia(d.dueDate))).toEqual(['2026-11-02', '2026-11-09'])
    expect(data[0]).toMatchObject({ invoiceMode: 'MANUAL', subtotalCents: 50000, taxCents: 8000, totalCents: 58000 })
  })

  it('un ancla futura dentro de la ventana crea sólo su fecha; más allá de hoy+7 crea el cobro sin ocurrencias todavía', async () => {
    await createCharge(entrada({ anchorDate: '2026-11-06' }), 'staff-1', AHORA)
    expect(prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0].data.map((d: any) => dia(d.dueDate))).toEqual(['2026-11-06'])

    prismaMock.platformChargeOccurrence.createMany.mockClear()
    await createCharge(entrada({ anchorDate: '2026-12-02' }), 'staff-1', AHORA)
    expect(prismaMock.platformCharge.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.platformChargeOccurrence.createMany).not.toHaveBeenCalled() // el generador diario las crea cuando toque
  })

  it('"hoy" es el día de CDMX, no el de UTC: a las 21:30 del 2-nov el límite de +366 días sigue contando desde el 2-nov', async () => {
    await expect(createCharge(entrada({ anchorDate: '2027-11-04' }), 'staff-1', AHORA_TARDE)).rejects.toBeInstanceOf(BadRequestError)
    await expect(createCharge(entrada({ anchorDate: '2027-11-03' }), 'staff-1', AHORA_TARDE)).resolves.toBeDefined()
  })

  it('guarda el nombre y las descripciones sin espacios de sobra', async () => {
    await createCharge(
      entrada({ customerName: '  Estética Luna  ', concepts: [{ ...RENTA, description: ' Renta de terminal ', satUnitKey: ' E48 ' }] }),
      'staff-1',
      AHORA,
    )

    const { data } = prismaMock.platformCharge.create.mock.calls[0][0]
    expect(data.customerName).toBe('Estética Luna')
    expect(data.concepts).toEqual([RENTA])
  })

  describe('rechaza lo inválido sin escribir nada', () => {
    it.each([
      ['hace 367 días', '2025-10-31'],
      ['dentro de 367 días', '2027-11-04'],
    ])('ancla %s (el límite es hoy±366 días)', async (_nombre, anchorDate) => {
      await expect(createCharge(entrada({ anchorDate }), 'staff-1', AHORA)).rejects.toThrow(/366 días/)
      ningunaEscritura()
    })

    it.each([
      ['hace 366 días', '2025-11-01'],
      ['dentro de 366 días', '2027-11-03'],
    ])('ancla %s sí pasa (los dos extremos son inclusivos)', async (_nombre, anchorDate) => {
      await expect(createCharge(entrada({ anchorDate }), 'staff-1', AHORA)).resolves.toBeDefined()
    })

    it.each([[''], ['2026-02-30'], ['2026-11-02T00:00:00.000Z'], ['02/11/2026'], ['mañana'], [undefined], [20261102]])(
      'ancla inválida (%p)',
      async anchorDate => {
        await expect(createCharge(entrada({ anchorDate: anchorDate as never }), 'staff-1', AHORA)).rejects.toThrow(
          /La fecha de inicio no es válida/,
        )
        ningunaEscritura()
      },
    )

    it.each([
      ['sin conceptos', [], /al menos un concepto/i],
      ['conceptos que no son una lista', undefined, /al menos un concepto/i],
      ['21 conceptos (el tope es 20)', Array.from({ length: 21 }, () => RENTA), /hasta 20 conceptos/i],
      ['un concepto que no es un objeto', [null], /un concepto no es válido/i],
      ['monto 0', [{ ...RENTA, amountCents: 0 }], /mayor a \$0/],
      ['monto negativo', [{ ...RENTA, amountCents: -100 }], /mayor a \$0/],
      ['monto con decimales (centavos fraccionarios)', [{ ...RENTA, amountCents: 100.5 }], /mayor a \$0/],
      ['monto como texto', [{ ...RENTA, amountCents: '500' }], /mayor a \$0/],
      ['monto NaN', [{ ...RENTA, amountCents: NaN }], /mayor a \$0/],
      ['monto de 999,999,999 + 1 centavos', [{ ...RENTA, amountCents: 1_000_000_000 }], /no puede pasar de \$9,999,999\.99/],
      ['modo de IVA desconocido', [{ ...RENTA, ivaMode: 'EXENTO' }], /IVA/],
      ['descripción vacía', [{ ...RENTA, description: '   ' }], /descripción/],
      ['sin clave de producto del SAT', [{ ...RENTA, satProductKey: '' }], /clave del SAT/i],
      ['sin clave de unidad del SAT', [{ ...RENTA, satUnitKey: '  ' }], /clave del SAT/i],
    ] as [string, unknown, RegExp][])('conceptos: %s', async (_nombre, concepts, mensaje) => {
      const error = await createCharge(entrada({ concepts: concepts as ChargeConcept[] }), 'staff-1', AHORA).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).message).toMatch(mensaje)
      ningunaEscritura()
    })

    it('20 conceptos y un monto de exactamente 999,999,999 centavos sí pasan', async () => {
      const veinte = Array.from({ length: 20 }, (_v, i) => ({ ...LICENCIA, description: `Concepto ${i + 1}`, amountCents: 1000 }))
      await expect(createCharge(entrada({ concepts: veinte }), 'staff-1', AHORA)).resolves.toBeDefined()
      await expect(
        createCharge(entrada({ concepts: [{ ...LICENCIA, amountCents: 999_999_999 }] }), 'staff-1', AHORA),
      ).resolves.toBeDefined()
    })

    it('el total con IVA no puede pasar del Int de Postgres (2,147,483,647 centavos): 20 conceptos de 999,999,999 se rechazan', async () => {
      const veinte = Array.from({ length: 20 }, (_v, i) => ({ ...RENTA, description: `Concepto ${i + 1}`, amountCents: 999_999_999 }))

      const error = await createCharge(entrada({ concepts: veinte }), 'staff-1', AHORA).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).message).toMatch(/total del cobro.*no puede pasar de \$21,474,836\.47/i)
      ningunaEscritura()
    })

    it('sin IVA el 16 % cuenta para ese tope: dos conceptos de 999,999,999 dan 2,319,999,998 y se rechazan; con IVA dan 1,999,999,998 y pasan', async () => {
      const sinIva = [RENTA, { ...RENTA, description: 'Otra renta' }].map(c => ({ ...c, amountCents: 999_999_999 }))
      await expect(createCharge(entrada({ concepts: sinIva }), 'staff-1', AHORA)).rejects.toThrow(/\$21,474,836\.47/)
      ningunaEscritura()

      const conIva = [LICENCIA, { ...LICENCIA, description: 'Otra licencia' }].map(c => ({ ...c, amountCents: 999_999_999 }))
      await expect(createCharge(entrada({ concepts: conIva, anchorDate: '2026-11-02' }), 'staff-1', AHORA)).resolves.toBeDefined()
    })

    it('el tope es exacto: un total de 2,147,483,647 centavos pasa y de 2,147,483,648 no', async () => {
      const dosGrandes = [LICENCIA, { ...LICENCIA, description: 'Otra licencia' }].map(c => ({ ...c, amountCents: 999_999_999 }))
      const justo = [...dosGrandes, { ...LICENCIA, description: 'Resto', amountCents: 147_483_649 }]
      await expect(createCharge(entrada({ concepts: justo, anchorDate: '2026-11-02' }), 'staff-1', AHORA)).resolves.toBeDefined()
      expect(prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0].data[0].totalCents).toBe(2_147_483_647)

      const unCentavoMas = [...dosGrandes, { ...LICENCIA, description: 'Resto', amountCents: 147_483_650 }]
      await expect(createCharge(entrada({ concepts: unCentavoMas, anchorDate: '2026-11-02' }), 'staff-1', AHORA)).rejects.toThrow(
        /\$21,474,836\.47/,
      )
    })

    it.each([
      ['sin nombre de cliente', { customerName: '   ' }, /nombre del cliente/i],
      ['periodicidad desconocida', { frequency: 'DAILY' as never }, /periodicidad/i],
      ['modo de factura desconocido', { invoiceMode: 'AUTO' as never }, /factura/i],
      ['tipo de cliente desconocido', { customerType: 'OTRO' as never }, /cliente/i],
      ['una organización sin organizationId', { organizationId: undefined }, /organización/i],
      ['un negocio sin venueId', { customerType: 'VENUE' as const, organizationId: undefined }, /negocio/i],
      ['una organización que también trae venueId', { venueId: 'venue-1' }, /no coinciden/i],
      ['un negocio que también trae organizationId', { customerType: 'VENUE' as const, venueId: 'venue-1' }, /no coinciden/i],
      ['un cliente externo con organizationId', { customerType: 'STANDALONE' as const }, /no coinciden/i],
    ] as [string, Partial<ChargeInput>, RegExp][])('cliente: %s', async (_nombre, cambio, mensaje) => {
      const error = await createCharge(entrada(cambio), 'staff-1', AHORA).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).message).toMatch(mensaje)
      ningunaEscritura()
    })

    it('AUTOMATIC sin perfil fiscal se rechaza (también con un id en blanco), y ni siquiera busca un perfil', async () => {
      for (const billingTaxProfileId of [undefined, '', '   ']) {
        const error = await createCharge(entrada({ billingTaxProfileId }), 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(BadRequestError)
        expect((error as BadRequestError).message).toMatch(/datos fiscales/i)
        expect((error as BadRequestError).code).toBe('PLATFORM_CHARGE_NEEDS_TAX_PROFILE')
      }
      expect(prismaMock.billingTaxProfile.findUnique).not.toHaveBeenCalled()
      ningunaEscritura()
    })

    it('MANUAL puede no traer perfil fiscal (se pide al facturar): se guarda con billingTaxProfileId null', async () => {
      await createCharge(entrada({ invoiceMode: 'MANUAL', billingTaxProfileId: undefined }), 'staff-1', AHORA)

      expect(prismaMock.billingTaxProfile.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.platformCharge.create.mock.calls[0][0].data.billingTaxProfileId).toBeNull()
    })

    it('un perfil que no existe se rechaza', async () => {
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue(null)

      await expect(createCharge(entrada(), 'staff-1', AHORA)).rejects.toThrow(/perfil fiscal no existe/i)
      ningunaEscritura()
    })

    it.each([
      ['una organización con un perfil de OTRA organización', {}, { organizationId: 'org-2' }],
      ['una organización con el perfil de un negocio', {}, { customerType: 'VENUE', organizationId: null, venueId: 'venue-1' }],
      [
        'un negocio con el perfil de OTRO negocio',
        { customerType: 'VENUE' as const, organizationId: undefined, venueId: 'venue-1' },
        { customerType: 'VENUE', organizationId: null, venueId: 'venue-2' },
      ],
      [
        'un cliente externo con el perfil de una organización',
        { customerType: 'STANDALONE' as const, organizationId: undefined },
        { customerType: 'ORGANIZATION', organizationId: 'org-1' },
      ],
    ] as [string, Partial<ChargeInput>, Record<string, unknown>][])(
      'perfil que no es de ese cliente: %s',
      async (_nombre, cliente, perfil) => {
        prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ ...PERFIL_DE_LA_ORG, ...perfil })

        const error = await createCharge(entrada(cliente), 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(BadRequestError)
        expect((error as BadRequestError).message).toMatch(/no es de este cliente/i)
        ningunaEscritura()
      },
    )

    it('un perfil que no es del cliente se rechaza también en MANUAL: el dato fiscal de otro nunca se guarda', async () => {
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ ...PERFIL_DE_LA_ORG, organizationId: 'org-2' })

      await expect(createCharge(entrada({ invoiceMode: 'MANUAL' }), 'staff-1', AHORA)).rejects.toThrow(/no es de este cliente/i)
      ningunaEscritura()
    })
  })

  it.each([
    ['una organización', {}, PERFIL_DE_LA_ORG],
    [
      'un negocio',
      { customerType: 'VENUE' as const, organizationId: undefined, venueId: 'venue-1' },
      { id: 'perfil-1', customerType: 'VENUE', organizationId: null, venueId: 'venue-1' },
    ],
    [
      'un cliente externo',
      { customerType: 'STANDALONE' as const, organizationId: undefined },
      { id: 'perfil-1', customerType: 'STANDALONE', organizationId: null, venueId: null },
    ],
  ] as [string, Partial<ChargeInput>, Record<string, unknown>][])(
    'acepta el perfil fiscal de %s y guarda sólo sus ids',
    async (_nombre, cliente, perfil) => {
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue(perfil)

      await createCharge(entrada(cliente), 'staff-1', AHORA)

      const { data } = prismaMock.platformCharge.create.mock.calls[0][0]
      expect(data).toMatchObject({
        customerType: cliente.customerType ?? 'ORGANIZATION',
        organizationId: cliente.customerType === undefined ? 'org-1' : null,
        venueId: cliente.venueId ?? null,
        billingTaxProfileId: 'perfil-1',
      })
    },
  )

  it('el cobro, el candado y sus fechas nacen en UNA transacción; la bitácora va DESPUÉS, fuera de ella', async () => {
    const eventos = trazar()

    await createCharge(entrada(), 'staff-1', AHORA)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(dentroDeLaTransaccion(eventos)).toEqual(['leer perfil', 'crear cobro', 'candado', 'revisar marcadas', 'crear fechas'])
    expect(eventos[eventos.length - 1]).toBe('bitácora')
    expect(mockLogAction).toHaveBeenCalledTimes(1)
  })

  it('registra PLATFORM_CHARGE_CREATED con quién, el venue y la organización', async () => {
    await createCharge(entrada(), 'staff-1', AHORA)

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PLATFORM_CHARGE_CREATED',
        staffId: 'staff-1',
        venueId: null,
        organizationId: 'org-1',
        entity: 'PlatformCharge',
        entityId: 'cobro-nuevo',
      }),
    )
  })

  it('para un negocio la bitácora lleva su venueId (y organizationId null)', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({
      id: 'perfil-1',
      customerType: 'VENUE',
      organizationId: null,
      venueId: 'venue-1',
    })

    await createCharge(entrada({ customerType: 'VENUE', organizationId: undefined, venueId: 'venue-1' }), 'staff-1', AHORA)

    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'venue-1', organizationId: null }))
  })

  it('si la generación falla, el error se propaga y NO se registra como creado (la transacción se deshace)', async () => {
    prismaMock.platformChargeOccurrence.createMany.mockRejectedValue(new Error('connection reset'))

    await expect(createCharge(entrada(), 'staff-1', AHORA)).rejects.toThrow('connection reset')

    expect(mockLogAction).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — updateCharge (NEW)', () => {
  // Cobro semanal (lunes) con ancla el 5-oct. Hoy es lunes 2-nov: el 26-oct está vencida, el 2-nov es de hoy, el 9-nov es futura.
  const TRES = () => [fila('2026-10-26'), fila('2026-11-02'), fila('2026-11-09')]
  const NUEVOS_CONCEPTOS = [{ ...RENTA, amountCents: 100000 }] // A=100000 → subtotal 100000, IVA 16000, total 116000

  it('borra sólo las PENDING con fecha mayor a hoy y las regenera con la foto nueva; lo vencido y lo de hoy conservan la suya', async () => {
    const filas = instalarOcurrencias(TRES())
    dadoElCobro()

    await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)

    expect(resumen(filas)).toEqual(['2026-10-26:PENDING', '2026-11-02:PENDING', '2026-11-09:PENDING'])
    const por = porDia(filas)
    expect(por['2026-10-26']).toMatchObject({ id: 'o-2026-10-26', totalCents: 107900, concepts: [RENTA, LICENCIA] })
    expect(por['2026-11-02']).toMatchObject({ id: 'o-2026-11-02', totalCents: 107900, concepts: [RENTA, LICENCIA] })
    expect(por['2026-11-09']).toMatchObject({
      subtotalCents: 100000,
      taxCents: 16000,
      totalCents: 116000,
      concepts: NUEVOS_CONCEPTOS,
    })
    expect(por['2026-11-09'].id).not.toBe('o-2026-11-09') // se borró y se volvió a crear
  })

  it('cambiar el modo de factura no toca lo ya generado (vencido y de hoy siguen con el suyo); lo futuro nace con el nuevo', async () => {
    const filas = instalarOcurrencias(TRES())
    dadoElCobro()

    await updateCharge('cobro-1', { invoiceMode: 'MANUAL' }, 'staff-1', AHORA)

    const por = porDia(filas)
    expect(por['2026-10-26'].invoiceMode).toBe('AUTOMATIC')
    expect(por['2026-11-02'].invoiceMode).toBe('AUTOMATIC')
    expect(por['2026-11-09'].invoiceMode).toBe('MANUAL')
    expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({
      where: { id: 'cobro-1' },
      data: expect.objectContaining({ invoiceMode: 'MANUAL' }),
    })
  })

  it('regenera de hoy a hoy+7 con el calendario nuevo, y nunca crea fechas anteriores a hoy', async () => {
    const filas = instalarOcurrencias(TRES())
    dadoElCobro()

    // Mismo lunes cada semana → ahora miércoles (7-oct + 7·k): el 4-nov cae en la ventana, el 28-oct ya pasó y no se inventa.
    await updateCharge('cobro-1', { anchorDate: '2026-10-07' }, 'staff-1', AHORA)

    // Lo de hoy (2-nov) ya no cae en el calendario nuevo y se va; lo vencido (26-oct) se queda.
    expect(resumen(filas)).toEqual(['2026-10-26:PENDING', '2026-11-04:PENDING'])
    expect(prismaMock.platformCharge.update.mock.calls[0][0].data.anchorDate).toEqual(new Date('2026-10-07T00:00:00.000Z'))
  })

  it('una ancla futura más allá de hoy+7 deja lo futuro sin generar hasta que el generador diario llegue', async () => {
    const filas = instalarOcurrencias(TRES())
    dadoElCobro()

    await updateCharge('cobro-1', { anchorDate: '2026-12-07' }, 'staff-1', AHORA)

    expect(resumen(filas)).toEqual(['2026-10-26:PENDING'])
  })

  describe('🔴 mover la fecha con lo de este periodo ya pagado u omitido: no se vuelve a cobrar', () => {
    // Hoy es 2-nov. La mensualidad del día 2 ya se marcó y el cobro se mueve a otro día.
    const dadaLaDeHoyMarcada = (status: 'PAID' | 'SKIPPED' = 'PAID') =>
      instalarOcurrencias([fila('2026-11-02', status === 'PAID' ? { status, paidAt: AHORA, paidById: 'staff-9' } : { status })])
    const tareaDiaria = async (dia: string, row: ReturnType<typeof cobro>) => {
      prismaMock.platformCharge.findMany.mockResolvedValueOnce([{ id: 'cobro-1' }])
      prismaMock.platformCharge.findUnique.mockResolvedValue(row)
      await generateAllActive(new Date(`${dia}T18:00:00.000Z`))
    }

    it.each(['PAID', 'SKIPPED'] as const)('mensualidad %s hoy que se mueve a mañana: no vuelve a salir', async status => {
      const filas = dadaLaDeHoyMarcada(status)
      dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-02') }))

      await updateCharge('cobro-1', { anchorDate: '2026-10-03' }, 'staff-1', AHORA)

      expect(resumen(filas)).toEqual([`2026-11-02:${status}`])
    })

    it('la tarea diaria tampoco la regresa, y la del mes siguiente sí nace', async () => {
      const filas = dadaLaDeHoyMarcada()
      const movido = cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-03') })

      await tareaDiaria('2026-11-03', movido)
      expect(resumen(filas)).toEqual(['2026-11-02:PAID'])

      await tareaDiaria('2026-11-28', movido)
      expect(resumen(filas)).toEqual(['2026-11-02:PAID', '2026-12-03:PENDING'])
    })

    it('moverla a un día anterior: la siguiente, que ya es de otro periodo, sí nace', async () => {
      const filas = dadaLaDeHoyMarcada()

      await tareaDiaria('2026-11-28', cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-01') }))

      expect(resumen(filas)).toEqual(['2026-11-02:PAID', '2026-12-01:PENDING'])
    })

    it('semanal pagada hoy que se mueve dos días: sale hasta la otra semana', async () => {
      const filas = dadaLaDeHoyMarcada()
      dadoElCobro(cobro({ frequency: 'WEEKLY', anchorDate: calendarDayToDb('2026-10-05') }))

      await updateCharge('cobro-1', { anchorDate: '2026-10-07' }, 'staff-1', AHORA)
      expect(resumen(filas)).toEqual(['2026-11-02:PAID'])

      await tareaDiaria('2026-11-05', cobro({ frequency: 'WEEKLY', anchorDate: calendarDayToDb('2026-10-07') }))
      expect(resumen(filas)).toEqual(['2026-11-02:PAID', '2026-11-11:PENDING'])
    })

    it('lo PENDIENTE no cuenta como marcado: lo de hoy sin pagar no frena la fecha nueva', async () => {
      const filas = instalarOcurrencias([fila('2026-11-02')])
      dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-02') }))

      await updateCharge('cobro-1', { anchorDate: '2026-10-03' }, 'staff-1', AHORA)

      expect(resumen(filas)).toContain('2026-11-03:PENDING')
    })
  })

  describe('🔴 mover la fecha con lo de hoy sin pagar: no deja dos cobros en el mes', () => {
    // Hoy es 2-nov.
    it('mensual de hoy que se mueve al día 5: lo de hoy se va y queda sólo la fecha nueva', async () => {
      const filas = instalarOcurrencias([fila('2026-11-02')])
      dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-02') }))

      await updateCharge('cobro-1', { anchorDate: '2026-10-05' }, 'staff-1', AHORA)

      expect(resumen(filas)).toEqual(['2026-11-05:PENDING'])
    })

    it('lo vencido se queda: eso sí se debe, y omitirlo es decisión de quien cobra', async () => {
      const filas = instalarOcurrencias([fila('2026-10-02'), fila('2026-11-02')])
      dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-02') }))

      await updateCharge('cobro-1', { anchorDate: '2026-10-05' }, 'staff-1', AHORA)

      expect(resumen(filas)).toEqual(['2026-10-02:PENDING', '2026-11-05:PENDING'])
    })

    it('si hoy sigue en el calendario nuevo, lo de hoy se queda con su foto', async () => {
      const deHoy = fila('2026-11-02', { totalCents: 12345 })
      const filas = instalarOcurrencias([deHoy])
      dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-02') }))

      await updateCharge('cobro-1', { frequency: 'WEEKLY', anchorDate: '2026-10-05' }, 'staff-1', AHORA)

      expect(porDia(filas)['2026-11-02'].totalCents).toBe(12345)
      expect(resumen(filas)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING'])
    })

    it('cambiar un monto no toca lo de hoy, aunque regenere lo que falta', async () => {
      const deHoy = fila('2026-11-02', { totalCents: 12345 })
      const filas = instalarOcurrencias([deHoy])
      dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-02') }))

      await updateCharge('cobro-1', { concepts: [RENTA] }, 'staff-1', AHORA)

      expect(porDia(filas)['2026-11-02'].totalCents).toBe(12345)
    })
  })

  describe('🔴 cambiar anchorDate o frequency con una ocurrencia futura ya marcada', () => {
    // Mensual el día 5: el 5-nov (futura) ya se marcó pagada. Hoy es 2-nov.
    const MENSUAL_CON_5_NOV = (estado: 'PAID' | 'SKIPPED' = 'PAID') => [
      fila('2026-10-05', { status: 'PAID', paidAt: AHORA, paidById: 'staff-9' }),
      fila('2026-11-05', { status: estado, paidAt: AHORA, paidById: 'staff-9' }),
    ]

    it.each([
      ['pagada', 'PAID' as const, { anchorDate: '2026-10-06' }],
      ['omitida', 'SKIPPED' as const, { anchorDate: '2026-10-06' }],
      ['pagada y cambia la periodicidad', 'PAID' as const, { frequency: 'WEEKLY' as const }],
    ])(
      'con la ocurrencia del 5-nov %s: 409 «Ya marcaste el cobro del 5 nov; deshazlo para cambiar la fecha», sin escribir nada',
      async (_n, estado, cambio) => {
        const filas = instalarOcurrencias(MENSUAL_CON_5_NOV(estado))
        dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-05') }))
        const antes = resumen(filas)

        const error = await updateCharge('cobro-1', cambio, 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(ConflictError)
        expect((error as ConflictError).statusCode).toBe(409)
        expect((error as ConflictError).message).toBe('Ya marcaste el cobro del 5 nov; deshazlo para cambiar la fecha')
        expect(resumen(filas)).toEqual(antes)
        ningunaEscritura()
      },
    )

    it('si hay varias marcadas futuras, nombra la más próxima; el día va en español sin cero a la izquierda ni año', async () => {
      instalarOcurrencias([
        fila('2026-12-12', { status: 'SKIPPED' }),
        fila('2026-12-09', { status: 'PAID' }),
        fila('2026-12-20', { status: 'PAID' }),
      ])
      dadoElCobro()

      await expect(updateCharge('cobro-1', { frequency: 'BIWEEKLY' }, 'staff-1', new Date('2026-11-30T18:00:00.000Z'))).rejects.toThrow(
        'Ya marcaste el cobro del 9 dic; deshazlo para cambiar la fecha',
      )
    })

    it('sin cambiar el calendario sí pasa: cambiar conceptos conserva la marcada y regenera el resto', async () => {
      const filas = instalarOcurrencias([...MENSUAL_CON_5_NOV(), fila('2026-11-12')])
      dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-05') }))

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)

      const por = porDia(filas)
      expect(por['2026-11-05']).toMatchObject({ id: 'o-2026-11-05', status: 'PAID', totalCents: 107900 }) // intacta
      expect(por['2026-11-12']).toBeUndefined() // la PENDING futura que no es del calendario mensual se borró
    })

    it('reenviar el mismo ancla y la misma periodicidad (el formulario completo) no cuenta como cambiar el calendario', async () => {
      instalarOcurrencias(MENSUAL_CON_5_NOV())
      dadoElCobro(cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-05') }))

      await expect(
        updateCharge('cobro-1', { anchorDate: '2026-10-05', frequency: 'MONTHLY', concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA),
      ).resolves.toBeDefined()
    })

    it('lo marcado de hoy o vencido no estorba: sólo cuentan las marcadas con fecha mayor a hoy', async () => {
      const filas = instalarOcurrencias([
        fila('2026-10-26', { status: 'PAID' }),
        fila('2026-11-02', { status: 'SKIPPED' }), // de hoy
      ])
      dadoElCobro()

      await expect(updateCharge('cobro-1', { anchorDate: '2026-10-07' }, 'staff-1', AHORA)).resolves.toBeDefined()
      // No hay 409. La del 4-nov no nace porque el 2-nov ya se omitió lo de esta semana; la siguiente es la del 11.
      expect(resumen(filas)).toEqual(['2026-10-26:PAID', '2026-11-02:SKIPPED'])
    })

    it('una PENDING futura no estorba: se borra y se regenera con el calendario nuevo', async () => {
      instalarOcurrencias([fila('2026-11-09')])
      dadoElCobro()

      await expect(updateCharge('cobro-1', { frequency: 'MONTHLY' }, 'staff-1', AHORA)).resolves.toBeDefined()
    })
  })

  it('toma el candado ANTES de leer, comprueba las marcadas futuras antes de escribir, y borra, regenera y actualiza en la MISMA transacción', async () => {
    instalarOcurrencias(TRES())
    dadoElCobro()
    const eventos = trazar()

    await updateCharge('cobro-1', { anchorDate: '2026-10-07' }, 'staff-1', AHORA)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    const dentro = dentroDeLaTransaccion(eventos)
    expect(dentro[0]).toBe('candado')
    expect(dentro[1]).toBe('leer cobro') // relee dentro del candado, no antes
    expect(dentro.indexOf('revisar marcadas')).toBeGreaterThan(0)
    for (const escritura of ['actualizar cobro', 'borrar futuras', 'crear fechas']) {
      expect(dentro).toContain(escritura)
      expect(dentro.indexOf('revisar marcadas')).toBeLessThan(dentro.indexOf(escritura))
    }
    expect(eventos[eventos.length - 1]).toBe('bitácora') // fuera del candado
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('el 409 ocurre dentro del candado y no deja a medias: no hay ni borrado ni regeneración ni bitácora', async () => {
    instalarOcurrencias([fila('2026-11-09', { status: 'PAID' })])
    dadoElCobro()
    const eventos = trazar()

    await expect(updateCharge('cobro-1', { frequency: 'MONTHLY' }, 'staff-1', AHORA)).rejects.toBeInstanceOf(ConflictError)

    expect(dentroDeLaTransaccion(eventos)).toEqual(['candado', 'leer cobro', 'revisar marcadas'])
    expect(eventos).not.toContain('bitácora')
  })

  it('cambiar sólo el nombre o el perfil fiscal no borra ni regenera ocurrencias (nada futuro cambia)', async () => {
    const filas = instalarOcurrencias(TRES())
    dadoElCobro()
    const antes = filas.map(f => f.id)

    await updateCharge('cobro-1', { customerName: 'Estética Luna Centro' }, 'staff-1', AHORA)

    expect(prismaMock.platformChargeOccurrence.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.platformChargeOccurrence.createMany).not.toHaveBeenCalled()
    expect(filas.map(f => f.id)).toEqual(antes)
    expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({
      where: { id: 'cobro-1' },
      data: expect.objectContaining({ customerName: 'Estética Luna Centro' }),
    })
  })

  it('un cobro pausado se actualiza pero no se regenera (los pausados no generan); sí se limpian sus PENDING futuras viejas', async () => {
    const filas = instalarOcurrencias([fila('2026-11-09')])
    dadoElCobro(cobro({ pausedAt: new Date('2026-10-20T10:00:00.000Z') }))

    await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)

    expect(prismaMock.platformCharge.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.platformChargeOccurrence.createMany).not.toHaveBeenCalled()
    expect(filas).toEqual([])
  })

  describe('el ancla de ±366 días se exige sólo al FIJARLA, no cada vez que el formulario la reenvía', () => {
    // Un cobro mensual de hace más de un año: su ancla (28-sep-2025) ya queda a 400 días de hoy y es perfectamente válida.
    const ANCLA_VIEJA = '2025-09-28'
    const cobroViejo = () => cobro({ anchorDate: calendarDayToDb(ANCLA_VIEJA), frequency: 'MONTHLY' })

    it('renombrarlo, con el formulario completo (reenvía el ancla de siempre), pasa y no toca el calendario', async () => {
      const filas = instalarOcurrencias([fila('2026-11-09')])
      dadoElCobro(cobroViejo())

      await expect(
        updateCharge('cobro-1', { anchorDate: ANCLA_VIEJA, frequency: 'MONTHLY', customerName: 'Otro nombre' }, 'staff-1', AHORA),
      ).resolves.toBeDefined()

      expect(prismaMock.platformCharge.update.mock.calls[0][0].data).toMatchObject({
        customerName: 'Otro nombre',
        anchorDate: new Date('2025-09-28T00:00:00.000Z'),
      })
      expect(prismaMock.platformChargeOccurrence.findFirst).not.toHaveBeenCalled() // no cambió el calendario
      expect(resumen(filas)).toEqual(['2026-11-09:PENDING']) // nada futuro se regeneró
    })

    it('renombrarlo sin mandar el ancla también pasa', async () => {
      instalarOcurrencias([])
      dadoElCobro(cobroViejo())

      await expect(updateCharge('cobro-1', { customerName: 'Otro nombre' }, 'staff-1', AHORA)).resolves.toBeDefined()
    })

    it('un ancla NUEVA fuera de ±366 días se rechaza dentro del candado, sin escribir nada', async () => {
      dadoElCobro()
      instalarOcurrencias([])

      for (const anchorDate of ['2025-10-31', '2027-11-04']) {
        const error = await updateCharge('cobro-1', { anchorDate }, 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(BadRequestError)
        expect((error as BadRequestError).message).toMatch(/366 días/)
      }
      ningunaEscritura()
    })

    it('un ancla nueva justo en los extremos (hoy−366 y hoy+366) sí pasa', async () => {
      instalarOcurrencias([])
      dadoElCobro()

      await expect(updateCharge('cobro-1', { anchorDate: '2025-11-01' }, 'staff-1', AHORA)).resolves.toBeDefined()
      await expect(updateCharge('cobro-1', { anchorDate: '2027-11-03' }, 'staff-1', AHORA)).resolves.toBeDefined()
    })
  })

  it('si no cambia nada (el formulario reenviado igual), no escribe, no regenera y no registra bitácora', async () => {
    instalarOcurrencias(TRES())
    const row = dadoElCobro()

    const resultado = await updateCharge(
      'cobro-1',
      {
        customerType: 'ORGANIZATION',
        organizationId: 'org-1',
        customerName: 'Estética Luna',
        billingTaxProfileId: 'perfil-1',
        frequency: 'WEEKLY',
        anchorDate: '2026-10-05',
        concepts: [RENTA, LICENCIA],
        invoiceMode: 'AUTOMATIC',
      },
      'staff-1',
      AHORA,
    )

    expect(resultado).toBe(row)
    ningunaEscritura()
  })

  it('valida lo que llega ANTES de abrir la transacción: conceptos, nombre o ancla mal formados no tocan la base', async () => {
    await expect(updateCharge('cobro-1', { concepts: [] }, 'staff-1', AHORA)).rejects.toBeInstanceOf(BadRequestError)
    await expect(updateCharge('cobro-1', { concepts: [{ ...RENTA, amountCents: 0 }] }, 'staff-1', AHORA)).rejects.toBeInstanceOf(
      BadRequestError,
    )
    await expect(updateCharge('cobro-1', { anchorDate: '2026-02-30' }, 'staff-1', AHORA)).rejects.toThrow(/fecha de inicio no es válida/)
    await expect(updateCharge('cobro-1', { customerName: ' ' }, 'staff-1', AHORA)).rejects.toBeInstanceOf(BadRequestError)

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    ningunaEscritura()
  })

  it('el tope de 2,147,483,647 centavos también aplica al editar conceptos', async () => {
    const veinte = Array.from({ length: 20 }, (_v, i) => ({ ...RENTA, description: `Concepto ${i + 1}`, amountCents: 999_999_999 }))

    await expect(updateCharge('cobro-1', { concepts: veinte }, 'staff-1', AHORA)).rejects.toThrow(/\$21,474,836\.47/)
    ningunaEscritura()
  })

  describe('modo de factura y perfil fiscal, sobre el cobro ya guardado', () => {
    it('pasar a AUTOMATIC un cobro MANUAL sin perfil se rechaza; con el perfil de su cliente pasa', async () => {
      instalarOcurrencias([])
      dadoElCobro(cobro({ invoiceMode: 'MANUAL', billingTaxProfileId: null }))

      await expect(updateCharge('cobro-1', { invoiceMode: 'AUTOMATIC' }, 'staff-1', AHORA)).rejects.toThrow(/datos fiscales/i)
      ningunaEscritura()

      await expect(
        updateCharge('cobro-1', { invoiceMode: 'AUTOMATIC', billingTaxProfileId: 'perfil-1' }, 'staff-1', AHORA),
      ).resolves.toBeDefined()
      expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({
        where: { id: 'cobro-1' },
        data: expect.objectContaining({ invoiceMode: 'AUTOMATIC', billingTaxProfileId: 'perfil-1' }),
      })
    })

    it('quitarle el perfil a un cobro AUTOMATIC se rechaza', async () => {
      dadoElCobro()

      await expect(updateCharge('cobro-1', { billingTaxProfileId: null as never }, 'staff-1', AHORA)).rejects.toThrow(/datos fiscales/i)
      ningunaEscritura()
    })

    it('un perfil de otro cliente se rechaza', async () => {
      dadoElCobro()
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ ...PERFIL_DE_LA_ORG, id: 'perfil-9', organizationId: 'org-2' })

      await expect(updateCharge('cobro-1', { billingTaxProfileId: 'perfil-9' }, 'staff-1', AHORA)).rejects.toThrow(/no es de este cliente/i)
      ningunaEscritura()
    })

    it('cambiar de cliente: los ids del cliente nuevo reemplazan a los viejos; con el perfil viejo se rechaza y con uno suyo pasa', async () => {
      instalarOcurrencias([])
      dadoElCobro()

      // El perfil de la organización ya no es de un negocio.
      await expect(updateCharge('cobro-1', { customerType: 'VENUE', venueId: 'venue-1' }, 'staff-1', AHORA)).rejects.toThrow(
        /no es de este cliente/i,
      )
      ningunaEscritura()

      prismaMock.billingTaxProfile.findUnique.mockResolvedValue({
        id: 'perfil-v',
        customerType: 'VENUE',
        organizationId: null,
        venueId: 'venue-1',
      })
      await updateCharge('cobro-1', { customerType: 'VENUE', venueId: 'venue-1', billingTaxProfileId: 'perfil-v' }, 'staff-1', AHORA)

      expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({
        where: { id: 'cobro-1' },
        data: expect.objectContaining({ customerType: 'VENUE', organizationId: null, venueId: 'venue-1', billingTaxProfileId: 'perfil-v' }),
      })
    })

    it('cambiar sólo los conceptos de un cobro AUTOMATIC no vuelve a revisar el perfil', async () => {
      instalarOcurrencias([])
      dadoElCobro()

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)

      expect(prismaMock.billingTaxProfile.findUnique).not.toHaveBeenCalled()
    })
  })

  it('un cobro que no existe: 404 desde el candado y no se escribe nada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])

    const error = await updateCharge('no-existe', { customerName: 'X' }, 'staff-1', AHORA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as NotFoundError).message).toBe('Cobro no encontrado')
    ningunaEscritura()
  })

  it('registra PLATFORM_CHARGE_UPDATED con los campos que cambiaron, quién, el venue y la organización', async () => {
    instalarOcurrencias(TRES())
    dadoElCobro()

    await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS, invoiceMode: 'MANUAL' }, 'staff-1', AHORA)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PLATFORM_CHARGE_UPDATED',
        staffId: 'staff-1',
        venueId: null,
        organizationId: 'org-1',
        entity: 'PlatformCharge',
        entityId: 'cobro-1',
        data: { changedFields: ['concepts', 'invoiceMode'] },
      }),
    )
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — pauseCharge (NEW)', () => {
  const OCURRENCIAS = () => [
    fila('2026-10-19', { status: 'PAID', paidAt: AHORA, paidById: 'staff-9' }), // vencida y pagada
    fila('2026-10-26'), // vencida, por cobrar
    fila('2026-11-02'), // de hoy, por cobrar
    fila('2026-11-09'), // futura, por cobrar
    fila('2026-11-16', { status: 'SKIPPED', skippedAt: AHORA, skippedById: 'staff-9' }), // futura ya omitida
  ]

  it('borra las PENDING futuras y deja lo demás: lo vencido y lo de hoy siguen por cobrar y lo ya marcado no se toca', async () => {
    const filas = instalarOcurrencias(OCURRENCIAS())
    dadoElCobro()

    const pausado = await pauseCharge('cobro-1', { skipOverdue: false }, 'staff-1', AHORA)

    expect(pausado.pausedAt).toEqual(AHORA)
    expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({ where: { id: 'cobro-1' }, data: { pausedAt: AHORA } })
    expect(resumen(filas)).toEqual(['2026-10-19:PAID', '2026-10-26:PENDING', '2026-11-02:PENDING', '2026-11-16:SKIPPED'])
  })

  it('con skipOverdue pasa a SKIPPED lo vencido y lo de hoy (con quién y cuándo); lo pagado no se toca', async () => {
    const filas = instalarOcurrencias(OCURRENCIAS())
    dadoElCobro()

    await pauseCharge('cobro-1', { skipOverdue: true }, 'staff-1', AHORA)

    expect(resumen(filas)).toEqual(['2026-10-19:PAID', '2026-10-26:SKIPPED', '2026-11-02:SKIPPED', '2026-11-16:SKIPPED'])
    const por = porDia(filas)
    expect(por['2026-10-26']).toMatchObject({ skippedAt: AHORA, skippedById: 'staff-1' })
    expect(por['2026-11-02']).toMatchObject({ skippedAt: AHORA, skippedById: 'staff-1' })
    expect(por['2026-10-19']).toMatchObject({ status: 'PAID', paidById: 'staff-9', skippedAt: null }) // intacta
    expect(por['2026-11-16']).toMatchObject({ skippedById: 'staff-9' }) // la omitió otra persona antes: no se reescribe
  })

  it('repetir no cambia nada: ni vuelve a escribir el cobro, ni borra, ni omite, ni mueve pausedAt, ni registra otra bitácora', async () => {
    const filas = instalarOcurrencias(OCURRENCIAS())
    dadoElCobro()
    await pauseCharge('cobro-1', { skipOverdue: false }, 'staff-1', AHORA)
    const despuesDeLaPrimera = resumen(filas)
    const pausado = cobro({ pausedAt: AHORA })
    dadoElCobro(pausado)
    jest.clearAllMocks() // se cuentan sólo las llamadas de la repetición

    const repetido = await pauseCharge('cobro-1', { skipOverdue: false }, 'staff-1', new Date('2026-11-02T20:00:00.000Z'))

    expect(repetido.pausedAt).toEqual(AHORA) // el momento de la pausa original
    expect(resumen(filas)).toEqual(despuesDeLaPrimera)
    ningunaEscritura()
  })

  it('pausar de nuevo con skipOverdue omite lo vencido que seguía por cobrar, sin mover pausedAt ni volver a escribir el cobro', async () => {
    // Ya estaba pausado (se dejó lo vencido por cobrar) y ahora el gerente elige «Omitirlo»: la elección se respeta.
    const filas = instalarOcurrencias(OCURRENCIAS().filter(f => dia(f.dueDate) !== '2026-11-09'))
    dadoElCobro(cobro({ pausedAt: new Date('2026-10-30T10:00:00.000Z') }))

    const resultado = await pauseCharge('cobro-1', { skipOverdue: true }, 'staff-1', AHORA)

    expect(resultado.pausedAt).toEqual(new Date('2026-10-30T10:00:00.000Z'))
    expect(prismaMock.platformCharge.update).not.toHaveBeenCalled()
    expect(prismaMock.platformChargeOccurrence.deleteMany).not.toHaveBeenCalled()
    expect(resumen(filas)).toEqual(['2026-10-19:PAID', '2026-10-26:SKIPPED', '2026-11-02:SKIPPED', '2026-11-16:SKIPPED'])
    expect(mockLogAction).toHaveBeenCalledTimes(1) // sí cambió algo (dos omitidas): se audita
  })

  it('toma el candado primero y hace todo en una transacción; la bitácora va fuera', async () => {
    instalarOcurrencias(OCURRENCIAS())
    dadoElCobro()
    const eventos = trazar()

    await pauseCharge('cobro-1', { skipOverdue: true }, 'staff-1', AHORA)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    const dentro = dentroDeLaTransaccion(eventos)
    expect(dentro[0]).toBe('candado')
    expect(dentro[1]).toBe('leer cobro')
    expect(dentro).toEqual(expect.arrayContaining(['actualizar cobro', 'borrar futuras', 'omitir vencidas']))
    expect(eventos[eventos.length - 1]).toBe('bitácora')
  })

  it('registra PLATFORM_CHARGE_PAUSED con quién, el venue, la organización y qué se hizo con lo vencido', async () => {
    instalarOcurrencias(OCURRENCIAS())
    dadoElCobro()

    await pauseCharge('cobro-1', { skipOverdue: true }, 'staff-1', AHORA)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PLATFORM_CHARGE_PAUSED',
        staffId: 'staff-1',
        venueId: null,
        organizationId: 'org-1',
        entity: 'PlatformCharge',
        entityId: 'cobro-1',
        data: { skipOverdue: true, removedFuture: 1, skippedOverdue: 2 },
      }),
    )
  })

  it('un cobro que no existe: 404 y no se escribe nada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])

    await expect(pauseCharge('no-existe', { skipOverdue: true }, 'staff-1', AHORA)).rejects.toBeInstanceOf(NotFoundError)
    ningunaEscritura()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — resumeCharge (NEW)', () => {
  const PAUSADO_DESDE_EL_13_OCT = () => cobro({ pausedAt: new Date('2026-10-13T16:00:00.000Z') })

  it('genera desde max(ancla, hoy) hasta hoy+7: las fechas de la pausa NO se crean', async () => {
    // Semanal (lunes) pausado desde el 13-oct: durante la pausa pasaron el 19-oct y el 26-oct. Quedó una vencida por cobrar.
    const filas = instalarOcurrencias([fila('2026-10-05', { status: 'PAID' }), fila('2026-10-12')])
    dadoElCobro(PAUSADO_DESDE_EL_13_OCT())

    const reanudado = await resumeCharge('cobro-1', 'staff-1', AHORA)

    expect(reanudado.pausedAt).toBeNull()
    expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({ where: { id: 'cobro-1' }, data: { pausedAt: null } })
    expect(resumen(filas)).toEqual(['2026-10-05:PAID', '2026-10-12:PENDING', '2026-11-02:PENDING', '2026-11-09:PENDING'])
    // Con la foto actual del cobro.
    expect(porDia(filas)['2026-11-02']).toMatchObject({ concepts: [RENTA, LICENCIA], ...TOTALES_MIXTOS, invoiceMode: 'AUTOMATIC' })
  })

  it('si el ancla es futura genera desde el ancla, no desde hoy', async () => {
    const filas = instalarOcurrencias([])
    dadoElCobro(cobro({ anchorDate: calendarDayToDb('2026-11-04'), pausedAt: new Date('2026-10-13T16:00:00.000Z') }))

    await resumeCharge('cobro-1', 'staff-1', AHORA)

    expect(resumen(filas)).toEqual(['2026-11-04:PENDING']) // el 11-nov queda fuera de la ventana
  })

  it('skipDuplicates respeta lo ya marcado: una futura omitida o pagada no se pisa ni se duplica', async () => {
    const filas = instalarOcurrencias([fila('2026-11-09', { status: 'SKIPPED', skippedAt: AHORA, skippedById: 'staff-9' })])
    dadoElCobro(PAUSADO_DESDE_EL_13_OCT())

    await resumeCharge('cobro-1', 'staff-1', AHORA)

    expect(resumen(filas)).toEqual(['2026-11-02:PENDING', '2026-11-09:SKIPPED'])
    expect(prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0].skipDuplicates).toBe(true)
    expect(porDia(filas)['2026-11-09']).toMatchObject({ id: 'o-2026-11-09', skippedById: 'staff-9' })
  })

  it('repetir no cambia nada: un cobro que ya está activo no se actualiza, no genera ni registra bitácora', async () => {
    const filas = instalarOcurrencias([])
    dadoElCobro(cobro({ pausedAt: null }))

    const resultado = await resumeCharge('cobro-1', 'staff-1', AHORA)

    expect(resultado.pausedAt).toBeNull()
    expect(filas).toEqual([])
    ningunaEscritura()
  })

  it('toma el candado primero y hace todo en una transacción; la bitácora va fuera', async () => {
    instalarOcurrencias([])
    dadoElCobro(PAUSADO_DESDE_EL_13_OCT())
    const eventos = trazar()

    await resumeCharge('cobro-1', 'staff-1', AHORA)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    const dentro = dentroDeLaTransaccion(eventos)
    expect(dentro).toEqual(['candado', 'leer cobro', 'actualizar cobro', 'revisar marcadas', 'crear fechas'])
    expect(eventos[eventos.length - 1]).toBe('bitácora')
  })

  it('registra PLATFORM_CHARGE_RESUMED con quién, el venue, la organización y cuántas fechas creó', async () => {
    instalarOcurrencias([])
    dadoElCobro(PAUSADO_DESDE_EL_13_OCT())

    await resumeCharge('cobro-1', 'staff-1', AHORA)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PLATFORM_CHARGE_RESUMED',
        staffId: 'staff-1',
        venueId: null,
        organizationId: 'org-1',
        entity: 'PlatformCharge',
        entityId: 'cobro-1',
        data: { occurrencesCreated: 2 },
      }),
    )
  })

  it('un cobro que no existe: 404 y no se escribe nada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])

    await expect(resumeCharge('no-existe', 'staff-1', AHORA)).rejects.toBeInstanceOf(NotFoundError)
    ningunaEscritura()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — generateAllActive (NEW)', () => {
  const ids = (desde: number, hasta: number) =>
    Array.from({ length: hasta - desde }, (_v, i) => ({ id: `c${String(desde + i).padStart(3, '0')}` }))

  /** `findUnique` devuelve, para cada id, un cobro semanal activo con ese id. */
  function cobrosActivos(pausados: string[] = []) {
    prismaMock.platformCharge.findUnique.mockImplementation(async ({ where }: any) =>
      cobro({ id: where.id, pausedAt: pausados.includes(where.id) ? new Date('2026-10-30T10:00:00.000Z') : null }),
    )
  }

  it('pide los cobros activos de 100 en 100, ordenados por id, y sigue desde el último id de cada página', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValueOnce(ids(0, 100)).mockResolvedValueOnce(ids(100, 103))
    cobrosActivos()
    prismaMock.platformChargeOccurrence.createMany.mockResolvedValue({ count: 1 })

    await generateAllActive(AHORA)

    expect(prismaMock.platformCharge.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.platformCharge.findMany).toHaveBeenNthCalledWith(1, {
      where: { pausedAt: null, frequency: { not: 'ONE_TIME' } },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true },
    })
    expect(prismaMock.platformCharge.findMany).toHaveBeenNthCalledWith(2, {
      where: { pausedAt: null, frequency: { not: 'ONE_TIME' }, id: { gt: 'c099' } },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true },
    })
    expect(prismaMock.platformChargeOccurrence.createMany).toHaveBeenCalledTimes(103)
    // Cada cobro en SU transacción y con SU candado.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(103)
    expect(prismaMock.$queryRaw.mock.calls.map((c: unknown[]) => c[1])).toEqual([...ids(0, 103).map(x => x.id)])
  })

  it('una página exacta de 100 pide otra más (vacía) y termina; una vacía de entrada no abre ninguna transacción', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValueOnce(ids(0, 100)).mockResolvedValueOnce([])
    cobrosActivos()
    prismaMock.platformChargeOccurrence.createMany.mockResolvedValue({ count: 0 })

    await generateAllActive(AHORA)
    expect(prismaMock.platformCharge.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.platformCharge.findMany.mock.calls[1][0].where).toEqual({
      pausedAt: null,
      frequency: { not: 'ONE_TIME' },
      id: { gt: 'c099' },
    })

    prismaMock.platformCharge.findMany.mockReset()
    prismaMock.$transaction.mockClear()
    prismaMock.platformCharge.findMany.mockResolvedValueOnce([])
    await generateAllActive(AHORA)
    expect(prismaMock.platformCharge.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('genera de hoy a hoy+7 con la foto actual de cada cobro', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValueOnce([{ id: 'cobro-1' }])
    const filas = instalarOcurrencias([fila('2026-10-26')])
    dadoElCobro()

    await generateAllActive(AHORA)

    expect(resumen(filas)).toEqual(['2026-10-26:PENDING', '2026-11-02:PENDING', '2026-11-09:PENDING'])
    expect(porDia(filas)['2026-11-09']).toMatchObject({
      chargeId: 'cobro-1',
      concepts: [RENTA, LICENCIA],
      ...TOTALES_MIXTOS,
      invoiceMode: 'AUTOMATIC',
    })
  })

  it('"hoy" es el de CDMX: a las 21:30 del 2-nov (ya 3-nov en UTC) la ventana es 2-nov → 9-nov', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValueOnce([{ id: 'cobro-1' }])
    const filas = instalarOcurrencias([])
    dadoElCobro()

    await generateAllActive(AHORA_TARDE)

    expect(resumen(filas)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING'])
  })

  it('es idempotente: correrlo otra vez no duplica ni reescribe nada', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValue([{ id: 'cobro-1' }])
    const filas = instalarOcurrencias([])
    dadoElCobro()

    await generateAllActive(AHORA)
    const foto = JSON.stringify(filas)
    prismaMock.platformCharge.findMany.mockResolvedValue([{ id: 'cobro-1' }])
    await generateAllActive(AHORA)

    expect(JSON.stringify(filas)).toBe(foto)
    expect(filas).toHaveLength(2)
  })

  it('un cobro pausado entre su lectura y su candado no recibe fechas (relee dentro del candado)', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
    cobrosActivos(['a']) // al releer dentro del candado, «a» ya está pausado
    const filas = instalarOcurrencias([])
    const eventos = trazar()

    await generateAllActive(AHORA)

    expect(filas.every(f => f.chargeId === 'b')).toBe(true)
    expect(resumen(filas)).toEqual(['2026-11-02:PENDING', '2026-11-09:PENDING'])
    // «a»: candado y relectura, y al ver que ya está pausado no escribe nada. «b»: candado, relectura y fechas.
    expect(eventos).toEqual(['tx:inicio', 'candado', 'leer cobro', 'tx:fin', 'candado', 'leer cobro', 'revisar marcadas', 'crear fechas'])
  })

  it('un cobro cuyos datos no se pueden calcular se registra como error y NO detiene a los demás', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValueOnce([{ id: 'roto' }, { id: 'sano' }])
    prismaMock.platformCharge.findUnique.mockImplementation(async ({ where }: any) =>
      cobro({ id: where.id, concepts: where.id === 'roto' ? [] : [RENTA, LICENCIA] }),
    )
    const filas = instalarOcurrencias([])

    await expect(generateAllActive(AHORA)).resolves.toBeUndefined()

    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    expect(mockLoggerError.mock.calls[0][1]).toMatchObject({ chargeId: 'roto' })
    expect(filas.map(f => f.chargeId)).toEqual(['sano', 'sano']) // sus dos fechas de la semana
  })

  it('un error de la base en un cobro tampoco detiene a los siguientes', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
    cobrosActivos()
    prismaMock.platformChargeOccurrence.createMany.mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValue({ count: 2 })

    await expect(generateAllActive(AHORA)).resolves.toBeUndefined()

    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    expect(mockLoggerError.mock.calls[0][1]).toMatchObject({ chargeId: 'a', error: 'deadlock detected' })
    expect(prismaMock.platformChargeOccurrence.createMany).toHaveBeenCalledTimes(2)
  })

  it('si la lista de cobros no se puede leer, el error sí se propaga (el llamador decide)', async () => {
    prismaMock.platformCharge.findMany.mockRejectedValue(new Error("Can't reach database server"))

    await expect(generateAllActive(AHORA)).rejects.toThrow("Can't reach database server")
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — listCharges (NEW)', () => {
  const ORDEN = [{ customerName: 'asc' }, { id: 'asc' }] // `id` desempata: sin él, una página repite o pierde filas

  beforeEach(() => {
    prismaMock.platformCharge.findMany.mockResolvedValue([cobro()])
    prismaMock.platformCharge.count.mockResolvedValue(1)
  })

  it('sin filtros: primera página de 50, orden estable y el total real', async () => {
    const resultado = await listCharges({})

    expect(prismaMock.platformCharge.findMany).toHaveBeenCalledWith({ where: {}, orderBy: ORDEN, skip: 0, take: 50 })
    expect(prismaMock.platformCharge.count).toHaveBeenCalledWith({ where: {} })
    expect(resultado).toEqual({ rows: [cobro()], total: 1, page: 1, pageSize: 50 })
  })

  it.each([
    ['active', { pausedAt: null }],
    ['paused', { pausedAt: { not: null } }],
  ] as const)('status=%s filtra en la base', async (status, where) => {
    await listCharges({ status })

    expect(prismaMock.platformCharge.findMany.mock.calls[0][0].where).toEqual(where)
    expect(prismaMock.platformCharge.count).toHaveBeenCalledWith({ where })
  })

  it('q busca por nombre del cliente en la base, sin importar mayúsculas ni espacios de los lados; q en blanco no filtra', async () => {
    await listCharges({ q: '  luna ' })
    expect(prismaMock.platformCharge.findMany.mock.calls[0][0].where).toEqual({ customerName: { contains: 'luna', mode: 'insensitive' } })

    prismaMock.platformCharge.findMany.mockClear()
    await listCharges({ q: '   ' })
    expect(prismaMock.platformCharge.findMany.mock.calls[0][0].where).toEqual({})
  })

  it('el estado y la búsqueda se combinan, y el total cuenta con el MISMO filtro', async () => {
    await listCharges({ status: 'paused', q: 'taller' })

    const where = { pausedAt: { not: null }, customerName: { contains: 'taller', mode: 'insensitive' } }
    expect(prismaMock.platformCharge.findMany.mock.calls[0][0].where).toEqual(where)
    expect(prismaMock.platformCharge.count).toHaveBeenCalledWith({ where })
  })

  it('pagina: la página 3 de 20 salta 40 filas', async () => {
    const resultado = await listCharges({ page: 3, pageSize: 20 })

    expect(prismaMock.platformCharge.findMany).toHaveBeenCalledWith({ where: {}, orderBy: ORDEN, skip: 40, take: 20 })
    expect(resultado).toMatchObject({ page: 3, pageSize: 20 })
  })

  it('el servidor impone el tope: un pageSize hostil se recorta a 100 y el que llega a la respuesta es el real', async () => {
    const resultado = await listCharges({ pageSize: 100_000 })

    expect(prismaMock.platformCharge.findMany.mock.calls[0][0].take).toBe(100)
    expect(resultado.pageSize).toBe(100)
  })

  it.each([
    [0, 1],
    [-5, 1],
    [3.7, 3],
    [NaN, 50],
    [Infinity, 50],
    [undefined, 50],
  ])('pageSize %p se normaliza a %p', async (pedido, esperado) => {
    await listCharges({ pageSize: pedido as number })

    expect(prismaMock.platformCharge.findMany.mock.calls[0][0].take).toBe(esperado)
  })

  it.each([
    [0, 1],
    [-2, 1],
    [2.9, 2],
    [NaN, 1],
    [undefined, 1],
  ])('page %p se normaliza a %p', async (pedida, esperada) => {
    const resultado = await listCharges({ page: pedida as number, pageSize: 10 })

    expect(resultado.page).toBe(esperada)
    expect(prismaMock.platformCharge.findMany.mock.calls[0][0].skip).toBe((esperada - 1) * 10)
  })

  it('el total sale de count, no de las filas de la página: 2 filas visibles de 57', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValue([cobro({ id: 'a' }), cobro({ id: 'b' })])
    prismaMock.platformCharge.count.mockResolvedValue(57)

    const resultado = await listCharges({ page: 3, pageSize: 25 })

    expect(resultado.rows).toHaveLength(2)
    expect(resultado.total).toBe(57)
  })

  it('sin cobros: filas vacías y total 0', async () => {
    prismaMock.platformCharge.findMany.mockResolvedValue([])
    prismaMock.platformCharge.count.mockResolvedValue(0)

    await expect(listCharges({ q: 'nadie' })).resolves.toEqual({ rows: [], total: 0, page: 1, pageSize: 50 })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — sin factura (NONE) y las claves del SAT (NEW)', () => {
  const FALTAN_CLAVES = 'Cada concepto necesita su clave del SAT y su unidad'
  // $10,000.00 con IVA: a mano, subtotal 862,069 + IVA 137,931 = 1,000,000 centavos.
  const VENTA = { description: 'Venta de equipo', amountCents: 1_000_000, ivaMode: 'WITH_IVA' as const }
  const TOTALES_VENTA = { subtotalCents: 862069, taxCents: 137931, totalCents: 1_000_000 }
  const SIN_CLAVES: ChargeConceptInput[] = [VENTA]
  /** Lo que manda el formulario de alta cuando no se llenan: las dos claves como texto vacío. */
  const CLAVES_VACIAS: ChargeConceptInput[] = [{ ...VENTA, satProductKey: '', satUnitKey: '' }]
  /** Como queda guardado un cobro sin factura: las claves vacías. */
  const GUARDADO_SIN_CLAVES = { ...VENTA, satProductKey: '', satUnitKey: '' }
  const SIN_FACTURA = (over: Partial<ChargeInput> = {}) =>
    entrada({ invoiceMode: 'NONE', frequency: 'MONTHLY', anchorDate: '2026-11-02', billingTaxProfileId: undefined, ...over })

  describe('createCharge', () => {
    it.each([
      ['las claves omitidas', SIN_CLAVES],
      ['las claves vacías («»), como las manda el formulario', CLAVES_VACIAS],
      ['las claves con sólo espacios', [{ ...VENTA, satProductKey: '   ', satUnitKey: ' ' }]],
    ] as [string, ChargeConceptInput[]][])(
      'NONE con %s: se guarda con las claves vacías, y la fecha nace con la misma foto',
      async (_caso, concepts) => {
        await createCharge(SIN_FACTURA({ concepts }), 'staff-1', AHORA)

        expect(prismaMock.platformCharge.create.mock.calls[0][0].data).toMatchObject({
          invoiceMode: 'NONE',
          concepts: [GUARDADO_SIN_CLAVES],
        })
        const { data } = prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0]
        expect(data).toEqual([
          {
            chargeId: 'cobro-nuevo',
            dueDate: new Date('2026-11-02T00:00:00.000Z'),
            concepts: [GUARDADO_SIN_CLAVES],
            ...TOTALES_VENTA,
            invoiceMode: 'NONE',
          },
        ])
      },
    )

    it('NONE con claves: se conservan (sin espacios de sobra); nadie las borra', async () => {
      await createCharge(SIN_FACTURA({ concepts: [{ ...VENTA, satProductKey: ' 43211509 ', satUnitKey: 'H87' }] }), 'staff-1', AHORA)

      expect(prismaMock.platformCharge.create.mock.calls[0][0].data.concepts).toEqual([
        { ...VENTA, satProductKey: '43211509', satUnitKey: 'H87' },
      ])
    })

    it('NONE no necesita perfil fiscal: se guarda sin él y ni siquiera lo busca', async () => {
      await createCharge(SIN_FACTURA({ concepts: SIN_CLAVES }), 'staff-1', AHORA)

      expect(prismaMock.billingTaxProfile.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.platformCharge.create.mock.calls[0][0].data.billingTaxProfileId).toBeNull()
    })

    it.each([
      ['MANUAL', 'MANUAL' as const],
      ['AUTOMATIC', 'AUTOMATIC' as const],
    ])('con %s las claves SÍ se exigen: 400 «Cada concepto necesita su clave del SAT y su unidad»', async (_nombre, invoiceMode) => {
      const sinClaves: [string, ChargeConceptInput[]][] = [
        ['omitidas', SIN_CLAVES],
        ['vacías', CLAVES_VACIAS],
        ['sólo espacios', [{ ...VENTA, satProductKey: '  ', satUnitKey: '  ' }]],
        ['sólo falta la unidad', [{ ...VENTA, satProductKey: '43211509' }]],
        ['sólo falta la clave del producto', [{ ...VENTA, satUnitKey: 'H87' }]],
        [
          'falta en el segundo concepto',
          [
            { ...VENTA, satProductKey: '43211509', satUnitKey: 'H87' },
            { ...VENTA, description: 'Otro' },
          ],
        ],
      ]
      for (const [caso, concepts] of sinClaves) {
        const error = await createCharge(entrada({ invoiceMode, billingTaxProfileId: 'perfil-1', concepts }), 'staff-1', AHORA).catch(
          (e: unknown) => e,
        )

        expect([caso, error]).toEqual([caso, expect.any(BadRequestError)])
        expect((error as BadRequestError).message).toBe(FALTAN_CLAVES)
        expect((error as BadRequestError).statusCode).toBe(400)
      }
      expect(prismaMock.$transaction).not.toHaveBeenCalled() // se rechaza antes de abrir una transacción
      ningunaEscritura()
    })
  })

  describe('updateCharge — las claves se exigen con el modo que QUEDA tras combinar lo que llega con lo guardado', () => {
    const cobroSinFactura = (over: Record<string, unknown> = {}) =>
      cobro({ invoiceMode: 'NONE', billingTaxProfileId: null, concepts: [GUARDADO_SIN_CLAVES], ...over })

    it('de NONE a MANUAL sin mandar conceptos, con los guardados sin claves: 400 dentro del candado y sin escribir nada', async () => {
      instalarOcurrencias([fila('2026-11-09', { concepts: [GUARDADO_SIN_CLAVES], invoiceMode: 'NONE' })])
      dadoElCobro(cobroSinFactura())
      const eventos = trazar()

      const error = await updateCharge('cobro-1', { invoiceMode: 'MANUAL' }, 'staff-1', AHORA).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).message).toBe(FALTAN_CLAVES)
      expect(dentroDeLaTransaccion(eventos)).toEqual(['candado', 'leer cobro']) // lo guardado se leyó dentro del candado; nada se escribió
      expect(eventos).not.toContain('bitácora')
      ningunaEscritura()
    })

    it('de NONE a AUTOMATIC con las claves vacías también: 400 de las claves, antes de buscar el perfil fiscal', async () => {
      dadoElCobro(cobroSinFactura())

      await expect(
        updateCharge('cobro-1', { invoiceMode: 'AUTOMATIC', billingTaxProfileId: 'perfil-1' }, 'staff-1', AHORA),
      ).rejects.toThrow(FALTAN_CLAVES)

      expect(prismaMock.billingTaxProfile.findUnique).not.toHaveBeenCalled()
      ningunaEscritura()
    })

    it('de NONE a MANUAL MANDANDO conceptos con claves (el formulario completo) pasa', async () => {
      instalarOcurrencias([])
      dadoElCobro(cobroSinFactura())
      const conClaves = [{ ...VENTA, satProductKey: '43211509', satUnitKey: 'H87' }]

      await updateCharge('cobro-1', { invoiceMode: 'MANUAL', concepts: conClaves }, 'staff-1', AHORA)

      expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({
        where: { id: 'cobro-1' },
        data: expect.objectContaining({ invoiceMode: 'MANUAL', concepts: conClaves }),
      })
    })

    it('de MANUAL a NONE conserva las claves que ya tenía, y lo futuro nace sin factura', async () => {
      const filas = instalarOcurrencias([fila('2026-11-09')])
      dadoElCobro(cobro({ invoiceMode: 'MANUAL' }))

      await updateCharge('cobro-1', { invoiceMode: 'NONE' }, 'staff-1', AHORA)

      expect(prismaMock.platformCharge.update.mock.calls[0][0].data).toMatchObject({ invoiceMode: 'NONE', concepts: [RENTA, LICENCIA] })
      expect(porDia(filas)['2026-11-09']).toMatchObject({ invoiceMode: 'NONE', concepts: [RENTA, LICENCIA] })
    })

    it('en un cobro MANUAL, mandar conceptos sin claves es 400; en uno NONE, pasa y se guardan vacías', async () => {
      instalarOcurrencias([])
      dadoElCobro(cobro({ invoiceMode: 'MANUAL' }))
      await expect(updateCharge('cobro-1', { concepts: SIN_CLAVES }, 'staff-1', AHORA)).rejects.toThrow(FALTAN_CLAVES)
      ningunaEscritura()

      dadoElCobro(cobroSinFactura())
      await updateCharge('cobro-1', { concepts: [{ ...VENTA, amountCents: 5000 }] }, 'staff-1', AHORA)

      expect(prismaMock.platformCharge.update.mock.calls[0][0].data.concepts).toEqual([{ ...GUARDADO_SIN_CLAVES, amountCents: 5000 }])
    })

    it('cambiar el nombre de un cobro sin factura (claves vacías guardadas) no vuelve a pedir claves', async () => {
      instalarOcurrencias([])
      dadoElCobro(cobroSinFactura())

      await expect(updateCharge('cobro-1', { customerName: 'Otro nombre' }, 'staff-1', AHORA)).resolves.toBeDefined()
    })

    it('un cobro sin factura reenviado igual (el formulario completo, con las claves vacías) no cambia nada ni exige nada', async () => {
      instalarOcurrencias([])
      dadoElCobro(cobroSinFactura())

      await updateCharge('cobro-1', { invoiceMode: 'NONE', concepts: CLAVES_VACIAS, billingTaxProfileId: null as never }, 'staff-1', AHORA)

      ningunaEscritura()
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — cobros de UNA SOLA VEZ, ONE_TIME (NEW)', () => {
  // Hoy es lunes 2-nov. Su única fecha es el 20-nov: ni vencida ni dentro de la ventana de hoy+7 del generador diario.
  const FECHA = '2026-11-20'
  const UNICA = (over: Record<string, unknown> = {}) => cobro({ frequency: 'ONE_TIME', anchorDate: calendarDayToDb(FECHA), ...over })
  const NUEVOS_CONCEPTOS = [{ ...RENTA, amountCents: 100000 }] // A=100000 → subtotal 100000, IVA 16000, total 116000
  const OTRA_FECHA = '2026-12-15'
  const EDICIONES: [string, Partial<ChargeInput>][] = [
    ['los conceptos', { concepts: NUEVOS_CONCEPTOS }],
    ['la fecha', { anchorDate: OTRA_FECHA }],
    ['el modo de factura', { invoiceMode: 'MANUAL' }],
  ]

  describe('createCharge', () => {
    it('con el ancla a 200 días crea su única fecha de una vez, aunque quede lejos de la ventana de hoy+7', async () => {
      const lejana = addDays('2026-11-02', 200)
      expect(lejana).toBe('2027-05-21')

      await createCharge(entrada({ frequency: 'ONE_TIME', anchorDate: lejana }), 'staff-1', AHORA)

      expect(prismaMock.platformCharge.create.mock.calls[0][0].data).toMatchObject({
        frequency: 'ONE_TIME',
        anchorDate: new Date('2027-05-21T00:00:00.000Z'),
      })
      expect(prismaMock.platformChargeOccurrence.createMany).toHaveBeenCalledTimes(1)
      const { data, skipDuplicates } = prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0]
      expect(skipDuplicates).toBe(true)
      expect(data).toEqual([
        {
          chargeId: 'cobro-nuevo',
          dueDate: new Date('2027-05-21T00:00:00.000Z'),
          concepts: [RENTA, LICENCIA],
          ...TOTALES_MIXTOS,
          invoiceMode: 'AUTOMATIC',
        },
      ])
    })

    it('un ancla ya vencida también nace de una vez, y es UNA sola fecha (no la serie semanal desde el ancla)', async () => {
      await createCharge(entrada({ frequency: 'ONE_TIME', anchorDate: '2026-10-03' }), 'staff-1', AHORA)

      const { data } = prismaMock.platformChargeOccurrence.createMany.mock.calls[0][0]
      expect(data.map((d: any) => dia(d.dueDate))).toEqual(['2026-10-03'])
    })

    it('el ancla se exige dentro de ±366 días como en los demás cobros', async () => {
      await expect(createCharge(entrada({ frequency: 'ONE_TIME', anchorDate: '2027-11-04' }), 'staff-1', AHORA)).rejects.toThrow(/366 días/)
      ningunaEscritura()

      await expect(createCharge(entrada({ frequency: 'ONE_TIME', anchorDate: '2027-11-03' }), 'staff-1', AHORA)).resolves.toBeDefined()
    })
  })

  describe('generateAllActive', () => {
    it('no recorre los de una sola vez: el generador no los lee, ni toma su candado, ni les crea fechas', async () => {
      const cobros = [cobro({ id: 'mensual', frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-05') }), UNICA({ id: 'unica' })]
      // La base contesta según el `where`: sólo entiende lo que el generador le pide (cobros activos, y los que NO son de una sola vez).
      prismaMock.platformCharge.findMany.mockImplementation(async ({ where }: any) =>
        cobros
          .filter(c => (where.pausedAt === null ? c.pausedAt === null : true))
          .filter(c => (where.frequency?.not ? c.frequency !== where.frequency.not : true))
          .map(c => ({ id: c.id })),
      )
      prismaMock.platformCharge.findUnique.mockImplementation(async ({ where }: any) => cobros.find(c => c.id === where.id) ?? null)
      const filas = instalarOcurrencias([])

      await generateAllActive(AHORA)

      expect(prismaMock.$queryRaw.mock.calls.map((c: unknown[]) => c[1])).toEqual(['mensual'])
      expect(filas.map(f => f.chargeId)).toEqual(['mensual'])
    })
  })

  describe('updateCharge — no se cambia de periodicidad a o desde «una sola vez»', () => {
    it.each([
      [
        'de mensual a una sola vez',
        cobro({ frequency: 'MONTHLY', anchorDate: calendarDayToDb('2026-10-05') }),
        { frequency: 'ONE_TIME' as const },
      ],
      ['de una sola vez a mensual', UNICA(), { frequency: 'MONTHLY' as const }],
      ['de una sola vez a semanal, aunque también cambie el ancla', UNICA(), { frequency: 'WEEKLY' as const, anchorDate: '2026-11-23' }],
    ])('%s: 400 PLATFORM_CHARGE_ONE_TIME_FIXED y no se escribe nada', async (_caso, row, cambio) => {
      instalarOcurrencias([fila(FECHA)])
      instalarFacturas([])
      dadoElCobro(row)

      const error = await updateCharge('cobro-1', cambio, 'staff-1', AHORA).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).statusCode).toBe(400)
      expect((error as BadRequestError).code).toBe('PLATFORM_CHARGE_ONE_TIME_FIXED')
      expect((error as BadRequestError).message).toMatch(/una sola vez/i)
      ningunaEscritura()
    })

    it('reenviar «una sola vez» tal cual (el formulario completo) no es cambiar de periodicidad', async () => {
      instalarOcurrencias([fila(FECHA)])
      instalarFacturas([])
      dadoElCobro(UNICA())

      await expect(
        updateCharge(
          'cobro-1',
          { frequency: 'ONE_TIME', anchorDate: FECHA, concepts: [RENTA, LICENCIA], invoiceMode: 'AUTOMATIC' },
          'staff-1',
          AHORA,
        ),
      ).resolves.toBeDefined()
      ningunaEscritura() // sin cambios, no hay nada que escribir
    })
  })

  describe('updateCharge — su única fecha se edita EN SU LUGAR mientras esté sin pagar y sin factura viva', () => {
    it('con conceptos y fecha nuevos, la MISMA fila (mismo id) queda con los totales y el dueDate nuevos, y el ancla del cobro también', async () => {
      const filas = instalarOcurrencias([fila(FECHA)])
      instalarFacturas([])
      dadoElCobro(UNICA())

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS, anchorDate: OTRA_FECHA }, 'staff-1', AHORA)

      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({
        id: `o-${FECHA}`,
        chargeId: 'cobro-1',
        dueDate: new Date(`${OTRA_FECHA}T00:00:00.000Z`),
        concepts: NUEVOS_CONCEPTOS,
        subtotalCents: 100000,
        taxCents: 16000,
        totalCents: 116000,
        invoiceMode: 'AUTOMATIC',
        status: 'PENDING',
      })
      expect(prismaMock.platformCharge.update.mock.calls[0][0].data).toMatchObject({
        anchorDate: new Date(`${OTRA_FECHA}T00:00:00.000Z`),
        concepts: NUEVOS_CONCEPTOS,
      })
      // No se borra ni se vuelve a crear: es la misma fila.
      expect(prismaMock.platformChargeOccurrence.deleteMany).not.toHaveBeenCalled()
      expect(prismaMock.platformChargeOccurrence.createMany).not.toHaveBeenCalled()
    })

    it('el modo de factura también se aplica a la fila: es parte de su foto', async () => {
      const filas = instalarOcurrencias([fila(FECHA)])
      instalarFacturas([])
      dadoElCobro(UNICA())

      await updateCharge('cobro-1', { invoiceMode: 'MANUAL' }, 'staff-1', AHORA)

      expect(filas[0]).toMatchObject({ id: `o-${FECHA}`, invoiceMode: 'MANUAL', dueDate: calendarDayToDb(FECHA), ...TOTALES_MIXTOS })
    })

    it('una fecha ya VENCIDA (sin pagar) también se edita; y la nueva fecha se exige dentro de ±366 días', async () => {
      const filas = instalarOcurrencias([fila('2026-10-03')])
      instalarFacturas([])
      dadoElCobro(UNICA({ anchorDate: calendarDayToDb('2026-10-03') }))

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)
      expect(filas[0]).toMatchObject({ id: 'o-2026-10-03', dueDate: calendarDayToDb('2026-10-03'), totalCents: 116000 })

      const error = await updateCharge('cobro-1', { anchorDate: '2027-11-04' }, 'staff-1', AHORA).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).message).toMatch(/366 días/)
      expect(filas[0].dueDate).toEqual(calendarDayToDb('2026-10-03')) // la fecha no se movió
    })

    it('registra PLATFORM_CHARGE_UPDATED con los campos que cambiaron', async () => {
      instalarOcurrencias([fila(FECHA)])
      instalarFacturas([])
      dadoElCobro(UNICA())

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS, anchorDate: OTRA_FECHA }, 'staff-1', AHORA)

      expect(mockLogAction).toHaveBeenCalledTimes(1)
      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PLATFORM_CHARGE_UPDATED',
          staffId: 'staff-1',
          entity: 'PlatformCharge',
          entityId: 'cobro-1',
          data: { changedFields: ['anchorDate', 'concepts'] },
        }),
      )
    })

    it('revisa la fecha y la factura DENTRO del candado y ANTES de escribir; la bitácora va después, fuera', async () => {
      instalarOcurrencias([fila(FECHA)])
      instalarFacturas([])
      dadoElCobro(UNICA())
      const eventos = trazar()

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      expect(dentroDeLaTransaccion(eventos)).toEqual([
        'candado',
        'leer cobro',
        'revisar marcadas', // la fecha del cobro
        'revisar factura',
        'actualizar cobro',
        'actualizar fecha',
      ])
      expect(eventos[eventos.length - 1]).toBe('bitácora')
    })

    it('si por algún motivo el cobro no tiene su fecha, editarlo la vuelve a crear (no queda un cobro sin fecha)', async () => {
      const filas = instalarOcurrencias([])
      instalarFacturas([])
      dadoElCobro(UNICA())

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS, anchorDate: OTRA_FECHA }, 'staff-1', AHORA)

      expect(filas.map(f => `${dia(f.dueDate)}:${f.status}`)).toEqual([`${OTRA_FECHA}:PENDING`])
      expect(filas[0]).toMatchObject({ concepts: NUEVOS_CONCEPTOS, totalCents: 116000 })
    })
  })

  describe('updateCharge — si la fecha ya no se puede editar, 409 con la razón y sin escribir nada', () => {
    it.each(EDICIONES)('PAGADA, cambiar %s: «Deshaz el pago»', async (_que, cambio) => {
      const filas = instalarOcurrencias([fila(FECHA, { status: 'PAID', paidAt: AHORA, paidById: 'staff-9' })])
      instalarFacturas([])
      dadoElCobro(UNICA())
      const antes = JSON.stringify(filas)

      const error = await updateCharge('cobro-1', cambio, 'staff-1', AHORA).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).statusCode).toBe(409)
      expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_ONE_TIME_PAID')
      expect((error as ConflictError).message).toBe('Este cobro ya está marcado como pagado. Deshaz el pago para poder editarlo.')
      expect(JSON.stringify(filas)).toBe(antes)
      ningunaEscritura()
    })

    it.each(EDICIONES)('OMITIDA, cambiar %s: «Deshaz la omisión»', async (_que, cambio) => {
      instalarOcurrencias([fila(FECHA, { status: 'SKIPPED', skippedAt: AHORA, skippedById: 'staff-9' })])
      instalarFacturas([])
      dadoElCobro(UNICA())

      const error = await updateCharge('cobro-1', cambio, 'staff-1', AHORA).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_ONE_TIME_SKIPPED')
      expect((error as ConflictError).message).toBe('Este cobro está omitido. Deshaz la omisión para poder editarlo.')
      ningunaEscritura()
    })

    it.each(['STAMPED', 'CANCEL_REQUESTED', 'STAMPING'])('con una factura %s (viva): «Quítala o cancélala»', async estado => {
      const filas = instalarOcurrencias([fila(FECHA)])
      instalarFacturas([{ id: 'cfdi-1', platformChargeOccurrenceId: `o-${FECHA}`, status: estado }])
      dadoElCobro(UNICA())
      const antes = JSON.stringify(filas)

      for (const [, cambio] of EDICIONES) {
        const error = await updateCharge('cobro-1', cambio, 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(ConflictError)
        expect((error as ConflictError).statusCode).toBe(409)
        expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_ONE_TIME_HAS_INVOICE')
        expect((error as ConflictError).message).toBe('Este cobro ya tiene una factura. Quítala o cancélala para poder editarlo.')
      }
      expect(JSON.stringify(filas)).toBe(antes)
      ningunaEscritura()
    })

    it.each(['CANCELLED', 'STAMP_FAILED', 'DRAFT'])('una factura %s ya no es viva: la fecha sin pagar se puede editar', async estado => {
      const filas = instalarOcurrencias([fila(FECHA)])
      instalarFacturas([{ id: 'cfdi-1', platformChargeOccurrenceId: `o-${FECHA}`, status: estado }])
      dadoElCobro(UNICA())

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)

      expect(filas[0]).toMatchObject({ id: `o-${FECHA}`, totalCents: 116000 })
    })

    it('sólo cuenta la factura de ESTA fecha: la de otra fecha no estorba', async () => {
      const filas = instalarOcurrencias([fila(FECHA)])
      instalarFacturas([{ id: 'cfdi-ajena', platformChargeOccurrenceId: 'o-de-otro-cobro', status: 'STAMPED' }])
      dadoElCobro(UNICA())

      await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)

      expect(filas[0].totalCents).toBe(116000)
    })

    it('PAGADA y con factura viva: manda la factura, porque «Deshacer» el pago también se bloquea mientras exista', async () => {
      instalarOcurrencias([fila(FECHA, { status: 'PAID', paidAt: AHORA, paidById: 'staff-9' })])
      instalarFacturas([{ id: 'cfdi-1', platformChargeOccurrenceId: `o-${FECHA}`, status: 'STAMPED' }])
      dadoElCobro(UNICA())

      const error = await updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA).catch((e: unknown) => e)

      expect((error as ConflictError).code).toBe('PLATFORM_CHARGE_ONE_TIME_HAS_INVOICE')
    })

    it('el 409 ocurre dentro del candado y no deja a medias: ni cobro actualizado, ni fecha tocada, ni bitácora', async () => {
      instalarOcurrencias([fila(FECHA, { status: 'PAID', paidAt: AHORA, paidById: 'staff-9' })])
      instalarFacturas([])
      dadoElCobro(UNICA())
      const eventos = trazar()

      await expect(updateCharge('cobro-1', { concepts: NUEVOS_CONCEPTOS }, 'staff-1', AHORA)).rejects.toBeInstanceOf(ConflictError)

      expect(dentroDeLaTransaccion(eventos)).toEqual(['candado', 'leer cobro', 'revisar marcadas', 'revisar factura'])
      expect(eventos).not.toContain('bitácora')
    })

    it('lo que no es de la fecha (nombre, perfil fiscal) se edita aunque esté pagada y con factura: sólo cambia el cobro', async () => {
      const filas = instalarOcurrencias([fila(FECHA, { status: 'PAID', paidAt: AHORA, paidById: 'staff-9' })])
      instalarFacturas([{ id: 'cfdi-1', platformChargeOccurrenceId: `o-${FECHA}`, status: 'STAMPED' }])
      dadoElCobro(UNICA())
      const antes = JSON.stringify(filas)

      await updateCharge('cobro-1', { customerName: 'Estética Luna Centro' }, 'staff-1', AHORA)

      expect(prismaMock.platformCharge.update).toHaveBeenCalledWith({
        where: { id: 'cobro-1' },
        data: expect.objectContaining({ customerName: 'Estética Luna Centro' }),
      })
      expect(prismaMock.platformChargeOccurrence.update).not.toHaveBeenCalled()
      expect(JSON.stringify(filas)).toBe(antes)
    })

    it('reenviar el formulario completo sin cambiar nada, con la fecha pagada y con factura, tampoco estorba: no hay nada que editar', async () => {
      instalarOcurrencias([fila(FECHA, { status: 'PAID', paidAt: AHORA, paidById: 'staff-9' })])
      instalarFacturas([{ id: 'cfdi-1', platformChargeOccurrenceId: `o-${FECHA}`, status: 'STAMPED' }])
      dadoElCobro(UNICA())

      await expect(
        updateCharge(
          'cobro-1',
          {
            customerType: 'ORGANIZATION',
            organizationId: 'org-1',
            customerName: 'Estética Luna',
            billingTaxProfileId: 'perfil-1',
            frequency: 'ONE_TIME',
            anchorDate: FECHA,
            concepts: [RENTA, LICENCIA],
            invoiceMode: 'AUTOMATIC',
          },
          'staff-1',
          AHORA,
        ),
      ).resolves.toBeDefined()
      ningunaEscritura()
    })
  })

  describe('pauseCharge y resumeCharge', () => {
    it('pausar uno de una sola vez es 400 PLATFORM_CHARGE_ONE_TIME_NO_PAUSE, con o sin omitir lo vencido, y no escribe nada', async () => {
      instalarOcurrencias([fila('2026-10-26'), fila(FECHA)])
      dadoElCobro(UNICA())

      for (const skipOverdue of [false, true]) {
        const error = await pauseCharge('cobro-1', { skipOverdue }, 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(BadRequestError)
        expect((error as BadRequestError).statusCode).toBe(400)
        expect((error as BadRequestError).code).toBe('PLATFORM_CHARGE_ONE_TIME_NO_PAUSE')
        expect((error as BadRequestError).message).toBe(
          'Un cobro de una sola vez no se puede pausar ni reanudar. Si ya no se va a cobrar, omite su fecha.',
        )
      }
      ningunaEscritura()
    })

    it('reanudar uno de una sola vez también es 400, tenga o no pausedAt, y no escribe nada', async () => {
      instalarOcurrencias([fila(FECHA)])

      for (const pausedAt of [null, new Date('2026-10-13T16:00:00.000Z')]) {
        dadoElCobro(UNICA({ pausedAt }))

        const error = await resumeCharge('cobro-1', 'staff-1', AHORA).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(BadRequestError)
        expect((error as BadRequestError).code).toBe('PLATFORM_CHARGE_ONE_TIME_NO_PAUSE')
      }
      ningunaEscritura()
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('platform-charges/charges.service — contrato que no se debe romper (REGRESSION)', () => {
  it('ninguna operación toca las ocurrencias de OTRO cobro ni lo ya pagado u omitido', async () => {
    const ajenas = [
      fila('2026-11-09', { chargeId: 'cobro-2', id: 'ajena-futura' }),
      fila('2026-10-26', { chargeId: 'cobro-2', id: 'ajena-vencida' }),
    ]
    const pagada = fila('2026-10-19', { status: 'PAID', paidAt: AHORA, paidById: 'staff-9' })
    const omitida = fila('2026-10-12', { status: 'SKIPPED', skippedAt: AHORA, skippedById: 'staff-9' })
    const filas = instalarOcurrencias([...ajenas, pagada, omitida, fila('2026-11-09')])
    const foto = (f: Fila) => JSON.stringify(f)
    const intactas = [...ajenas, pagada, omitida].map(foto)
    dadoElCobro()

    await updateCharge('cobro-1', { concepts: [{ ...RENTA, amountCents: 1 }] }, 'staff-1', AHORA)
    await pauseCharge('cobro-1', { skipOverdue: true }, 'staff-1', AHORA)
    dadoElCobro(cobro({ pausedAt: AHORA }))
    await resumeCharge('cobro-1', 'staff-1', AHORA)

    expect([...ajenas, pagada, omitida].map(foto)).toEqual(intactas)
    expect(filas).toEqual(expect.arrayContaining([...ajenas, pagada, omitida]))
  })

  it('los totales de cada ocurrencia son centavos enteros y se calculan sobre la SUMA de los conceptos, no renglón por renglón', async () => {
    // $33.33 con IVA, dos veces: renglón por renglón darían 2873 + 2873 de base y 460 + 460 de IVA (5746 / 920); sumando primero,
    // como el PAC, son 5747 / 919. El total es el mismo (6666): lo que cambia es el desglose, y el CFDI tiene que coincidir.
    const filas = instalarOcurrencias([])
    prismaMock.platformCharge.findMany.mockResolvedValueOnce([{ id: 'cobro-1' }])
    dadoElCobro(
      cobro({
        concepts: [
          { ...LICENCIA, amountCents: 3333 },
          { ...LICENCIA, description: 'Otra', amountCents: 3333 },
        ],
      }),
    )

    await generateAllActive(AHORA)

    expect(filas).toHaveLength(2)
    for (const f of filas) {
      expect(f).toMatchObject({ subtotalCents: 5747, taxCents: 919, totalCents: 6666 })
      for (const cents of [f.subtotalCents, f.taxCents, f.totalCents]) expect(Number.isInteger(cents)).toBe(true)
    }
  })
})
