// tests/integration/staffPay/foto.limite.test.ts — fase 3, B14 (medición de carga): el tope de una foto (`enUnaFoto`, 60 s o el que
// pida quien la usa) corta en la BASE. El `timeout` de una transacción interactiva de Prisma no interrumpe una sentencia que ya
// está corriendo: sin `SET LOCAL statement_timeout`, una sentencia de 8 s en una foto de 2 s contestaba 409 LECTURA_VENCIDA a los
// 8.1 s, con la base trabajando y la conexión retenida hasta el final. Con él, la base la cancela al tope (~2.5 s).
import prisma from '@/utils/prismaClient'
import { enUnaFoto } from '@/services/dashboard/staffPay/foto'

describe('enUnaFoto: el tope corta en la base (B14)', () => {
  it('una sentencia que pasa del tope se cancela al tope y contesta 409 LECTURA_VENCIDA, no al terminar', async () => {
    const t = Date.now()
    await expect(enUnaFoto(tx => tx.$queryRaw`SELECT 1 AS x FROM pg_sleep(8)`, { timeoutMs: 2_000 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LECTURA_VENCIDA',
    })
    const ms = Date.now() - t
    expect(ms).toBeGreaterThanOrEqual(1_900)
    expect(ms).toBeLessThan(5_000)
    // La base ya no la está corriendo (no se quedó trabajando sola después del 409).
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%pg_sleep(8)%' AND pid <> pg_backend_pid()`
    expect(n).toBe(0)
  })

  it('el tope es SÓLO de esa foto: lo que corre después en la misma conexión no lo hereda', async () => {
    await expect(enUnaFoto(tx => tx.$queryRaw`SELECT 1 AS x FROM pg_sleep(3)`, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'LECTURA_VENCIDA',
    })
    // Una consulta de 1.5 s fuera de la foto (y otra foto con su tope por defecto) termina bien.
    await expect(prisma.$queryRaw`SELECT 1 AS x FROM pg_sleep(1.5)`).resolves.toEqual([{ x: 1 }])
    await expect(enUnaFoto(tx => tx.$queryRaw`SELECT 1 AS x FROM pg_sleep(1.5)`)).resolves.toEqual([{ x: 1 }])
  })

  it('una foto que cabe en su tope no cambia', async () => {
    await expect(enUnaFoto(tx => tx.$queryRaw`SELECT 1 AS x FROM pg_sleep(0.2)`, { timeoutMs: 2_000 })).resolves.toEqual([{ x: 1 }])
  })
})
