/**
 * Revisión final · ronda 5 (17-sep) — el ÚNICO defecto que Codex r10 dejó abierto (P1-B, dinero).
 *
 * 🔑 La forma del defecto, que es lo que hay que atacar: **se acota ANTES de filtrar.** El selector de la RED DURABLE traía
 * la evidencia de colisión con un `LIMIT 1` y sólo DESPUÉS, ya en el núcleo, se comprobaba si la identidad acreditada de esa
 * evidencia es la terminal de la solicitud (regla T10). Tomar «la primera» de un conjunto y sólo entonces preguntar si sirve
 * deja fuera a todas las demás PARA SIEMPRE:
 *
 *  1. E1 apunta a la solicitud liberada pero pertenece a OTRA terminal.
 *  2. El selector devuelve E1 por su `LIMIT 1`; T10 contesta `IDENTITY_MISMATCH` — correctamente: la fila ajena no se toca.
 *  3. Llega E2, legítima, y su re-retención inmediata se difiere (`DEFERRED`, candado ocupado).
 *  4. El selector SIGUE devolviendo E1. La caché de contradicciones omite volver a evaluarla, y **nadie examina jamás E2**:
 *     la solicitud se queda liberada diciéndole al POS «Se puede volver a cobrar» con una posible segunda captura encima.
 *
 * El arreglo NO relaja T10 (una evidencia ajena sigue sin tocar la fila y sigue gritando): lo que cambia es que se SIGUE
 * BUSCANDO entre las candidatas acotadas en vez de quedarse con la primera.
 */
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
  socketManager: { getServer: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => {
  const normalizeTerminalId = (id: string) => id.replace(/^AVQD-/i, '').toLowerCase()
  return {
    normalizeTerminalId,
    terminalRegistry: { getTerminal: jest.fn(), getTerminalBySocketId: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
  }
})

const prismaMock = prisma as any
const tpr = () => prismaMock.terminalPaymentRequest
const svc = terminalPaymentService as any
const opsAlert = require('@/services/alerts/opsAlert.service')
const logger = require('@/config/logger').default

/** El texto COMPLETO de un tagged template de Prisma: las plantillas y los fragmentos `Prisma.sql` anidados. */
const sqlDe = (llamada: any[]) => {
  const [strings, ...values] = llamada
  const fragmentos: string[] = []
  const recolectar = (v: unknown) => {
    if (v && typeof v === 'object' && typeof (v as { sql?: unknown }).sql === 'string') {
      fragmentos.push((v as { sql: string }).sql)
      for (const anidado of ((v as { values?: unknown[] }).values ?? []) as unknown[]) recolectar(anidado)
    }
  }
  for (const v of values) recolectar(v)
  return { texto: (strings as string[]).join('?'), fragmentos, values }
}

const liberada = (extra: Record<string, unknown> = {}) => ({
  id: 'row-e',
  requestId: 'REQ-E',
  venueId: 'venue-1',
  terminalId: 't-e',
  orderId: 'order-e',
  amountCents: 10000,
  tipCents: 0,
  status: 'FAILED',
  failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
  paymentId: null,
  updatedAt: new Date('2026-09-17T10:05:00.000Z'),
  resultJson: {
    requestId: 'REQ-E',
    status: 'failed',
    outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
    errorMessage: 'No se confirmó el cobro en la ventana de 30 s. Se puede volver a cobrar.',
    releasedAfterWindow: { windowMs: 30_000, releasedAt: '2026-09-17T10:00:00.000Z', origen: 'TIMER' },
  },
  ...extra,
})

const CONSULTA = 'liberadas-con-senal'
const consultas = () => prismaMock.$queryRaw.mock.calls.filter((c: any[]) => (c[0] as string[]).join('?').includes(CONSULTA))

/**
 * 🔴 La fila tal como la describe LA BASE cuando hay varias evidencias PENDING sobre la MISMA solicitud liberada.
 *
 * Lleva las DOS lecturas a propósito, y no es una concesión al arreglo: es el estado real de la base visto por cada versión
 * del código. `evidenciaId` es lo que el selector de HOY surface (su `LIMIT 1` devuelve la primera, E1) y `evidenciaIds` es
 * el conjunto ACOTADO que el selector tiene que surfacear. Así el código de hoy lee lo único que sabe leer —E1, y ahí se
 * queda— y el arreglado ve las dos. La prueba de que la base de verdad devuelve las dos es la de integración
 * (`terminalPaymentWindowSenalesTardias`), que corre el selector REAL contra Postgres.
 */
const filaDeLaBase = (ids: string[]) => ({
  requestId: 'REQ-E',
  venueId: 'venue-1',
  createdAt: new Date('2026-09-16T00:00:00Z'),
  id: 'row-e',
  paymentId: null,
  evidenciaId: ids[0] ?? null,
  evidenciaIds: ids.length > 0 ? ids : null,
  afirmacion: false,
})

const conFilas = (ids: string[]) =>
  prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
    (strings as string[]).join('?').includes(CONSULTA) ? [filaDeLaBase(ids)] : [],
  )

let alerta: jest.SpyInstance

beforeEach(() => {
  alerta = jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true as never)
  tpr().findFirst.mockReset().mockResolvedValue(liberada())
  tpr().findMany.mockReset().mockResolvedValue([])
  tpr().updateMany.mockReset().mockResolvedValue({ count: 0 })
  tpr().count.mockReset().mockResolvedValue(0)
  prismaMock.terminalPaymentAttemptLink.findMany.mockReset().mockResolvedValue([])
  prismaMock.payment.count.mockReset().mockResolvedValue(0)
  prismaMock.payment.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.$queryRaw.mockReset().mockResolvedValue([])
  prismaMock.$executeRaw.mockReset().mockResolvedValue(1)
  prismaMock.activityLog.create.mockReset().mockResolvedValue({ id: 'log' })
  prismaMock.$transaction.mockReset().mockImplementation((callback: any) => callback(prismaMock))
  ;(logger.error as jest.Mock).mockClear()
  ;(logger.warn as jest.Mock).mockClear()
  svc.contradiccionesDeLaRed?.clear?.()
})
afterEach(() => alerta.mockRestore())

// ════════ P1-B · una evidencia AJENA no puede tapar a una LEGÍTIMA ════════
describe('Ronda 5 · P1-B: el `LIMIT 1` antes de acreditar la identidad escondía una evidencia legítima para siempre', () => {
  /** El núcleo real: sólo la legítima acredita identidad; la ajena devuelve `IDENTITY_MISMATCH` (y no toca la fila). */
  const nucleo = (legitima: string) =>
    jest
      .spyOn(svc, 'retenerSolicitudLiberadaPorColisionDeReferencia')
      .mockImplementation(async (input: any) => (input.paymentId === legitima ? 'HELD' : 'IDENTITY_MISMATCH'))

  let veredicto: jest.SpyInstance
  beforeEach(() => {
    // El veredicto COMPARTIDO no aplica (no hay Payment que conciliar ni ligar): esto es la rama de las señales SIN pago.
    veredicto = jest.spyOn(svc, 'conciliarORetenerLiberada').mockResolvedValue('NADA')
  })
  afterEach(() => veredicto.mockRestore())

  it('🔴 la secuencia de Codex: E1 ajena + E2 legítima ⇒ la solicitud acaba RETENIDA por E2, no liberada para siempre', async () => {
    conFilas(['E1-ajena', 'E2-legitima'])
    const colision = nucleo('E2-legitima')
    try {
      const r = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      // Lo que Codex reprodujo en memoria: la ajena se examina (y se rechaza) y la legítima NUNCA se examinaba.
      const pedidas = colision.mock.calls.map((c: any[]) => c[0].paymentId)
      expect(pedidas).toContain('E1-ajena')
      expect(pedidas).toContain('E2-legitima')
      expect(r).toMatchObject({ sinPago: 1 })
    } finally {
      colision.mockRestore()
    }
  })

  it('🔴 y no se cura con el tiempo: cuatro pasadas del vigía con el defecto dejan la solicitud liberada', async () => {
    conFilas(['E1-ajena', 'E2-legitima'])
    const colision = nucleo('E2-legitima')
    try {
      let retenidas = 0
      for (let pasada = 0; pasada < 4; pasada++) {
        const r = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
        retenidas += r.sinPago
      }
      expect(retenidas).toBeGreaterThanOrEqual(1)
      // La caché sigue sirviendo: la ajena se evalúa UNA sola vez en las cuatro pasadas (el 🚨 no se repite cada 30 s).
      expect(colision.mock.calls.filter((c: any[]) => c[0].paymentId === 'E1-ajena')).toHaveLength(1)
    } finally {
      colision.mockRestore()
    }
  })

  it('el orden no la salva: con la legítima PRIMERA se retiene en la primera candidata y la otra ni se toca', async () => {
    conFilas(['E1-legitima', 'E2-ajena'])
    const colision = nucleo('E1-legitima')
    try {
      const r = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      expect(r).toMatchObject({ sinPago: 1 })
      // «Dos legítimas no se procesan dos veces»: al primer HELD se para.
      expect(colision.mock.calls.map((c: any[]) => c[0].paymentId)).toEqual(['E1-legitima'])
    } finally {
      colision.mockRestore()
    }
  })

  it('control: una evidencia AJENA SOLA sigue sin tocar la fila, y sigue gritando (T10 intacta)', async () => {
    conFilas(['E1-ajena'])
    const colision = nucleo('NINGUNA')
    try {
      const r = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      expect(r).toMatchObject({ sinPago: 0 })
      expect(colision).toHaveBeenCalledTimes(1)
    } finally {
      colision.mockRestore()
    }
  })

  it('control: DOS ajenas ⇒ cada contradicción se evalúa UNA vez, y ninguna se repite en la pasada siguiente', async () => {
    conFilas(['E1-ajena', 'E2-ajena'])
    const colision = nucleo('NINGUNA')
    try {
      await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:30.000Z'))
      expect(colision.mock.calls.map((c: any[]) => c[0].paymentId)).toEqual(['E1-ajena', 'E2-ajena'])
    } finally {
      colision.mockRestore()
    }
  })

  it('🔴 un `DEFERRED` PARA el recorrido (la base no está para más) y no envenena la caché: la pasada siguiente reintenta', async () => {
    conFilas(['E1-diferida', 'E2-legitima'])
    const colision = jest
      .spyOn(svc, 'retenerSolicitudLiberadaPorColisionDeReferencia')
      .mockImplementationOnce(async () => 'DEFERRED')
      .mockImplementation(async (input: any) => (input.paymentId === 'E2-legitima' ? 'HELD' : 'IDENTITY_MISMATCH'))
    try {
      expect(await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))).toMatchObject({ sinPago: 0 })
      expect(colision.mock.calls.map((c: any[]) => c[0].paymentId)).toEqual(['E1-diferida'])
      // Nada se recordó: la siguiente pasada vuelve a empezar por E1 y llega hasta E2.
      expect(await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:30.000Z'))).toMatchObject({ sinPago: 1 })
      expect(colision.mock.calls.map((c: any[]) => c[0].paymentId)).toEqual(['E1-diferida', 'E1-diferida', 'E2-legitima'])
    } finally {
      colision.mockRestore()
    }
  })

  it('la afirmación de la terminal sigue siendo el respaldo cuando NINGUNA candidata acredita identidad', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA) ? [{ ...filaDeLaBase(['E1-ajena', 'E2-ajena']), afirmacion: true }] : [],
    )
    const colision = nucleo('NINGUNA')
    const porAfirmacion = jest.spyOn(svc, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal').mockResolvedValue('HELD')
    try {
      const r = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      expect(colision).toHaveBeenCalledTimes(2)
      expect(porAfirmacion).toHaveBeenCalledWith({ requestId: 'REQ-E', venueId: 'venue-1', origen: 'BARRIDO_SENALES' })
      expect(r).toMatchObject({ sinPago: 1 })
    } finally {
      colision.mockRestore()
      porAfirmacion.mockRestore()
    }
  })

  it('🔴 el recorrido está ACOTADO: aunque la fila traiga más candidatas, nunca se evalúan más que el tope', async () => {
    const muchas = Array.from({ length: 50 }, (_, i) => `E${i}-ajena`)
    conFilas(muchas)
    const colision = nucleo('NINGUNA')
    try {
      await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      expect(colision.mock.calls.length).toBeLessThanOrEqual(5)
      expect(colision.mock.calls.length).toBeGreaterThan(1)
    } finally {
      colision.mockRestore()
    }
  })
})

// ════════ El selector: se acota DENTRO de la consulta, y sigue siendo UNA por lote ════════
describe('Ronda 5 · el selector surfacea un conjunto ACOTADO de evidencias, no «la primera»', () => {
  it('🔴 la evidencia de colisión viaja como CONJUNTO acotado y determinista, no como un `LIMIT 1`', async () => {
    await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
    expect(consultas()).toHaveLength(1)
    const { texto, fragmentos, values } = sqlDe(consultas()[0])
    const completo = texto + ' ' + fragmentos.join(' ')
    // El conjunto, agregado DENTRO del LATERAL: acotado, ordenado (determinista) y con su propio tope.
    expect(completo).toContain('array_agg')
    expect(completo).toContain('"evidenciaIds"')
    expect(completo).toMatch(/ORDER BY 1\s+LIMIT/)
    // El filtro NO cambia: un conjunto vacío es NULL, igual que lo era el id ausente del `LIMIT 1`.
    expect(completo).toMatch(/ligado\."id" IS NOT NULL OR .*colision\."ids" IS NOT NULL/s)
    // Y el recorrido conserva sus límites: mismo keyset, mismo lote, mismo horizonte de 7 días.
    expect(completo).toMatch(/ORDER BY r\."createdAt" ASC, r\."id" ASC/)
    expect(values).toContain(200)
    expect(values).toContain(5)
    expect(JSON.stringify(values)).toContain('2026-09-10T12:00:00')
  })
})
