# IVA por producto — Plan 3: la factura con IVA por producto (opción B+) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la factura individual timbre cada renglón con su IVA real (16 %, 0 %, exento), armada SÓLO desde una foto congelada al reservar y con los renglones «sellados» por el documento; que una venta nunca esté en la global y en una factura propia a la vez; y que la global y la nota de crédito bloqueen con motivo las ventas con IVA distinto de 16 % — sin cambiar un solo byte de lo que hoy se factura cuando todo es 16 %.

**Architecture:** Un módulo puro resuelve el tratamiento de cada renglón (sellado > producto > 16 %) y lo traduce a lo que pide el SAT. La reserva de cada documento corre en UNA transacción con candado compartido de admisión por organización, la orden `FOR UPDATE` y los productos `FOR SHARE`: captura la **entrada documental** (JSON versionado con huella) en `Cfdi.entrada`, escribe los **sellos** (tabla renglón ↔ CFDI + `OrderItem.ivaTratamiento`) y la fila del intento. El payload al PAC se arma después del commit y sólo desde esa entrada. Los sellos se liberan con una única función cuando el intento termina sin documento o la cancelación queda confirmada. La global escribe su lista de ventas (manifiesto) y la exclusión con la individual es simétrica.

**Tech Stack:** TypeScript, Express, Prisma 6.19, PostgreSQL (advisory locks, `FOR UPDATE`/`FOR SHARE`), Jest (`unit` / `integration`), Facturapi (sandbox para la verificación real).

**Spec:** workspace `docs/superpowers/plans/2026-09-24-iva-por-producto.md` — v4 (A, B, C, D), v5 §1, §3, §4, v6 §1–§3 y «Ronda 6: Codex AUTORIZA» (condiciones 1 y 2). **Recorte decidido por el founder el 26-sep (opción B+)** tras investigar el mercado (`docs/investigations/iva-por-producto-plan-3/investigacion-facturacion-{A-softrestaurant-parrot,B-fudo-alegra-eleventa}.md`): global con IVA mixto y egreso mixto **se bloquean con motivo** (0 usos hoy en producción: 0 globales, 0 notas de crédito, 0 comercios con global encendida); la exclusión global ↔ individual SÍ se construye (todo el mercado la tiene). Mapas del código actual (léelos antes de tu tarea): `docs/investigations/iva-por-producto-plan-3/plan3-mapa-{A-individual,B-global-egreso-delivery,C-escritores-de-renglones}.md`.

**Rama/worktree:** `iva-por-producto` (worktree `avoqado-server/.claude/worktrees/iva-por-producto`), encima de los planes 1 y 2.

**v2 (26-sep) — cierres de la auditoría de Codex** (`docs/investigations/iva-por-producto-plan-3/informe-codex-plan-3.md`: RECHAZO
con 6 P1 + 2 P2, B+ se mantiene). Ya incorporados en cada tarea: recaptura sólo con rechazo definitivo o ventana segura, versión
del intento en todas las escrituras, recuperación sólo por identidad para intentos nuevos, egreso con 16 % de la original y no del
catálogo, exclusión global ↔ individual releída bajo el bloqueo de cada orden, reintentos seguros en global y egreso, nunca una
entrada inventada para un documento viejo, motivo del egreso por la ruta real, CAS nuevo en la cancelación directa, golden también
de montos y motivos. Quitado: el enum de causas de sello (la relación renglón ↔ CFDI se queda). Simplificado: la entrada guarda los
parámetros YA resueltos del documento. Delivery pasa a **condición de encendido** (plan 6).

**v3 (26-sep) — cierres de la ronda 2 de Codex** (`informe-codex-plan-3-ronda2.md`: RECHAZO, 4 P1 + 2 P2 + 1 P3, B+ se mantiene).
El cambio de fondo: **un intento de resultado INCIERTO nunca se recaptura.** Ni una búsqueda negativa ni el paso del tiempo prueban que
no timbró (Facturapi recupera solicitudes pendientes hasta el minuto 50). Se quita la ventana de 10 minutos. Un intento sólo se
recaptura si **nunca se envió** o si el PAC lo **rechazó** con un error de validación (400/422, que el adaptador ahora conserva). Lo
incierto se resuelve encontrando el documento, reenviando la MISMA entrada con la misma llave (si la sonda del Step 0 prueba que
Facturapi deduplica), o por una declaración humana auditada después de 60 minutos. Además: `pending` (202) ya no se toma por timbrado,
consultar no invalida el envío en curso, delivery se bloquea también al conectarlo, y se quita el re-sellado del finalizador.

## Qué NO entra en este plan (declarado)

- **Plan 3b (siguiente): escritores de renglones con candado de orden** (condición 2 de Codex r6). El mapa C mide que `addItemsToOrder` (TPV) corre sin transacción y que `recalculateOrderTotals` escribe sin CAS. Es obligatorio **antes de encender la bandera** (plan 6), no antes de este plan: aquí la reserva ya toma `FOR UPDATE` y la barrera «documento = cobrado» bloquea una captura incoherente.
- **Delivery:** sin cambios de código en este plan, pero es **CONDICIÓN DE ENCENDIDO (plan 6)**: `deliveryFiscalDelta.ts:113`
  recalcula la venta con las tasas ACTUALES y le resta devoluciones con IVA congelado; si el producto cambia de tasa entre dos
  retiros de Uber, sale IVA negativo y `deliveryReconciliation.service.ts:360` corta en `FISCAL_PENDING` antes de registrar la
  segunda devolución (escenario de Codex P1-6). Hasta que el plan 4 lo arregle, la incompatibilidad va **en los dos sentidos** y se
  comprueba de forma atómica (misma transacción, candado del venue): se NIEGA encender el IVA por producto a un negocio con delivery
  activo, y se NIEGA conectar o reanudar un canal de delivery (`deliveryStoreClaim.service.ts:~373` y la reanudación) en un negocio
  con IVA por producto encendido. Los dos con motivo visible.
- **Reportes (estado de resultados, IVA de flujo) y pólizas:** plan 4.
- **Global con IVA mixto, egreso mixto, egreso calculado desde el XML:** futuro, cuando alguien los use.

## Pantalla aprobada (26-sep) — la construye el plan 6, no éste

El founder eligió, entre tres maquetas, la **A · «Lista de requisitos»** para el diálogo «Facturar venta» cuando una venta
con IVA mixto está bloqueada (maquetas: `~/.gstack/projects/Joseamica-avoqado-workspace/designs/facturar-venta-iva-mixto-20260926/design-board.html`,
elección en `approved.json`): arriba del formulario, los tres candados (pagada · cuadra con lo cobrado · IVA incluido
confirmado) con palomita; el que falta trae su botón en el mismo renglón; el formulario del cliente se ve apagado
hasta cumplirlos. Dos consecuencias que el plan 6 debe construir (este plan sólo deja los motivos en el servidor):

- **El bloqueo se ve ANTES de llenar el formulario.** Hoy los motivos llegan en el 422 del timbrado, después de que el
  dueño capturó RFC y razón social. Hace falta una lectura previa (`GET …/orders/:orderId/cfdi/requisitos`) que devuelva
  los tres candados y los motivos del sobre, calculados con la MISMA función que usa la emisión.
- **«Confirmar IVA incluido» desde el dashboard.** Hoy esa confirmación existe sólo en el MCP (plan 2). Hace falta la
  ruta del dashboard que llame a `confirmarContratoIvaIncluido` con el mismo permiso (`cfdi:configure`), la misma vista
  previa y el mismo candado por versión.

## Global Constraints

- 🔴 **Con todos los renglones en IVA_16, el payload al PAC, los montos guardados en `Cfdi` y los motivos son IDÉNTICOS a los de hoy.** Mientras la bandera `IVA_POR_PRODUCTO` esté apagada ningún producto puede ser ≠ IVA_16 (trigger del plan 1), así que en producción todo es 16 %: cualquier diferencia en esa rama es un defecto de la tarea. Hay pruebas «golden» que lo fijan (Tarea 3).
- Resolución del tratamiento de un renglón: `OrderItem.ivaTratamiento` (sellado) **si no es NULL**; si es NULL, `Product.ivaTratamiento`; sin producto (venta de importe libre) ⇒ `IVA_16`.
- Traducción al SAT (Anexo 20; `src/services/fiscal/ivaTratamiento.ts` `trasladoSatDe`): IVA_16 ⇒ ObjetoImp 02 + Traslado Tasa 0.160000 · IVA_8 ⇒ 02 + Tasa 0.080000 · IVA_0 ⇒ 02 + **Tasa 0.000000, importe 0** · EXENTO ⇒ 02 + **factor Exento, sin tasa ni importe** · NO_OBJETO ⇒ 01 sin traslados · BLOQUEADO_03/04 ⇒ **no timbrable, se bloquea con motivo**.
- **Rama mixta** (algún renglón ≠ IVA_16) exige las TRES: `Order.contratoDePrecio = IVA_INCLUIDO` + `Order.paymentStatus = PAID` + la barrera «documento = cobrado» actual. Si falta cualquiera ⇒ bloqueada con motivo en español. **Nunca se bloquea una venta**, sólo su factura.
- La rama todo-16 sigue decidiendo «precio con IVA incluido» con la heurística de hoy (`taxAmount == 0`); la rama mixta usa el contrato (siempre IVA incluido).
- **La entrada se captura en la transacción de reserva y el payload SÓLO la lee** (nunca la orden viva ni el producto después del commit). Se recaptura únicamente cuando consta que ese intento no puede tener documento (regla siguiente).
- **Sellar** = escribir, en la misma transacción que la reserva, `OrderItem.ivaTratamiento` (si era NULL) + una fila en `OrderItemSelloIva` (renglón + CFDI que lo usa + versión del intento). **Liberar** = borrar las filas de UN CFDI y poner `ivaTratamiento = NULL` sólo en los renglones que se quedan sin ninguna. Una sola función para liberar.
- 🔴 **Tres estados de un intento y qué permite cada uno** (filas `protocoloIva = 1`):
  | Estado | Cómo se sabe | ¿Recapturar entrada y liberar sellos? |
  |---|---|---|
  | **Nunca enviado** | `enviadoAt IS NULL` (p. ej. `VALIDATION_FAILED` que el dueño ya corrigió) | Sí |
  | **Rechazado** | `falloDefinitivo = true`: el PAC respondió **400 o 422** (error de validación, ocurre antes de timbrar) | Sí |
  | **Incierto** | cualquier otro: timeout, red, 5xx, 401/403/404/409/429, `pending`, respuesta ilegible | **Nunca** |
  Filas viejas con `enviadoAt IS NULL` (`protocoloIva IS NULL`) NO cuentan como «nunca enviado»: siguen el camino de hoy.
- 🔴 **Un intento INCIERTO se resuelve sólo así**, sin cambiar su entrada: (a) la búsqueda por `external_id` encuentra el documento ⇒ se finaliza; (b) **reenvío idéntico** — la MISMA entrada, el mismo `external_id` y el mismo `idempotency_key` en el cuerpo — **sólo si la sonda del Step 0 de la Tarea 6 prueba que Facturapi deduplica** (el PAC devuelve el documento existente o lo crea una vez); si la sonda falla, no hay reenvío; (c) una persona con `cfdi:configure` declara «revisé el portal del PAC y esa factura no existe», **aceptado sólo si `ahora − enviadoAt ≥ 60 min`** (Facturapi recupera solicitudes pendientes hasta el minuto 50) ⇒ `falloDefinitivo = true` + `ActivityLog` `CFDI_INTENTO_DECLARADO_SIN_DOCUMENTO`. Mientras siga incierto: 409 «La factura de esta venta se está procesando; intenta de nuevo en unos minutos.» y la venta cuenta como facturada para la global.
- 🔴 **Versión de la entrada = `Cfdi.attempts`**, que sube **sólo** cuando se envía una entrada NUEVA (primer envío o recaptura); ni una consulta ni un reenvío idéntico la suben. `external_id = <idempotencyKey>#<attempts>`, así un documento sólo puede asociarse con la entrada que lo produjo. Toda escritura del intento (fallo, liberación, finalización, barrido) lleva `attempts = <versión>` en el `where`. Una respuesta de otra versión nunca pisa la fila: `logger.error('🚨 …')` + `ActivityLog` `CFDI_TIMBRE_DUPLICADO`. El finalizador nunca resucita una cancelación confirmada.
- 🔴 **Consultar no reclama.** La búsqueda en el PAC es de sólo lectura y no toca la fila; sólo ENVIAR reclama (transición a `STAMPING` con CAS sobre `status`, `attempts` y `enviadoAt`).
- 🔴 **Sólo `valid` con UUID finaliza.** Una respuesta `pending` (202) guarda el id del proveedor (`facturapiId`) y deja la fila en `STAMPING`; la conciliación existente la completa por ese id.
- 🔴 **Intentos nuevos (`protocoloIva = 1`) se recuperan SÓLO por identidad** (`external_id` de su versión). Coincidir en RFC + total + fecha no prueba identidad: ese respaldo queda sólo para filas viejas (como hoy).
- **Nunca se inventa una entrada** para un documento anterior al plan 3 a partir de la orden actual: se finaliza con `entrada = NULL`, desglose leído de su XML y sin sellos (sellar lo histórico desde el XML es el script del plan 6).
- Toda reserva (individual, sustitución, global, egreso) toma `pg_advisory_xact_lock_shared(hashtextextended('iva-emision:' || <organizationId>, 0))` y escribe `Cfdi.protocoloIva = 1`. `protocoloIva` **no tiene default** en la base (filas viejas quedan NULL a propósito: el encendido del plan 6 las cuenta).
- Motivos al usuario en español, en el mismo estilo que los actuales. Centavos sólo en el borde CFDI (como hoy).
- Migraciones a mano, aditivas, con `SET LOCAL lock_timeout = '5s'`; `OrderItem` es tabla caliente: sólo `ADD COLUMN` nullable, **sin backfill ni NOT NULL**. `docs/SCHEMA_MAP.md` regenerado en el mismo commit; modelos nuevos agregados a `scripts/generate-schema-map.ts` → `MODEL_TO_DOMAIN`.
- TDD (dinero y fiscal): prueba vista en rojo antes de implementar. Base de pruebas `av_db_25_iva_test` (NUNCA `av-db-25`). Facturapi sólo en **sandbox**.
- Pruebas por ruta exacta; nunca un `--testPathPattern` con «product». Typecheck del CI (`npm run typecheck`) por `avq-verify` con `AVQ_TREE`.

## Review Focus

1. **Un timbrado que termina tarde** (el PAC contestó después de un timeout, un 500 o un `pending`) ⇒ el intento queda INCIERTO y nunca se recaptura ni se liberan sus sellos: se resuelve encontrando el documento, con un reenvío idéntico deduplicado, o por declaración humana tras 60 min; así nunca hay dos documentos por la misma venta. Consultar no invalida el envío en curso. Pruebas con pausas controladas en las Tareas 6 y 7.
2. **Alguien corrige el IVA del producto entre la reserva y el timbrado** ⇒ la factura sale con el tratamiento de la entrada, no con el nuevo. Prueba en la Tarea 6.
3. **Mavericks: un intento fallido y se corrige el producto** ⇒ al reintentar, el PAC confirma que no hay documento, se recaptura la entrada y la factura sale con el IVA corregido. Prueba en la Tarea 6.
4. **Una venta que ya está en una global vigente y alguien pide su factura propia** (y al revés) ⇒ se rechaza con motivo; con la global cancelada y confirmada, sí se puede. Prueba en la Tarea 10.
5. **Todo al 16 %** (con extras, venta por peso, descuento de renglón, sin renglones, e IVA separado con `taxAmount > 0`) ⇒ el payload, los montos que se guardan y los motivos son los de hoy. Única excepción deliberada: el motivo nuevo «ya está incluida en la factura global». Prueba en la Tarea 3.

---

### Task 1: Módulo puro del IVA de cada renglón

**Files:**
- Create: `src/services/fiscal/ivaDeRenglon.ts`
- Test: `tests/unit/services/fiscal/ivaDeRenglon.test.ts`

**Interfaces:**
- Consumes: `IvaTratamiento`, `trasladoSatDe` de `src/services/fiscal/ivaTratamiento.ts` (plan 1).
- Produces:
  - `resolverTratamiento(r: { selladoIva: IvaTratamiento | null | undefined; productoIva: IvaTratamiento | null | undefined; tieneProducto: boolean }): IvaTratamiento`
  - `impuestosSatDe(t: IvaTratamiento): { objetoImp: '01' | '02'; taxes: Array<{ type: 'IVA'; factor: 'Tasa' | 'Exento'; rate: number; withholding: false }>; rate: number } | { bloqueado: true; motivo: string }`
  - `clasificarOrden(ts: IvaTratamiento[]): 'TODO_16' | 'MIXTA'`
  - `hayBloqueados(ts: IvaTratamiento[]): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/ivaDeRenglon.test.ts
import { clasificarOrden, hayBloqueados, impuestosSatDe, resolverTratamiento } from '@/services/fiscal/ivaDeRenglon'

describe('resolverTratamiento', () => {
  it('el sello manda sobre el producto', () => {
    expect(resolverTratamiento({ selladoIva: 'IVA_16', productoIva: 'IVA_0', tieneProducto: true })).toBe('IVA_16')
  })
  it('sin sello, el tratamiento ACTUAL del producto', () => {
    expect(resolverTratamiento({ selladoIva: null, productoIva: 'EXENTO', tieneProducto: true })).toBe('EXENTO')
  })
  it('sin producto (importe libre) ⇒ IVA_16', () => {
    expect(resolverTratamiento({ selladoIva: null, productoIva: null, tieneProducto: false })).toBe('IVA_16')
  })
  it('producto sin tratamiento (fila vieja antes del backfill) ⇒ IVA_16', () => {
    expect(resolverTratamiento({ selladoIva: undefined, productoIva: null, tieneProducto: true })).toBe('IVA_16')
  })
})

describe('impuestosSatDe', () => {
  it('IVA_16 ⇒ 02 + Tasa 0.16', () => {
    expect(impuestosSatDe('IVA_16')).toEqual({ objetoImp: '02', rate: 0.16, taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }] })
  })
  it('IVA_8 ⇒ 02 + Tasa 0.08', () => {
    expect(impuestosSatDe('IVA_8')).toEqual({ objetoImp: '02', rate: 0.08, taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.08, withholding: false }] })
  })
  it('IVA_0 ⇒ 02 + Tasa 0 (traslado con importe 0, NO exento)', () => {
    expect(impuestosSatDe('IVA_0')).toEqual({ objetoImp: '02', rate: 0, taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }] })
  })
  it('EXENTO ⇒ 02 + factor Exento', () => {
    expect(impuestosSatDe('EXENTO')).toEqual({ objetoImp: '02', rate: 0, taxes: [{ type: 'IVA', factor: 'Exento', rate: 0, withholding: false }] })
  })
  it('NO_OBJETO ⇒ 01 sin traslados', () => {
    expect(impuestosSatDe('NO_OBJETO')).toEqual({ objetoImp: '01', rate: 0, taxes: [] })
  })
  it.each(['BLOQUEADO_03', 'BLOQUEADO_04'] as const)('%s ⇒ bloqueado con motivo en español', t => {
    const r = impuestosSatDe(t)
    expect(r).toMatchObject({ bloqueado: true })
    expect((r as { motivo: string }).motivo).toMatch(/objeto de impuesto/)
  })
})

describe('clasificarOrden / hayBloqueados', () => {
  it('todo 16 (o sin renglones) ⇒ TODO_16', () => {
    expect(clasificarOrden(['IVA_16', 'IVA_16'])).toBe('TODO_16')
    expect(clasificarOrden([])).toBe('TODO_16')
  })
  it('cualquier renglón distinto ⇒ MIXTA', () => {
    expect(clasificarOrden(['IVA_16', 'IVA_0'])).toBe('MIXTA')
    expect(clasificarOrden(['EXENTO'])).toBe('MIXTA')
  })
  it('detecta bloqueados', () => {
    expect(hayBloqueados(['IVA_16', 'BLOQUEADO_04'])).toBe(true)
    expect(hayBloqueados(['IVA_16', 'IVA_0'])).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --selectProjects unit --runTestsByPath tests/unit/services/fiscal/ivaDeRenglon.test.ts --ci`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/fiscal/ivaDeRenglon.ts
/**
 * El IVA de UN renglón al facturar (plan 3 del IVA por producto). Regla única:
 *   sellado (OrderItem.ivaTratamiento) > tratamiento ACTUAL del producto > IVA_16 (sin producto).
 * Un renglón sellado ya pertenece a un documento y nunca vuelve a leer el producto.
 * La traducción al SAT sale de `trasladoSatDe` (plan 1), la misma regla que usa el trigger de la base.
 */
import { IvaTratamiento, trasladoSatDe } from './ivaTratamiento'

export function resolverTratamiento(r: {
  selladoIva: IvaTratamiento | null | undefined
  productoIva: IvaTratamiento | null | undefined
  tieneProducto: boolean
}): IvaTratamiento {
  if (r.selladoIva) return r.selladoIva
  if (r.tieneProducto && r.productoIva) return r.productoIva
  return 'IVA_16'
}

type ImpuestoSat = { type: 'IVA'; factor: 'Tasa' | 'Exento'; rate: number; withholding: false }

export function impuestosSatDe(
  t: IvaTratamiento,
): { objetoImp: '01' | '02'; taxes: ImpuestoSat[]; rate: number } | { bloqueado: true; motivo: string } {
  const sat = trasladoSatDe(t)
  if (!sat.timbrable) {
    return {
      bloqueado: true,
      motivo: `Hay un producto con objeto de impuesto ${sat.objetoImp}, que la facturación todavía no soporta; corrígelo en el producto antes de facturar.`,
    }
  }
  if (!sat.traslado) return { objetoImp: '01', taxes: [], rate: 0 }
  if (sat.traslado.tipoFactor === 'Exento') {
    return { objetoImp: '02', rate: 0, taxes: [{ type: 'IVA', factor: 'Exento', rate: 0, withholding: false }] }
  }
  const rate = Number(sat.traslado.tasaOCuota)
  return { objetoImp: '02', rate, taxes: [{ type: 'IVA', factor: 'Tasa', rate, withholding: false }] }
}

export function clasificarOrden(ts: IvaTratamiento[]): 'TODO_16' | 'MIXTA' {
  return ts.every(t => t === 'IVA_16') ? 'TODO_16' : 'MIXTA'
}

export function hayBloqueados(ts: IvaTratamiento[]): boolean {
  return ts.some(t => t === 'BLOQUEADO_03' || t === 'BLOQUEADO_04')
}
```

- [ ] **Step 4: Run to verify it passes** (mismo comando). Expected: PASS.
- [ ] **Step 5: Commit** — `git add` de los dos archivos nuevos; `git commit -m "feat(iva): el IVA de cada renglón al facturar (resolución y traducción al SAT)" -- <los dos>`; `git show --stat HEAD`.

---

### Task 2: Esquema — sellos, entrada, protocolo y manifiesto de la global

**Files:**
- Modify: `prisma/schema.prisma` — `model OrderItem` (campo nuevo), `model Cfdi` (5 campos), modelos nuevos `OrderItemSelloIva` y `CfdiGlobalOrden`.
- Create: `prisma/migrations/20260926000400_iva_sellos_entrada_manifiesto/migration.sql`
- Modify: `scripts/generate-schema-map.ts` (`MODEL_TO_DOMAIN`: `OrderItemSelloIva` y `CfdiGlobalOrden` en el dominio donde vive `Cfdi`), `docs/SCHEMA_MAP.md` (regenerado)
- Test: `tests/integration/fiscal/ivaSellos.schema.test.ts`

**Interfaces:**
- Produces:
  - `OrderItem.ivaTratamiento IvaTratamiento?` — NULL = sigue al producto; no NULL = sellado.
  - `model OrderItemSelloIva { id String @id @default(cuid()); orderItemId String; orderItem OrderItem @relation(fields:[orderItemId], references:[id], onDelete: Restrict); cfdiId String; cfdi Cfdi @relation(fields:[cfdiId], references:[id], onDelete: Restrict); intento Int; createdAt DateTime @default(now()); @@unique([orderItemId, cfdiId]); @@index([cfdiId]) }` — `intento` = `Cfdi.attempts` del envío que selló. Si es individual o global se deduce del CFDI (sin enum).
  - `Cfdi.entrada Json?`, `Cfdi.entradaHuella String?`, `Cfdi.protocoloIva Int?` (sin default), `Cfdi.enviadoAt DateTime?` (cuándo salió el primer envío de la versión actual; distingue «nunca enviado» y fecha la declaración humana), `Cfdi.falloDefinitivo Boolean @default(false)` (el PAC rechazó con 400/422, o una persona lo declaró: ese intento no dejó documento).
  - `model CfdiGlobalOrden { id String @id @default(cuid()); cfdiId String; cfdi Cfdi @relation(fields:[cfdiId], references:[id], onDelete: Restrict); orderId String; order Order @relation(fields:[orderId], references:[id], onDelete: Restrict); huella String; createdAt DateTime @default(now()); @@unique([cfdiId, orderId]); @@index([orderId]) }`
  - Relaciones inversas: `OrderItem.sellosIva OrderItemSelloIva[]`, `Cfdi.sellosIva OrderItemSelloIva[]`, `Cfdi.manifiestoGlobal CfdiGlobalOrden[]`, `Order.enGlobales CfdiGlobalOrden[]`.

- [ ] **Step 1: Write the failing test** (contra `av_db_25_iva_test`, ver entorno):

```typescript
// tests/integration/fiscal/ivaSellos.schema.test.ts
import prisma from '@/utils/prismaClient'

const col = (tabla: string, columna: string) =>
  prisma.$queryRawUnsafe<{ is_nullable: string; column_default: string | null }[]>(
    `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    tabla,
    columna,
  )

describe('esquema de sellos, entrada y manifiesto (plan 3)', () => {
  afterAll(() => prisma.$disconnect())

  it('OrderItem.ivaTratamiento existe, es nullable y sin default', async () => {
    const r = await col('OrderItem', 'ivaTratamiento')
    expect(r).toHaveLength(1)
    expect(r[0].is_nullable).toBe('YES')
    expect(r[0].column_default).toBeNull()
  })

  it('Cfdi.protocoloIva existe SIN default (las filas viejas quedan NULL a propósito)', async () => {
    const r = await col('Cfdi', 'protocoloIva')
    expect(r).toHaveLength(1)
    expect(r[0].column_default).toBeNull()
  })

  it('Cfdi.entrada y Cfdi.entradaHuella existen y son nullable', async () => {
    expect((await col('Cfdi', 'entrada'))[0].is_nullable).toBe('YES')
    expect((await col('Cfdi', 'entradaHuella'))[0].is_nullable).toBe('YES')
  })

  it('las tablas nuevas existen con sus llaves únicas', async () => {
    const idx = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename IN ('OrderItemSelloIva','CfdiGlobalOrden')`,
    )
    const defs = idx.map(i => i.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE.*"orderItemId", "cfdiId"/)
    expect(defs).toMatch(/UNIQUE.*"cfdiId", "orderId"/)
  })

  it('Cfdi.enviadoAt (nullable) y Cfdi.falloDefinitivo (NOT NULL, default false) existen', async () => {
    expect((await col('Cfdi', 'enviadoAt'))[0].is_nullable).toBe('YES')
    const f = await col('Cfdi', 'falloDefinitivo')
    expect(f[0].is_nullable).toBe('NO')
    expect(f[0].column_default).toContain('false')
  })
})
```

Run: `TEST_DATABASE_URL=… DATABASE_URL=… npx jest --selectProjects integration --runTestsByPath tests/integration/fiscal/ivaSellos.schema.test.ts --ci` ⇒ FAIL.

- [ ] **Step 2: Schema** (los campos y modelos de «Produces», en su lugar: el campo de `OrderItem` junto a `taxAmount`; los de `Cfdi` junto a `taxBreakdown`; los modelos nuevos junto a `Cfdi`). El tipo `IvaTratamiento` ya existe (plan 1).

- [ ] **Step 3: Migración a mano**

```sql
-- IVA por producto, plan 3: sellos por renglón, entrada documental del intento, protocolo de emisión y manifiesto
-- de la global. Todo aditivo. "OrderItem" es tabla caliente: sólo una columna nullable, sin backfill ni NOT NULL.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "ivaTratamiento" "IvaTratamiento";

ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "entrada" JSONB;
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "entradaHuella" TEXT;
-- Sin default A PROPÓSITO: una reserva hecha por código anterior al plan 3 queda NULL y el encendido lo detecta.
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "protocoloIva" INTEGER;
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "enviadoAt" TIMESTAMP(3);
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "falloDefinitivo" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "OrderItemSelloIva" (
  "id" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "cfdiId" TEXT NOT NULL,
  "intento" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderItemSelloIva_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderItemSelloIva_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderItemSelloIva_cfdiId_fkey" FOREIGN KEY ("cfdiId") REFERENCES "Cfdi"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrderItemSelloIva_orderItemId_cfdiId_key" ON "OrderItemSelloIva"("orderItemId", "cfdiId");
CREATE INDEX IF NOT EXISTS "OrderItemSelloIva_cfdiId_idx" ON "OrderItemSelloIva"("cfdiId");

CREATE TABLE IF NOT EXISTS "CfdiGlobalOrden" (
  "id" TEXT NOT NULL,
  "cfdiId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "huella" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CfdiGlobalOrden_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CfdiGlobalOrden_cfdiId_fkey" FOREIGN KEY ("cfdiId") REFERENCES "Cfdi"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CfdiGlobalOrden_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CfdiGlobalOrden_cfdiId_orderId_key" ON "CfdiGlobalOrden"("cfdiId", "orderId");
CREATE INDEX IF NOT EXISTS "CfdiGlobalOrden_orderId_idx" ON "CfdiGlobalOrden"("orderId");
```

Aplicar sólo a la base de pruebas (imprime la URL antes), `npx prisma generate`, agrega los dos modelos a `MODEL_TO_DOMAIN`, `npm run schema:map`. Si alguna guarda de migraciones sobre tablas calientes (`tests/unit/architecture/*MigrationLockSafety*`, `hotOrderIndexMigrationGuard`) aplica a `OrderItem`, léela y cúmplela (esta migración no crea índices sobre `OrderItem`).

- [ ] **Step 4: Verify** — la prueba del Step 1 ⇒ PASS; las guardas de arquitectura de migraciones ⇒ PASS; typecheck del CI por avq-verify ⇒ `errores TS: 0` (el campo nuevo de `OrderItem` es opcional: ningún escritor debe romperse).
- [ ] **Step 5: Commit** con pathspec (schema, migración, script del mapa, SCHEMA_MAP, prueba); `git show --stat HEAD`.

---

### Task 3: Conceptos por tratamiento (rama todo-16 intacta, rama mixta con sus tres candados)

**Files:**
- Modify: `src/services/fiscal/cfdi.service.ts` — `RenglonParaCfdi` (campo `tratamiento`), `conceptosDesdeRenglon`, `repartirDescuentoDeOrden`, `totalDelDocumentoCents`, `loadOrderForCfdiFromDb` (select + resolución + candados de la rama mixta + `pricesIncludeIva` por rama).
- Modify: `src/services/fiscal/assembleSaleInput.ts` (pasa `tratamiento`), `src/services/fiscal/cfdiPayloadBuilder.ts` (`AvoqadoSaleItemInput.tratamiento?`, `resolveItem` usa `impuestosSatDe` cuando viene).
- Test: `tests/unit/services/fiscal/cfdiConceptosPorTratamiento.test.ts` (nuevo) + las suites existentes `cfdi.service.test.ts`, `cfdiPayloadBuilder.test.ts`, `assembleSaleInput.test.ts`, `loadOrderForCfdi.test.ts`, `cfdiGlobal.service.test.ts` (la global comparte `reconstruirConceptos`).

**Interfaces:**
- Consumes: Tarea 1 (`resolverTratamiento`, `impuestosSatDe`, `clasificarOrden`, `hayBloqueados`); columnas de la Tarea 2; `Order.contratoDePrecio` (plan 2).
- Produces:
  - `RenglonParaCfdi.tratamiento?: IvaTratamiento` (lo pone `loadOrderForCfdiFromDb` para cada renglón; los conceptos de extras heredan el del padre).
  - `AvoqadoSaleItemInput.tratamiento?: IvaTratamiento`; con `tratamiento`, `resolveItem` toma `objetoImp` y `taxes` de `impuestosSatDe(tratamiento)`; **sin** `tratamiento` (egreso, global de importe libre) se queda exactamente como hoy.
  - `LoadedOrderBundle.order.clasificacion: 'TODO_16' | 'MIXTA'` (aditivo) — lo leen la Tarea 4 y la global.

**Reglas exactas:**
1. `loadOrderForCfdiFromDb` agrega al `select` del renglón `ivaTratamiento: true` y `id: true`, al del producto `ivaTratamiento: true`, y a la orden `contratoDePrecio: true` y `paymentStatus: true`. Resuelve `tratamiento` por renglón con `resolverTratamiento` y **deriva `product.taxRate` y `product.objetoImp` del tratamiento** (`tuplaDesdeTratamiento`) para el resto del cálculo — así `totalDelDocumentoCents`, `splitIvaIncluded` y los montos no cambian para IVA_16.
2. **Rama todo-16:** todo exactamente como hoy (heurística `taxAmount == 0` para `pricesIncludeIva`, mismos motivos, mismo payload). La única diferencia permitida: `resolveItem` recibe `tratamiento: 'IVA_16'` y debe producir el MISMO `CfdiItemInput` que hoy (misma `objetoImp` que el producto guardado, mismos `taxes`).
3. **Rama mixta:** motivo (y no se timbra) si: `hayBloqueados` (motivo de `impuestosSatDe`), o `contratoDePrecio !== 'IVA_INCLUIDO'` («Esta venta tiene productos con IVA distinto de 16 % y no consta que se cobró con IVA incluido; confírmalo antes de facturar.»), o `paymentStatus !== 'PAID'` («Esta venta tiene productos con IVA distinto de 16 % y no está pagada por completo; se factura cuando se liquide.»). Con los tres candados, `pricesIncludeIva = true` (el contrato manda, no la heurística), y la barrera «documento = cobrado» de siempre sigue aplicando.
4. `conceptosDesdeRenglon`: el motivo «tasa 0 y objeto 02 (tasa cero vs exento sin distinguir)» **sólo aplica cuando el renglón NO trae `tratamiento`** (entrada legacy); con `tratamiento`, IVA_0 y EXENTO son válidos. Los extras con precio heredan `tratamiento` del padre.
5. `repartirDescuentoDeOrden`: agrupa por `tratamiento` (si falta, por `taxRate` como hoy). IVA_0 y EXENTO son grupos DISTINTOS aunque los dos tengan tasa 0.
6. Venta sin renglones: el concepto «Venta» lleva `tratamiento: 'IVA_16'` (igual que hoy).

- [ ] **Step 1: Golden de la rama todo-16 (RED sólo por la prueba nueva, no por las golden)** — en `cfdiConceptosPorTratamiento.test.ts`, construye 5 órdenes fijas (con extras con precio; venta por peso KGM exacta; descuento de renglón; sin renglones; **IVA separado con `taxAmount > 0`**) y, ANTES de tocar el código, captura con el código actual, por orden: (a) el `CreateInvoiceParams` que sale de `buildCreateInvoiceParams(assembleSaleInput(bundle.order, opts))` sobre el bundle que produce `loadOrderForCfdiFromDb` con Prisma mockeado (reusa el arnés de `tests/unit/services/fiscal/loadOrderForCfdi.test.ts`); (b) los montos que se GUARDAN en la fila (`subtotal`, `taxAmount`, `total` de `baseCfdiData`); (c) la lista de motivos de `validateBeforeStamp` + barrera de dinero. Agrega además dos órdenes bloqueadas de hoy (renglón con tasa 0 y objeto 02 SIN tratamiento; descuento general sobre dos tasas) y captura sus motivos exactos. Guarda todo como literales en la prueba (`expect(...).toEqual(<literal>)`). Esta parte debe PASAR con el código viejo y seguir pasando al final: es la red de la rama todo-16.
- [ ] **Step 2: Pruebas de la rama mixta (RED)** en el mismo archivo:
  - renglón con producto `ivaTratamiento: 'IVA_0'` + contrato IVA_INCLUIDO + PAID ⇒ sin motivos; su `CfdiItemInput` lleva `objetoImp: '02'`, `taxes: [{ type:'IVA', factor:'Tasa', rate:0, withholding:false }]`, `taxIncluded: true`;
  - EXENTO ⇒ `taxes: [{ type:'IVA', factor:'Exento', rate:0, withholding:false }]`;
  - un renglón sellado `IVA_16` con producto hoy en `IVA_0` ⇒ sale al 16 % (el sello manda);
  - mixta con contrato `DESCONOCIDO` ⇒ motivo del contrato; mixta con `paymentStatus: 'PENDING'` ⇒ motivo de liquidación; producto `BLOQUEADO_04` ⇒ motivo de objeto de impuesto;
  - descuento general sobre un renglón IVA_0 y otro EXENTO ⇒ motivo de «descuento general … IVA distinto» (grupos distintos);
  - la barrera «documento = cobrado» sigue bloqueando una mixta que no cuadra.
- [ ] **Step 3: Implementar** las reglas 1–6.
- [ ] **Step 4: Verify** — la prueba nueva completa en verde (golden incluidas); y en verde, por ruta, `cfdi.service.test.ts`, `cfdiPayloadBuilder.test.ts`, `assembleSaleInput.test.ts`, `loadOrderForCfdi.test.ts`, `cfdiGlobal.service.test.ts`, `cfdiReplacement.service.test.ts`, `cfdiCreditNote.service.test.ts`. Si una prueba existente afirmaba el motivo «tasa 0 y objeto 02» sobre un renglón SIN tratamiento, debe seguir pasando (la regla 4 lo conserva para entradas legacy). Typecheck del CI por avq-verify.
- [ ] **Step 5: Commit** con pathspec; `git show --stat HEAD`.

---

### Task 4: La entrada documental (foto congelada del intento)

**Files:**
- Create: `src/services/fiscal/entradaDocumental.ts`
- Test: `tests/unit/services/fiscal/entradaDocumental.test.ts`

**Interfaces:**
- Consumes: `LoadedOrderBundle` (con `order.clasificacion` de la Tarea 3), `IssueReceptor`, `assembleSaleInput`, `buildCreateInvoiceParams`.
- Produces:
  - `interface EntradaDocumentalV1 { version: 1; orderId: string; fiscalEmisorId: string; replacesCfdiId: string | null; contratoDePrecio: string | null; paymentStatus: string | null; clasificacion: 'TODO_16' | 'MIXTA'; paidCents: number; montos: { subtotalCents: number; taxCents: number; totalCents: number }; renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>; params: Omit<CreateInvoiceParams, 'externalId'> }` — **los parámetros YA resueltos** que se mandarán al PAC (claves SAT, receptor, forma y método de pago, conceptos con sus impuestos); nada se vuelve a resolver después (simplificación pedida por Codex).
  - `capturarEntrada(bundle: LoadedOrderBundle, receptor: IssueReceptor, orderId: string, opts?: { replacesCfdiId?: string }): EntradaDocumentalV1` — arma `params` con `buildCreateInvoiceParams(assembleSaleInput(bundle.order, …))` una sola vez, sin `externalId`.
  - `huellaDeEntrada(e: EntradaDocumentalV1): string` — sha256 hex del JSON canónico (llaves ordenadas recursivamente).
  - `paramsDesdeEntrada(e: EntradaDocumentalV1, idempotencyKey: string): CreateInvoiceParams` — `{ ...structuredClone(e.params), externalId: idempotencyKey }`. Nada más.
  - `leerEntrada(json: unknown): EntradaDocumentalV1 | null` — valida `version === 1` y forma mínima; `null` si no es válida (filas viejas).

**Por qué `renglones` además de `conceptos`:** los conceptos de extras no tienen `orderItemId`; `renglones` es lo que se SELLA (un renglón por `OrderItem` real, con su tratamiento resuelto). `LoadedOrderBundle` debe exponer, por renglón original, `orderItemId` y `tratamiento` (agrégalo en `loadOrderForCfdiFromDb` como `order.renglonesOrigen: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>`; la venta sin renglones da `[]`).

- [ ] **Step 1: Pruebas (RED):**
  - `paramsDesdeEntrada(capturarEntrada(b, r, id), key)` es `toEqual` al `buildCreateInvoiceParams(assembleSaleInput(b.order, …))` de hoy + `externalId: key`, para las 5 órdenes golden de la Tarea 3 (misma foto ⇒ mismo payload); y `montos` coincide con los montos guardados de esas golden;
  - con `replacesCfdiId`, la entrada lo conserva y la huella cambia;
  - la huella es estable ante reordenar llaves y cambia si cambia un centavo, un tratamiento o el receptor;
  - `leerEntrada` rechaza `null`, `{}` y `{ version: 2 }`; acepta una entrada capturada;
  - mutar el bundle DESPUÉS de capturar no cambia `paramsDesdeEntrada` (la entrada es una copia profunda: usa `structuredClone`).
- [ ] **Step 2: Implementar** (JSON canónico: función recursiva que ordena llaves; la entrada sólo debe tener números, strings, booleanos y null: si `CreateInvoiceParams` trae algún `Decimal` o `Date`, conviértelo a string al capturar y pruébalo).
- [ ] **Step 3: Verify** + commit con pathspec.

---

### Task 5: Sellar y liberar (una sola función para cada cosa)

**Files:**
- Create: `src/services/fiscal/sellosIva.ts`
- Test: `tests/integration/fiscal/sellosIva.test.ts`

**Interfaces:**
- Consumes: modelos de la Tarea 2.
- Produces:
  - `type Tx = Prisma.TransactionClient`
  - `sellarRenglones(tx: Tx, p: { cfdiId: string; intento: number; renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }> }): Promise<void>` — por renglón: `UPDATE "OrderItem" SET "ivaTratamiento" = $t WHERE id = $id AND "ivaTratamiento" IS NULL` (un renglón ya sellado conserva su valor; si su valor sellado es DISTINTO del que la entrada resolvió, lanza `Error('SELLO_DIVERGENTE')` — no puede pasar si la entrada se capturó bajo el candado, y si pasa es un defecto que no se debe tapar) y `INSERT … ON CONFLICT ("orderItemId","cfdiId") DO NOTHING` de la fila renglón ↔ CFDI.
  - `liberarSellosDe(tx: Tx, cfdiId: string): Promise<{ liberados: number }>` — borra las filas renglón ↔ CFDI de ese `cfdiId` y, en la MISMA transacción, pone `ivaTratamiento = NULL` en los renglones afectados que ya no tienen NINGUNA fila.
  - `renglonesSellados(tx: Tx, orderId: string): Promise<Array<{ orderItemId: string; tratamiento: IvaTratamiento | null; cfdis: number }>>` (para pruebas y el encendido del plan 6).

- [ ] **Step 1: Pruebas de integración (RED)** — siembra organización, venue, producto, orden con 2 renglones y 2 filas `Cfdi` de prueba (A y B):
  1. sellar con A ⇒ los 2 renglones quedan con tratamiento y 1 CFDI cada uno;
  2. sellar otra vez con A ⇒ idempotente (sigue 1);
  3. sellar con B (sustituta) ⇒ 2 CFDI por renglón;
  4. liberar A ⇒ los renglones SIGUEN sellados (queda B);
  5. liberar B ⇒ `ivaTratamiento` vuelve a NULL;
  6. sellar con una entrada cuyo tratamiento difiere del ya sellado ⇒ `SELLO_DIVERGENTE` y nada cambia (la transacción revierte);
  7. liberar un `cfdiId` sin filas ⇒ `{ liberados: 0 }`, sin error.
- [ ] **Step 2: Implementar** con SQL parametrizado (`tx.$executeRaw` con plantilla de Prisma).
- [ ] **Step 3: Verify** + commit con pathspec.

---

### Task 6: La emisión individual en una transacción (captura, sello, reserva) y el timbrado desde la entrada

**Files:**
- Modify: `src/services/fiscal/cfdi.service.ts` — `issueCfdiForOrder`, `IssueCfdiDeps`, `defaultDeps`, `loadOrderForCfdiFromDb` (acepta un cliente de transacción opcional), `reconciliarIntentoPrevio`, `baseCfdiData`.
- Create: `src/services/fiscal/admisionIva.ts` — `tomarAdmisionCompartida(tx, organizationId)` y `bloquearOrdenParaFacturar(tx, orderId)` (+ productos `FOR SHARE`).
- Test: `tests/integration/fiscal/emisionIndividualSellada.test.ts` (nuevo, con el proveedor fiscal simulado por inyección) + `tests/unit/services/fiscal/cfdi.service.test.ts` (ajustado sin debilitar).

**Interfaces:**
- Consumes: Tareas 3, 4, 5.
- Produces (en `admisionIva.ts`):
  - `tomarAdmisionCompartida(tx: Prisma.TransactionClient, organizationId: string): Promise<void>` — `SELECT pg_advisory_xact_lock_shared(hashtextextended('iva-emision:' || ${organizationId}, 0))`.
  - `bloquearOrdenParaFacturar(tx, orderId): Promise<{ venueId: string; organizationId: string } | null>` — `SELECT o."venueId", v."organizationId" FROM "Order" o JOIN "Venue" v ON v.id = o."venueId" WHERE o.id = ${orderId} FOR UPDATE OF o`, y luego `SELECT p.id FROM "Product" p JOIN "OrderItem" oi ON oi."productId" = p.id WHERE oi."orderId" = ${orderId} FOR SHARE OF p`.
  - `loadOrderForCfdiFromDb(orderId, opts, db: Prisma.TransactionClient | typeof prisma = prisma)`.

**El flujo nuevo de `issueCfdiForOrder` (conserva TODAS las reglas actuales: aislamiento por venue, vigente/en trámite ⇒ 409 o `alreadyIssued`, llave `-nN`, reclamo CAS por `attempts`, consulta al PAC antes de re-timbrar, persistir identidad antes de los archivos):**

1. **Previo (fuera de transacción, igual que hoy):** facturas previas de la orden, vigente / en trámite, `llaveDeEmision`, otro carril en curso.
2. **Transacción A** (`prisma.$transaction(fn, { timeout: 15_000, maxWait: 5_000 })`):
   a. `bloquearOrdenParaFacturar` (orden inexistente ⇒ 404 como hoy) y `tomarAdmisionCompartida(organizationId)`.
   b. **Exclusión con la global:** `const motivoGlobal = await excluirSiEstaEnGlobal(tx, orderId)` (función de `src/services/fiscal/exclusionGlobal.ts`; en esta tarea devuelve `null`, la Tarea 10 la implementa). **Se consume:** con motivo ⇒ la transacción termina sin crear fila ni sellos y se responde 409 con ese motivo (es un estado, no un defecto de datos: al cancelarse la global, el reintento entra limpio).
   c. Leer la fila existente por `idempotencyKey` DENTRO de la transacción: `STAMPED` ⇒ salir con éxito idempotente (con el guard de tenant); `STAMPING` ⇒ salir sin tocarla hacia el paso 3 (consulta); `STAMP_FAILED`/`VALIDATION_FAILED` ⇒ salir sin tocarla hacia el paso 3. **Aquí no se reclama nada.**
   d. Sin fila: `loadOrderForCfdiFromDb(orderId, opts, tx)`, gates de comercio, `capturarEntrada`, `validateBeforeStamp` + motivos + barrera de dinero sobre el MISMO bundle que produjo la entrada, dentro de la misma transacción (misma lógica de hoy).
      - Con motivos ⇒ crear la fila `VALIDATION_FAILED` con `entrada`, `entradaHuella`, `protocoloIva: 1`, **sin sellos**, y devolver `VALIDATION_FAILED` como hoy.
      - Sin motivos ⇒ crear la fila `STAMPING` con `entrada`, `entradaHuella`, `protocoloIva: 1` y `sellarRenglones(tx, { cfdiId, intento: <attempts de la fila>, renglones: entrada.renglones con orderItemId })`.
3. **Fila existente (`protocoloIva = 1`)** — según su estado (tabla de Global Constraints):
   - **Consulta primero** (sólo lectura, sin reclamar): búsqueda por `external_id` de su versión (o por `facturapiId` si hay uno de un `pending`). Documento `valid` con UUID ⇒ finalizar (Tarea 7) con la entrada de la fila. Si la fila es vieja (`protocoloIva IS NULL`) y no tiene entrada válida ⇒ el camino de hoy, finalizando con `entrada = NULL` y sin sellos (**nunca** capturar la orden actual como si fuera la entrada de ese documento).
   - **Nunca enviado o Rechazado**, sin documento ⇒ **Transacción B**: mismo candado y bloqueo, reclamo CAS (`status` + `attempts`), `liberarSellosDe(tx, cfdiId)`, recapturar entrada, validar; con motivos ⇒ fila a `VALIDATION_FAILED` con la entrada nueva, `enviadoAt = NULL` y sin sellos; sin motivos ⇒ entrada nueva + `attempts + 1` + `enviadoAt = NULL` + `falloDefinitivo = false`, sellar, y seguir al paso 4.
   - **Incierto**, sin documento ⇒ si la sonda probó la deduplicación de Facturapi: reclamar (`STAMP_FAILED → STAMPING` con CAS, **sin** subir `attempts`) y reenviar la MISMA entrada (paso 4). Si no: 409 «se está procesando», sin tocar nada. La declaración humana (Global Constraints, (c)) es una ruta aparte: `declararIntentoSinDocumento(cfdiId, staffId)` en `cfdi.service.ts`, expuesta en el dashboard detrás de `cfdi:configure` y en el MCP con confirmación en dos pasos.
4. **Timbrar desde la entrada:** si `enviadoAt IS NULL`, fijarlo con CAS sobre `attempts`. Luego `provider.createInvoice({ ...paramsDesdeEntrada(entrada, idempotencyKey + '#' + attempts), idempotencyKey: <la misma llave> })`. El adaptador (`facturapi.provider.ts`) debe **conservar el código HTTP y el código de error** del PAC — el SDK 4.17 los descarta (`node_modules/facturapi/dist/index.es.js:~799`), así que `invoices.create` va por una llamada HTTP propia del adaptador que lance `ProviderHttpError { status, code, message }`. Errores, siempre con CAS sobre `attempts`:
   - `ProviderHttpError` con `status` 400 o 422 ⇒ `STAMP_FAILED` + `falloDefinitivo = true` (Rechazado);
   - cualquier otro (5xx, 401/403/404/409/429, red, timeout, respuesta ilegible) ⇒ `STAMP_FAILED` + `falloDefinitivo = false` (Incierto).
   Los sellos se QUEDAN; sólo se liberan en la Transacción B del paso 3.
   Respuesta `pending` (202) ⇒ guardar `facturapiId`, la fila sigue `STAMPING`; nada de `STAMPED` sin UUID. `toStamped` y `toSummary` dejan de convertir cualquier estado no cancelado en `valid`: `pending` se reporta como `pending`.
5. **Éxito (`valid` con UUID):** finalizador de la Tarea 7 con `version = attempts` (en esta tarea, deja el `persistCfdi` STAMPED como hoy pero con CAS sobre `attempts`; la Tarea 7 lo envuelve). Si el CAS no escribe (otra versión), no se pisa: `logger.error('🚨 …')` + `ActivityLog` `CFDI_TIMBRE_DUPLICADO` con los dos UUID.

`baseCfdiData` deja de leer montos del bundle cuando hay entrada: los toma de la entrada (`entrada.montos` y la forma y el método de pago de `entrada.params`).

- [ ] **Step 0: Sonda del contrato del PAC (sandbox, sin tocar producción)** — script temporal `scripts/temp-sonda-facturapi-idempotency.ts` con una llamada HTTP directa (no el SDK): (1) dos `POST /v2/invoices` idénticos con `idempotency_key` en el CUERPO — ¿devuelve el mismo documento?; (2) el mismo `idempotency_key` con un cuerpo DISTINTO — ¿lo rechaza o timbra otro?; (3) un cuerpo inválido — ¿qué `status` y `code` devuelve? (confirma que la validación responde 400/422). Anota los tres resultados en el reporte. Si (1) no deduplica, el reenvío idéntico queda desactivado (constante `FACTURAPI_DEDUPLICA = false`) y el incierto sólo se resuelve por búsqueda o declaración humana. La regla de recaptura NO cambia en ningún caso. Borra el script antes del commit.
- [ ] **Step 1: Pruebas de integración (RED)** contra `av_db_25_iva_test`, con `deps.resolveProvider` inyectado (proveedor falso que registra el payload y responde un timbre fijo), sembrando un emisor + comercio con facturación encendida y una orden PAID:
  1. emisión feliz ⇒ fila `STAMPED` con `entrada` válida, `entradaHuella`, `protocoloIva = 1`, renglones sellados con ese CFDI y el payload enviado igual a `paramsDesdeEntrada(entrada)`;
  2. **(Review Focus 2)** el proveedor falso, al recibir la llamada, cambia en la base el `ivaTratamiento` del producto (con la bandera del negocio encendida en la prueba vía `encenderIvaPorProducto` de `tests/__helpers__/iva-por-producto.ts`) ⇒ el payload YA enviado conserva el tratamiento viejo y la fila sigue sellada con el viejo;
  3. **(Review Focus 3 · Mavericks)** primer intento con el proveedor que responde un RECHAZO ⇒ `STAMP_FAILED` + `falloDefinitivo = true` con renglones sellados en IVA_16; se cambia el producto a IVA_0 (contrato IVA_INCLUIDO); segundo intento con `findByExternalId` que devuelve `null` ⇒ sellos liberados, entrada recapturada con IVA_0 y el payload lleva Tasa 0;
  4. segundo intento con `findByExternalId` que devuelve un documento ⇒ se completa SIN volver a timbrar y la entrada NO se recaptura;
  5. validación fallida (p. ej. contrato DESCONOCIDO en mixta) ⇒ `VALIDATION_FAILED`, con entrada, **sin** sellos;
  6. dos emisiones concurrentes de la misma orden (dos `issueCfdiForOrder` en `Promise.all`) ⇒ UN solo `createInvoice` y el otro recibe 409 o el éxito idempotente;
  7. una orden de OTRO venue ⇒ 404 sin fuga (regresión del guard);
  8. **(Review Focus 1)** primer intento con TIMEOUT ⇒ Incierto; reintento con búsqueda negativa, **aunque hayan pasado horas** ⇒ nunca recaptura: con la deduplicación probada, reenvía la MISMA entrada con el mismo `external_id` e `idempotency_key` y sin subir `attempts`; sin ella, 409 sin ningún `createInvoice` nuevo;
  9. respuesta 500 con cuerpo JSON ⇒ Incierto (no Rechazado); respuesta 422 ⇒ Rechazado y el siguiente intento recaptura;
  10. **(pausa controlada)** A se está procesando; B consulta (búsqueda negativa, 409); luego A termina ⇒ A se finaliza normalmente: la consulta de B no subió `attempts` y NO hay `CFDI_TIMBRE_DUPLICADO`;
  10b. respuesta `pending` sin UUID ⇒ la fila sigue `STAMPING` con `facturapiId`, no `STAMPED`; la conciliación la completa cuando el PAC da el UUID;
  10c. `VALIDATION_FAILED` por contrato DESCONOCIDO; se confirma el contrato y se reintenta ⇒ «nunca enviado»: recaptura y timbra;
  10d. declaración humana a los 30 min ⇒ rechazada; a los 61 min con `cfdi:configure` ⇒ `falloDefinitivo = true`, `ActivityLog`, y el siguiente intento recaptura;
  11. `excluirSiEstaEnGlobal` simulado para devolver un motivo ⇒ 409 con ese motivo, sin fila ni sellos.
- [ ] **Step 2: Ajustar las pruebas unitarias existentes** de `cfdi.service.test.ts` que inyectan `deps` en memoria: si el nuevo flujo necesita un `runInTransaction` inyectable, agrégalo a `IssueCfdiDeps` (default: `prisma.$transaction`) para que esas pruebas sigan corriendo sin base. Ninguna aserción existente se afloja.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verify** — integración nueva en verde; `cfdi.service.test.ts`, `cfdiRefacturar.service.test.ts`, `loadOrderForCfdi.test.ts`, controladores de CFDI (dashboard y público) en verde por ruta; typecheck del CI por avq-verify.
- [ ] **Step 5: Commit** con pathspec; `git show --stat HEAD`.

---

### Task 7: El finalizador desde el XML y el barrido que lo repara

**Files:**
- Create: `src/services/fiscal/finalizadorCfdi.ts`
- Modify: `src/services/fiscal/cfdi.service.ts` (paso 6-7 del éxito y `reconciliarIntentoPrevio` usan el finalizador), `src/services/fiscal/cfdiReconcile.service.ts` (`completeFromPac` usa el finalizador; `RESET` libera sellos), `src/jobs/cfdiReconcile.job.ts` (pasada acotada de reparación).
- Test: `tests/unit/services/fiscal/finalizadorCfdi.test.ts`, `tests/integration/fiscal/finalizadorCfdi.test.ts`, `tests/unit/services/fiscal/cfdiReconcile.service.test.ts` (ajustado).

**Interfaces:**
- Consumes: Tareas 4 y 5; el lector de XML existente `src/services/fiscal/cfdiReceived.parser.ts` (reúsalo si expone los `Traslados`; si no, agrega ahí una función pura `trasladosDesdeXml(xml: string)` sin romper sus usos actuales).
- Produces:
  - `desgloseDesdeXml(xml: string): Array<{ impuesto: '002'; tipoFactor: 'Tasa' | 'Exento'; tasa: string | null; base: string; importe: string | null }>` — de los `cfdi:Traslado` del nodo `cfdi:Impuestos` del comprobante (no de cada concepto).
  - `finalizarTimbre(p: { cfdiId: string; idempotencyKey: string; version: number; identidad: { facturapiId; uuid; serie; folio; stampedAt }; entrada: EntradaDocumentalV1 | null }): Promise<'FINALIZADO' | 'DUPLICADO' | 'YA_FINALIZADO'>` — en UNA transacción: `updateMany … WHERE id = cfdiId AND attempts = version AND status IN ('STAMPING','STAMP_FAILED')` a `STAMPED` + identidad (los sellos ya nacieron con la reserva: no se vuelven a escribir). Sólo acepta `status = 'valid'` con UUID. Si no escribió: misma identidad ya guardada ⇒ `YA_FINALIZADO`; otra identidad, otra versión o una fila ya cancelada ⇒ `DUPLICADO` (alerta `🚨` + `ActivityLog` `CFDI_TIMBRE_DUPLICADO`) y **nunca** se revive una cancelación confirmada.
  - `cfdiReconcile.service.ts`: `completeCfdi` y `failCfdi` pasan a `updateMany` con `attempts` en el `where` (hoy escriben por id sin versión, `:328`); `RESET` de una `STAMPING` vieja ⇒ `STAMP_FAILED` con `falloDefinitivo = false` **sin liberar sellos y sin cambiar `attempts`** (salvo si tiene `facturapiId` de un `pending`: entonces se consulta por ese id y se completa la identidad, reusando la conciliación existente); el barrido también revisa `STAMP_FAILED` inciertas por `external_id` (hoy sólo busca `STAMPING`); la recuperación por RFC + total sólo para filas con `protocoloIva IS NULL`.
  - `completarArchivos(p: { cfdiId; idempotencyKey; providerInvoiceId; venueSlug; uuid; provider }): Promise<'OK' | 'FALLO'>` — descarga XML y PDF, sube, guarda URLs y `taxBreakdown = desgloseDesdeXml(xml)` con `updateMany … WHERE status = 'STAMPED'` (como `persistArtifacts`).
  - Pasada del job: filas `STAMPED` con `taxBreakdown IS NULL` o `xmlUrl IS NULL`, `stampedAt < ahora − 10 min`, tope 20 por corrida, orden `stampedAt ASC, id ASC` ⇒ `completarArchivos`.

- [ ] **Step 1: Pruebas (RED):**
  - unit: `desgloseDesdeXml` sobre tres XML de ejemplo guardados como fixtures en `tests/fixtures/cfdi/` (16 %; 16 % + tasa 0; 16 % + exento) — el exento sale con `tipoFactor: 'Exento'`, `tasa: null`, `importe: null`;
  - integración **(Review Focus 1)**: una fila `STAMPING` sellada; el barrido la resetea (`RESET` ⇒ `STAMP_FAILED`, sellos intactos, misma versión); llega el timbre tardío de esa versión ⇒ `finalizarTimbre` devuelve `FINALIZADO` y la fila queda `STAMPED` con sus sellos de la reserva;
  - integración: una fila `STAMPING` con `facturapiId` de un `pending`; el PAC ya lo tiene `valid` ⇒ el barrido completa UUID, serie y folio;
  - integración: `finalizarTimbre` con una versión vieja (la fila ya se recapturó) ⇒ `DUPLICADO`, la fila no cambia, `ActivityLog` `CFDI_TIMBRE_DUPLICADO`;
  - integración: `finalizarTimbre` sobre una fila `CANCELLED` ⇒ `DUPLICADO`, sigue `CANCELLED`, sin sellos nuevos;
  - integración: una fila `protocoloIva = 1` sin documento por `external_id` y otro documento en el PAC con el mismo RFC y total ⇒ el barrido NO la asocia (sigue sin identidad);
  - integración: `completarArchivos` con el proveedor falso escribe `xmlUrl`, `pdfUrl` y `taxBreakdown`; si la fila ya no está `STAMPED` (se canceló) no escribe nada;
  - unit del barrido: toma sólo `STAMPED` con desglose o XML faltante, respeta el tope y el orden, y un fallo de una fila no detiene las demás.
- [ ] **Step 2: Implementar.** El job sigue la regla de `cron-jobs.md` (lectura de entrada envuelta en `retry(..., shouldRetryDbConnectionError)`) y usa `scheduleJob` (la pasada nueva va dentro del job existente, no uno nuevo).
- [ ] **Step 3: Verify** + commit con pathspec.

---

### Task 8: Liberar sellos cuando la cancelación queda CONFIRMADA (los tres caminos)

**Files:**
- Modify: `src/services/fiscal/cfdi.service.ts` — `cancelCfdi` (resultado `CANCELLED`/`ACCEPTED`), `refreshPendingCancellation`/`applyCancelOutcome`, `sincronizarCancelacionExterna`.
- Test: `tests/integration/fiscal/liberarAlCancelar.test.ts` + suites existentes `cfdiCancel.service.test.ts`, `facturapiWebhook.service.test.ts`.

**Interfaces:**
- Consumes: `liberarSellosDe` (Tarea 5).
- Produces: en los tres caminos, cuando el estado escrito es `CANCELLED` (cancelStatus `CANCELLED` o `ACCEPTED`), la escritura del estado y `liberarSellosDe(tx, cfdiId)` van en la MISMA transacción, con CAS (`updateMany … WHERE …`): si el CAS no escribe (`count === 0`), NO se libera nada. `REQUESTED` y `REJECTED` no liberan. 🔴 **La cancelación directa hoy escribe sin CAS** (`defaultCancelDeps.updateCfdi` = `prisma.cfdi.update` por id, `cfdi.service.ts:~1308`): aquí se **crea** el CAS (`WHERE id = … AND status = 'STAMPED' AND "cancelStatus" IS DISTINCT FROM 'CANCELLED'`), no sólo se conserva el de los otros dos caminos.

- [ ] **Step 1: Pruebas (RED):** para cada camino (directo, consulta de pendiente, externo): cancelación confirmada ⇒ sellos de ESA factura liberados y los de una sustituta intactos; `REQUESTED` ⇒ siguen; `REJECTED` ⇒ siguen; dos confirmaciones concurrentes ⇒ una sola bitácora y una sola liberación (la segunda no escribe) — incluido el camino directo, que hoy no tiene CAS; una respuesta vieja del finalizador después de la cancelación confirmada no la revive (Tarea 7). Después de liberar, `issueCfdiForOrder` con llave `-n2` recaptura con el tratamiento ACTUAL del producto (el «refacturar tras cancelar» usa el IVA corregido).
- [ ] **Step 2: Implementar.**
- [ ] **Step 3: Verify** + commit con pathspec.

---

### Task 9: La sustitución captura su propia entrada y sella

**Files:**
- Modify: `src/services/fiscal/cfdiReplacement.service.ts` (`replaceCfdi`).
- Test: `tests/unit/services/fiscal/cfdiReplacement.service.test.ts` (ajustado) + `tests/integration/fiscal/sustitucionSellada.test.ts`.

**Interfaces:**
- Consumes: Tareas 3–6 (`tomarAdmisionCompartida`, `bloquearOrdenParaFacturar`, `capturarEntrada`, `paramsDesdeEntrada`, `sellarRenglones`), Tarea 7 (`finalizarTimbre`).
- Produces: la sustituta nace en una transacción con el mismo candado y bloqueo que la individual, con su `entrada` (con `replacesCfdiId` de la original), `protocoloIva: 1` y sus sellos (`cfdiId` = la sustituta); timbra desde su entrada con las mismas reglas de la Tarea 6 (tres estados del intento, versión, recuperación por identidad, `pending` sin UUID no finaliza). La original conserva SU entrada y SUS sellos hasta que su cancelación quede confirmada (Tarea 8 los libera). Todas las reglas actuales de la sustitución se conservan (intento durable por `replacesCfdiId`, receptor de la original, emisor igual, reanudación sin re-timbrar, respuesta que nunca afirma la cancelación).

- [ ] **Step 1: Pruebas (RED):** la sustituta queda sellada con su propia fila; con la original todavía vigente cada renglón tiene 2 CFDI; al confirmarse la cancelación de la original queda 1; una sustitución reanudada no recaptura ni vuelve a timbrar; el payload de la sustituta sale de su entrada.
- [ ] **Step 2: Implementar.**
- [ ] **Step 3: Verify** + commit con pathspec.

---

### Task 10: Global: manifiesto, exclusión simétrica y ventas con IVA mixto fuera

**Files:**
- Create: `src/services/fiscal/exclusionGlobal.ts` (la función que la Tarea 6 ya llama).
- Modify: `src/services/fiscal/cfdiGlobal.service.ts` (selección, reserva, `globalLinesFromOrder`), `src/controllers/dashboard/cfdi.dashboard.controller.ts` (`triggerGlobalCfdiController`: respuesta aditiva).
- Test: `tests/unit/services/fiscal/cfdiGlobal.service.test.ts` (ajustado) + `tests/integration/fiscal/globalManifiesto.test.ts`.

**Interfaces:**
- Consumes: Tareas 2, 3, 5, 6.
- Produces:
  - `excluirSiEstaEnGlobal(tx, orderId): Promise<string | null>` — motivo en español si la orden está en el manifiesto de una global VIVA (cualquier fila salvo `VALIDATION_FAILED`, `STAMP_FAILED` con `falloDefinitivo = true`, o cancelación confirmada — o sea, un intento incierto CUENTA como vivo): «Esta venta ya está incluida en la factura global {serie-folio o periodo}; para facturarla aparte primero hay que cancelar esa global.» `null` si no.
  - Selección de la global: además de lo actual, excluye órdenes con una factura individual VIVA (misma definición: todo salvo `VALIDATION_FAILED`, `STAMP_FAILED` con `falloDefinitivo = true` y cancelación confirmada), órdenes en el manifiesto de OTRA global viva, y órdenes cuya clasificación sea `MIXTA` (cuenta aparte: `excluidasPorIvaMixto`).
  - Reserva de la global: en UNA transacción con `tomarAdmisionCompartida`, **bloquea las órdenes candidatas `FOR UPDATE` en orden estable (`id ASC`) y RELEE su elegibilidad** (individual viva, otra global viva, `MIXTA`) bajo ese bloqueo; con la selección DEFINITIVA crea la fila con `protocoloIva: 1`, escribe `CfdiGlobalOrden` (una por orden incluida, `huella` = sha256 de los renglones y tratamientos de esa orden), sella sus renglones con la global (todos IVA_16) y construye el documento desde esa misma selección. Hoy los candidatos se cargan antes de reservar (`cfdiGlobal.service.ts:130`): eso es lo que se cambia.
  - Reintentos de la global: el camino que hoy vuelve a emitir al encontrar una reserva `STAMP_FAILED` o vencida (`cfdiGlobal.service.ts:207`) pasa a las MISMAS reglas de la individual: tres estados del intento (un incierto nunca se re-emite con otra entrada), versión `attempts`, recuperación sólo por identidad, `pending` sin UUID no finaliza, identidad persistida antes de descargar archivos.
  - Cancelación confirmada de una global ⇒ `liberarSellosDe` (la Tarea 8 ya lo hace por `cfdiId`; verifica que el camino de la global pase por ahí). Las filas del manifiesto se CONSERVAN (historia); la «vida» se decide por el estado de la global.
  - `issueGlobalForEmisor` devuelve además `excluidasPorIvaMixto: number`, y la respuesta del disparo manual del dashboard lo incluye (campo nuevo, opcional).

- [ ] **Step 1: Pruebas (RED)** — **(Review Focus 4)**:
  1. orden en una global `STAMPED` ⇒ `issueCfdiForOrder` la rechaza con el motivo;
  2. la misma orden con la global cancelada y confirmada ⇒ sí se factura;
  3. orden con factura individual `STAMPING` ⇒ no entra a la global;
  4. orden en el manifiesto de una global `STAMPING` ⇒ no entra a otra global;
  5. orden con un renglón IVA_0 ⇒ fuera de la global, contada en `excluidasPorIvaMixto`;
  6. la global crea su manifiesto y sella; una global de sólo órdenes todo-16 produce el MISMO payload que hoy (golden con dos órdenes);
  7. **carrera (pausa controlada):** la global selecciona una orden, la individual la reserva y confirma, y luego la global reserva ⇒ la global la excluye al releer bajo el bloqueo y no la timbra;
  8. reintento de una global con la respuesta perdida (el PAC sí timbró) ⇒ se recupera por identidad, sin un segundo documento.
- Nota: el motivo «ya está incluida en la factura global» es la única excepción deliberada a «idéntico a hoy» (Review Focus 5).
- [ ] **Step 2: Implementar.**
- [ ] **Step 3: Verify** + commit con pathspec.

---

### Task 11: Nota de crédito: bloquear la original con IVA mixto; candado y protocolo

**Files:**
- Modify: `src/services/fiscal/cfdiCreditNote.service.ts` (`CreditNoteBlockReason`, `checkCreditNoteEligibility`, carga de la original, reserva).
- Test: `tests/unit/services/fiscal/cfdiCreditNote.service.test.ts` + la prueba del MCP que cubra `emit_refund_credit_note` si existe (si no, agrega un caso en `tests/unit/mcp-customer/` calcado del arnés de `write-confirm-gating.test.ts`).

**Interfaces:**
- Consumes: `leerEntrada` (Tarea 4), `tomarAdmisionCompartida` (Tarea 6).
- Produces:
  - `CreditNoteBlockReason` gana `'ORIGINAL_IVA_MIXTO'`: la factura original tiene una entrada válida con algún renglón `tratamiento !== 'IVA_16'`. Mensaje: «La factura original tiene productos con IVA distinto de 16 %; la nota de crédito para esas ventas todavía no está disponible aquí. Emítela desde el portal del SAT o de tu PAC.» Una original SIN entrada (anterior al plan 3) se trata como todo-16 (la bandera apagada lo garantiza): comportamiento de hoy.
  - **El reparto del IVA del egreso sale de la ORIGINAL, no del catálogo:** hoy `byRate` usa `it.product?.taxRate` en vivo (`cfdiCreditNote.service.ts:~563`); como en B+ sólo pasan originales todo-16, el egreso se reparte al 16 % sin consultar el producto. Escenario que cierra: original de $116 sellada al 16 %, el producto se corrige a IVA_0 y se devuelven $116 ⇒ el egreso sale con base $100 e IVA $16, no sin IVA.
  - La reserva de la nota de crédito toma `tomarAdmisionCompartida`, escribe `protocoloIva: 1` y sus reintentos siguen las reglas de la individual (tres estados del intento, versión, identidad antes de archivos): el camino que hoy vuelve a emitir al encontrar `STAMP_FAILED` (`cfdiCreditNote.service.ts:309`) se cambia.
  - El botón del dashboard y el MCP consultan `checkCreditNoteEligibility`; y el controlador (`cfdi.dashboard.controller.ts:~485`) **mapea** el motivo nuevo a una respuesta de negocio (409 con el mensaje), no a 500.

- [ ] **Step 1: Pruebas (RED):** original con entrada mixta ⇒ bloqueada con el motivo; original todo-16 con entrada ⇒ igual que hoy; original sin entrada ⇒ igual que hoy; la fila de la nota nace con `protocoloIva = 1`; **producto corregido a IVA_0 después de la original ⇒ el egreso sale al 16 %**; egreso con la respuesta perdida (el PAC sí timbró) ⇒ se recupera por identidad, sin un segundo egreso; **por la ruta real** del dashboard, un egreso de original mixta responde 409 con el mensaje en español (no 500).
- [ ] **Step 2: Implementar.**
- [ ] **Step 3: Verify** + commit con pathspec.

---

### Task 12: Verificación real en el sandbox de Facturapi y cierre

**Files:**
- Create: `scripts/sandbox-facturapi-iva-mixto.ts` (sólo sandbox; se niega a correr si `FACTURAPI_*` no es de pruebas o si la URL de base no es `av_db_25_iva_test`).
- Modify: nada de producción.

- [ ] **Step 1: Timbrado real en sandbox:** el script siembra (o reusa) en `av_db_25_iva_test` un negocio con emisor sandbox, enciende su `VenueIvaPorProducto`, crea productos IVA_16, IVA_0 y EXENTO, una orden PAID con contrato IVA_INCLUIDO con los tres, y llama a `issueCfdiForOrder` con el proveedor REAL en sandbox. Imprime el UUID y descarga el XML. Aserciones del script: el XML trae un `Traslado` Tasa 0.160000, uno Tasa 0.000000 con importe 0.00, uno Exento sin TasaOCuota ni Importe; `Total` = lo cobrado; `Cfdi.taxBreakdown` coincide con el XML. Pega la salida en el reporte.
- [ ] **Step 2:** typecheck del CI por avq-verify; unitaria completa en 4 partes por avq-verify (leer «Test Suites:» y «Tests:»); integración completa en una base desechable `avoqado_h1a_test_20260808` del servidor 5433 (crear, migrar, correr, borrar). Clasificar cada fallo contra la base de la rama con evidencia.
- [ ] **Step 3:** el controlador escribe la crónica del plan 3 y actualiza `docs/proyectos/iva-por-producto-16-8-0-exento.md` del workspace.
