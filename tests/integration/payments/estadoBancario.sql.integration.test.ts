/**
 * Codex R14-3: el estado bancario tiene UNA clasificación — la de `clasificarEstadoBancario` (JS) — y su espejo en SQL
 * (`estadoBancarioSql`, el que usan el selector de la primera evidencia y S6) tiene que decir EXACTAMENTE lo mismo sobre la
 * misma matriz de valores: campo ausente, JSON null, número, booleano, objeto, arreglo, cadena vacía, sólo espacios (ASCII y
 * Unicode), `approved` con mayúsculas y con los espacios que `trim()` quita (tabulador, NBSP, BOM, separadores), y rechazos.
 * Un `btrim` de Postgres sólo quita el espacio ASCII: sin el patrón compartido, `"\tapproved\u00a0"` sería APROBADO en JS y
 * RECHAZADO en SQL — la incoherencia que Codex R14-3 denunció (captura y confirmación no coincidían con el clasificador).
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { clasificarEstadoBancario, estadoBancarioSql, eventoAprobadoSql } from '@/services/tpv/estadoBancario'
import { evidenciaDurableDelIngreso } from '@/services/tpv/evidenciaDeIngreso'
import { contradiccionDeProcedenciaSql, hayAprobadoVinculadoSql, sinEventoQueVetaSql } from '@/services/tpv/evidenciaPositivaSql'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { crearFixture, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

// `terminalPaymentService` se importa sólo por `aprobacionBancariaConocida` (una lectura): sin sockets ni alertas reales.
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

beforeAll(() => exigirBaseDesechable())

/** [descripción, cuerpo `payload` del evento (JSON), valor JS equivalente de `status`] */
const MATRIZ: [string, Record<string, unknown>, unknown][] = [
  ['campo ausente', {}, undefined],
  ['null presente', { status: null }, null],
  ['número', { status: 123 }, 123],
  ['cero', { status: 0 }, 0],
  ['booleano', { status: true }, true],
  ['objeto', { status: {} }, {}],
  ['arreglo', { status: ['approved'] }, ['approved']],
  ['cadena vacía', { status: '' }, ''],
  ['sólo espacios ASCII', { status: '   ' }, '   '],
  ['sólo tab y salto', { status: '\n\t' }, '\n\t'],
  ['sólo NBSP y BOM', { status: ' ﻿' }, ' ﻿'],
  ['approved', { status: 'approved' }, 'approved'],
  ['APPROVED', { status: 'APPROVED' }, 'APPROVED'],
  ['Approved con espacios ASCII', { status: '  Approved  ' }, '  Approved  '],
  ['approved con tab y NBSP', { status: '\tapproved ' }, '\tapproved '],
  ['APPROVED con BOM y salto', { status: '﻿APPROVED\n' }, '﻿APPROVED\n'],
  ['approved con separadores Unicode', { status: ' approved　' }, ' approved　'],
  ['declined', { status: 'declined' }, 'declined'],
  ['DECLINED con espacios', { status: ' DECLINED ' }, ' DECLINED '],
  ['approvedx', { status: 'approvedx' }, 'approvedx'],
  ['error', { status: 'error' }, 'error'],
]

describe('estadoBancarioSql ≡ clasificarEstadoBancario (Codex R14-3)', () => {
  it.each(MATRIZ)('%s: SQL y JS clasifican igual', async (_n, payload, valorJs) => {
    const filas = await prisma.$queryRaw<{ estado: string }[]>`
      SELECT ${estadoBancarioSql(Prisma.sql`(${JSON.stringify({ payload })}::jsonb -> 'payload' -> 'status')`)} AS estado`
    expect(filas).toHaveLength(1)
    expect(filas[0].estado).toBe(clasificarEstadoBancario(valorJs))
  })

  it('la clasificación en SQL sirve dentro de un WHERE (el selector filtra APROBADO antes de cualquier LIMIT)', async () => {
    const eventos = [
      { id: 1, payload: { status: 'declined' } },
      { id: 2, payload: { status: 123 } },
      { id: 3, payload: { status: ' Approved ' } },
      { id: 4, payload: { status: 'approved' } },
    ]
    const filas = await prisma.$queryRaw<{ id: number }[]>`
      SELECT e.id FROM (
        SELECT (x->>'id')::int AS id, x->'payload' AS payload
        FROM jsonb_array_elements(${JSON.stringify(eventos)}::jsonb) AS x
      ) e
      WHERE ${estadoBancarioSql(Prisma.sql`e.payload -> 'status'`)} = 'APROBADO'
      ORDER BY e.id ASC
      LIMIT 1`
    expect(filas).toEqual([{ id: 3 }])
  })
})

/**
 * Fase 1 del SDK propio (Tarea 4): el aviso APROBADO de Blumon (`VENTA` con `eventId` `blumon-tpv-…` y `codeResponse = '00'`)
 * cuenta como aprobación bancaria del intento en los cinco lectores de evidencia, igual que el `send_transaction` aprobado de
 * AngelPay: la primera evidencia del ingreso (tarifa congelada), el aprobado vinculado (veto y re-retención de la solicitud), el
 * veto a la declaración del cajero, la contradicción de procedencia y la aprobación conocida de la ventana. Los reversos de
 * Blumon, los no aprobados y un `codeResponse` ausente quedan fuera.
 */
describe('eventoAprobadoSql: el aprobado de Blumon cuenta igual que el de AngelPay (fase 1 del SDK propio)', () => {
  it.each([
    ['send_transaction', 'angelpay-x', { payload: { status: 'approved' } }, true],
    ['send_transaction', 'angelpay-x', { payload: { status: 'declined' } }, false],
    ['VENTA', 'blumon-tpv-1-ref', { codeResponse: '00' }, true],
    ['VENTA', 'blumon-tpv-1-ref', {}, false], // ausente NO aprueba
    ['VENTA', 'blumon-tpv-1-ref', { codeResponse: '05' }, false],
    ['DEVOLUCION', 'blumon-tpv-reversal-devolucion-1-ref', { codeResponse: '00' }, false],
    ['VENTA', 'otro-1', { codeResponse: '00' }, false],
  ] as [string, string, Record<string, unknown>, boolean][])(
    'eventoAprobadoSql(%s, %s, %j) = %s',
    async (type, eventId, payload, esperado) => {
      const filas = await prisma.$queryRaw<{ aprobado: boolean }[]>`
      SELECT ${eventoAprobadoSql('e')} AS aprobado
      FROM (SELECT ${type}::text AS "type", ${eventId}::text AS "eventId", ${JSON.stringify(payload)}::jsonb AS "payload") e`
      expect(filas).toEqual([{ aprobado: esperado }])
    },
  )

  describe('los cinco lectores', () => {
    let f: Fixture
    let n = 0
    beforeAll(async () => {
      f = await crearFixture('estbanc')
    })
    afterEach(async () => {
      await prisma.providerEventLog.deleteMany({ where: { venueId: f.venueId } })
      await f.limpiar()
    })
    afterAll(async () => {
      await prisma.providerEventLog.deleteMany({ where: { venueId: f.venueId } })
      await f.destruir()
    })

    /** Un aviso de Blumon persistido con la forma que le da el receptor: tipo = operationType, llave del intento, venue. */
    const avisoBlumon = (
      attemptId: string,
      over: { type?: string; codeResponse?: string | null; avoqado?: Record<string, unknown> } = {},
    ) => {
      const op = `${f.fixture}-${++n}`
      const type = over.type ?? 'VENTA'
      const eventId = type === 'VENTA' ? `blumon-tpv-${op}-ref` : `blumon-tpv-reversal-${type.toLowerCase()}-${op}-ref`
      return prisma.providerEventLog.create({
        data: {
          provider: 'PAYMENT_PROCESSOR',
          venueId: f.venueId,
          eventId,
          type,
          attemptId,
          payload: {
            amount: '100.00',
            reference: attemptId,
            operationNumber: op,
            operationType: type,
            ...(over.codeResponse === null ? {} : { codeResponse: over.codeResponse ?? '00' }),
            ...(over.avoqado ? { _avoqado: over.avoqado } : {}),
          } as Prisma.InputJsonValue,
        },
      })
    }
    const solicitudVinculada = async () => {
      const row = await f.solicitud()
      const attemptId = randomUUID()
      await prisma.terminalPaymentAttemptLink.create({
        data: { attemptId, requestId: row.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
      })
      return { requestId: row.requestId, attemptId }
    }

    it('evidenciaDurableDelIngreso ve el aprobado de Blumon con su captura', async () => {
      const attemptId = randomUUID()
      const captura = { slot: 'PRIMARY', pricing: { slot: 'PRIMARY', creditRate: 0.025 } }
      // Un reverso y un no aprobado del mismo intento no son evidencia de ingreso.
      await avisoBlumon(attemptId, { type: 'DEVOLUCION', avoqado: { receivedByMerchantAccountId: f.merchantId } })
      await avisoBlumon(attemptId, { codeResponse: '05', avoqado: { receivedByMerchantAccountId: f.merchantId } })
      expect(await evidenciaDurableDelIngreso(prisma, f.venueId, f.merchantId, attemptId)).toBeNull()
      const aviso = await avisoBlumon(attemptId, {
        avoqado: { receivedByMerchantAccountId: f.merchantId, tarifaCongeladaAlIngreso: captura },
      })
      expect(await evidenciaDurableDelIngreso(prisma, f.venueId, f.merchantId, attemptId)).toEqual({
        tipo: 'CON_CAPTURA',
        eventLogId: aviso.id,
        captura,
      })
    })

    it('hayAprobadoVinculadoSql ve un aprobado de Blumon del intento vinculado', async () => {
      const { requestId, attemptId } = await solicitudVinculada()
      const hay = async () =>
        (await prisma.$queryRaw<{ hay: boolean }[]>`SELECT ${hayAprobadoVinculadoSql(requestId, f.venueId)} AS hay`)[0].hay
      await avisoBlumon(attemptId, { codeResponse: '05' })
      expect(await hay()).toBe(false)
      await avisoBlumon(attemptId)
      expect(await hay()).toBe(true)
    })

    it('sinEventoQueVetaSql veta la declaración del cajero con un aprobado de Blumon', async () => {
      const { attemptId } = await solicitudVinculada()
      const sinVeto = async () =>
        (
          await prisma.$queryRaw<{ ok: boolean }[]>`
            SELECT ${sinEventoQueVetaSql(attemptId, f.venueId, f.llaveTerminal, true)} AS ok`
        )[0].ok
      await avisoBlumon(attemptId, { codeResponse: '05' })
      expect(await sinVeto()).toBe(true)
      await avisoBlumon(attemptId)
      expect(await sinVeto()).toBe(false)
    })

    it('contradiccionDeProcedenciaSql ve un aprobado de Blumon del intento (H6)', async () => {
      const { attemptId } = await solicitudVinculada()
      const contradice = async () =>
        (
          await prisma.$queryRaw<{ hay: boolean }[]>`
            SELECT ${contradiccionDeProcedenciaSql([attemptId], f.venueId, f.llaveTerminal)} AS hay`
        )[0].hay
      await avisoBlumon(attemptId, { codeResponse: '05' })
      expect(await contradice()).toBe(false)
      await avisoBlumon(attemptId)
      expect(await contradice()).toBe(true)
    })

    it('aprobacionBancariaConocida devuelve el eventLogId de un aprobado de Blumon (H6)', async () => {
      const { attemptId } = await solicitudVinculada()
      const svc = terminalPaymentService as any
      await avisoBlumon(attemptId, { type: 'CANCELACION' })
      await avisoBlumon(attemptId, { codeResponse: '05' })
      expect(await svc.aprobacionBancariaConocida(prisma, f.venueId, [attemptId])).toBeNull()
      const aviso = await avisoBlumon(attemptId)
      expect(await svc.aprobacionBancariaConocida(prisma, f.venueId, [attemptId])).toEqual({ eventLogId: aviso.id })
    })
  })
})
