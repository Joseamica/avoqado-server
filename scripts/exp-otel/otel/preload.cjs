'use strict'
/**
 * 🧪 EXPERIMENTO OTel — precarga del SDK (brazos B, B0, B−P, C y la suite «con SDK»). Se carga con
 * NODE_OPTIONS=--require ANTES que cualquier módulo de la app (express, prisma, socket.io…) y sin importar nada de la app
 * (plan, corrección 8). Con `EXP_OTEL` vacía no hace NADA (los brazos A/A+ ni siquiera la cargan).
 *
 *   EXP_OTEL=B      SDK + instrumentaciones SELECCIONADAS (http, express, Prisma, amqplib, socket.io, winston), 100 %
 *   EXP_OTEL=B0     igual, con muestreo 0 % (separa «tener el SDK» de «mandar spans»)
 *   EXP_OTEL=BmP    B sin @prisma/instrumentation (sensibilidad, corrección 2 de la investigación)
 *   EXP_OTEL=suite  igual que B pero se activa también dentro de Jest y sin exportar (OTEL_TRACES_EXPORTER=none)
 *
 * Versiones FIJAS en la línea 2.x (sdk-node 0.223.0 / SDK 2.12.0; Node 20). Nunca auto-instrumentations-node.
 * Winston con `disableLogSending: true` (sólo pone trace_id/span_id en cada log; sin envío doble).
 * Cola/lote/timeout fijados por variables OTEL_BSP_* / OTEL_EXPORTER_OTLP_* (los pone el orquestador).
 *
 * Medición (no cambia el comportamiento): cuenta spans terminados / exportados / fallidos / descartados y la cola
 * pendiente máxima, y lo escribe cada 5 s en EXP_OTEL_CONTADORES (por defecto /tmp/exp-otel-contadores.json).
 */
const modo = process.env.EXP_OTEL
const esServer = /dist\/src\/server\.js$/.test(process.argv[1] || '')
if (!modo || (!esServer && modo !== 'suite')) return

const fs = require('node:fs')
const api = require('@opentelemetry/api')
const { NodeSDK } = require('@opentelemetry/sdk-node')
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express')
const { SocketIoInstrumentation } = require('@opentelemetry/instrumentation-socket.io')
const { AmqplibInstrumentation } = require('@opentelemetry/instrumentation-amqplib')
const { WinstonInstrumentation } = require('@opentelemetry/instrumentation-winston')

const contadores = { terminados: 0, exportadosOk: 0, exportadosFallidos: 0, lotesOk: 0, lotesFallidos: 0, pendienteMax: 0, descartados: 0 }

const instrumentaciones = [
  new HttpInstrumentation(),
  new ExpressInstrumentation(),
  new SocketIoInstrumentation(),
  new AmqplibInstrumentation(),
  new WinstonInstrumentation({ disableLogSending: true }),
]
if (modo !== 'BmP') {
  const { PrismaInstrumentation } = require('@prisma/instrumentation')
  instrumentaciones.push(new PrismaInstrumentation())
}

let bsp = null
const procesadores = [
  {
    onStart() {},
    onEnd() {
      contadores.terminados++
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  },
]
if ((process.env.OTEL_TRACES_EXPORTER || 'otlp') !== 'none') {
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto')
  const real = new OTLPTraceExporter()
  const exportador = {
    export(spans, cb) {
      real.export(spans, r => {
        if (r && r.code === 0) {
          contadores.exportadosOk += spans.length
          contadores.lotesOk++
        } else {
          contadores.exportadosFallidos += spans.length
          contadores.lotesFallidos++
        }
        cb(r)
      })
    },
    shutdown: () => real.shutdown(),
    forceFlush: () => (real.forceFlush ? real.forceFlush() : Promise.resolve()),
  }
  bsp = new BatchSpanProcessor(exportador)
  procesadores.push(bsp)
}

const sdk = new NodeSDK({ spanProcessors: procesadores, instrumentations: instrumentaciones })
sdk.start()

const tracer = api.trace.getTracer('avoqado-exp-otel')
function correrYCerrar(span, fn) {
  const fallar = e => {
    span.recordException(e)
    span.setStatus({ code: api.SpanStatusCode.ERROR })
  }
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      return r.then(
        v => {
          span.end()
          return v
        },
        e => {
          fallar(e)
          span.end()
          throw e
        },
      )
    }
    span.end()
    return r
  } catch (e) {
    fallar(e)
    span.end()
    throw e
  }
}
const extraer = tp => api.propagation.extract(api.ROOT_CONTEXT, { traceparent: tp })

// Puente que usa src/observability/expTraza.ts (la app no importa OpenTelemetry).
globalThis.__expOtel = {
  inyectar() {
    const c = {}
    api.propagation.inject(api.context.active(), c)
    return c.traceparent
  },
  conPadre(tp, nombre, fn) {
    return tracer.startActiveSpan(nombre, { kind: api.SpanKind.CONSUMER }, extraer(tp), span => correrYCerrar(span, fn))
  },
  conEnlace(tp, nombre, atributos, fn) {
    const links = []
    const sc = tp ? api.trace.getSpanContext(extraer(tp)) : undefined
    if (sc) links.push({ context: sc })
    return tracer.startActiveSpan(
      nombre,
      { kind: api.SpanKind.CONSUMER, links, attributes: atributos, root: true },
      api.ROOT_CONTEXT,
      span => correrYCerrar(span, fn),
    )
  },
  marcarError(e) {
    const s = api.trace.getActiveSpan()
    if (!s) return
    s.recordException(e)
    s.setStatus({ code: api.SpanStatusCode.ERROR })
  },
}

const archivo = process.env.EXP_OTEL_CONTADORES || '/tmp/exp-otel-contadores.json'
function escribir() {
  try {
    if (bsp) {
      const pend = Array.isArray(bsp._finishedSpans) ? bsp._finishedSpans.length : bsp._finishedSpansQueue?.length ?? 0
      contadores.pendienteMax = Math.max(contadores.pendienteMax, pend || 0)
      contadores.pendiente = pend || 0
      contadores.descartados = bsp._droppedSpansCount ?? contadores.descartados
    }
    contadores.t = Date.now()
    fs.writeFileSync(archivo, JSON.stringify(contadores))
  } catch {
    /* medición: nunca afecta al server */
  }
}
setInterval(escribir, 1000).unref()
process.on('exit', escribir)
