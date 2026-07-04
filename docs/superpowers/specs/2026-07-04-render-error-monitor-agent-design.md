# Spec de diseño — Agente automático de monitoreo de errores de Render

## 0. Resumen en español sencillo

Un scheduled task de Claude Code (`render-error-monitor`) que corre cada 10 horas, revisa los logs
de error de avoqado-server en BetterStack desde la última corrida, distingue solo con criterio
automático qué es un "blip" (autoresuelto, ya lo hemos visto, no amerita nada) de qué parece un bug
real, y para lo real corre una investigación profunda (el mismo playbook que `/investigate-prod`)
proponiendo un fix — **sin aplicarlo nunca**. Todo queda en un reporte que el usuario lee cuando
quiere; si hubo algo real, además manda un push notification. Cuando el usuario diga "arréglalas
todas" en una sesión normal, eso se maneja igual que hoy: se leen los reportes y se presentan
riesgos antes de tocar código — no es parte de este agente.

**Limitación de plataforma que hay que aceptar:** el scheduled task solo corre mientras la app de
Claude Code esté abierta en la máquina del usuario. Si está cerrada, la corrida pendiente se
dispara en el siguiente arranque — no es un cron 24/7 en la nube.

## 1. Problema y contexto

Esta sesión investigó 3 errores de producción pegados por el usuario (`/investigate-prod`,
2026-07-04): un blip de conectividad DB de ~1-2s (autoresuelto), un blip de "server closed the
connection" de ~60s (autoresuelto, sin backlog), y una colisión real de 5 cron jobs compartiendo
`*/5 * * * *` que agotó el pool de conexiones (P2024) — este último sí se arregló (stagger de los
cron patterns + 2 retry-wraps faltantes, ya committeado... bueno, ya implementado en el working
tree).

De los 3, solo 1 ameritaba investigación profunda + fix. El usuario quiere automatizar exactamente
este proceso de detección + triage + investigación, corriendo sin supervisión cada 10h, para no
tener que pegar logs manualmente.

## 2. Objetivos y NO-objetivos

**Objetivos:**
- Escanear errores nuevos de avoqado-server en BetterStack cada 10h, sin intervención humana.
- Triage automático de 3 vías: blip (autoresuelto, nunca se investiga) / investigado sin acción /
  requiere atención — las últimas dos se determinan por el veredicto de `/investigate-prod`, nunca
  por adivinar de antemano qué es "benigno" (ver sección 5).
- Para todo lo que no calificó como blip: investigación profunda (reutilizando el playbook de
  `/investigate-prod`) + propuesta de fix (research, no código aplicado) cuando aplique.
- Reporte legible + notificación condicional (solo si hay algo que **requiere atención**, no por
  cualquier cosa que simplemente no fue blip).
- No repetir trabajo: un blip ya visto no se re-investiga en la siguiente corrida (salvo
  reclasificación, sección 5).

**NO-objetivos (explícitamente fuera de alcance):**
- Aplicar fixes automáticamente. Nunca. Ni siquiera para cosas triviales.
- Reemplazar `/investigate-prod` para uso manual/interactivo — este agente es un consumidor
  adicional del mismo conocimiento, no un reemplazo.
- Garantizar disponibilidad 24/7 — depende de que la app esté abierta (ver limitación arriba).
- Monitorear otros repos/servicios de Render — solo el servicio de avoqado-server
  (`source_id: 1720702`, el mismo que usa `/investigate-prod`).
- Un mecanismo nuevo para "arréglalas todas" — ese flujo ya existe (conversación interactiva
  normal); este agente solo necesita dejar reportes legibles para que ese flujo los consuma.

## 3. Arquitectura y ubicación de archivos

Un scheduled task (`mcp__scheduled-tasks__create_scheduled_task`), cron cada 10h,
`notifyOnCompletion: false` (la notificación la controla el propio prompt, condicionalmente).

Todo el estado vive fuera del repo de git, junto al task:

```
~/.claude/scheduled-tasks/render-error-monitor/
├── SKILL.md              ← prompt autocontenido (ver sección 4)
├── state.json            ← huellas de errores conocidos + lastScanAt
└── reports/
    └── <ISO-timestamp>.md
```

Cada corrida es una sesión fresca sin memoria de conversaciones previas — el `SKILL.md` debe
contener todo el conocimiento operativo necesario: fuente de BetterStack, criterio de triage,
formato de estado y de reporte.

## 4. Flujo de una corrida (algoritmo)

1. Leer `state.json`. Si no existe (primera corrida): ventana default = últimas 10h, estado vacío.
2. Ventana = `[state.lastScanAt, ahora]`.
3. Query BetterStack (`t284025.render_log_stream`): dado que la ventana siempre corre hasta
   "ahora" y dura ~10h, se consulta cold storage (`s3Cluster`) para el grueso de la ventana **UNION
   ALL** con hot storage (`remote`) para los últimos ~30min (que aún no llegan a S3) — mismo patrón
   que ya usa `/investigate-prod`. Filtro: `level = 'error'`, agrupado por `_pattern`.
4. Por cada `_pattern`:
   - Si ya está en `state.knownPatterns` con `classification: "blip"` → solo actualiza
     contador/`lastSeenAt`, no re-investiga (salvo que la reclasificación de la sección 5 lo saque
     de este estado).
   - Si ya está en `state.knownPatterns` con `classification: "investigado_sin_accion"` o
     `"requiere_atencion"` → SÍ se re-investiga (paso 5) cada vez que reaparece — es la única forma
     de detectar si algo antes benigno cambió de comportamiento. Barato en la práctica: estos
     patrones son raros (~1/semana visto hoy).
   - Si es nuevo → aplica el criterio de triage (sección 5).
5. Para cada patrón que no calificó como blip (nuevo, conocido-no-blip, o reclasificado): corre el
   playbook de 5 fases de `/investigate-prod` (extraer contexto → localizar en código → BetterStack
   → DB read-only → diagnóstico), arma una propuesta de fix cuando aplique (research, sin aplicar),
   y toma su veredicto final ("¿Requiere fix?") para clasificarlo `investigado_sin_accion` o
   `requiere_atencion` (sección 5).
6. Escribe `reports/<timestamp>.md`: resumen ejecutivo (N nuevos, N blips, N investigados sin
   acción, N que requieren atención) + 1-2 líneas por blip + diagnóstico completo por cada uno de
   los otros dos grupos, cada uno bajo su propio encabezado (sección 7).
7. Actualiza `state.json` (nuevas huellas, contadores, `lastScanAt` = ahora) — **excepto si el paso
   3 falló**, ver sección 8.
8. Si ≥1 hallazgo clasificado **requiere_atencion** → `PushNotification` (mensaje corto, ej.
   `"Render monitor: 1 hallazgo requiere atención, ver reporte"`). Si todo fue blip o
   investigado-sin-acción, sin notificación — evita avisos por P2024s que resultan inofensivos.

## 5. Criterio de triage (blip vs investigar → sin-acción / requiere-atención)

**BLIP** (se descarta automáticamente, nunca se investiga) si se cumplen TODAS:
- El código de error cae en la familia transitoria de conexión:
  `P1001/P1002/P1008/P1017/ECONNREFUSED/ETIMEDOUT/ENOTFOUND/ECONNRESET/EPIPE` (los mismos que
  `shouldRetryDbConnectionError` en `src/utils/retry.ts`). **`P2024` queda excluido a propósito**
  de esta lista — ver el punto siguiente.
- Hay evidencia de auto-recuperación en los logs cercanos (mismo endpoint/job con éxito poco
  después, sin backlog visible).
- Ocurrió ≤3 veces en el historial completo de `state.json` (no solo en esta ventana — para un
  patrón nuevo, la ventana actual ES su historial completo, no existe historia previa a su primera
  aparición).

**`P2024` (pool de conexiones agotado) NUNCA es candidato a BLIP automático**, sin importar
auto-recuperación u ocurrencias — a diferencia de un blip de red al azar, agotar el pool es señal
de fragilidad estructural (el cron-collision investigado hoy es exactamente este caso). Siempre
pasa a investigación profunda. La mayoría de las veces `/investigate-prod` va a concluir que no
requiere fix — pero el agente lo mira cada vez en vez de enterrarlo en silencio.

**Todo lo que no calificó como BLIP** (código no-transitorio, `P2024`, o un blip reclasificado —
ver abajo) pasa a investigación profunda (sección 4, paso 5) vía `/investigate-prod`. El
**veredicto final de esa investigación** ("¿Requiere fix?") — no un criterio adivinado de
antemano — es lo que decide si el hallazgo se reporta como `investigado_sin_accion` o
`requiere_atencion` (sección 7). Se decidió así explícitamente: enumerar de antemano qué mensajes
son "esperados/benignos" (ej. un JWT expirado) arriesga esconder algo que en realidad sí
importaba; investigar siempre y clasificar después, con el veredicto real de la investigación, da
más información sin ese riesgo.

**Reclasificación**: un patrón ya catalogado como BLIP que acumula más de 5 ocurrencias en un
período de 30 días (vía `occurrenceTimestamps` podado) deja de auto-descartarse — algo que pasa 1
vez por semana es un blip, lo mismo pasando todos los días deja de serlo aunque el código de error
no cambie. Esto refleja el juicio aplicado manualmente hoy (se revisó la frecuencia en 7 días antes
de decidir "no amerita fix"). La siguiente vez que el patrón reaparezca, pasa a investigación como
cualquier otro no-blip, y su resultado lo cataloga en una de las dos categorías de arriba.

**Nota aceptada (no es un bug, decisión explícita):** un mismo incidente puede generar más de un
`_pattern` distinto — por ejemplo, la excepción real (con su código) y el log de acceso genérico
`Request End: ... - 5xx` del mismo request (sin código propio). Ambos se evalúan por separado; el
segundo, al no traer un código transitorio reconocible, normalmente pasa a investigación aunque el
primero ya se haya descartado como blip — apareciendo como un hallazgo aparentemente redundante en
el reporte. Se acepta esta redundancia ocasional a propósito: es más simple que intentar
correlacionar ambos logs como "el mismo evento", y el costo es solo un poco de ruido en el reporte,
no una acción equivocada.

## 6. Estado y deduplicación (`state.json`)

```json
{
  "lastScanAt": "2026-07-04T22:00:00.000Z",
  "knownPatterns": {
    "Can't reach database server at ?": {
      "classification": "blip",
      "firstSeenAt": "2026-07-03T20:57:56.000Z",
      "occurrenceTimestamps": ["2026-07-03T20:57:56.000Z", "2026-07-04T22:00:00.000Z"]
    },
    "P2024|Timed out fetching a new connection...MarketingCampaign": {
      "classification": "investigado_sin_accion",
      "firstSeenAt": "2026-07-03T18:05:10.000Z",
      "occurrenceTimestamps": ["2026-07-03T18:05:10.000Z"]
    }
  }
}
```

La llave es el string de `_pattern` tal cual (JSON admite claves con cualquier texto; no hace
falta hashearlo — es innecesario). `occurrenceTimestamps` es la lista de timestamps en que se vio
ese patrón; en cada corrida se poda a solo los últimos 30 días y su longitud ES el
`occurrencesLast30d` de la sección 5 — así el contador envejece solo en vez de crecer para
siempre.

`classification` toma 3 valores: `blip` (se auto-descarta sin investigar — salvo que la
reclasificación de >5/30d lo saque de este estado), `investigado_sin_accion` (ya se investigó y
`/investigate-prod` concluyó que no había nada que hacer) y `requiere_atencion` (ya se investigó y
sí hay algo a considerar). A diferencia de `blip`, un patrón conocido en cualquiera de estas dos
últimas categorías SÍ se vuelve a investigar cada vez que reaparece (sección 4, paso 4) — es la
única forma de detectar si algo antes benigno cambió de comportamiento; el costo es bajo porque en
la práctica estos patrones son raros (~1/semana visto hoy).

## 7. Reporte y notificación

Reporte markdown por corrida con 3 secciones (no 2):

1. **Blips** (autoresueltos, no ameritan acción) — resumen de una línea cada uno (por qué se
   descartó).
2. **Investigado, sin acción requerida** — patrones que no calificaron como blip (incluye
   `P2024` siempre) pero cuya investigación con `/investigate-prod` concluyó que no hay nada que
   hacer. Mismo tono/estructura que los reportes de `/investigate-prod` en esta conversación:
   tabla de timeline, quién/qué/por qué/impacto, terminando en "Requiere fix? No".
3. **Requiere atención** — igual de detallado que el grupo anterior, pero el veredicto de
   `/investigate-prod` fue "Requiere fix? Sí" (o el diagnóstico quedó ambiguo/incompleto — ver
   manejo de errores, sección 8).

Notificación (`PushNotification`) SOLO si hubo ≥1 hallazgo en la sección 3 (**requiere
atención**) — no por cualquier cosa que simplemente no fue blip, para no generar avisos por
`P2024`s (u otros) que la propia investigación concluye que son inofensivos. Mensaje corto
apuntando a que hay reporte nuevo, sin detalle (el detalle vive en el reporte).

## 8. Manejo de errores del propio agente

- **Primera corrida sin `state.json`**: arranca en frío, sin tratarlo como error.
- **Falla la query a BetterStack** (timeout, auth, etc.): el reporte lo dice explícitamente y **NO
  se avanza `lastScanAt`** — la siguiente corrida reintenta la misma ventana en vez de dejar un
  hueco silencioso sin escanear.
- **El deep-dive de un hallazgo truena a medias**: se reporta lo alcanzado a ver en vez de
  descartar el hallazgo en silencio (mejor un diagnóstico parcial visible que nada). Si no se
  alcanzó a obtener un veredicto claro de "¿Requiere fix?", el hallazgo se cataloga como
  `requiere_atencion` por defecto (fail-safe — más vale un falso positivo ocasional que esconder
  algo por una investigación incompleta).
- **READ-ONLY absoluto**, igual que `/investigate-prod`: nunca Edit/Write/git commit/INSERT/
  UPDATE/DELETE sobre el código o la DB de negocio. Los únicos archivos que este agente escribe
  son su propio `state.json` y sus propios reportes.

## 9. Validación antes de activar el cron

Antes de crear el scheduled task, correr el prompt manualmente una vez contra los datos ya
conocidos del 3-4 de julio 2026 (una corrida real de dry-run ya se hizo durante el diseño, ventana
completa 2026-07-03T00:00Z a 2026-07-04T05:00Z) y verificar:

- El blip de conectividad DB (~20:57, `P1001`) y los dos de "server closed the connection" (~03:26,
  `P1017` en `providerEventLog`/`posCommand`) clasifican **BLIP**.
- Los dos `P2024` del cron-collision (~18:05, `MarketingCampaign`/`Reservation`) se investigan
  (nunca blip, por diseño) y aterrizan en **`investigado_sin_accion`** — la investigación real
  encontró que ambos jobs ya envuelven su lectura con `retry(shouldRetryDbConnectionError)`
  correctamente y que el pool se recupera solo al siguiente tick, sin backlog.
- No debe haber notificación (`PushNotification`) en esta corrida — nada aterriza en
  `requiere_atencion`.

Si el diseño no reproduce esto, se ajusta el criterio antes de prender el cron recurrente. (La
corrida real de validación también encontró, de paso, 5 ocurrencias de un P2025 de limpieza de
`LiveDemoSession` ya arregladas y desplegadas — confirmado vía `git log` que el fix es anterior al
deploy, no una regresión — y un caso de JWT expirado correctamente diagnosticado como
comportamiento esperado. Ambos son ejemplos reales de por qué la categoría
`investigado_sin_accion` importa: sin ella, habrían generado notificación innecesaria bajo el
diseño original de 2 categorías.)

## 10. Relación con `/investigate-prod`

Este agente NO reemplaza el skill — lo reutiliza como motor de investigación profunda para todo lo
que no calificó como blip (tanto lo que termina `investigado_sin_accion` como lo que termina
`requiere_atencion` — la diferencia la da el veredicto, no cuál se investiga). `/investigate-prod`
sigue existiendo tal cual para uso manual/interactivo cuando el usuario pega un log a mano.

## 11. Fuera de alcance (futuro, no ahora)

- Paralelizar deep-dives si el volumen de hallazgos reales crece (hoy ~1/semana, no lo justifica).
- Monitorear otros servicios de Render además de avoqado-server.
- Cualquier automatización de "arréglalas todas" — sigue siendo 100% manual/interactivo.
