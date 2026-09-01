/**
 * 🔴 `Customer.marketingConsent` sólo se ESCRIBE en `consent.service.ts`.
 *
 * Es el único camino que produce evidencia legal (LFPDPPP): un `ConsentEvent` + `ActivityLog`
 * en la MISMA transacción (Task 3). Un escritor directo (`prisma.customer.update({ data: {
 * marketingConsent: ... } })` en cualquier otro archivo) deja el campo desincronizado del
 * ledger — el cache dice una cosa y no hay evento que la respalde, que es exactamente lo que
 * una auditoría o una solicitud de derecho ARCO no puede sostener.
 *
 * Esta prueba es ESTÁTICA a propósito (mismo patrón que
 * `tests/unit/observability/multipartContext.test.ts` y
 * `tests/unit/services/dashboard/attendance-shift-independence.test.ts`): lee el código fuente
 * y falla si alguien vuelve a escribir el campo por fuera. Una prueba de comportamiento no lo
 * cazaría — un escritor nuevo se cuela como "sólo una asignación más" que no cambia el
 * resultado feliz del caso que se esté probando.
 */
import fs from 'fs'
import path from 'path'

function* tsFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* tsFiles(p)
    else if (e.name.endsWith('.ts')) yield p
  }
}

/**
 * Rutas completas excluidas del barrido, cada una con su motivo — nunca por comodidad.
 *
 * - `consent.service.ts` es EL escritor legítimo (Task 3).
 * - `src/schemas/**` son declaraciones Zod de FORMA de entrada (qué shape acepta un endpoint),
 *   no escrituras a Prisma — igual que un `interface { marketingConsent?: boolean }`.
 * - `demoSeed.service.ts` siembra clientes SINTÉTICOS (`*.demo.com`) para la demo de
 *   exploración del producto — no son personas reales que puedan otorgar/revocar consentimiento.
 *   Enrutarlo por `grantMarketingConsent` (a) exigiría un `PrivacyNoticeVersion` para CADA venue
 *   demo (la mayoría no tiene uno hoy — el seed reventaría con `BadRequestError`), y (b)
 *   escribiría `ConsentEvent`/`ActivityLog` reales para un consentimiento que nadie otorgó,
 *   contaminando el ledger legal con eventos ficticios. Ver reporte de la Task 8: se deja
 *   declarado como concern para el founder, no se fuerza el enrutado.
 */
const ARCHIVOS_EXCLUIDOS = (relPath: string): string | null => {
  if (relPath.endsWith('consent.service.ts')) return 'escritor legítimo (Task 3)'
  if (relPath.startsWith(`schemas${path.sep}`)) return 'declaración Zod de forma de entrada, no escritura a Prisma'
  if (relPath.endsWith(`onboarding${path.sep}demoSeed.service.ts`)) return 'siembra de clientes sintéticos de demo — ver comentario arriba'
  return null
}

/**
 * Líneas concretas excluidas por CONTENIDO exacto (no por número de línea — un número de línea
 * se corre con cualquier edición de arriba y dejaría de proteger lo que de verdad se quería
 * excluir, o peor, empezaría a tapar una escritura real que cayó justo en ese número).
 *
 * - `kioskOutreach.service.ts`: filtro de relación anidado dentro de un `where:` multi-línea
 *   (`prisma.creditPackPurchase.findMany({ where: { ..., customer: { marketingConsent: true },
 *   ... } })`). Es una LECTURA — decide a quién avisar, no escribe nada — pero la palabra
 *   "where" vive unas líneas arriba, no en esta línea, así que el filtro por contenido de la
 *   línea (`grep -v where`) no la protege.
 */
const LINEAS_DE_LECTURA_ANIDADA = [/^\s*customer:\s*\{\s*marketingConsent:\s*true\s*\},?\s*$/]

/**
 * La heurística vive en UNA sola función, usada tanto por el barrido real como por el
 * sabotaje de abajo — dos copias de la misma regla es exactamente cómo este guard se coló la
 * primera vez (ver Fix round 1 abajo): la prueba de sabotaje comprobaba una heurística más
 * vieja y más floja que la que de verdad corría en el barrido, así que "pasaba" sin probar
 * nada real. Con una sola función, cualquier endurecimiento futuro se prueba automáticamente
 * en ambos lados.
 *
 * escritura = "marketingConsent:" seguido de un valor (true/false/identificador) — no una
 * lectura ni la declaración de un tipo.
 */
function esLineaViolatoria(linea: string): boolean {
  if (!/marketingConsent\s*:\s*(true|false|[a-zA-Z])/.test(linea)) return false

  // `campo: z.boolean()...` es una declaración de esquema Zod (el valor arranca con el
  // builder `z.`), no una asignación — aparece también FUERA de src/schemas/ (p. ej. el
  // shape de entrada de una tool del MCP en src/mcp/tools/).
  if (/marketingConsent\s*:\s*z\./.test(linea)) return false
  if (LINEAS_DE_LECTURA_ANIDADA.some(re => re.test(linea))) return false

  // 🔴 Fix round 1 (revisor, verificado EN VIVO 2026-09-01): `consent.service.ts:65` —
  // `await tx.customer.update({ where: { id: p.customerId }, data: { marketingConsent:
  // action === 'GRANTED' } })` — es EXACTAMENTE la forma compacta de una línea. La primera
  // versión de esta prueba excluía cualquier línea que contuviera "where" en CUALQUIER
  // parte, así que copiar ese mismo estilo a un archivo nuevo se colaba sin ser detectado
  // (el revisor lo inyectó y dio 0 violaciones, verde). La justificación de esa versión —
  // "el estilo real del repo nunca compacta así" — era FALSA: el propio escritor legítimo
  // lo hace, y es justo el patrón más a mano para copiar.
  //
  // Arreglo: si la línea trae un `data:` y `marketingConsent` aparece DESPUÉS de ese `data:`
  // (gobernado por él), es violación SIEMPRE — sin importar que "where"/"select" también
  // vivan antes en la misma línea física. Sólo cuando NO hay `data:` gobernando el campo en
  // esa línea se aplica el filtro grueso original (para no atrapar el `select:` de la línea
  // 166 de kioskOutreach.service.ts, que trae "marketingConsent: true" pero ningún "data:").
  const idxData = linea.lastIndexOf('data:')
  const idxConsent = linea.indexOf('marketingConsent')
  const dataGobiernaElCampo = idxData !== -1 && idxConsent > idxData
  if (!dataGobiernaElCampo && /select|where|expect|\/\//.test(linea)) return false

  return true
}

describe('marketingConsent sólo se ESCRIBE en consent.service.ts', () => {
  it('ningún otro archivo de src/ asigna marketingConsent directamente', () => {
    const raiz = path.join(__dirname, '../../../../src')
    const violaciones: string[] = []

    for (const f of tsFiles(raiz)) {
      const relPath = path.relative(raiz, f)
      if (ARCHIVOS_EXCLUIDOS(relPath)) continue

      const src = fs.readFileSync(f, 'utf8')
      for (const [i, linea] of src.split('\n').entries()) {
        if (esLineaViolatoria(linea)) violaciones.push(`${relPath}:${i + 1}`)
      }
    }

    expect(violaciones).toEqual([])
  })

  it('el guard SÍ falla ante el escritor multi-línea más obvio (sabotaje intencional)', () => {
    // No se sabotea el árbol real: se ejercita la MISMA heurística que usa la prueba de
    // arriba, sobre un snippet que reproduce el escritor prohibido —
    // `prisma.customer.update({ data: { marketingConsent: true } })` fuera de consent.service,
    // formateado tal como el repo escribe TODA su Prisma multi-línea.
    expect(esLineaViolatoria('      marketingConsent: true,')).toBe(true)
  })

  it('el guard SÍ falla ante la forma COMPACTA de una línea (el hallazgo del revisor)', () => {
    // La forma exacta de consent.service.ts:65, copiada a un archivo hipotético que NO está
    // excluido — "where" y "data:" en la MISMA línea física. Antes del Fix round 1 esto NO
    // se detectaba.
    const lineaCompacta =
      "      await tx.customer.update({ where: { id: p.customerId }, data: { marketingConsent: action === 'GRANTED' } })"
    expect(esLineaViolatoria(lineaCompacta)).toBe(true)
  })

  it('NO marca como violación un filtro de lectura real (where multi-línea, select)', () => {
    // Las dos formas de lectura real que SÍ existen hoy en el árbol — deben seguir pasando
    // limpias con la heurística endurecida, o el barrido empezaría a acusar código honesto.
    expect(esLineaViolatoria('      customer: { marketingConsent: true },')).toBe(false) // kioskOutreach.service.ts:71 (where arriba)
    expect(esLineaViolatoria('select: { email: true, firstName: true, marketingConsent: true } },')).toBe(false) // select en la misma línea
  })
})
