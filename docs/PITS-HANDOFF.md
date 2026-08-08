# PITS — Traspaso de contexto

> **Para qué es esto:** darle a otra IA (o a una persona nueva) todo el contexto del
> proyecto PITS sin tener que leer la conversación completa. Última actualización:
> **2026-08-08**.
>
> Léelo entero antes de tocar nada. Son 10 minutos y evita repetir trabajo que ya falló dos
> veces.

---

## 1. Quién es PITS y qué está en juego

**PITS** es una cadena de paradores de carretera en México: **18 tiendas de conveniencia,
8 restaurantes y 5 cafeterías = 31 puntos de venta, 141 usuarios.** Están **eligiendo ERP**
con la ayuda de la consultora **LDM**, y el competidor es **Intelisis**.

- Contacto: **Wendy** (del lado de PITS).
- Su ponderación declarada: **1º Compras, 2º Contabilidad, 3º Punto de venta, 4º Inventarios.**
- Contestamos una **matriz de 259 requerimientos**:
  `~/Documents/Programming/Avoqado-HQ/customer-calls/Matriz-Requerimientos-Avoqado-PITS-CONTESTADA.xlsx`
  (hoja "2. Matriz de Requerimientos"). **Esa matriz es, en la práctica, un contrato**:
  varios renglones traen compromisos de días explícitos.

**El demo se APLAZÓ** (decisión del fundador, 2026-08-07). Ya no hay fecha. Eso cambió el
objetivo de "qué cabe antes del 11 de agosto" a "todo lo que prometimos en la matriz".

### El riesgo que define el proyecto

Hay **~30 renglones contestados como "cumplimiento en forma natural" que NO cumplen.** No
les faltan campos: no funcionan. Son exactamente los que una consultora de selección prueba
sin avisar. La buena noticia es que casi todos son de horas o días — la brecha más peligrosa
es también la más barata de cerrar. Por eso el hito H0 existe y va primero.

---

## 2. Qué leer, y en qué orden

| # | Documento | Qué te da |
|---|---|---|
| 1 | `docs/PITS-PROGRAMA-COMPLETO.md` | **Empieza aquí.** El titular honesto (17 meses si construimos todo; 8-9 de lo que van a usar; 13 semanas de lo que decide la selección), las sorpresas buenas ya construidas, y el programa por hitos H0→H7 con su secuencia justificada. |
| 2 | `docs/PITS-INVENTARIO-MATRIZ.md` | **125 de 259 renglones** con detalle: qué prometimos (cita textual), qué existe hoy (con archivo:línea), tamaño de la brecha, esfuerzo y riesgo a los ~70 venues vivos. |
| 3 | `docs/PITS-H0-PENDIENTES.md` | Registro histórico de los puntos que faltaban de H0. Ya no es una lista vigente de ejecución. |
| 4 | `docs/PITS-HANDOFF-SESION-2026-08-07.md` §0 | **Cierre verificable de H0.6:** contrato, 11 pruebas HTTP/DB, comandos, límites y rollout seguro. |
| 5 | `docs/PITS-H0.3-EXPORTACIONES-PLAN.md` | Plan histórico de implementación de las exportaciones + patrón por módulo. |
| 6 | `docs/superpowers/specs/2026-08-06-autorizacion-y-segregacion-compras-design.md` | Spec de autorización de compras por monto y sucursal, con segregación aprobar/recibir. |
| 7 | `docs/superpowers/plans/2026-08-06-autorizacion-y-segregacion-compras-v2.md` | 🔴 **Este plan FALLÓ la auditoría de Codex con 46 incidencias. No lo ejecutes tal cual.** |
| 8 | `docs/DEMO-PITS-2026-08-BITACORA.md` | Bitácora de lo trabajado antes del 7 de agosto. |

Contexto de la plataforma en general (no específico de PITS): el `CLAUDE.md` de este repo y
las reglas de `.claude/rules/` — auto-cargan y son obligatorias.

---

## 3. Estado actualizado al 2026-08-08

### Hito H0 — "todo lo que dijimos que ya cumple, cumple"

Lista **cerrada** de nueve puntos, 2 semanas. **LOS NUEVE IMPLEMENTADOS.** H0.6 terminó su
implementación y prueba local el 8 de agosto; su despliegue permanece pendiente y el opt-in nace
apagado, por lo que no cambia a ningún venue actual.

| | Punto | Estado |
|---|---|---|
| H0.1 | Bloquear orden de compra a proveedor dado de baja | ✅ |
| H0.2 | LOGIN/LOGOUT en la bitácora + filtro por acción | ✅ |
| H0.3 | Exportación en bitácora, inventario, compras y contabilidad | ✅ (6 exportaciones + bitácora) |
| H0.4 | Botón de pólizas XML + export de estado de resultados y balance | ✅ |
| H0.5 | Montar captura de merma y exponer cuarentena de lotes | ✅ |
| H0.6 | Diferencia de caja al cerrar turno | ✅ implementación + prueba HTTP/DB; ⚠️ rollout/piloto físico pendientes |
| H0.7 | Candado de ajuste de inventario a `inventory:adjust` | ✅ |
| H0.8 | Tasa de surtido y días de cobertura | ✅ |
| H0.9 | "Recibir ninguno" devuelve la mercancía al almacén | ✅ |

### Hallazgo grande del 7 de agosto, fuera de la lista

**Tres reportes de inventario no estaban incompletos: estaban MUERTOS.** PMIX (mezcla de
ventas), consumo de insumos y variación de costo. Los tres con ruta viva; los tres armaban
su SQL con columnas en `snake_case` contra columnas que son `camelCase`. Verificado contra
la base de producción:

```
ERROR:  column o.venue_id does not exist
HINT:  Perhaps you meant to reference the column "o.venueId".
```

Nadie se enteró porque dos de los tres viven detrás del candado de inventario premium.
**Ya corren y devuelven datos reales.** El esquema NO mapea nombres —los únicos `@@map` que
existen son de otras tablas (`time_entries`, `tpv_messages`, `training_*`, `mcp_*`)—, así
que cualquier SQL crudo nuevo tiene que usar camelCase **entre comillas dobles**. Hay una
prueba-guardia estática que lo vigila: `tests/unit/services/dashboard/reports.rawSql.test.ts`.

Segundo defecto del mismo archivo: los fragmentos condicionales (`LIMIT`, filtro por insumo)
estaban interpolados con backticks **dentro de una plantilla etiquetada**, donde eso NO
concatena SQL — manda el texto como parámetro. Resultado: sintaxis rota y un filtro que
nunca filtró. Ahora usan `Prisma.sql` / `Prisma.empty`.

### Deuda conocida que dejó H0.3 (señalada, no escondida)

- **`new Date(req.query.startDate)` pelón** en la exportación del kardex y de órdenes de
  compra (`export.controller.ts:167` y `:239`). Es la trampa de zona horaria de
  `critical-warnings.md`. **Se dejó a propósito:** los dos controladores copian carácter por
  carácter el parseo de la pantalla que exportan. Arreglarlo sólo en la exportación produce
  el peor defecto de esta familia — un archivo que no coincide con lo que el usuario ve. El
  arreglo correcto es a los dos a la vez, y es otra tarea.
- **La exportación de gastos tiene tope duro de 500** porque `listExpenses` corta ahí. Un
  contribuyente con más de 500 CFDI en un mes **no puede exportar el mes completo por ningún
  camino**. Rechaza en vez de truncar (correcto), pero es un límite de producto que requiere
  paginar `listExpenses`.

### H0.9 resultó ser una BORRADA, no una construcción de 4-5 días

`receiveNoItems` hacía un `updateMany` a ciegas: ponía todos los renglones en NOT_PROCESSED
con `quantityReceived: 0`, cancelaba la orden y **no tocaba la existencia**. La bodega se
quedaba con la mercancía mientras el sistema declaraba que nunca llegó.

Al investigarlo apareció que **`applyItemReceiveStatusInTx` ya sabía revertir**: es la
función que usa la pantalla renglón por renglón, atiende insumos Y mercancía de reventa,
deriva el delta del estado real —lotes vivos y movimientos de inventario, nunca de
`quantityReceived`— y ya se niega cuando el insumo se consumió. El arreglo fue **dejar de
reimplementar y pasar cada renglón por ella**.

Lo único que sí faltaba era el guard del lado de mercancía de reventa: ese camino usaba
`increment: delta` **sin protección contra negativos**, así que revertir una recepción ya
vendida dejaba la existencia en negativo. Ahora se niega con 409 y un mensaje que dice
cuánto queda y que la salida es una devolución al proveedor — el modelo de Odoo: cancelar es
"esto nunca pasó", devolver es otro documento.

Regresión: 150 pruebas en 18 suites de compras, lotes y reabasto, todas en verde.

### H0.6 — cerrado en implementación, pendiente de rollout

El bloqueo original ya se resolvió de forma aditiva:

1. El cálculo nuevo es `contado − (fondo inicial + pagos COMPLETED en efectivo)` con Decimal exacto.
   Un turno balanceado devuelve y persiste `0.00`; ausencia de conteo conserva `null`.
2. `CASH_RECONCILIATION` es PRO y exige un opt-in por venue con default `false`. Sin ambos, el flujo
   antiguo queda idéntico y nunca se convierte en stopper.
3. `avoqado-tpv` ahora ofrece conteo ciego de efectivo físico total, cierre sin conteo confirmado y
   un resultado que no desaparece hasta pulsar **Listo**.
4. El payload antiguo, kiosk y Avoqado Desktop siguen funcionando. En particular, el top-level
   legacy `cashDeclared` de Desktop permanece activo incluso en FREE/opt-out.
5. El server usa cierre atómico `OPEN -> CLOSING -> CLOSED`, auditoría transaccional y outcomes
   explícitos para counted, skipped, disabled, inválido, overflow y legacy.

Se probaron once escenarios de punta a punta con el Express/Prisma real contra un clon PostgreSQL
aislado, incluida concurrencia, recuperación de `CLOSING`, cero físico, downgrade e aislamiento por
tenant. Server (8 508 unitarias), dashboard (624), TPV (suite + Production compile + lint) y Desktop
`CajaFlowUiTest` quedaron verdes en sus verificaciones de alcance.

**Lo que falta es release, no diseño funcional:** resolver/separar dos WIP ajenos que bloquean los
builds globales, commitear sólo con permiso, desplegar server antes del dashboard/APK, hacer bump
MINOR y validar en una terminal 360x640. `adb devices -l` no mostró dispositivo, así que no se
inventa evidencia física. Ver el registro exacto en
`docs/PITS-HANDOFF-SESION-2026-08-07.md` §0.

### Limitación conocida y declarada

`expected` no resta retiros ni pagos de caja, porque `CashDrawerSession` **no está ligado a
`Shift`** — cuelga de venue + staff, así que los eventos del cajón no se pueden atribuir a un
turno sin adivinar por traslape de horas, y adivinar ahí atribuye dinero real a quien no fue.
Un local que saca efectivo a media jornada verá un faltante por ese monto. Sigue siendo
mejor que la fórmula anterior, y falla en la dirección que hace que alguien revise, no en la
que esconde un hueco.

### Otras cosas que se encontraron y arreglaron

- **Evaluación de proveedores:** la puntualidad devolvía `false` cuando faltaba la fecha
  comprometida, y ese `false` salía del numerador pero **seguía en el denominador**. Un
  proveedor al que nadie le puso fecha aparecía con **0% de puntualidad**. Ahora esas
  órdenes salen del cálculo y se reportan aparte (`ordersWithoutCommittedDate`).
- **Toda la capa de lotes estaba escrita y era INALCANZABLE:** listar, consultar,
  estadísticas y cuarentena existían con pruebas en verde y **ninguna ruta las invocaba**.
  Y faltaba la mitad del ciclo: no había forma de liberar un lote retenido.
- **Se podía ponerle una orden de compra a un proveedor dado de baja.** Y como
  `deleteSupplier` se niega a borrar a un proveedor con órdenes, la baja (`active: false`)
  era el único control real — y no se respetaba.

### 🔴 Estado del control de versiones

El estado ya no es completamente no-commiteado: el commit mixto `891dc0fb` incorporó 125 archivos
de varias sesiones, incluida una parte inicial de H0/H0.6. **No reescribirlo ni atribuirlo a una sola
sesión.** Las correcciones finales de server y los cambios de dashboard/TPV continúan en el árbol
compartido. El fundador mantiene la regla dura: **nunca hacer otro commit, push ni operación Git
mutante sin permiso explícito.**

**Verificación al 2026-08-07:** typecheck limpio en `avoqado-server` y en
`avoqado-web-dashboard`; 159 pruebas propias en verde. Tres suites del repo fallan
(`storesAnalysis.sales-export`, `job-schedule-hardening`, `supervisorSalesExport`) y son de
**otra sesión** trabajando en paralelo, no de este trabajo.

---

## 4. Decisiones CERRADAS — no re-litigar

- **Tier de la autorización de compras: core / gratis.** No se cobra aparte.
- **Interruptor por sucursal + umbral por monto.** Cada sucursal decide si exige
  autorización y a partir de qué monto.
- **El correo de autorización sale al ENVIAR la orden, para todos.**
- **Revertir una autorización sí se puede, con guarda de consumo** (no se revierte lo que ya
  se recibió).
- **Rechazar tiene ciclo de corrección:** una orden rechazada se corrige y se reenvía; no se
  rehace desde cero. Ya implementado.
- **Se partió el trabajo:** primero estabilizar el módulo de compras (H0), después construir
  la autorización (H2). El plan de autorización falló dos auditorías y **la mitad de sus
  bloqueadores era deuda preexistente, no complejidad del feature.**
- **Código en INGLÉS.** Identificadores, comentarios y nombres de prueba. Se queda en
  español sólo lo que lee una persona: mensajes de Zod, de `AppError`, etiquetas de UI, y
  las descripciones y llaves de salida de las herramientas del MCP.

---

## 5. Decisiones ABIERTAS — bloquean trabajo

### Del fundador

1. **¿Quién puede leer la bitácora?** Hoy `activity:read` lo tiene **sólo OWNER**. Un
   contralor con rol ADMIN abre la pantalla y no ve nada. Dos salidas:
   (a) agregarlo a los permisos por default de ADMIN — una línea, aplica a todos los
   clientes; (b) configurarlo por sucursal con el editor de roles personalizados —
   verificado que ADMIN está en **modo suma**, así que es aditivo y no congela nada, pero
   son 31 configuraciones para PITS y otra por cada tienda nueva.
2. **¿Qué tier va a contratar PITS?** Inventario, compras y contabilidad están detrás de
   candados de plan (`INVENTORY_TRACKING`, `VENUE_AUDIT_LOG`, `CFDI`). Si su paquete no los
   incluye, los botones responden "tu plan no lo incluye", que en una verificación con la
   consultora se lee igual de mal que "no está hecho".

### De PITS — pedirlos por escrito, con fecha

3. **La matriz real de niveles de autorización** (montos por puesto) → bloquea H2.
4. **Los layouts reales de carga masiva** (precios, códigos, pólizas, órdenes) → bloquea H1 y H4.
5. **El banco y su especificación de dispersión** → bloquea H4.
6. **Qué productos causan IEPS y a qué tasa o cuota** → bloquea H5.

> Pedirlos tiene un segundo efecto: **un cliente que entrega insumos es un cliente
> comprometido.** Es la mejor señal temprana de hacia dónde se inclina la selección.

---

## 6. Lo que falta de planeación

**No existe spec ni plan para seis de los ocho hitos** (catálogo maestro, inventario de
tienda, ciclo de compra a pago, fiscal, presupuestos, POS comercial). Y **134 de los 259
renglones no están analizados uno por uno** — el inventario se acotó a los 25 de mayor
consecuencia por módulo.

Tres cosas urgen, en este orden:

1. **Terminar el inventario de los 134 restantes**, para el **acta de alcance**: hay ~30
   renglones que dicen *"se configura durante la implementación"*, que es alcance infinito
   escrito con letra de alcance cerrado, y al menos 4 donde dijimos "se configura" y en
   realidad es desarrollo. Se clasifican en *entregado hoy / entregado en el hito N /
   requiere insumo de PITS*. **Es la póliza de seguro del programa entero y no depende de
   nadie más.**
2. **Corregir el plan de autorización contra las 46 incidencias de Codex** — antes de
   escribir código, no durante.
3. **Spec del catálogo maestro (H1)** — es el siguiente y bloquea a los demás.

**Los otros tres hitos NO se speccan todavía**, a propósito: el fiscal depende de una
decisión de compra y de datos de PITS; presupuestos depende de que ellos definan qué es un
centro de costo. Speccearlos hoy es escribir ficción con formato de compromiso.

---

## 7. Cómo trabaja este proyecto (respétalo)

- **Flujo obligatorio:** brainstorming → spec → plan escrito → decidir explícito si va
  inline o con subagentes → ejecución. Nunca saltar directo a implementar.
- **Codex es el auditor.** Plan → Codex audita → el fundador adjudica → re-audita →
  construir. Para que sirva necesita: el repo, el spec, las decisiones cerradas, y la orden
  explícita de **verificar en el código en vez de creer**.
- **Investigar a los líderes de la industria antes de construir** (Odoo, Square, NetSuite,
  D365, SAP) y aplicar juicio. También sirve para saber a quién NO copiar.
- **Varias sesiones de IA trabajan en este repo al mismo tiempo.** Archivos modificados que
  tú no tocaste son WIP ajeno: normal. 🔴 Nunca `git reset --hard`, `git checkout .`,
  `git clean` ni `git stash`. Commitea por rutas explícitas, nunca `git add -A`. Nunca
  `npm run format` global — reformatea archivos ajenos.
- **Verificar siempre**, pero el tamaño lo decide la carga de la máquina (10 núcleos /
  32 GB, compartida). Lo que difieras va explícito en el reporte, con el comando exacto.
- **Base de producción:** hay acceso de **sólo lectura** para verificar hipótesis
  (`RENDER_DATABASE_URL` en `.env`). SELECT únicamente, jamás escrituras.

---

## 8. Qué NO asumir

- **No asumas que un reporte funciona porque existe y tiene ruta.** Tres estaban muertos y
  nadie se había dado cuenta. Verifica contra la base antes de reportar algo como cumplido.
- **No asumas que una función probada es alcanzable.** La capa de lotes tenía pruebas en
  verde y cero rutas.
- **No asumas que la matriz dice lo que crees.** Ábrela y cita textual. Varios renglones
  contestados como "natural" no lo son.
- **No confíes en el resultado de un subagente sin verificarlo.** En este proyecto ya hubo
  varios reportes de agentes que resultaron falsos o a medias.
- **El `CLAUDE.md` de la raíz del workspace dice que los restaurantes NO son el ICP. Está
  desactualizado** — las tres verticales (retail, servicios con cita, y alimentos y
  bebidas) son activas. PITS es justamente tiendas + restaurantes + cafeterías.
