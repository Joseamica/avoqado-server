/**
 * Apagador del SDK propio desde el MCP (fase 3, bloque 2a): `set_terminal_in_house_sdk` prende o apaga, en UNA terminal, el motor
 * de cobro propio de Avoqado. Escribe sólo por `cambiarSdkPropioDeTerminal` (el único escritor, con su bitácora).
 *
 * 🔴 SOLO SUPERADMIN, con defensa doble: `registerAllTools` sólo la registra dentro de `if (scope.isSuperAdmin)` y el handler
 * vuelve a comprobarlo. Sólo en el MCP libre: NO está en `directory/catalog.ts`.
 *
 * Al PRENDER, la vista previa devuelve ARRIBA `expectedSerialNumber` (la serie guardada) y `expectedTerminalState` (la huella del
 * ESTADO que enseñó: negocio, serie, tipo, marca y el propio ajuste). El catálogo ata las dos a la confirmación y el escritor las
 * compara bajo el candado. Si la terminal cambió entre los dos pasos (aparato, negocio o ajuste), no prende (409).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import {
  cambiarSdkPropioDeTerminal,
  contarCambiosDelApagador,
  elegibilidadDelSdkPropio,
  huellaDeLaTerminal,
} from '@/services/superadmin/sdkPropioDeTerminal.service'
import { mcpProvenance } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { text } from '../respond'
import type { McpScope } from '../scope'

const SOLO_AVOQADO = 'Sólo el equipo de Avoqado puede cambiar con qué motor cobra una terminal.'
const estado = (prendido: boolean) => (prendido ? 'motor propio de Avoqado' : 'motor de siempre')

export function registerSdkPropioTools(server: McpServer, scope: McpScope): void {
  server.tool(
    'set_terminal_in_house_sdk',
    'Prende o apaga, en UNA terminal PAX, el cobro con el motor propio de Avoqado (en vez del de siempre). La terminal lo toma la ' +
      'próxima vez que arranca la app; con el freno general abajo no surte efecto. Para prender, la terminal debe ser una PAX con ' +
      'serie física y una afiliación de Blumon activa; apagar siempre se puede. Por DEFECTO sólo muestra una vista previa (con la ' +
      'terminal que se va a confirmar); confirm:true aplica, y si la terminal cambió desde la vista previa (aparato, negocio o ' +
      'ajuste) no prende. ' +
      'Sólo para el equipo de Avoqado.',
    {
      terminalId: z.string().min(1).describe('La terminal a cambiar'),
      enabled: z.boolean().describe('true = cobra con el motor propio; false = vuelve al de siempre'),
      expectedSerialNumber: z.string().optional().describe('La serie que viste; la pone la vista previa al prender (no se escribe a mano)'),
      expectedTerminalState: z
        .string()
        .optional()
        .describe('El estado de la terminal que viste; lo pone la vista previa al prender (no se escribe a mano)'),
      reason: z.string().min(3).max(300).optional().describe('Por qué (p. ej. "piloto del motor propio")'),
      confirm: z.boolean().optional().describe('Debe ser true para aplicarlo; sin esto sólo obtienes una vista previa'),
    },
    async args => {
      const { terminalId, enabled, expectedSerialNumber, expectedTerminalState, reason, confirm } = args
      if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
      requireWriteScopeAlways(scope, 'tpv:update', 'cambia con qué motor cobra una terminal')

      if (!confirm) {
        const terminal = await prisma.terminal.findUnique({
          where: { id: terminalId },
          select: {
            id: true,
            venueId: true,
            serialNumber: true,
            type: true,
            brand: true,
            inHouseSdkEnabled: true,
            venue: { select: { id: true, name: true } },
          },
        })
        if (!terminal) return text({ ok: false, error: 'No encontré esa terminal.' })
        const elegibilidad = await elegibilidadDelSdkPropio(prisma, terminalId)
        // Prender lo que no se puede prender ⇒ rechazo SIN `requiresConfirmation`: el catálogo no firma nada (Codex b2a r1 #2).
        // Una vista sin serie no puede autorizar después a un aparato que nunca enseñó. Si ya está prendida, confirmar no
        // cambia nada (el escritor no vuelve a revisar) y la vista previa de abajo lo dice.
        if (enabled && !terminal.inHouseSdkEnabled) {
          if (!terminal.serialNumber)
            return text({
              ok: false,
              code: 'TERMINAL_SERIAL_MISMATCH',
              error: 'La terminal no tiene serie guardada; corrígela en la ficha.',
            })
          if (!elegibilidad.elegible) return text({ ok: false, code: 'TERMINAL_NOT_ELIGIBLE_FOR_IN_HOUSE_SDK', error: elegibilidad.razon })
        }
        // Sólo al prender, y sólo si hay serie: el catálogo ata la serie y la huella del ESTADO que se vio (R2-2), y el escritor
        // las compara bajo el candado.
        const serie =
          enabled && terminal.serialNumber
            ? {
                expectedSerialNumber: terminal.serialNumber,
                expectedTerminalState: huellaDeLaTerminal(terminal, await contarCambiosDelApagador(prisma, terminalId)),
              }
            : {}
        // Los argumentos del paso 2: lo que firma el catálogo (la entrada sin `confirm`, más la serie de arriba) + confirm:true.
        const { confirm: _confirm, ...entrada } = { ...args, ...serie }
        return text({
          ok: false,
          requiresConfirmation: true,
          terminal: { id: terminal.id, serialNumber: terminal.serialNumber, venue: terminal.venue },
          actual: estado(terminal.inHouseSdkEnabled),
          siguiente: estado(enabled),
          elegibilidad,
          ...serie,
          message:
            terminal.inHouseSdkEnabled === enabled
              ? `La terminal ${terminal.serialNumber ?? terminal.id} de ${terminal.venue.name} ya cobra con el ${estado(enabled)}; confirmar no cambia nada.`
              : `Vas a pasar la terminal ${terminal.serialNumber ?? terminal.id} de ${terminal.venue.name} al ${estado(enabled)}. La toma la próxima vez que arranca la app. Confirma para aplicar; si la terminal cambia antes (aparato, negocio o ajuste), no se prende.`,
          confirmationArgs: { ...Object.fromEntries(Object.entries(entrada).filter(([, v]) => v !== undefined)), confirm: true },
        })
      }

      try {
        const r = await cambiarSdkPropioDeTerminal({
          terminalId,
          enabled,
          serieEsperada: expectedSerialNumber,
          estadoEsperado: expectedTerminalState,
          staffId: scope.staffId,
          reason: reason ?? null,
          procedencia: 'mcp',
          extra: await mcpProvenance(scope),
        })
        return text({
          ok: true,
          changed: r.changed,
          enabled: r.enabled,
          message: r.changed
            ? `Listo: la terminal ahora cobra con el ${estado(r.enabled)} (la toma la próxima vez que arranca la app).`
            : `Ya estaba así: la terminal ya cobraba con el ${estado(r.enabled)}. No cambié nada.`,
        })
      } catch (err) {
        // 404 y 409 del escritor (serie que cambió, terminal no elegible): su texto es para el operador.
        if (err instanceof AppError && err.isOperational) return text({ ok: false, code: err.code, error: err.message })
        throw err
      }
    },
  )
}
