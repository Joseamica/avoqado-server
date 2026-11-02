/**
 * Los negocios demo de prospectos (`LIVE_DEMO`) se llaman normal y escriben en el mismo registro que los reales: el
 * formateador del registro marca «🧪 DEMO» lo que un job hace para uno de ellos, para que sus alertas no se confundan con
 * las de un negocio real (founder, 1-nov). Vive aparte de `venueNames` porque el formateador lo consulta en cada línea y
 * el logger no debe cargar Prisma: hay scripts que eligen su base antes de cargarlo (grafoDeImports.guard).
 */
let demoIds = new Set<string>()

/** ¿Es un negocio demo? Sólo por id: un nombre puede repetirlo un negocio real (Codex r1). Síncrono y nunca truena. */
export function isDemoVenue(venueId?: string | null): boolean {
  return !!venueId && demoIds.has(venueId)
}

/** La semilla demo avisa el negocio que acaba de crear: el registro lo marca desde su primera línea, sin esperar la recarga. */
export function marcarNegocioDemo(venueId: string): void {
  demoIds.add(venueId)
}

/**
 * La recarga de `venueNames` deja los demos que trae la consulta, más lo que la semilla marcó y no vino en ella (lo creó
 * después de que la consulta salió).
 */
export function reemplazarNegociosDemo(demo: Set<string>, vistos: Set<string>): void {
  for (const id of demoIds) if (!vistos.has(id)) demo.add(id)
  demoIds = demo
}

/** Test seam. */
export function __resetDemoVenueIdsForTests(): void {
  demoIds = new Set()
}
