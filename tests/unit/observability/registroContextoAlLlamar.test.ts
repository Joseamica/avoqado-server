/**
 * hz:f26b3afc:D3 — Cada transporte del registro formatea la línea cuando la ESCRIBE, no cuando se llamó al logger. Si la
 * consola o el archivo se atoran, las líneas esperan en fila y se formatean después, dentro del contexto de otra petición
 * u otro job: una alerta podía salir con el negocio de otro (Codex r3 de la marca demo: 30 de 45 líneas en consola y 45 de
 * 45 en archivo, con salidas lentas simuladas). Aquí se arma un logger de verdad con un transporte lento.
 */
import winston from 'winston'
import TransportStream from 'winston-transport'
import { capturarContextoAlLlamar, contextFormat } from '@/observability/logContext'
import { enrichContext, runWithContext } from '@/observability/executionContext'

/** Tarda en escribir cada línea, como una consola o un archivo atorados. */
class TransporteLento extends TransportStream {
  lineas: Record<string, unknown>[] = []
  log(info: Record<string, unknown>, listo: () => void) {
    this.lineas.push(info)
    setTimeout(listo, 2)
  }
}

const ctx = (i: number) => ({
  correlationId: `req-${i}`,
  source: 'http' as const,
  entrypoint: 'POST /x',
  venueId: `venue-${i}`,
  venueName: `Negocio ${i}`,
})

async function registrar(capturar: boolean) {
  const lento = new TransporteLento({ format: contextFormat() })
  const creado = winston.createLogger({ transports: [lento] })
  const logger = capturar ? capturarContextoAlLlamar(creado) : creado

  for (let i = 0; i < 6; i++) {
    runWithContext(ctx(i), () => {
      ;(i % 2 ? logger.child({ modulo: 'hijo' }) : logger).info(`linea ${i}`)
      // Lo que la petición agregue DESPUÉS no se cuela en la línea que ya se escribió.
      enrichContext({ venueName: 'cambió después' })
    })
  }
  logger.info('sin contexto')

  while (lento.lineas.length < 7) await new Promise(r => setTimeout(r, 5))
  return Object.fromEntries(lento.lineas.map(l => [l.message as string, l]))
}

it('el escenario sí atora: sin la foto, alguna línea sale con el negocio de otra petición', async () => {
  const lineas = await registrar(false)
  const ajenas = [1, 2, 3, 4, 5].filter(i => lineas[`linea ${i}`].correlationId !== `req-${i}`)
  expect(ajenas.length).toBeGreaterThan(0)
})

it('🔴 con la foto al llamar, cada línea lleva el negocio de SU petición aunque el transporte se atore', async () => {
  const lineas = await registrar(true)
  for (let i = 0; i < 6; i++) {
    expect(lineas[`linea ${i}`]).toMatchObject({ correlationId: `req-${i}`, venueId: `venue-${i}`, venueName: `Negocio ${i}` })
  }
  expect(lineas['linea 1'].modulo).toBe('hijo')
  // Una línea sin contexto sigue sin contexto, aunque se escriba mientras otra petición está activa.
  expect(lineas['sin contexto'].correlationId).toBeUndefined()
  expect(lineas['sin contexto'].venueId).toBeUndefined()
})

it('🔴 Codex r1 · el MISMO objeto registrado en dos peticiones y sin contexto lleva lo de cada llamada', async () => {
  const lento = new TransporteLento({ format: contextFormat() })
  const logger = capturarContextoAlLlamar(winston.createLogger({ transports: [lento] }))
  const mismo = { level: 'info', message: 'mismo' }

  runWithContext(ctx(1), () => logger.log(mismo))
  runWithContext(ctx(2), () => logger.log(mismo))
  logger.log(mismo)

  while (lento.lineas.length < 3) await new Promise(r => setTimeout(r, 5))
  expect(lento.lineas.map(l => l.correlationId)).toEqual(['req-1', 'req-2', undefined])
})

it('🔴 Codex r1 · la foto no se pega al objeto de quien llama ni lleva campos internos del contexto', async () => {
  const lento = new TransporteLento({ format: contextFormat() })
  const logger = capturarContextoAlLlamar(winston.createLogger({ transports: [lento] }))
  const error = new Error('boom')
  const cancellation = { signal: new AbortController().signal, hasWritten: false, refused: false }

  runWithContext({ ...ctx(1), cancellation, prismaBatch: true }, () => logger.error(error))

  while (lento.lineas.length < 1) await new Promise(r => setTimeout(r, 5))
  expect(Object.getOwnPropertySymbols(error).map(String)).not.toContain('Symbol(contextoAlLlamar)')
  const foto = Object.getOwnPropertySymbols(lento.lineas[0])
    .filter(s => String(s) === 'Symbol(contextoAlLlamar)')
    .map(s => (lento.lineas[0] as Record<symbol, Record<string, unknown>>)[s])[0]
  expect(foto).toMatchObject({ correlationId: 'req-1', venueId: 'venue-1' })
  expect(foto).not.toHaveProperty('cancellation')
  expect(foto).not.toHaveProperty('prismaBatch')
})
