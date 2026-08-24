# Conciliador de estructura PlayTelecom / BAIT

Asana: [Actualizar Estructura](https://app.asana.com/1/12709793723059/project/1213523434401320/task/1217743599033214) (`1217743599033214`,
"Bait <> Play Telecom", Plataforma `[Dashboard]`, Prioridad Alta). Adjunto fuente: `Estructura BAIT.xlsx` (Isaac Mayoral, 2026-08-22).

Enunciado del task: _"Actualizar la estructura de acuerdo a la que está adjunta. Lo anterior se debe reflejar en todos los dashboards de
Avoqado."_

## Contexto: es la tercera vez

El mismo archivo, con otro nombre, ya llegó dos veces y se resolvió con scripts de un solo uso que casaban personas y sucursales **por
nombre**, con listas de alias escritas a mano:

- `scripts/temp-fix-playtelecom-estructura.ts` (Asana `1215613218390496`, 2026-06-12) — normaliza ciudad y agrega el supervisor faltante
  como MANAGER. Tiene un mapa `dbName` de overrides.
- `scripts/temp-fix-playtelecom-supervisors-v2.ts` (2026-06-13) — asigna supervisor único por tienda y desactiva 17 cuentas. Aborta si un
  nombre resuelve a ≠1 staff.

Ambos usan un `norm()` que **descarta** el `(1234)` del final del nombre del venue — justo el dato más estable que existe.

**La causa raíz no es que falte un script: es que nadie guardó la llave de identidad.** El Excel trae una columna `ID` con el número de
empleado de Bait (`BEQJURR8002`, `WMQMEAE8008`). El modelo `Staff` tiene `employeeCode String?` y está **vacío en las 25 personas** de la
estructura. Mientras eso siga así, cada actualización vuelve a ser un ejercicio de emparejar nombres a mano — y los nombres ya divergieron:
12 de 25 personas están en Avoqado con nombre corto ("Karina de la Cruz") contra el largo del Excel ("Marisol Karina de la Cruz Zermeño").

## Estado medido contra producción (2026-08-23)

Org `PlayTelecom` = `cmietitbn000zpr2d8213qkzq`, 48 venues.

| Hecho                                         | Valor                                             |
| --------------------------------------------- | ------------------------------------------------- |
| Personas en el Excel                          | 4 supervisores + 31 promotores + 3 cubre descanso |
| De ésas, puestos vacantes (sin persona real)  | 9                                                 |
| Personas reales que **ya existen** en Avoqado | 25 de 25                                          |
| Personas reales que hay que crear             | **0**                                             |
| Tiendas del Excel que ya existen              | 23                                                |
| Tiendas del Excel que no existen              | 6 (todas con promotor vacante)                    |
| Tiendas en Avoqado ausentes del Excel         | 18 (14 sin venta en 90 días; 10 sin venta nunca)  |
| Tiendas que cambian de supervisor             | 8 (las 8 pasan a Juan Nájera)                     |
| `Staff.employeeCode` poblado                  | 0 de 25                                           |

Los 4 supervisores del Excel ya existen: Elias Medina (19 tiendas hoy), Hugo González (9), René Cubos (18) y **Juan Nájera (1)** — el
supervisor que en el archivo crece a 8 tiendas.

### 🔴 Corrección de un hecho que yo di por bueno sin verificar (2026-08-23, tras el primer dry-run)

Una versión anterior de este diseño afirmaba que **39 de las 42 filas `StaffVenue` con `role='WAITER'` activas eran "cuentas de terminal"**,
por tener correo `tpv-…@internal.avoqado.io`, y que desasignarlas dejaría terminales sin poder cobrar. **Es falso, y era una deducción hecha
desde el prefijo del correo sin mirar quién estaba detrás.**

En esta organización **no existe ninguna cuenta de máquina**. Ese correo es simplemente cómo Avoqado da de alta a un promotor que no tiene
correo propio. Las 42 filas son personas reales, con PIN de acceso y con SIMs en custodia — Karina de la Cruz 501, Yolanda González 481,
Tirza Juárez 471, Ma. Elizabeth García 626. Braulio Niño es la excepción sólo porque sí registró un correo personal.

**Cómo se detectó:** el primer dry-run contra producción devolvió **24 de 25 personas como `NOT_FOUND`**, cuando el análisis independiente
decía que las 25 existían. El emparejador estaba excluyendo por esa heurística justo a las personas que debía encontrar.

**Consecuencia de diseño:** el concepto `isTerminalAccount` se elimina del código. La protección real contra desasignar a quien no toca es
otra, y ya existe por construcción: el conciliador sólo toca venues nombrados en el Excel, y toda baja es `active = false`, reversible.

## Cómo representa Avoqado esta estructura

No hay un modelo "organigrama". La jerarquía es **derivada**, y el eslabón es la tienda:

```
Supervisor --(StaffVenue.role = MANAGER, active)--> Venue <--(StaffVenue.role = WAITER, active)-- Promotor
```

- `getOrgManagers` (`src/services/organization-dashboard/organizationDashboard.service.ts:1798`) lista supervisores consultando `StaffVenue`
  con `role IN ('ADMIN','MANAGER') AND active`, agrupado por `staffId`. El `storeCount` de un supervisor **es** su número de filas activas.
- `promoters.service.ts:84-89` lista promotores de un venue con `role IN ('CASHIER','WAITER')`.

**Consecuencia de diseño, y es la parte que contesta el task:** las tres superficies white-label (org `/wl/organizations/:orgSlug`, venue
`/wl/venues/:slug`, y el mount legacy `/venues/:slug/playtelecom`) leen esa misma tabla en vivo. **No hay que escribir código de
dashboard.** Corregir `StaffVenue` corrige las tres a la vez. Cualquier propuesta que agregue una tabla de organigrama paralela introduciría
una segunda fuente de verdad que se desincroniza.

### Dónde el Excel no cabe en el modelo

El Excel declara `promotor → supervisor` **directo**. Avoqado lo deduce a través de la tienda. Eso funciona mientras cada persona tenga
tienda propia, y se rompe en dos casos:

1. **Cubre descanso.** Las 3 personas comparten el venue `Cubre Descanso`, pero el Excel las reparte entre DOS supervisores (José Lopes →
   Juan Nájera; Carlos Vicente Díaz y Heavan Leigh → René Cubos).

   **Corrección (2026-08-23):** una versión anterior de este párrafo decía "un venue admite un solo MANAGER, así que hoy es
   irrepresentable". **Eso es falso.** El único índice único de `StaffVenue` es `@@unique([staffId, venueId])`, que sólo impide que **una
   misma persona** tenga dos filas en el mismo venue; nada impide dos MANAGER **distintos** en un venue, y el propio conciliador lo asume
   (itera sobre N managers activos y desactiva los sobrantes). Que quede uno solo es una decisión de este conciliador, no una restricción
   del schema.

   **La limitación real es otra, y sí sigue en pie:** aunque los dos supervisores puedan colgar del mismo venue, el modelo no permite decir
   que José Lopes reporta a Juan **mientras** Heavan reporta a René dentro de esa misma tienda. La relación promotor→supervisor pasa por la
   tienda, y ahí las tres personas comparten una. Es decisión de negocio (pregunta 5 a Isaac), no un cambio de schema especulativo.

2. **"ACTIVACIONES".** Braulio Niño y Ma. Elizabeth García salen como promotores sin tienda ni ID de tienda, bajo Hugo. Sin venue no hay
   dónde colgar la relación.

### Trampa verificada: `ACTIVACIÓN SLP` NO es la respuesta a "ACTIVACIONES"

Es tentador mapear "ACTIVACIONES" del Excel al venue `ACTIVACIÓN SLP`, que además es el de mayor volumen de PlayTelecom (480 órdenes en 30
días). **Es incorrecto.** Ese venue lo creó otra sesión el 2026-08-20
(`docs/superpowers/specs/2026-08-20-activacion-slp-sim-evento-design.md`) como **destino de reasignación automática** de ventas marcadas
`SIM de Evento`. Evidencia en prod: **0 terminales** y 2 351 eventos `ORDER_VENUE_REASSIGNED`. Braulio y Ma. Elizabeth aparecen vendiendo
ahí porque sus ventas de evento se movieron solas desde RICARDO B ANAYA, UNIDAD PAVON y FLEMING.

Que no tenga `StaffVenue` **es su diseño, no un defecto**. Asignarle promotores los dejaría sin terminal desde donde cobrar. Queda como
pregunta abierta a Isaac.

## Diseño

Tres capas. La primera es la que hace que no haya una cuarta vez.

### Capa 1 — Identidad (sin migración)

- **Personas:** poblar `Staff.employeeCode` con el `ID` del Excel para las 25 personas reales. El campo ya existe; es un `UPDATE`, no un
  cambio de schema.
- **Tiendas:** el ID de tienda ya vive en `Venue.name` entre paréntesis — `BAE RANCHO SAN PEDRO (2978)` — y está presente en el 100% de las
  sucursales con ID. Se extrae con `/\((\d+)\)\s*$/` y se usa como llave de emparejamiento.

**Se descarta agregar `Venue.externalStoreId`.** Obligaría a una migración en un schema de 250+ modelos y a regenerar `docs/SCHEMA_MAP.md`,
y le heredaría un campo a todos los tenants para tapar un hueco de un solo cliente — exactamente lo que prohíbe la postura del founder
registrada en `.claude/rules/playtelecom-vertical.md` (2026-06-23): _"no quiero romper lo escalable de avoqado"_. El paréntesis ya funciona
y es 100% consistente.

### Capa 2 — Conciliador re-ejecutable

`scripts/temp-conciliar-estructura-bait.ts`, con la forma que ya probó ser correcta en los dos scripts previos:

```bash
npx tsx scripts/temp-conciliar-estructura-bait.ts --file=<ruta.xlsx> --org-id=<id>           # dry-run
npx tsx scripts/temp-conciliar-estructura-bait.ts --file=<ruta.xlsx> --org-id=<id> --apply   # escribe
```

- **Lee el Excel, no una lista pegada en el código.** Los dos scripts previos tenían la estructura transcrita a mano en un arreglo; por eso
  quedaron obsoletos el día que llegó el archivo siguiente.
- **Emparejamiento en cascada, y nunca adivina:** por `employeeCode` → por nombre normalizado → por nombre normalizado sin acentos ni
  partículas. Si un renglón resuelve a ≠1 persona, **se reporta y se omite**; jamás se elige una.
- **Dry-run imprime el diff completo** agrupado por tipo de cambio, con el estado actual y el propuesto lado a lado.
- **Idempotente.** Correrlo dos veces no cambia nada la segunda vez.

Operaciones que aplica:

| #   | Operación                                       | Escribe                                         |
| --- | ----------------------------------------------- | ----------------------------------------------- |
| 1   | Poblar el número de empleado                    | `Staff.employeeCode`                            |
| 2   | Supervisor designado por tienda                 | `StaffVenue` upsert `role=MANAGER, active=true` |
| 3   | Quitar supervisores sobrantes de una tienda     | `StaffVenue.active=false` (esa tienda)          |
| 4   | Promotor designado por tienda                   | `StaffVenue` upsert `role=WAITER, active=true`  |
| 5   | Quitar promotores que ya no están en esa tienda | `StaffVenue.active=false` (esa tienda)          |

### Capa 3 — Lo que espera respuesta de Isaac

Cada duda es una bandera **apagada por defecto**. Sin la bandera, el conciliador reporta pero no toca:

| Bandera                         | Qué habilita                                           | Pregunta |
| ------------------------------- | ------------------------------------------------------ | -------- |
| `--baja-ausentes`               | Desactiva las 18 tiendas ausentes del Excel            | 1        |
| `--alta-nuevas`                 | Crea las 6 tiendas del Excel que no existen            | 2        |
| `--vacantes=libre\|placeholder` | Qué hacer con los 9 puestos vacantes (default `libre`) | 6        |
| `--mover-activaciones`          | Mueve a Braulio y Ma. Elizabeth                        | 3, 7     |

## Reglas de seguridad (no negociables)

1. **Nunca `DELETE`.** Toda baja es `active=false`. Hay ventas pagadas, `SaleVerification` y `SerializedItem` con FK a `Staff.id`; un
   borrado en cascada destruye ventas reales (`.claude/rules/playtelecom-vertical.md`, "Staff removal is always soft-delete").
2. **Antes de desasignar a un promotor**, verificar SIMs en su poder (`SerializedItem.assignedPromoterId`) y ventas pendientes, y
   reportarlo. Desasignar de una tienda **no** mueve sus SIMs: la custodia es org-level y sigue a la persona.
3. **`ActivityLog` por cada mutación** (`.claude/rules/critical-warnings.md`). Acciones: `STAFF_VENUE_ROLE_CHANGED`,
   `STAFF_VENUE_DEACTIVATED`, `STAFF_EMPLOYEE_CODE_SET`, con `staffId` del actor, `venueId` y el `data` del cambio.
4. **Alcance duro a la org.** Todas las consultas filtran por `organizationId`. Ningún cambio puede escapar a otro tenant.
5. **Dry-run obligatorio y revisado antes de `--apply`.** Escritura en prod solo con OK explícito del founder.
6. **No se toca `Payment.shiftId` ni ningún venue de una orden ya cobrada.** Este cambio es de asignación de personal, no de reatribución de
   ventas históricas.

## Fuera de alcance (YAGNI)

- **No se construye un modelo de organigrama** (`Staff.supervisorId` o tabla equivalente). Sería una segunda fuente de verdad frente a
  `StaffVenue`, que es lo que los dashboards ya leen. Si Isaac confirma que el reparto de cubre descanso entre dos supervisores es real y
  relevante para comisiones, se diseña entonces con el caso concreto en la mano.
- **No se construye el cargador de Excel en el dashboard.** Es una feature completa (tier, permisos, QA) y depende de la Capa 1 de todos
  modos. Candidato natural al siguiente paso si el archivo vuelve una cuarta vez.
- **No se toca `bulkVenueCreation.service.ts`** ni ningún camino genérico compartido.
- **Sin gating de tier ni Module nuevo**: es un script interno de operación, no expone capacidad a ningún cliente ni rol. Tampoco requiere
  tool nueva del MCP — `list_staff` y las tools de venue ya leen `StaffVenue`, así que la estructura corregida aparece sola.

## Verificación

1. **Unitarias** del emparejador (la única lógica con riesgo real): cascada `employeeCode` → nombre → nombre laxo; ambigüedad ⇒ omite y
   reporta; extracción del ID de tienda del nombre; e idempotencia (segunda pasada = 0 cambios).
2. **Dry-run contra prod** y revisión del diff con el founder. Cifras esperadas: 8 cambios de supervisor, 25 `employeeCode`, 0 personas
   creadas.
3. **Tras `--apply`**, reconsultar `getOrgManagers` y confirmar que Juan Nájera pasa de 1 a 8 tiendas y que ninguna tienda queda con dos
   MANAGER activos.
4. **Log del backend** (`logs/development*.log`) si se ejerce por API; el script corre directo contra Prisma, así que la evidencia es
   `ActivityLog`.

## Decisiones abiertas

Las 9 preguntas están publicadas en el task de Asana (comentario `1217757396400620`) más una precisión sobre "ACTIVACIONES"
(`1217757642004500`). Ninguna bloquea las Capas 1 y 2.
