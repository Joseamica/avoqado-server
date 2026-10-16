/**
 * 🧪 EXPERIMENTO OTel (rama exp/otel-trazas — NO va a develop): fallas SEMBRADAS para medir «¿dónde se fue el tiempo?»
 * (plan, 1b/1c y corrección 6). El MISMO inyector en los MISMOS puntos en TODOS los brazos; no escribe ningún log
 * (nada que sólo exista para el inyector). Con `EXP_INYECTOR` vacía (producción) cada función es un no-op.
 *
 *   db_lenta      +800 ms de consulta dentro de la transacción del dinero (paso ⑦)
 *   cpu           800 ms de CPU síncrono en el handler del registro del cobro (paso ⑥: congela el hilo)
 *   externa_lenta llamada HTTP a un servidor falso local que tarda 800 ms, dentro del efecto RECEIPT (paso ⑧).
 *                 SINTÉTICA: el recorrido real no tiene llamada externa (el banco se simula).
 *   efecto_falla  el efecto RECEIPT lanza un error (1c)
 */
import http from 'node:http'
import type { Prisma } from '@prisma/client'

const falla = (): string | undefined => process.env.EXP_INYECTOR || undefined

export async function inyectarDbLenta(tx: Prisma.TransactionClient): Promise<void> {
  if (falla() === 'db_lenta') await tx.$queryRaw`SELECT pg_sleep(0.8)`
}

export function inyectarCpu(): void {
  if (falla() !== 'cpu') return
  const fin = performance.now() + 800
  // eslint-disable-next-line no-empty
  while (performance.now() < fin) {}
}

export async function inyectarEnEfecto(kind: string): Promise<void> {
  if (kind !== 'RECEIPT') return
  const f = falla()
  if (f === 'efecto_falla') throw new Error('EXP_EFECTO_FALLA')
  if (f !== 'externa_lenta') return
  const url = process.env.EXP_FALSO_URL || 'http://servicios:8080/lento'
  await new Promise<void>((resolve, reject) => {
    http
      .get(url, res => {
        res.resume()
        res.on('end', () => resolve())
      })
      .on('error', reject)
  })
}
