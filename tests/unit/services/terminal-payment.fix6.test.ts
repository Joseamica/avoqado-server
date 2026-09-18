/**
 * Revisión final · ronda 6 (17-sep) — el ÚNICO defecto que Codex r11 dejó abierto (P1-B, dinero): falta AVANCE entre páginas.
 *
 * 🔑 La ronda 5 dejó de quedarse con «la primera» evidencia y recorre un conjunto ACOTADO de cinco. Codex demostró que el tope
 * sin avance sigue escondiendo evidencias: con cinco AJENAS delante y una sexta LEGÍTIMA, cuatro barridos examinaron sólo
 * E1–E5, E6 siguió PENDING y la solicitud respondió `failed / «Se puede volver a cobrar»`. Y no hay invariante que limite a
 * cinco: el registro crea la colisión aunque el arbitraje haya rechazado la asociación.
 *
 * La forma del arreglo la prescribió Codex: cinco por pasada + CURSOR PERSISTIDO por solicitud (`id > último ORDER BY id`),
 * que AVANZA sobre lo examinado o recordado, CONSERVA la candidata ante `DEFERRED` y se REINICIA al agotar el conjunto.
 *
 * Esta suite emula la BASE: el selector devuelve lo que devolvería Postgres (ids mayores que el cursor, en el orden de la
 * base, con una de más para saber si hay página siguiente) y la escritura del cursor lo guarda con su CAS. La prueba de que
 * la base de verdad hace eso es la de integración (`terminalPaymentWindowSenalesTardias`, «Ronda 6»), que corre el selector
 * REAL contra Postgres.
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
const { logAction } = require('@/services/dashboard/activity-log.service')
const logger = require('@/config/logger').default

const CONSULTA = 'liberadas-con-senal'
/** El tope de evidencias que se EXAMINAN por pasada (`LIMITE_DE_EVIDENCIAS_DE_COLISION`). */
const TOPE = 5
const ACCION_DEL_AVISO = 'TERMINAL_PAYMENT_EVIDENCE_NOT_ACCREDITED_AFTER_RELEASE'

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

/**
 * 🔴 La BASE emulada, por solicitud: las evidencias PENDING apuntadas a ella y el cursor persistido.
 *
 * El orden es el de Postgres con collation `C` (el de la base desechable): orden de bytes, igual que `sort()` de JS para
 * estos ids. El cursor sólo lo cambia la escritura con su CAS (`IS NOT DISTINCT FROM` el valor que se leyó).
 */
type Solicitud = { requestId: string; rowId: string; evidencias: string[]; cursor: string | null; retenida?: boolean }
let solicitudes: Solicitud[]
let escrituras: Array<{ rowId: string; anterior: string | null; nuevo: string | null }>

const pagina = (s: Solicitud) => {
  const orden = [...s.evidencias].sort()
  return (s.cursor === null ? orden : orden.filter(id => id > (s.cursor as string))).slice(0, TOPE + 1)
}

/** Lo que el selector REAL devuelve: la fila entra si trae evidencias en su página o si tiene un cursor que reiniciar. */
const filasDelSelector = () =>
  solicitudes.flatMap(s => {
    // Una solicitud RETENIDA ya no es liberada (`TIMED_OUT`): el `WHERE` del selector la deja fuera.
    if (s.retenida) return []
    const ids = pagina(s)
    if (ids.length === 0 && s.cursor === null) return []
    return [
      {
        requestId: s.requestId,
        venueId: 'venue-1',
        createdAt: new Date('2026-09-16T00:00:00Z'),
        id: s.rowId,
        paymentId: null,
        evidenciaIds: ids.length > 0 ? ids : null,
        afirmacion: false,
        cursorDeEvidencias: s.cursor,
      },
    ]
  })

/** Monta la base con UNA solicitud (la de siempre) o varias. */
const conBase = (...s: Array<Partial<Solicitud> & { evidencias: string[] }>) => {
  solicitudes = s.map((x, i) => ({
    requestId: x.requestId ?? (i === 0 ? 'REQ-E' : `REQ-${i}`),
    rowId: x.rowId ?? (i === 0 ? 'row-e' : `row-${i}`),
    evidencias: x.evidencias,
    cursor: x.cursor ?? null,
  }))
}

const pasada = (segundo = 0) => svc.retenerLiberadasConSenalPositiva(new Date(Date.UTC(2026, 8, 17, 12, 0, segundo)))

/** El núcleo real decide la identidad; aquí la legítima retiene y cualquier otra es `IDENTITY_MISMATCH` (T10 intacta). */
const nucleo = (resolver: (paymentId: string) => string) =>
  jest.spyOn(svc, 'retenerSolicitudLiberadaPorColisionDeReferencia').mockImplementation(async (input: any) => {
    const r = resolver(input.paymentId)
    if (r === 'HELD') for (const s of solicitudes) if (s.requestId === input.requestId) s.retenida = true
    return r
  })
const pedidas = (spy: jest.SpyInstance) => spy.mock.calls.map((c: any[]) => c[0].paymentId)

let alerta: jest.SpyInstance
let veredicto: jest.SpyInstance
let asientos: Array<Record<string, any>>
const avisos = () => alerta.mock.calls.filter((c: any[]) => String(c[0]?.subject).includes('no acredita'))
const asientosDelAviso = () => asientos.filter(a => a.action === ACCION_DEL_AVISO)

beforeEach(() => {
  conBase({ evidencias: [] })
  escrituras = []
  asientos = []
  alerta = jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true as never)
  // El veredicto COMPARTIDO no aplica (no hay Payment que conciliar ni ligar): esto es la rama de las señales SIN pago.
  veredicto = jest.spyOn(svc, 'conciliarORetenerLiberada').mockResolvedValue('NADA')
  tpr()
    .findFirst.mockReset()
    .mockImplementation(async ({ where }: any) => {
      const s = solicitudes.find(x => x.requestId === where.requestId)
      return s ? liberada({ id: s.rowId, requestId: s.requestId }) : null
    })
  prismaMock.$queryRaw
    .mockReset()
    .mockImplementation(async (strings: string[]) => ((strings as string[]).join('?').includes(CONSULTA) ? filasDelSelector() : []))
  // La escritura del cursor. La base sólo aplica el CAS si el `WHERE` lo PIDE — igual que Postgres: una escritura sin él
  // pisaría el cursor de otra instancia, y esta emulación no se lo va a esconder.
  prismaMock.$executeRaw.mockReset().mockImplementation(async (strings: string[], ...values: unknown[]) => {
    const texto = (strings as string[]).join('?')
    if (!texto.includes('"collisionEvidenceCursor"')) return 1
    const [nuevo, rowId, anterior] = values as [string | null, string, string | null]
    const s = solicitudes.find(x => x.rowId === rowId)
    if (!s) return 0
    if (texto.includes('"collisionEvidenceCursor" IS NOT DISTINCT FROM') && s.cursor !== anterior) return 0
    s.cursor = nuevo
    escrituras.push({ rowId, anterior, nuevo })
    return 1
  })
  // La bitácora DURABLE: lo que se escribe en `ActivityLog` es lo que `debeAuditar` encuentra después (sobrevive a un
  // reinicio). El aviso escribe su asiento DIRECTO —no con `logAction`, que falla en silencio—: `logAction` no debe tocarse.
  ;(logAction as jest.Mock).mockReset()
  prismaMock.activityLog.create.mockReset().mockImplementation(async ({ data }: { data: Record<string, any> }) => {
    asientos.push(data)
    return { id: `log-${asientos.length}` }
  })
  prismaMock.activityLog.findFirst
    .mockReset()
    .mockImplementation(async ({ where }: any) =>
      asientos.some(a => a.action === where.action && a.entityId === where.entityId) ? { id: 'log' } : null,
    )
  ;(logger.error as jest.Mock).mockClear()
  ;(logger.warn as jest.Mock).mockClear()
  svc.contradiccionesDeLaRed?.clear?.()
  svc.anomaliasAuditadas?.clear?.()
})
afterEach(() => {
  alerta.mockRestore()
  veredicto.mockRestore()
})

// ════════ P1-B · el AVANCE entre páginas ════════
describe('Ronda 6 · P1-B: el tope de cinco sin avance escondía la sexta evidencia para siempre', () => {
  it('🔴 la secuencia de Codex con SEIS: cinco ajenas + una sexta legítima ⇒ la sexta se examina y la solicitud queda retenida', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-legitima'] })
    const colision = nucleo(id => (id === 'E6-legitima' ? 'HELD' : 'IDENTITY_MISMATCH'))
    try {
      let retenidas = 0
      // Las cuatro pasadas que Codex corrió: con el defecto, las cuatro examinan sólo E1–E5.
      for (let p = 0; p < 4; p++) retenidas += (await pasada(p * 30)).sinPago
      expect(pedidas(colision)).toContain('E6-legitima')
      expect(retenidas).toBe(1)
      // La caché sigue sirviendo: cada ajena se examinó UNA sola vez (su 🚨 no se repite en cada pasada).
      for (const ajena of ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena'])
        expect(pedidas(colision).filter(id => id === ajena)).toHaveLength(1)
      // Y como la legítima retuvo, no sale el aviso de «atascada»: esa solicitud ya tiene quien la decida.
      expect(avisos()).toHaveLength(0)
    } finally {
      colision.mockRestore()
    }
  })

  it('el tope sigue valiendo POR PASADA: nunca se examinan más de cinco evidencias de una solicitud en la misma pasada', async () => {
    conBase({ evidencias: Array.from({ length: 12 }, (_, i) => `E${String(i).padStart(2, '0')}-ajena`) })
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      await pasada()
      expect(colision).toHaveBeenCalledTimes(TOPE)
      await pasada(30)
      expect(colision).toHaveBeenCalledTimes(2 * TOPE)
    } finally {
      colision.mockRestore()
    }
  })

  it('🔴 condición 3: ante `DEFERRED` la candidata se CONSERVA — el cursor no pasa por encima y la pasada siguiente la retoma', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-legitima'] })
    let diferida = false
    const colision = nucleo(id => {
      if (id !== 'E6-legitima') return 'IDENTITY_MISMATCH'
      if (!diferida) {
        diferida = true
        return 'DEFERRED'
      }
      return 'HELD'
    })
    try {
      expect(await pasada()).toMatchObject({ sinPago: 0 }) // E1–E5 examinadas: el cursor avanza hasta E5
      expect(solicitudes[0].cursor).toBe('E5-ajena')
      expect(await pasada(30)).toMatchObject({ sinPago: 0 }) // E6 se difiere
      expect(solicitudes[0].cursor).toBe('E5-ajena') // 🔴 NO avanzó sobre la candidata diferida
      expect(await pasada(60)).toMatchObject({ sinPago: 1 }) // …y la pasada siguiente la retoma y retiene
      expect(pedidas(colision).filter(id => id === 'E6-legitima')).toHaveLength(2)
    } finally {
      colision.mockRestore()
    }
  })

  it('condición 3, a media página: lo examinado ANTES del diferimiento sí avanza; la diferida y lo que sigue se conservan', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-diferida', 'E3-ajena'] })
    let diferida = false
    const colision = nucleo(id => {
      if (id !== 'E2-diferida') return 'IDENTITY_MISMATCH'
      if (!diferida) {
        diferida = true
        return 'DEFERRED'
      }
      return 'HELD'
    })
    try {
      await pasada()
      expect(solicitudes[0].cursor).toBe('E1-ajena')
      expect(await pasada(30)).toMatchObject({ sinPago: 1 })
      // E1 no se volvió a examinar (el cursor ya la dejó atrás) y E2 se examinó dos veces.
      expect(pedidas(colision)).toEqual(['E1-ajena', 'E2-diferida', 'E2-diferida'])
    } finally {
      colision.mockRestore()
    }
  })

  it('🔴 condición 4: al AGOTAR el conjunto el cursor se REINICIA y recoge una evidencia insertada ANTES de donde quedó', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-ajena'] })
    const colision = nucleo(id => (id === 'E2b-legitima' ? 'HELD' : 'IDENTITY_MISMATCH'))
    try {
      await pasada() // E1–E5 ⇒ cursor en E5
      expect(solicitudes[0].cursor).toBe('E5-ajena')
      // Llega una legítima cuyo id queda DETRÁS del cursor (ids que no crecen estrictamente, otro reloj, otra instancia).
      solicitudes[0].evidencias.push('E2b-legitima')
      expect(await pasada(30)).toMatchObject({ sinPago: 0 }) // E6: la página se AGOTA ⇒ el cursor vuelve al principio
      expect(solicitudes[0].cursor).toBeNull()
      expect(await pasada(60)).toMatchObject({ sinPago: 1 }) // desde el principio: E1 y E2 recordadas, E2b retenida
      expect(pedidas(colision)).toContain('E2b-legitima')
    } finally {
      colision.mockRestore()
    }
  })

  it('condición 2: una contradicción RECORDADA no vuelve a consumir el cupo — el cursor pasa por encima de ella', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-ajena', 'E7-legitima'] })
    const colision = nucleo(id => (id === 'E7-legitima' ? 'HELD' : 'IDENTITY_MISMATCH'))
    try {
      // Las cinco primeras ya las gritó este proceso (otra pasada, otro camino): están en la caché.
      for (const e of ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena']) svc.contradiccionesDeLaRed.add(`venue-1:REQ-E:${e}`)
      await pasada()
      expect(colision).not.toHaveBeenCalled() // recordadas: no se re-examinan…
      expect(solicitudes[0].cursor).toBe('E5-ajena') // …pero el cursor SÍ avanza sobre ellas
      expect(await pasada(30)).toMatchObject({ sinPago: 1 }) // E6 ajena, E7 legítima
      expect(pedidas(colision)).toEqual(['E6-ajena', 'E7-legitima'])
    } finally {
      colision.mockRestore()
    }
  })

  it('no regresión: UNA evidencia legítima sola se resuelve en la PRIMERA pasada y no escribe cursor', async () => {
    conBase({ evidencias: ['E1-legitima'] })
    const colision = nucleo(id => (id === 'E1-legitima' ? 'HELD' : 'IDENTITY_MISMATCH'))
    try {
      expect(await pasada()).toMatchObject({ sinPago: 1 })
      expect(pedidas(colision)).toEqual(['E1-legitima'])
      expect(escrituras).toHaveLength(0)
    } finally {
      colision.mockRestore()
    }
  })

  it('no regresión: con la legítima entre las cinco primeras, la ronda 5 se conserva (se retiene en la misma pasada)', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-legitima', 'E3-ajena'] })
    const colision = nucleo(id => (id === 'E2-legitima' ? 'HELD' : 'IDENTITY_MISMATCH'))
    try {
      expect(await pasada()).toMatchObject({ sinPago: 1 })
      expect(pedidas(colision)).toEqual(['E1-ajena', 'E2-legitima'])
      expect(escrituras).toHaveLength(0) // se retuvo: el cursor ya no sirve de nada y no se toca
    } finally {
      colision.mockRestore()
    }
  })

  it('un conjunto de hasta cinco ajenas que se agota en la misma página NO escribe cursor (cero escrituras en el caso común)', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena'] })
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      for (let p = 0; p < 4; p++) await pasada(p * 30)
      expect(escrituras).toHaveLength(0)
      expect(colision).toHaveBeenCalledTimes(2) // cada ajena, una vez
    } finally {
      colision.mockRestore()
    }
  })

  it('🔴 la escritura del cursor es CONTABILIDAD: CAS sobre el valor leído, sin tocar `updatedAt` ni el estado', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-ajena'] })
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      await pasada()
      const escritura = prismaMock.$executeRaw.mock.calls.find((c: any[]) =>
        (c[0] as string[]).join('?').includes('"collisionEvidenceCursor"'),
      )
      expect(escritura).toBeDefined()
      const texto = (escritura[0] as string[]).join('?')
      expect(texto).toMatch(/"collisionEvidenceCursor" IS NOT DISTINCT FROM/)
      // `updatedAt` gobierna el barrido de 30 min y es la «última modificación real» de la fila: el cursor no la mueve.
      expect(texto).not.toContain('"updatedAt"')
      expect(texto).not.toMatch(/"status"|"failureCode"|"resultJson"/)
      expect(escrituras).toEqual([{ rowId: 'row-e', anterior: null, nuevo: 'E5-ajena' }])
    } finally {
      colision.mockRestore()
    }
  })

  it('🔴 si otra instancia movió el cursor, el CAS pierde y NO lo pisa con un valor viejo', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-ajena', 'E7-ajena'] })
    const colision = nucleo(id => {
      // Mientras esta pasada examina, otra instancia adelanta el cursor hasta E6.
      if (id === 'E5-ajena') solicitudes[0].cursor = 'E6-ajena'
      return 'IDENTITY_MISMATCH'
    })
    try {
      await pasada()
      expect(solicitudes[0].cursor).toBe('E6-ajena') // el de la otra instancia se conserva
      expect(escrituras).toHaveLength(0)
    } finally {
      colision.mockRestore()
    }
  })

  it('🔴 un fallo al escribir el cursor NO tumba la red: se avisa y las demás solicitudes del lote se procesan', async () => {
    conBase(
      { requestId: 'REQ-A', rowId: 'row-a', evidencias: ['A1-ajena', 'A2-ajena', 'A3-ajena', 'A4-ajena', 'A5-ajena', 'A6-ajena'] },
      { requestId: 'REQ-B', rowId: 'row-b', evidencias: ['B1-legitima'] },
    )
    prismaMock.$executeRaw.mockImplementation(async (strings: string[]) => {
      if ((strings as string[]).join('?').includes('"collisionEvidenceCursor"')) throw new Error('conexión perdida')
      return 1
    })
    const colision = nucleo(id => (id === 'B1-legitima' ? 'HELD' : 'IDENTITY_MISMATCH'))
    try {
      const r = await pasada()
      expect(r).toMatchObject({ sinPago: 1 }) // REQ-B se retuvo aunque la escritura de REQ-A reventó
      expect(pedidas(colision)).toContain('B1-legitima')
      expect((logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('cursor'))).toBe(true)
    } finally {
      colision.mockRestore()
    }
  })

  it('el selector trae el cursor de la fila, filtra por él, pide UNA de más y deja pasar la fila que sólo tiene cursor', async () => {
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      await pasada()
      const [llamada] = prismaMock.$queryRaw.mock.calls.filter((c: any[]) => (c[0] as string[]).join('?').includes(CONSULTA))
      const [strings, ...values] = llamada
      const texto = (strings as string[]).join('?')
      expect(texto).toContain('r."collisionEvidenceCursor" AS "cursorDeEvidencias"')
      expect(texto).toMatch(/e\."id" > r\."collisionEvidenceCursor"/)
      // El orden del conjunto lo fija el AGREGADO, no la suerte: con cursor, el orden es lo que decide qué se conserva.
      expect(texto).toMatch(/array_agg\(c\."id" ORDER BY c\."id"\)/)
      expect(values).toContain(TOPE + 1)
      expect(texto).toMatch(/OR r\."collisionEvidenceCursor" IS NOT NULL\)/)
    } finally {
      colision.mockRestore()
    }
  })
})

// ════════ El segundo hallazgo · la solicitud atascada no puede ser INVISIBLE (y tampoco un correo por pasada) ════════
describe('Ronda 6 · una solicitud atascada por evidencias que no acreditan su terminal avisa UNA vez, por correo y en la bitácora', () => {
  it('🔴 dos ajenas y nada más: la solicitud queda liberada ⇒ UN correo y UN asiento, aunque pasen cuatro pasadas', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena'] })
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      for (let p = 0; p < 4; p++) await pasada(p * 30)
      expect(avisos()).toHaveLength(1)
      expect(asientosDelAviso()).toHaveLength(1)
      const [aviso] = avisos()[0]
      expect(aviso.subject).toContain('t-e')
      const texto = aviso.lines.join(' ')
      expect(texto).toContain('REQ-E')
      expect(texto).toContain('$100.00')
      expect(texto).toContain('E1-ajena')
      expect(texto).toContain('E2-ajena')
      expect(asientosDelAviso()[0]).toMatchObject({
        venueId: 'venue-1',
        entity: 'TerminalPaymentRequest',
        entityId: 'row-e',
        data: expect.objectContaining({ requestId: 'REQ-E', evidencePaymentIds: ['E1-ajena', 'E2-ajena'] }),
      })
    } finally {
      colision.mockRestore()
    }
  })

  it('🔴 y NO se repite tras un reinicio del proceso: la bitácora es la memoria, no la caché', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena'] })
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      await pasada()
      expect(avisos()).toHaveLength(1)
      // Reinicio: se pierden las dos memorias de proceso (contradicciones y anomalías ya auditadas).
      svc.contradiccionesDeLaRed.clear()
      svc.anomaliasAuditadas.clear()
      await pasada(30)
      await pasada(60)
      expect(avisos()).toHaveLength(1)
      expect(asientosDelAviso()).toHaveLength(1)
    } finally {
      colision.mockRestore()
    }
  })

  it('con EXACTAMENTE cinco ajenas el conjunto se agota en la primera página: avisa ahí, sin esperar una página vacía', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena'] })
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      await pasada()
      expect(avisos()).toHaveLength(1)
      expect(escrituras).toHaveLength(0)
    } finally {
      colision.mockRestore()
    }
  })

  it('con MÁS de cinco ajenas el cursor va y viene entre páginas, y el aviso sale UNA sola vez', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-ajena', 'E7-ajena'] })
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      for (let p = 0; p < 6; p++) await pasada(p * 30)
      expect(avisos()).toHaveLength(1)
      expect(asientosDelAviso()).toHaveLength(1)
      // Las siete se examinaron UNA vez cada una (la caché sirve), aunque el cursor diera varias vueltas.
      expect(colision).toHaveBeenCalledTimes(7)
    } finally {
      colision.mockRestore()
    }
  })

  it('no avisa cuando la página sale vacía porque lo que quedaba DESPUÉS del cursor desapareció: sólo reinicia', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-ajena'] })
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      await pasada() // E1–E5 ⇒ cursor en E5 (hay una sexta)
      expect(solicitudes[0].cursor).toBe('E5-ajena')
      // Alguien concilió E6 a mano: deja de ser evidencia PENDING y la página siguiente sale vacía.
      solicitudes[0].evidencias = solicitudes[0].evidencias.filter(e => e !== 'E6-ajena')
      await pasada(30)
      expect(solicitudes[0].cursor).toBeNull() // la fila entró SÓLO por su cursor, y se reinició
      // Una página vacía no prueba que la solicitud esté atascada: el aviso lo decide el recorrido completo siguiente.
      expect(avisos()).toHaveLength(0)
    } finally {
      colision.mockRestore()
    }
  })

  it('no avisa mientras el recorrido NO ha agotado el conjunto (una página llena todavía puede traer la legítima detrás)', async () => {
    conBase({ evidencias: ['E1-ajena', 'E2-ajena', 'E3-ajena', 'E4-ajena', 'E5-ajena', 'E6-legitima'] })
    const colision = nucleo(id => (id === 'E6-legitima' ? 'DEFERRED' : 'IDENTITY_MISMATCH'))
    try {
      await pasada() // E1–E5, página llena
      await pasada(30) // E6 diferida: no se agotó nada
      expect(avisos()).toHaveLength(0)
    } finally {
      colision.mockRestore()
    }
  })

  it('no avisa si la afirmación de la terminal RETIENE la solicitud (ya no está atascada)', async () => {
    conBase({ evidencias: ['E1-ajena'] })
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA) ? filasDelSelector().map(f => ({ ...f, afirmacion: true })) : [],
    )
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    const porAfirmacion = jest.spyOn(svc, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal').mockResolvedValue('HELD')
    try {
      expect(await pasada()).toMatchObject({ sinPago: 1 })
      expect(avisos()).toHaveLength(0)
    } finally {
      colision.mockRestore()
      porAfirmacion.mockRestore()
    }
  })

  it('🔴 sin asiento NO hay correo (un reinicio lo repetiría): si escribir el asiento falla, la pasada siguiente reintenta los dos', async () => {
    conBase({ evidencias: ['E1-ajena'] })
    prismaMock.activityLog.create.mockRejectedValueOnce(new Error('base caída'))
    const colision = nucleo(() => 'IDENTITY_MISMATCH')
    try {
      await pasada()
      expect(avisos()).toHaveLength(0) // ni asiento ni correo
      expect(asientosDelAviso()).toHaveLength(0)
      expect((logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('evidencia sin identidad'))).toBe(true)
      await pasada(30) // la reserva en proceso se soltó: esta pasada lo vuelve a intentar
      expect(asientosDelAviso()).toHaveLength(1)
      expect(avisos()).toHaveLength(1)
      await pasada(60)
      expect(avisos()).toHaveLength(1)
      expect(logAction).not.toHaveBeenCalled()
    } finally {
      colision.mockRestore()
    }
  })

  it('un fallo al auditar el aviso no tumba la red y se reintenta en la pasada siguiente', async () => {
    conBase({ evidencias: ['E1-ajena'] }, { requestId: 'REQ-B', rowId: 'row-b', evidencias: ['B1-legitima'] })
    prismaMock.activityLog.findFirst.mockRejectedValueOnce(new Error('base caída'))
    const colision = nucleo(id => (id === 'B1-legitima' ? 'HELD' : 'IDENTITY_MISMATCH'))
    try {
      expect(await pasada()).toMatchObject({ sinPago: 1 }) // REQ-B se procesó igual
      expect(avisos()).toHaveLength(0)
      await pasada(30)
      expect(avisos()).toHaveLength(1) // la pasada siguiente sí avisa
    } finally {
      colision.mockRestore()
    }
  })
})
