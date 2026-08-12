import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { runAreaTicketExternalReconciliation } from '@/jobs/areaTicketExternalReconciliation.job'

import { prismaMock } from '../../__helpers__/setup'

const logActionMock = logAction as jest.Mock
const loggerErrorMock = logger.error as jest.Mock

const venueId = 'venue-external-recon'

/**
 * Fila tal como la devuelve el `select` del job: `AreaTicketExternalSettlement`
 * con `venue.timezone` y `areaTicket.{issuedAt, code}` incluidos — el job no
 * vuelve a consultar nada más por vale.
 */
function candidateRow(overrides: { areaTicketId: string; referenceAmount?: string; timezone?: string; issuedAt: Date; code?: string }) {
  return {
    areaTicketId: overrides.areaTicketId,
    venueId,
    referenceAmount: overrides.referenceAmount ?? '100.00',
    venue: { timezone: overrides.timezone ?? 'America/Mexico_City' },
    areaTicket: { issuedAt: overrides.issuedAt, code: overrides.code ?? '9000000000' },
  }
}

describe('Job de conciliación de cobros externos', () => {
  beforeEach(() => {
    // "Ahora" fijo en TODOS los tests: 2026-08-11T02:00:00Z == 2026-08-10
    // 20:00 en Ciudad de México (UTC-6, sin horario de verano). El día
    // operativo mexicano de "ahora" sigue siendo el 10 de agosto, aunque en
    // UTC ya haya rodado al 11 — es exactamente el escenario que el brief
    // describe para el caso "usa timezone, no UTC".
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T02:00:00.000Z'))
    prismaMock.areaTicketExternalIncident.upsert.mockResolvedValue({ id: 'incident-1' })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  // --- Tests del brief (Task 12, Step 1), verbatim en intención ---

  it('abre UNCONFIRMED_CHARGE para vales PENDING de días operativos anteriores', async () => {
    prismaMock.areaTicketExternalSettlement.findMany.mockResolvedValue([
      candidateRow({
        areaTicketId: 'ticket-yesterday',
        referenceAmount: '250.00',
        // 2026-08-09 12:00 mediodía Mexico — claramente un día operativo anterior.
        issuedAt: new Date('2026-08-09T18:00:00.000Z'),
        code: '9000000010',
      }),
    ])

    await runAreaTicketExternalReconciliation()

    expect(prismaMock.areaTicketExternalIncident.upsert).toHaveBeenCalledWith({
      where: { areaTicketId_kind: { areaTicketId: 'ticket-yesterday', kind: 'UNCONFIRMED_CHARGE' } },
      create: {
        venueId,
        areaTicketId: 'ticket-yesterday',
        kind: 'UNCONFIRMED_CHARGE',
        status: 'OPEN',
        detail: { referenceAmount: '250.00', issuedAt: '2026-08-09T18:00:00.000Z', code: '9000000010' },
      },
      update: {
        status: 'OPEN',
        detail: { referenceAmount: '250.00', issuedAt: '2026-08-09T18:00:00.000Z', code: '9000000010' },
        occurrenceCount: { increment: 1 },
        reopenedAt: expect.any(Date),
      },
    })
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AREA_TICKET_EXTERNAL_UNCONFIRMED_CHARGE_DETECTED',
        entity: 'AreaTicketExternalIncident',
        entityId: 'incident-1',
        staffId: null,
        venueId,
      }),
    )
  })

  it('NO abre incidencia para los de hoy — el día todavía no cierra', async () => {
    prismaMock.areaTicketExternalSettlement.findMany.mockResolvedValue([
      candidateRow({
        areaTicketId: 'ticket-today',
        // 19:00 Mexico del 10-ago — una hora antes de "ahora" (20:00), mismo
        // día operativo, sin ambigüedad de timezone.
        issuedAt: new Date('2026-08-11T01:00:00.000Z'),
        code: '9000000011',
      }),
    ])

    await runAreaTicketExternalReconciliation()

    expect(prismaMock.areaTicketExternalIncident.upsert).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('no duplica: correrlo dos veces deja UNA incidencia por vale', async () => {
    prismaMock.areaTicketExternalSettlement.findMany.mockResolvedValue([
      candidateRow({
        areaTicketId: 'ticket-repeat',
        issuedAt: new Date('2026-08-09T18:00:00.000Z'),
        code: '9000000012',
      }),
    ])

    await runAreaTicketExternalReconciliation()
    await runAreaTicketExternalReconciliation()

    // Lo que un test CON MOCKS puede probar: el código nunca abandona el
    // camino idempotente (`upsert` sobre la llave `(areaTicketId, kind)`,
    // jamás un `create` liso) — así que dos corridas siempre apuntan a la
    // MISMA fila. Que Postgres de verdad deje una sola fila (y reabra en vez
    // de duplicar) es lo que prueba el test de integración contra la base
    // real — un mock no puede simular la restricción `@@unique` del motor.
    expect(prismaMock.areaTicketExternalIncident.upsert).toHaveBeenCalledTimes(2)
    expect(prismaMock.areaTicketExternalIncident.create).not.toHaveBeenCalled()
    const [firstCallArgs] = prismaMock.areaTicketExternalIncident.upsert.mock.calls[0]
    const [secondCallArgs] = prismaMock.areaTicketExternalIncident.upsert.mock.calls[1]
    expect(firstCallArgs.where).toEqual({ areaTicketId_kind: { areaTicketId: 'ticket-repeat', kind: 'UNCONFIRMED_CHARGE' } })
    expect(secondCallArgs.where).toEqual(firstCallArgs.where)
  })

  it('usa el día operativo del venue en su timezone, no UTC', async () => {
    // Un venue en America/Mexico_City a las 20:00 locales sigue en el mismo día
    // operativo aunque en UTC ya sea mañana.
    //
    // "Ahora" (ver beforeEach) = 2026-08-11T02:00:00Z = 20:00 del 10-ago en
    // México. Este vale se emitió a las 09:00 del 10-ago LOCAL (15:00 UTC):
    // mismo día operativo mexicano que "ahora", pero en CALENDARIO UTC es
    // 2026-08-10 contra un "hoy" de 2026-08-11 — un corte que comparara
    // fechas por calendario UTC (en vez de `venueStartOfDay`) lo marcaría
    // como "de un día anterior" y lo reportaría por error.
    prismaMock.areaTicketExternalSettlement.findMany.mockResolvedValue([
      candidateRow({
        areaTicketId: 'ticket-same-mexico-day',
        issuedAt: new Date('2026-08-10T15:00:00.000Z'),
        code: '9000000013',
      }),
    ])

    await runAreaTicketExternalReconciliation()

    expect(prismaMock.areaTicketExternalIncident.upsert).not.toHaveBeenCalled()
  })

  it('ignora los vales en modo ASSUME_ON_PRINT: no hay nada que confirmar', async () => {
    // La exclusión ocurre en el WHERE que se manda a Postgres — un venue con
    // ASSUME_ON_PRINT nunca aparece en `candidates` para empezar (un vale así
    // no tiene nada que un humano deba confirmar; el venue se excluyó de eso
    // por diseño). Se asserta el argumento REAL de la query, no sólo que la
    // función "no truena" con una lista vacía.
    prismaMock.areaTicketExternalSettlement.findMany.mockResolvedValue([])

    await runAreaTicketExternalReconciliation()

    expect(prismaMock.areaTicketExternalSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PENDING',
          confirmationMode: 'MANUAL',
        }),
      }),
    )
    expect(prismaMock.areaTicketExternalIncident.upsert).not.toHaveBeenCalled()
  })

  // --- Endurecimiento adicional: aislamiento por fila ---

  it('un fallo al abrir la incidencia de UN vale no detiene a los demás del batch', async () => {
    prismaMock.areaTicketExternalSettlement.findMany.mockResolvedValue([
      candidateRow({ areaTicketId: 'ticket-bad', issuedAt: new Date('2026-08-09T12:00:00.000Z'), code: 'BAD' }),
      candidateRow({ areaTicketId: 'ticket-good', issuedAt: new Date('2026-08-09T12:00:00.000Z'), code: 'GOOD' }),
    ])
    prismaMock.areaTicketExternalIncident.upsert
      .mockRejectedValueOnce(new Error('boom: fallo transitorio de escritura'))
      .mockResolvedValueOnce({ id: 'incident-good' })

    await runAreaTicketExternalReconciliation()

    // Los DOS vales se intentaron — el segundo no se saltó por el fallo del primero.
    expect(prismaMock.areaTicketExternalIncident.upsert).toHaveBeenCalledTimes(2)
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('No se pudo abrir/reabrir'),
      expect.objectContaining({ areaTicketId: 'ticket-bad' }),
    )
    // El bueno sí completó su bitácora — el fallo del primero no contaminó al segundo.
    expect(logActionMock).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'incident-good' }))
  })
})
