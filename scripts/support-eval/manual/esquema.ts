/**
 * Esquemas del manual interno del soporte (Task 8): superficies (salida de `$D/scripts/soporte-superficies.py`, no se editan a
 * mano), inventario por app y evidencia por página. Los usan las pruebas, aprobar-biblioteca y los scripts del workspace.
 * No viajan a producción: `copy:assets` sólo copia `src/assets`.
 */
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { isDay } from '@/services/support/libraryFiles'

export const MANUAL_EVAL_DIRECTORY = __dirname
export const SIN_PAGINA_RAZONES = ['superadmin', 'legacy', 'a-la-medida', 'apagada-o-sin-lanzar', 'sin-acciones'] as const
export type SinPaginaRazon = (typeof SIN_PAGINA_RAZONES)[number]

const app = z.enum(['tpv', 'android', 'windows', 'dashboard'])
const REPO_OF = { tpv: 'avoqado-tpv', android: 'avoqado-android', windows: 'avoqado-android', dashboard: 'avoqado-web-dashboard' }
const sha40 = z.string().regex(/^[a-f0-9]{40}$/)
const day = z.string().refine(isDay, 'yyyy-mm-dd de un día que existe')
const text = z.string().trim().min(1)
const line = z.number().int().positive()
const repeated = (values: (string | undefined)[]) => values.filter((v, i) => v !== undefined && values.indexOf(v) !== i)

export const surfacesSchema = z
  .object({
    app,
    sourceRef: sha40,
    superficies: z.array(z.object({ id: text, archivo: text, linea: line }).strict()),
  })
  .strict()
  .refine(s => !repeated(s.superficies.map(x => x.id)).length, 'id de superficie repetido')

const row = z
  .object({
    id: text,
    /** id del extractor (superficies/<app>.json) cuando la fila es una superficie. */
    superficie: text.optional(),
    tipo: z.enum(['pantalla', 'accion']),
    nombre: text,
    origen: text,
    quienLaVe: text,
    equipos: z
      .array(z.enum(['PAX', 'NEXGO']))
      .min(1)
      .optional(),
    paginas: z.array(text),
    sinPagina: z
      .object({ razon: z.enum(SIN_PAGINA_RAZONES), detalle: text })
      .strict()
      .optional(),
  })
  .strict()
  // Una fila empieza sin página ni razón (pendiente); nunca con las dos.
  .refine(r => !(r.paginas.length && r.sinPagina), 'una fila lleva páginas o sinPagina, no las dos')

export const inventorySchema = z
  .object({
    app,
    sourceRepo: z.enum(['avoqado-tpv', 'avoqado-android', 'avoqado-web-dashboard']),
    sourceRef: sha40,
    version: text,
    publicadoComo: text,
    generado: day,
    supuestos: z.array(text),
    /** Las versiones vivas de la app, tal cual las da Task 0 (`$A/manual/versiones-vivas-2026-11-11.txt`). */
    versionesVivas: z.array(text),
    filas: z.array(row),
  })
  .strict()
  .superRefine((inv, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if (inv.sourceRepo !== REPO_OF[inv.app]) issue(`${inv.app} sale de ${REPO_OF[inv.app]}, no de ${inv.sourceRepo}`)
    if (inv.app !== 'tpv' && inv.filas.some(f => f.equipos)) issue('equipos sólo en la TPV')
    // En la TPV, una fila que se cubre con páginas dice en qué equipos (sin `equipos`, una página de la PAX la daría por
    // cubierta también en la Nexgo). Una con `sinPagina` no se cubre: puede no traerlo (el módulo campo/ es un celular).
    for (const f of inv.filas) if (inv.app === 'tpv' && !f.equipos && !f.sinPagina) issue(`fila de la TPV sin equipos: ${f.id}`)
    for (const id of repeated(inv.filas.map(f => f.id))) issue(`fila repetida: ${id}`)
    for (const id of repeated(inv.filas.map(f => f.superficie))) issue(`dos filas para la superficie ${id}`)
  })

const at = { archivo: text, linea: line }
const run = { fotos: z.array(text), filasCreadas: z.array(text), nota: text.optional() }
export const evidenceSchema = z
  .object({
    pagina: text,
    sourceRepo: z.enum(['avoqado-tpv', 'avoqado-android', 'avoqado-web-dashboard']),
    sourceRef: sha40,
    version: text,
    /** Por cada paso numerado (1, 2…) de la página: dónde está en el código y la cita del texto o la acción. */
    pasos: z.array(z.object({ paso: line, ...at, cita: text }).strict()),
    permisos: z.array(z.object({ permiso: text, ...at }).strict()),
    plan: z.array(z.object({ featureCode: text, ...at }).strict()),
    sinInternet: z.array(z.object({ afirmacion: text, ...at }).strict()),
    rutas: z.array(z.object({ ruta: text, ...at }).strict()),
    aparato: z
      .object({
        estado: z.enum(['PROBADO', 'NO PROBADO EN APARATO', 'NO APLICA']),
        aparato: text.optional(),
        version: text.optional(),
        apkSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        fecha: day.optional(),
        ...run,
      })
      .strict()
      .refine(
        a => a.estado !== 'PROBADO' || (a.aparato && a.version && a.apkSha256 && a.fecha && a.fotos.length),
        'PROBADO lleva aparato, versión, apkSha256, fecha y fotos',
      ),
    /** Sólo DASHBOARD: el recorrido con /browse o Playwright contra el panel y el servidor locales. */
    navegador: z
      .object({
        estado: z.enum(['PROBADO', 'NO PROBADO EN NAVEGADOR', 'NO APLICA']),
        herramienta: z.enum(['browse', 'playwright']).optional(),
        servidor: text.optional(),
        fecha: day.optional(),
        ...run,
      })
      .strict()
      .refine(
        n => n.estado !== 'PROBADO' || (n.herramienta && n.servidor && n.fecha && n.fotos.length),
        'PROBADO lleva herramienta, servidor, fecha y fotos',
      )
      .optional(),
    /** La ronda de Codex del lote; antes de auditarla, ronda 0 y PENDIENTE. */
    codex: z
      .object({ lote: line, ronda: z.number().int().min(0), veredicto: z.enum(['PENDIENTE', 'SIN-HALLAZGOS', 'CON-HALLAZGOS']) })
      .strict(),
  })
  .strict()

export type ManualSurfaces = z.infer<typeof surfacesSchema>
export type ManualInventory = z.infer<typeof inventorySchema>
export type ManualEvidence = z.infer<typeof evidenceSchema>
type App = z.infer<typeof app>

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))
export const readSurfaces = (name: App, root = MANUAL_EVAL_DIRECTORY): ManualSurfaces =>
  surfacesSchema.parse(readJson(path.join(root, 'superficies', `${name}.json`)))
export const readInventory = (name: App, root = MANUAL_EVAL_DIRECTORY): ManualInventory =>
  inventorySchema.parse(readJson(path.join(root, 'inventario', `${name}.json`)))

/** La evidencia de una página (`evidencia/<id>.json`); null si no existe. Una que existe y no cumple el esquema truena. */
export function readManualEvidence(id: string, root = MANUAL_EVAL_DIRECTORY): ManualEvidence | null {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(id)) throw new Error(`id de página inválido: ${id}`)
  const file = path.join(root, 'evidencia', `${id}.json`)
  return fs.existsSync(file) ? evidenceSchema.parse(readJson(file)) : null
}
