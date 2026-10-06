// tests/integration/staffPay/ajustesManuales.test.ts
import prisma from '@/utils/prismaClient'
import { agregarAjusteManual, previewAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import {
  barreraDeLaOrganizacion,
  barreraDelPeriodo,
  borrarMundo,
  CIERRE_EN_CURSO,
  clase,
  conCandadoRetenido,
  confirmadas,
  crearMundo,
  crearSede,
  Mundo,
  tablaMindform,
} from './_mundo'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  // El cierre resuelve sus permisos ANTES de la transacción (revisión A8, Importante 2).
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))
const acceso = jest.requireMock('@/services/dashboard/staffPay/acceso')

const AHORA = new Date('2026-09-02T12:00:00Z')
let m: Mundo
let n = 0
const ajuste = (extra: Partial<Parameters<typeof agregarAjusteManual>[0]> = {}) =>
  agregarAjusteManual({
    userId: m.owner,
    venueId: m.venueId,
    sede: m.venueId,
    staffId: m.carla,
    amount: 300,
    reason: 'Bono de septiembre',
    fecha: '2026-08-20',
    clientKey: `${m.key}-${++n}`,
    ahora: AHORA,
    ...extra,
  })

beforeEach(async () => {
  m = await crearMundo('manuales')
  ;(global as any).__sedes = [m.venueId]
  await tablaMindform(m)
})
afterEach(() => borrarMundo(m))

describe('ajustes manuales (spec §6.4)', () => {
  it('un bono y un descuento quedan en el periodo de la fecha, con sede, motivo y ActivityLog', async () => {
    const bono = await ajuste()
    const desc = await ajuste({ staffId: m.ana, amount: -125.5, reason: 'Llegó tarde' })
    expect(bono).toMatchObject({ amount: '300.00', sede: m.venueId, periodo: { start: '2026-08-01', end: '2026-08-31' }, yaExistia: false })
    expect(desc.amount).toBe('-125.50')
    expect(desc.periodId).toBe(bono.periodId)
    expect(
      await prisma.activityLog.count({ where: { action: 'SERVICE_PAY_MANUAL_ADJUSTMENT', entityId: { in: [bono.id, desc.id] } } }),
    ).toBe(2)
  })

  it('un ajuste nuevo guarda el nombre visible de la persona: su recibo abre aunque después la borren (spec fase 3 §6.1)', async () => {
    const bono = await ajuste()
    const e = await prisma.serviceEarning.findUniqueOrThrow({ where: { id: bono.id } })
    expect(e.descriptor).toMatchObject({ persona: 'Carla QA', motivo: 'Bono de septiembre' })
  })

  it('el mismo clientKey no crea una segunda línea; con otro contenido es un error, no el éxito del primero', async () => {
    const a = await ajuste({ clientKey: `${m.key}-fijo` })
    const b = await ajuste({ clientKey: `${m.key}-fijo` })
    expect(b).toMatchObject({ id: a.id, yaExistia: true })
    await expect(ajuste({ clientKey: `${m.key}-fijo`, amount: 999 })).rejects.toMatchObject({ code: 'CLAVE_REUTILIZADA' })
    await expect(ajuste({ clientKey: `${m.key}-fijo`, staffId: m.ana })).rejects.toMatchObject({ code: 'CLAVE_REUTILIZADA' })
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, concept: 'MANUAL' } })).toBe(1)
  })

  it('la misma clave hacia OTRO periodo destino es un error: un bono idéntico para septiembre no devuelve el de agosto (Codex R2-R1-4)', async () => {
    const agosto = await ajuste({ clientKey: `${m.key}-destino` })
    expect(agosto.periodo).toEqual({ start: '2026-08-01', end: '2026-08-31' })
    await expect(ajuste({ clientKey: `${m.key}-destino`, fecha: '2026-09-10' })).rejects.toMatchObject({
      code: 'CLAVE_REUTILIZADA',
      statusCode: 409,
      message: 'Esta solicitud ya se usó para otro ajuste. Vuelve a abrir el formulario.',
    })
    // Otro día del MISMO periodo es la misma operación: devuelve la guardada.
    await expect(ajuste({ clientKey: `${m.key}-destino`, fecha: '2026-08-25' })).resolves.toMatchObject({ id: agosto.id, yaExistia: true })
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, concept: 'MANUAL' } })).toBe(1)
  })

  it('la clave es POR ORGANIZACIÓN: la misma clientKey en otro negocio se guarda (sin 500 y sin revelar la otra)', async () => {
    const m2 = await crearMundo('manuales-b')
    try {
      const clientKey = `compartida-${m.key}`
      const a = await ajuste({ clientKey })
      ;(global as any).__sedes = [m2.venueId]
      const b = await agregarAjusteManual({
        userId: m2.owner,
        venueId: m2.venueId,
        sede: m2.venueId,
        staffId: m2.carla,
        amount: 300,
        reason: 'Bono de septiembre',
        fecha: '2026-08-20',
        clientKey,
        ahora: AHORA,
      })
      expect(a.yaExistia).toBe(false)
      expect(b).toMatchObject({ yaExistia: false, sede: m2.venueId, staffId: m2.carla })
      expect(b.id).not.toBe(a.id)
      expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, clientKey } })).toBe(1)
      expect(await prisma.serviceEarning.count({ where: { organizationId: m2.orgId, clientKey } })).toBe(1)
    } finally {
      await borrarMundo(m2)
    }
  })

  it('permiso: exige staffpay:close en la sede del ajuste', async () => {
    acceso.assertPermisoEnSedes.mockClear()
    await ajuste()
    expect(acceso.assertPermisoEnSedes).toHaveBeenCalledWith(m.owner, [m.venueId], 'staffpay:close', expect.any(String))
  })

  it('otra organización: una persona con StaffVenue en otro negocio es PERSONA_AJENA y una sede ajena no se encuentra', async () => {
    const m2 = await crearMundo('manuales-c')
    try {
      await expect(ajuste({ staffId: m2.ana })).rejects.toMatchObject({ code: 'PERSONA_AJENA' })
      await expect(ajuste({ sede: m2.venueId })).rejects.toMatchObject({ statusCode: 404 })
      expect(await prisma.serviceEarning.count({ where: { organizationId: { in: [m.orgId, m2.orgId] } } })).toBe(0)
    } finally {
      await borrarMundo(m2)
    }
  })

  it('el preview rechaza lo mismo que la confirmación: persona ajena y sede sin el módulo', async () => {
    const pv = (extra: Partial<Parameters<typeof previewAjusteManual>[0]> = {}) =>
      previewAjusteManual({
        userId: m.owner,
        venueId: m.venueId,
        sede: m.venueId,
        staffId: m.carla,
        amount: 300,
        reason: 'Bono',
        fecha: '2026-08-20',
        ahora: AHORA,
        ...extra,
      })
    const ajena = await prisma.staff.create({
      data: { email: `${m.key}-ajena@example.test`, firstName: 'Ajena', lastName: 'QA', active: true },
    })
    await expect(pv({ staffId: ajena.id })).rejects.toMatchObject({ code: 'PERSONA_AJENA' })
    const otra = await crearSede(m.orgId, m.key, 'bsf') // sin módulo y fuera del alcance
    await expect(pv({ sede: otra.venueId })).rejects.toMatchObject({ code: 'SEDE_SIN_MODULO' })
    // Una sede que ya está en el alcance guardado del periodo sí se puede, aunque hoy no tenga el módulo.
    await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId, otra.venueId],
      },
    })
    await expect(pv({ sede: otra.venueId })).resolves.toMatchObject({ sede: otra.venueId, periodo: { estado: 'OPEN' } })
  })

  it('doble clic: dos envíos SIMULTÁNEOS con la misma clave dejan una sola línea y los dos devuelven la misma', async () => {
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    const barrera = await barreraDelPeriodo(agosto.id)
    const dos = Promise.allSettled([ajuste({ clientKey: `${m.key}-doble` }), ajuste({ clientKey: `${m.key}-doble` })])
    try {
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const [a, b] = await dos
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('fulfilled')
    const ids = [a, b].map(r => (r as PromiseFulfilledResult<{ id: string }>).value.id)
    expect(ids[0]).toBe(ids[1])
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, concept: 'MANUAL' } })).toBe(1)
  })

  it('módulos y permisos se resuelven ANTES de la transacción: dentro no se llama al cliente global (Codex bloque A #3)', async () => {
    // Con el pool lleno, una transacción que pide OTRA conexión para el módulo o el permiso espera a sí misma (timeout).
    // Dos caminos: un periodo que se CREA (asegurarPeriodo) y uno guardado al que se le SUMA la sede (ampliarAlcance).
    const otra = await crearSede(m.orgId, m.key, 'bsf')
    await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [otra.venueId],
      },
    })
    const linea: string[] = []
    const real = prisma.$transaction.bind(prisma)
    const espia = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, o: any) =>
      real(async (tx: any) => {
        linea.push('abre')
        try {
          return await fn(tx)
        } finally {
          linea.push('cierra')
        }
      }, o)) as any)
    const globales = ['sedesConServicePay', 'sedesConPermiso', 'assertPermisoEnSedes'] as const
    const originales = globales.map(g => acceso[g].getMockImplementation())
    globales.forEach((g, i) =>
      acceso[g].mockImplementation(async (...a: unknown[]) => {
        linea.push(g)
        return originales[i](...a)
      }),
    )
    try {
      const julio = await ajuste({ fecha: '2026-07-10' }) // crea julio
      const agosto = await ajuste() // agosto ya existe sólo con BSF: suma PN
      expect(julio.periodo).toEqual({ start: '2026-07-01', end: '2026-07-31' })
      expect((await prisma.servicePayPeriod.findUniqueOrThrow({ where: { id: agosto.periodId } })).venueIds.sort()).toEqual(
        [m.venueId, otra.venueId].sort(),
      )
    } finally {
      espia.mockRestore()
      globales.forEach((g, i) => acceso[g].mockImplementation(originales[i]))
    }
    const dentro: string[] = []
    let abierta = 0
    for (const x of linea) {
      if (x === 'abre') abierta++
      else if (x === 'cierra') abierta--
      else if (abierta > 0) dentro.push(x)
    }
    expect(linea.filter(x => x === 'abre').length).toBeGreaterThanOrEqual(2)
    expect(dentro).toEqual([])
  })

  it('rechaza: monto cero, motivo corto, periodo cerrado, sede sin el módulo y persona de otro negocio', async () => {
    await expect(ajuste({ amount: 0 })).rejects.toThrow(/no puede ser cero/)
    await expect(ajuste({ amount: 10.005 })).rejects.toThrow('El monto admite hasta 2 decimales')
    await expect(ajuste({ reason: 'x' })).rejects.toThrow(/motivo/)
    const otra = await crearSede(m.orgId, m.key, 'bsf') // sin módulo: no está en __sedes
    await expect(ajuste({ sede: otra.venueId })).rejects.toMatchObject({ code: 'SEDE_SIN_MODULO' })
    const ajena = await prisma.staff.create({
      data: { email: `${m.key}-ajena@example.test`, firstName: 'Ajena', lastName: 'QA', active: true },
    })
    await expect(ajuste({ staffId: ajena.id })).rejects.toMatchObject({ code: 'PERSONA_AJENA' })
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
    await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: '2026-08-15',
      ahora: AHORA,
      huellaEsperada: p.huella,
      confirmarHuerfanas: true,
    })
    await expect(ajuste()).rejects.toMatchObject({ code: 'PERIODO_CERRADO' })
  })

  // full-testing A6: aceptaba 1900 y 2999 y creaba esos periodos (el de 2999 salía primero en el selector como «Abierto»).
  it('la fecha va de hoy − 12 meses al fin del periodo de hoy: fuera, 400 con el rango y SIN crear ningún periodo', async () => {
    const periodos = () => prisma.servicePayPeriod.count({ where: { organizationId: m.orgId } })
    const antes = await periodos()
    // AHORA = 2 sep 2026 ⇒ del 2 sep 2025 al 30 sep 2026 (fin del periodo mensual de hoy).
    const fuera = {
      statusCode: 400,
      code: 'FECHA_FUERA_DE_RANGO',
      message: 'La fecha del ajuste debe estar entre 2 sep 2025 y 30 sep 2026',
      details: { desde: '2025-09-02', hasta: '2026-09-30' },
    }
    const base = { userId: m.owner, venueId: m.venueId, sede: m.venueId, staffId: m.carla, amount: 300, reason: 'Bono', ahora: AHORA }
    for (const fecha of ['1900-01-01', '2999-01-01', '2025-09-01', '2026-10-01']) {
      await expect(ajuste({ fecha })).rejects.toMatchObject(fuera)
      await expect(previewAjusteManual({ ...base, fecha })).rejects.toMatchObject(fuera)
    }
    expect(await periodos()).toBe(antes)
    // Los bordes sí entran.
    await expect(ajuste({ fecha: '2025-09-02' })).resolves.toMatchObject({ periodo: { start: '2025-09-01', end: '2025-09-30' } })
    await expect(ajuste({ fecha: '2026-09-30' })).resolves.toMatchObject({ periodo: { start: '2026-09-01', end: '2026-09-30' } })
  })

  it('la huella del preview fija el periodo destino: confirmar hacia otro periodo pide revisar (Codex R1-10)', async () => {
    const pv = await previewAjusteManual({
      userId: m.owner,
      venueId: m.venueId,
      sede: m.venueId,
      staffId: m.carla,
      amount: 300,
      reason: 'Bono de septiembre',
      fecha: '2026-08-20',
      ahora: AHORA,
    })
    expect(pv.periodo).toMatchObject({ start: '2026-08-01', end: '2026-08-31', estado: 'OPEN' })
    // A quién y en qué sede: lo que el humano revisa antes de autorizar (dos «Ana» en el estudio).
    expect(pv).toMatchObject({ persona: 'Carla QA', sedeNombre: `${m.key}-pn` })
    await expect(ajuste({ fecha: '2026-09-10', huellaEsperada: pv.huella })).rejects.toMatchObject({ code: 'HUELLA_CAMBIO' })
    await expect(ajuste({ fecha: '2026-08-21', huellaEsperada: pv.huella })).resolves.toMatchObject({ amount: '300.00' })
  })

  it('un descuento mayor que el total deja el recibo en negativo (no se recorta)', async () => {
    await ajuste({ staffId: m.carla, amount: -500, reason: 'Adelanto de nómina' })
    const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
    const r = await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: '2026-08-15',
      ahora: AHORA,
      huellaEsperada: p.huella,
      confirmarHuerfanas: true,
    })
    const recibo = await prisma.staffPayStatement.findUniqueOrThrow({
      where: { periodId_staffId: { periodId: r.periodId, staffId: m.carla } },
    })
    expect(recibo.total.toFixed(2)).toBe('-500.00')
  })

  it('un bono que compite con el cierre queda DENTRO del recibo o se rechaza con PERIODO_CERRADO; nunca guardado fuera', async () => {
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    // El periodo existe ANTES: las dos operaciones lo encuentran y se detienen en su candado (la barrera lo tiene).
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    // El preview va ANTES de la carrera (Codex R1-15): así los únicos desenlaces válidos son dos, y los dos se exigen.
    const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
    // Barrera real (Codex R2-R1-15): se suelta sólo cuando las DOS están esperando el candado del periodo.
    const barrera = await barreraDelPeriodo(agosto.id)
    const carrera = Promise.allSettled([
      cerrarPeriodo({
        userId: m.owner,
        venueId: m.venueId,
        fecha: '2026-08-15',
        ahora: AHORA,
        huellaEsperada: p.huella,
        confirmarHuerfanas: true,
      }),
      ajuste(),
    ])
    try {
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const [cierre, bono] = await carrera
    const periodo = await prisma.servicePayPeriod.findFirstOrThrow({ where: { organizationId: m.orgId } })
    const lineas = await prisma.serviceEarning.aggregate({ where: { periodId: periodo.id }, _sum: { amount: true } })
    if (cierre.status === 'fulfilled') {
      // El cierre ganó: el bono tuvo que recibir «periodo cerrado» (cualquier otro error es un defecto).
      expect(bono).toMatchObject({ status: 'rejected', reason: { code: 'PERIODO_CERRADO' } })
      const recibos = await prisma.staffPayStatement.aggregate({ where: { periodId: periodo.id }, _sum: { total: true } })
      expect(recibos._sum.total?.toFixed(2)).toBe(lineas._sum.amount?.toFixed(2))
      expect(lineas._sum.amount?.toFixed(2)).toBe('570.00')
    } else {
      // El bono ganó: el cierre vio otra huella y no congeló nada; el bono sigue en el periodo abierto.
      expect(cierre).toMatchObject({ status: 'rejected', reason: { code: 'HUELLA_CAMBIO' } })
      expect(bono.status).toBe('fulfilled')
      expect(periodo.status).toBe('OPEN')
      expect(lineas._sum.amount?.toFixed(2)).toBe('300.00')
    }
  })

  it('con el BONO primero en el candado: el cierre no congela sin él (HUELLA_CAMBIO) y el siguiente cierre lo incluye', async () => {
    // La prueba de arriba siempre la gana el cierre (llega antes a su candado). Aquí el orden se fuerza: el bono espera
    // primero, así que obtiene el candado primero y el cierre —cuya foto es de ANTES del bono— tiene que reintentar.
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
    const barrera = await barreraDelPeriodo(agosto.id)
    let bono!: Promise<unknown>
    let cierre!: Promise<unknown>
    try {
      bono = ajuste()
      await barrera.esperarA(1)
      cierre = cerrarPeriodo({
        userId: m.owner,
        venueId: m.venueId,
        fecha: '2026-08-15',
        ahora: AHORA,
        huellaEsperada: p.huella,
        confirmarHuerfanas: true,
      })
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const [rCierre, rBono] = await Promise.allSettled([cierre, bono])
    expect(rBono.status).toBe('fulfilled')
    expect(rCierre).toMatchObject({ status: 'rejected', reason: { code: 'HUELLA_CAMBIO' } })
    expect((await prisma.servicePayPeriod.findUniqueOrThrow({ where: { id: agosto.id } })).status).toBe('OPEN')
    expect(await prisma.staffPayStatement.count({ where: { periodId: agosto.id } })).toBe(0)

    const p2 = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
    await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: '2026-08-15',
      ahora: AHORA,
      huellaEsperada: p2.huella,
      confirmarHuerfanas: true,
    })
    const recibo = await prisma.staffPayStatement.findUniqueOrThrow({
      where: { periodId_staffId: { periodId: agosto.id, staffId: m.carla } },
    })
    expect(recibo.total.toFixed(2)).toBe('300.00')
    const recibos = await prisma.staffPayStatement.aggregate({ where: { periodId: agosto.id }, _sum: { total: true } })
    expect(recibos._sum.total?.toFixed(2)).toBe('870.00')
  })
})

/**
 * B7 r2: un cierre retiene la FILA de su periodo (`bloquearPeriodo`) y el candado de la organización todo lo que dura
 * (~40 s). Un ajuste manual espera con tope y contesta 409 CIERRE_EN_CURSO, nunca el P2028 (500) de su transacción de 10 s.
 */
describe('con un cierre en curso, el ajuste manual no espera sin tope (B7 r2)', () => {
  it('sobre un periodo YA guardado: 409 CIERRE_EN_CURSO a los ~5 s y no escribe', async () => {
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    const r = await conCandadoRetenido(await barreraDelPeriodo(agosto.id), () => ajuste())
    expect(r.error).toMatchObject(CIERRE_EN_CURSO)
    expect(r.ms).toBeGreaterThanOrEqual(4_500)
    expect(r.ms).toBeLessThan(25_000)
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, concept: 'MANUAL' } })).toBe(0)
  }, 60_000)

  it('con el periodo todavía POR CREAR (candado de la organización): también 409, y no crea el periodo', async () => {
    const r = await conCandadoRetenido(await barreraDeLaOrganizacion(m.orgId), () => ajuste())
    expect(r.error).toMatchObject(CIERRE_EN_CURSO)
    expect(r.ms).toBeGreaterThanOrEqual(4_500)
    expect(r.ms).toBeLessThan(25_000)
    expect(await prisma.servicePayPeriod.count({ where: { organizationId: m.orgId } })).toBe(0)
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, concept: 'MANUAL' } })).toBe(0)
  }, 60_000)
})
