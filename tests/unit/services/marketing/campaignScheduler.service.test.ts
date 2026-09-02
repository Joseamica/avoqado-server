// tests/unit/services/marketing/campaignScheduler.service.test.ts
/**
 * 🔴 EL FAIRNESS ES EL CORAZÓN de esta prueba. Además de la FORMA del SQL (el `FOR UPDATE
 * SKIP LOCKED`, el `ROW_NUMBER() OVER (PARTITION BY …)` y el `COALESCE` de `sendAttemptAt` no
 * se pueden probar contra Postgres real desde una suite unitaria), el reparto entre venues se
 * prueba de VERDAD con datos concretos contra `repartirEquitativo` — el espejo puro del CTE.
 * Es un espejo, no el SQL mismo: si alguien cambia uno sin el otro, esta suite no lo detecta.
 * Esa verificación en vivo queda para la Task 8.
 */
import { LEASE_MS, reclamarLote, repartirEquitativo, type CandidatoReparto } from '@/services/marketing/campaignScheduler.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $queryRaw: jest.fn() },
}))

const queryRawMock = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw

function sqlTextOf(callIndex = 0): string {
  const sql = queryRawMock.mock.calls[callIndex]?.[0] as { strings: string[]; values: unknown[] }
  return sql.strings.join('?')
}

beforeEach(() => {
  queryRawMock.mockReset()
})

describe('campaignScheduler.service — repartirEquitativo (fairness, PURA)', () => {
  it('con 3 venues de 100 pendientes y topeGlobal 60, trae 20 de CADA venue — no 60 del primero', () => {
    const candidatos: CandidatoReparto[] = []
    for (const venueId of ['venue-a', 'venue-b', 'venue-c']) {
      for (let i = 0; i < 100; i += 1) {
        candidatos.push({ id: `${venueId}-${String(i).padStart(3, '0')}`, venueId })
      }
    }

    const seleccionados = repartirEquitativo(candidatos, 60, 100)

    expect(seleccionados).toHaveLength(60)
    const porVenue = { 'venue-a': 0, 'venue-b': 0, 'venue-c': 0 }
    for (const id of seleccionados) {
      const venueId = id.slice(0, id.lastIndexOf('-'))
      porVenue[venueId as keyof typeof porVenue] += 1
    }
    expect(porVenue).toEqual({ 'venue-a': 20, 'venue-b': 20, 'venue-c': 20 })
  })

  it('respeta a los MÁS VIEJOS primero dentro de cada venue (no cualquier subconjunto de 20)', () => {
    const candidatos: CandidatoReparto[] = []
    for (const venueId of ['venue-a', 'venue-b']) {
      for (let i = 0; i < 10; i += 1) candidatos.push({ id: `${venueId}-${i}`, venueId })
    }

    const seleccionados = repartirEquitativo(candidatos, 6, 10)

    // capa 0..2 de cada venue: los índices 0,1,2 — nunca uno más nuevo colándose antes.
    expect(seleccionados.sort()).toEqual(['venue-a-0', 'venue-a-1', 'venue-a-2', 'venue-b-0', 'venue-b-1', 'venue-b-2'].sort())
  })

  it('con reparto desigual (5 pendientes vs 100), sirve al venue chico ENTERO y el resto va al grande', () => {
    const candidatos: CandidatoReparto[] = []
    for (let i = 0; i < 5; i += 1) candidatos.push({ id: `chico-${i}`, venueId: 'venue-chico' })
    for (let i = 0; i < 100; i += 1) candidatos.push({ id: `grande-${i}`, venueId: 'venue-grande' })

    const seleccionados = repartirEquitativo(candidatos, 60, 50)

    const chico = seleccionados.filter(id => id.startsWith('chico-')).length
    const grande = seleccionados.filter(id => id.startsWith('grande-')).length
    expect(chico).toBe(5)
    expect(grande).toBe(50)
    expect(seleccionados).toHaveLength(55) // 5 + 50 < topeGlobal (60): no hay más que repartir
  })

  // Minor de la revisión: los casos de arriba terminan por AGOTAMIENTO (se acabaron los
  // candidatos), nunca porque `topeGlobal` corte a media capa con venues desiguales. Ese es
  // el caso donde el reparto por capas se puede equivocar sin que nadie lo note: el corte
  // cae DENTRO de una capa y hay que servir a los venues en el orden determinista, no al
  // que casualmente venía primero en la lista de entrada.
  it('cuando topeGlobal corta a MEDIA capa con 3 venues desiguales, sirve por capas y desempata por venueId', () => {
    const candidatos: CandidatoReparto[] = []
    // Se insertan a propósito en orden INVERSO al alfabético: si el reparto dependiera del
    // orden de llegada en vez del desempate determinista, esta prueba lo caza.
    for (let i = 0; i < 2; i += 1) candidatos.push({ id: `venue-c-${i}`, venueId: 'venue-c' })
    for (let i = 0; i < 10; i += 1) candidatos.push({ id: `venue-b-${i}`, venueId: 'venue-b' })
    for (let i = 0; i < 10; i += 1) candidatos.push({ id: `venue-a-${i}`, venueId: 'venue-a' })

    // 7 no es múltiplo de 3: el corte cae a media capa. Capas completas: (a0,b0,c0),
    // (a1,b1,c1) = 6; el 7º sale de la capa 2, y ahí el turno es de `venue-a` por orden.
    const seleccionados = repartirEquitativo(candidatos, 7, 10)

    expect(seleccionados).toHaveLength(7)
    expect(seleccionados).toEqual(['venue-a-0', 'venue-b-0', 'venue-c-0', 'venue-a-1', 'venue-b-1', 'venue-c-1', 'venue-a-2'])
  })

  it('agotado un venue, las capas siguientes NO le guardan turno: el resto se reparte entre los que quedan', () => {
    const candidatos: CandidatoReparto[] = []
    for (let i = 0; i < 1; i += 1) candidatos.push({ id: `venue-c-${i}`, venueId: 'venue-c' })
    for (let i = 0; i < 4; i += 1) candidatos.push({ id: `venue-a-${i}`, venueId: 'venue-a' })
    for (let i = 0; i < 4; i += 1) candidatos.push({ id: `venue-b-${i}`, venueId: 'venue-b' })

    const seleccionados = repartirEquitativo(candidatos, 7, 10)

    // Capa 0: a0,b0,c0 · capa 1: a1,b1 (c ya se agotó) · capa 2: a2,b2 → 7.
    expect(seleccionados).toEqual(['venue-a-0', 'venue-b-0', 'venue-c-0', 'venue-a-1', 'venue-b-1', 'venue-a-2', 'venue-b-2'])
  })

  it('el tope LOCAL (lotePorVenue) manda aunque topeGlobal sobre cupo', () => {
    const candidatos: CandidatoReparto[] = []
    for (let i = 0; i < 100; i += 1) candidatos.push({ id: `v-${i}`, venueId: 'venue-unico' })

    const seleccionados = repartirEquitativo(candidatos, 1000, 30)

    expect(seleccionados).toHaveLength(30) // un solo venue nunca rebasa su lote local
  })

  it('sin candidatos, no revienta y devuelve vacío', () => {
    expect(repartirEquitativo([], 60, 30)).toEqual([])
  })
})

describe('campaignScheduler.service — reclamarLote (forma del SQL)', () => {
  const AHORA = new Date('2026-09-01T12:00:00.000Z')

  beforeEach(() => {
    queryRawMock.mockResolvedValue([])
  })

  it('lleva FOR UPDATE SKIP LOCKED: dos workers nunca se llevan la misma fila', async () => {
    await reclamarLote({ topeGlobal: 60, lotePorVenue: 20, ahora: AHORA })
    expect(sqlTextOf()).toContain('FOR UPDATE SKIP LOCKED')
  })

  /**
   * 🔴 Fix loop 1 — el defecto que ninguna prueba anterior podía ver: el `FOR UPDATE SKIP
   * LOCKED` estaba en un scan SIN `LIMIT`, así que bloqueaba TODAS las filas elegibles de la
   * tabla, no sólo las `lotePorVenue` que iba a usar. Reproducido por el coordinador contra
   * Postgres local: dos workers en paralelo daban A=60 / B=0 — el segundo se iba vacío.
   *
   * Una prueba que sólo busca la FRASE "FOR UPDATE SKIP LOCKED" en el texto (como las de
   * arriba) no distingue "el LIMIT está en el mismo scan" de "el LIMIT está mucho después,
   * en otro CTE". Por eso ésta compara POSICIONES: el LIMIT por venue tiene que aparecer
   * ANTES que FOR UPDATE SKIP LOCKED en el texto — es la única forma de que ambos vivan en
   * el MISMO scan bloqueado.
   */
  it('el LIMIT por venue va DENTRO del scan bloqueado (antes de FOR UPDATE SKIP LOCKED), vía CROSS JOIN LATERAL', async () => {
    await reclamarLote({ topeGlobal: 60, lotePorVenue: 20, ahora: AHORA })
    const text = sqlTextOf()
    expect(text).toContain('CROSS JOIN LATERAL')
    const posLimit = text.indexOf('LIMIT ')
    const posForUpdate = text.indexOf('FOR UPDATE SKIP LOCKED')
    expect(posLimit).toBeGreaterThanOrEqual(0)
    expect(posForUpdate).toBeGreaterThan(0)
    expect(posLimit).toBeLessThan(posForUpdate)
  })

  it('numera por venue con ROW_NUMBER() OVER (PARTITION BY "venueId" …) — es lo que hace posible el reparto justo', async () => {
    await reclamarLote({ topeGlobal: 60, lotePorVenue: 20, ahora: AHORA })
    expect(sqlTextOf()).toContain('ROW_NUMBER() OVER (PARTITION BY "venueId"')
  })

  it('escribe sendAttemptAt con COALESCE: un retry JAMÁS mueve el ancla del primer intento', async () => {
    await reclamarLote({ topeGlobal: 60, lotePorVenue: 20, ahora: AHORA })
    expect(sqlTextOf()).toContain('COALESCE(d."sendAttemptAt"')
  })

  it('incrementa attempts AL RECLAMAR (attempts = d.attempts + 1), no al fallar', async () => {
    await reclamarLote({ topeGlobal: 60, lotePorVenue: 20, ahora: AHORA })
    expect(sqlTextOf()).toContain('attempts = d.attempts + 1')
  })

  it('la elegibilidad cubre PENDING vencido, RETRYING vencido y SENDING con lease vencido', async () => {
    await reclamarLote({ topeGlobal: 60, lotePorVenue: 20, ahora: AHORA })
    const text = sqlTextOf()
    expect(text).toContain("d.status = 'PENDING'")
    expect(text).toContain("d.status = 'RETRYING'")
    expect(text).toContain("d.status = 'SENDING'")
    expect(text).toContain('d."leaseUntil" IS NULL OR d."leaseUntil" <= ')
  })

  // 🔴 Important de la revisión: `NULL <= algo` en SQL es NULL, NO es verdadero. Una fila
  // `RETRYING` con `nextAttemptAt` nulo que no tolere el NULL queda INALCANZABLE para
  // siempre — exactamente la clase de defecto («trabada para siempre») contra la que se
  // escribió la rama de SENDING. Hoy nadie escribe ese estado porque el remitente es la
  // Task 7 y todavía no existe: cerrarlo AHORA cuesta una cláusula y evita dejarle la
  // trampa puesta a quien la construya sin este contexto.
  it('RETRYING tolera nextAttemptAt NULO igual que PENDING (NULL <= x es NULL, no true)', async () => {
    await reclamarLote({ topeGlobal: 60, lotePorVenue: 20, ahora: AHORA })
    const text = sqlTextOf().replace(/\s+/g, ' ')
    expect(text).toContain('d.status = \'RETRYING\' AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= ')
  })

  it('las columnas DateTime viajan con el cast ::timestamp (nunca un Date crudo)', async () => {
    await reclamarLote({ topeGlobal: 60, lotePorVenue: 20, ahora: AHORA })
    const text = sqlTextOf()
    expect(text).toContain('::timestamp')
  })

  it('corta por rn <= lotePorVenue y LIMIT topeGlobal, ordenado por capas (rn ASC, "venueId" ASC)', async () => {
    await reclamarLote({ topeGlobal: 42, lotePorVenue: 17, ahora: AHORA })
    const sql = queryRawMock.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] }
    const text = sql.strings.join('?')
    expect(text).toContain('WHERE rn <= ')
    expect(text).toContain('ORDER BY rn ASC, "venueId" ASC')
    expect(text).toContain('LIMIT ')
    // Los dos números viajan como parámetros, no interpolados a mano en el texto.
    expect(sql.values).toContain(17)
    expect(sql.values).toContain(42)
  })
})

describe('campaignScheduler.service — reclamarLote (comportamiento)', () => {
  const AHORA = new Date('2026-09-01T12:00:00.000Z')

  it('mapea las filas devueltas por RETURNING a ClaimedDelivery', async () => {
    const leaseUntil = new Date('2026-09-01T12:05:00.000Z')
    const sendAttemptAt = new Date('2026-09-01T12:00:00.000Z')
    queryRawMock.mockResolvedValue([
      { id: 'del-1', venueId: 'venue-1', campaignId: 'camp-1', customerId: 'cust-1', attempts: 2, leaseUntil, sendAttemptAt },
    ])

    const resultado = await reclamarLote({ topeGlobal: 10, lotePorVenue: 10, ahora: AHORA })

    expect(resultado).toEqual([
      { id: 'del-1', venueId: 'venue-1', campaignId: 'camp-1', customerId: 'cust-1', attempts: 2, leaseUntil, sendAttemptAt },
    ])
  })

  it('devuelve vacío sin reventar cuando no hay nada elegible', async () => {
    queryRawMock.mockResolvedValue([])
    await expect(reclamarLote({ topeGlobal: 10, lotePorVenue: 10, ahora: AHORA })).resolves.toEqual([])
  })

  it('campaignId puede venir null (delivery de automatización, fase 2) sin romper el mapeo', async () => {
    queryRawMock.mockResolvedValue([
      {
        id: 'del-2',
        venueId: 'venue-1',
        campaignId: null,
        customerId: 'cust-2',
        attempts: 1,
        leaseUntil: new Date(),
        sendAttemptAt: new Date(),
      },
    ])
    const resultado = await reclamarLote({ topeGlobal: 10, lotePorVenue: 10, ahora: AHORA })
    expect(resultado[0].campaignId).toBeNull()
  })

  it('el lease dura LEASE_MS a partir de "ahora"', () => {
    expect(LEASE_MS).toBe(5 * 60 * 1000)
  })

  it.each([
    ['topeGlobal cero', { topeGlobal: 0, lotePorVenue: 10 }],
    ['topeGlobal negativo', { topeGlobal: -1, lotePorVenue: 10 }],
    ['topeGlobal no entero', { topeGlobal: 1.5, lotePorVenue: 10 }],
    ['lotePorVenue cero', { topeGlobal: 10, lotePorVenue: 0 }],
    ['lotePorVenue negativo', { topeGlobal: 10, lotePorVenue: -5 }],
    ['lotePorVenue no entero', { topeGlobal: 10, lotePorVenue: 2.2 }],
  ])('rechaza %s antes de tocar la base', async (_label, params) => {
    await expect(reclamarLote({ ...params, ahora: AHORA })).rejects.toThrow()
    expect(queryRawMock).not.toHaveBeenCalled()
  })
})
