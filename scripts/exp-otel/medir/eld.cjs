'use strict'
/**
 * 🧪 EXPERIMENTO OTel — muestreador de medición, IGUAL en TODOS los brazos (A incluido): retraso del event loop
 * (perf_hooks.monitorEventLoopDelay, resolución 10 ms) y memoria del proceso, cada 5 s, a un archivo (no a stdout:
 * no agrega líneas al log que califica la utilidad). Sólo se activa en el proceso del server con EXP_MEDIR=1.
 */
if (process.env.EXP_MEDIR !== '1' || !/dist\/src\/server\.js$/.test(process.argv[1] || '')) return
const fs = require('node:fs')
const { monitorEventLoopDelay } = require('node:perf_hooks')
const h = monitorEventLoopDelay({ resolution: 10 })
h.enable()
const archivo = process.env.EXP_MEDIR_ARCHIVO || '/tmp/exp-medicion.jsonl'
const ms = ns => Math.round((ns / 1e6) * 10) / 10
setInterval(() => {
  try {
    const m = process.memoryUsage()
    fs.appendFileSync(
      archivo,
      JSON.stringify({ t: Date.now(), p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), rss: m.rss, heap: m.heapUsed }) + '\n',
    )
  } catch {
    /* medición: nunca afecta al server */
  }
  h.reset()
}, 5000).unref()
