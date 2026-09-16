/**
 * Codex R3 (R3-1) + R4 (R4-1): la búsqueda por referencia lleva los DISCRIMINADORES en la CONSULTA (venue, referencia,
 * importe, propina, orden objetivo y afiliación) y recorre TODAS las páginas hasta resolver la identidad o agotar el conjunto.
 * Un subconjunto agotado —«los diez más recientes»— nunca acredita ausencia: el candidato número once convertía un reintento
 * legítimo en otra venta.
 *
 * R4-1: la paginación es KEYSET sobre columnas INMUTABLES (`createdAt desc, id desc`) en DOS pasadas (sin llave, con llave),
 * nunca un cursor de Prisma sobre un orden que incluya `idempotencyKey` — esa columna la escribe la propia consolidación y
 * un cursor sobre ella saltaba candidatos. Agotar el presupuesto devuelve `agotado: true` (el registrador NO crea con eso).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { buscarRegistroPorReferencia } from '@/services/tpv/payment.tpv.service'

const huella = {
  orderId: null as string | null,
  amountPesos: 100,
  tipPesos: 0,
  merchantAccountId: 'm1',
  idempotencyKey: null as string | null,
  terminalSerial: 'AVQD-T1',
  terminalPaymentRequestId: null,
}
const candidato = (i: number, serial: string, idempotencyKey: string | null = null) => ({
  id: `p${i}`,
  orderId: null,
  amount: new Prisma.Decimal(100),
  tipAmount: new Prisma.Decimal(0),
  merchantAccountId: 'm1',
  idempotencyKey,
  terminalPaymentRequestId: null,
  processorData: { deviceSerialNumber: serial },
  createdAt: new Date(Date.UTC(2026, 8, 13, 20, 0, 0) - i * 1000),
  receipts: [],
})
const llamada = (n: number) => (prismaMock as any).payment.findMany.mock.calls[n][0]

beforeEach(() => {
  ;(prismaMock as any).payment.findMany.mockReset()
  ;(prismaMock as any).terminalPaymentAttemptLink.findUnique.mockReset().mockResolvedValue(null)
})

it('los discriminadores viajan en la consulta (referencia, importe, propina, orden objetivo, sin reembolsos) con tope y orden INMUTABLE, sin cursor — y la AFILIACIÓN NO filtra en SQL (Codex R8-1: se juzga en JS con la única regla de identidad)', async () => {
  ;(prismaMock as any).payment.findMany.mockResolvedValue([candidato(1, 'AVQD-T1')])
  const r = await buscarRegistroPorReferencia('v1', 'REF', 'o1', { ...huella, orderId: 'o1' }, {})
  expect(r.registro?.id).toBe('p1')
  expect(r.exigeLlave).toBe(false)
  const args = llamada(0)
  expect(args.where.AND[0]).toMatchObject({
    venueId: 'v1',
    referenceNumber: 'REF',
    orderId: 'o1',
  })
  // Codex R5-6: `type` es NULLABLE (legacy anterior al default REGULAR): `not: 'REFUND'` a secas es `type <> 'REFUND'` y
  // NULL no lo cumple — esos Payments desaparecían de la búsqueda y su replay nacía como venta nueva. Nunca reembolsos.
  expect(args.where.AND[0]).not.toHaveProperty('type')
  // Codex R7-2 / R8-1: la afiliación NO entra a la consulta — un replay legacy sin merchant ni autorización quedaba fuera de
  // la OR y nacía como venta nueva. Los candidatos de otra afiliación llegan a `esElMismoCobroPorReferencia` (conjunto
  // {definitiva, la del APK} + autorización) y salen como AFILIACION (otro cargo) o AFILIACION_INCIERTA (evidencia).
  expect(args.where.AND[0].AND).toEqual([{ OR: [{ type: null }, { type: { not: 'REFUND' } }] }])
  expect(JSON.stringify(args.where)).not.toMatch(/merchantAccountId|merchantAccountIdFromApk|authorizationNumber/)
  expect(String(args.where.AND[0].amount)).toBe('100')
  expect(String(args.where.AND[0].tipAmount)).toBe('0')
  // Primera pasada: los candidatos SIN llave (legacy ↔ legacy).
  expect(args.where.AND[1]).toEqual({ idempotencyKey: null })
  expect(args.take).toBe(10)
  // R4-1: el orden es sobre columnas que NADIE escribe después (createdAt, id) — nunca sobre `idempotencyKey`.
  expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  expect(args.cursor).toBeUndefined()
  expect(args.skip).toBeUndefined()
})

it('R4-1 · pagina por KEYSET (createdAt, id) hasta resolver la identidad: diez candidatos de OTRA terminal en la primera página no acreditan ausencia', async () => {
  const ajenos = Array.from({ length: 10 }, (_, i) => candidato(i + 1, 'AVQD-OTRA'))
  ;(prismaMock as any).payment.findMany.mockResolvedValueOnce(ajenos).mockResolvedValueOnce([candidato(11, 'AVQD-T1')])
  const r = await buscarRegistroPorReferencia('v1', 'REF', null, huella, {})
  expect(r.registro?.id).toBe('p11')
  expect(r.candidatos).toBe(11)
  expect(r.descartes).toHaveLength(10)
  expect(r.descartes.every(d => d.motivo === 'TERMINAL')).toBe(true)
  expect(r.agotado).toBe(false)
  expect((prismaMock as any).payment.findMany).toHaveBeenCalledTimes(2)
  const segunda = llamada(1)
  // La segunda página empieza DESPUÉS del último de la primera, por (createdAt, id) — no por un cursor de Prisma.
  const ultimo = ajenos[9]
  expect(segunda.where.AND[2]).toEqual({
    OR: [{ createdAt: { lt: ultimo.createdAt } }, { createdAt: ultimo.createdAt, id: { lt: ultimo.id } }],
  })
  expect(segunda.cursor).toBeUndefined()
  expect(segunda.skip).toBeUndefined()
  expect(segunda.take).toBe(10)
})

it('R4-1 · dos PASADAS: agotados los candidatos sin llave, se examinan los que tienen llave (un legacy sin llave puede ser el reintento de un cobro que ya ganó su llave)', async () => {
  ;(prismaMock as any).payment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidato(1, 'AVQD-T1', 'K-ganada')])
  const r = await buscarRegistroPorReferencia('v1', 'REF', null, huella, {})
  expect(r.registro?.id).toBe('p1')
  expect((prismaMock as any).payment.findMany).toHaveBeenCalledTimes(2)
  expect(llamada(0).where.AND[1]).toEqual({ idempotencyKey: null })
  expect(llamada(1).where.AND[1]).toEqual({ idempotencyKey: { not: null } })
  // Cada pasada arranca desde el principio (sin predicado de keyset heredado de la otra).
  expect(llamada(1).where.AND).toHaveLength(2)
})

it('R4-6 · los candidatos EXCLUIDOS (contradijeron bajo el candado) no vuelven a elegirse: van en la consulta', async () => {
  ;(prismaMock as any).payment.findMany.mockResolvedValue([candidato(2, 'AVQD-T1')])
  const r = await buscarRegistroPorReferencia('v1', 'REF', null, huella, {}, ['p1'])
  expect(r.registro?.id).toBe('p2')
  expect(llamada(0).where.AND[0]).toMatchObject({ id: { notIn: ['p1'] } })
})

it('una página corta cierra la pasada: sin registro, sin agotar, con los descartes explicados', async () => {
  ;(prismaMock as any).payment.findMany.mockResolvedValue([candidato(1, 'AVQD-OTRA')])
  const r = await buscarRegistroPorReferencia('v1', 'REF', null, huella, {})
  // Una pasada por grupo (sin llave, con llave): dos consultas, ninguna acredita al ajeno.
  expect(r).toMatchObject({ registro: null, candidatos: 2, agotado: false })
  expect(r.descartes).toEqual([
    { id: 'p1', motivo: 'TERMINAL', orderId: null },
    { id: 'p1', motivo: 'TERMINAL', orderId: null },
  ])
  expect((prismaMock as any).payment.findMany).toHaveBeenCalledTimes(2)
})

it('R4-1 · agotar el presupuesto de páginas devuelve agotado:true y NUNCA un registro (el registrador rechaza, no crea)', async () => {
  const pagina = Array.from({ length: 10 }, (_, i) => candidato(i + 1, 'AVQD-OTRA'))
  ;(prismaMock as any).payment.findMany.mockResolvedValue(pagina)
  const r = await buscarRegistroPorReferencia('v1', 'REF', null, huella, {})
  expect(r.registro).toBeNull()
  expect(r.agotado).toBe(true)
  expect(r.candidatos).toBe(10_000)
  expect((prismaMock as any).payment.findMany).toHaveBeenCalledTimes(1000)
})

it('con vínculo S1 para la llave del entrante, un candidato SIN llave nunca es este cobro (exigeLlave) y la regla se devuelve para la consolidación', async () => {
  ;(prismaMock as any).terminalPaymentAttemptLink.findUnique.mockResolvedValue({ requestId: 'req-1' })
  ;(prismaMock as any).payment.findMany.mockResolvedValueOnce([candidato(1, 'AVQD-T1')]).mockResolvedValueOnce([])
  const r = await buscarRegistroPorReferencia('v1', 'REF', null, { ...huella, idempotencyKey: 'K' }, { idempotencyKey: 'K' })
  expect(r.registro).toBeNull()
  expect(r.exigeLlave).toBe(true)
  // Codex R7-2: cada descarte lleva la orden del candidato (una identidad INCIERTA de afiliación se vuelve evidencia de colisión).
  expect(r.descartes).toEqual([{ id: 'p1', motivo: 'LLAVE', orderId: null }])
  // El orden es el MISMO con llave: inmutable; y `id` cierra la paginación.
  expect(llamada(0).orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
})

it('sin vínculo, un entrante con llave SÍ puede ser el reintento de un legacy sin llave (transición APK viejo → nuevo)', async () => {
  ;(prismaMock as any).payment.findMany.mockResolvedValue([candidato(1, 'AVQD-T1')])
  const r = await buscarRegistroPorReferencia('v1', 'REF', null, { ...huella, idempotencyKey: 'K' }, { idempotencyKey: 'K' })
  expect(r.registro?.id).toBe('p1')
  expect(r.exigeLlave).toBe(false)
})
