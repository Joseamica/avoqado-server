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
- Triage automático blip-vs-real usando el mismo criterio que se aplicó manualmente hoy.
- Para hallazgos reales: investigación profunda (reutilizando el playbook de `/investigate-prod`)
  + propuesta de fix (research, no código aplicado).
- Reporte legible + notificación condicional (solo si hay algo real).
- No repetir trabajo: un blip ya visto no se re-investiga en la siguiente corrida.

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
   - Si ya está en `state.knownPatterns` → solo actualiza contador/`lastSeenAt`, no re-investiga.
   - Si es nuevo → aplica el criterio de triage (sección 5).
5. Para cada patrón clasificado **REAL** (nuevo o reclasificado): corre el playbook de 5 fases de
   `/investigate-prod` (extraer contexto → localizar en código → BetterStack → DB read-only →
   diagnóstico) y arma una propuesta de fix (research, sin aplicar).
6. Escribe `reports/<timestamp>.md`: resumen ejecutivo (N nuevos, N blips, N reales) + 1-2 líneas
   por blip + diagnóstico completo por cada real.
7. Actualiza `state.json` (nuevas huellas, contadores, `lastScanAt` = ahora) — **excepto si el paso
   3 falló**, ver sección 8.
8. Si ≥1 hallazgo REAL → `PushNotification` (mensaje corto, ej. `"Render monitor: 1 posible bug
   real, ver reporte"`). Si no, sin notificación.

## 5. Criterio de triage (blip vs real)

**BLIP** si se cumplen TODAS:
- El código de error cae en la familia transitoria ya reconocida por el código
  (`P1001/P1002/P1008/P1017/P2024/ECONNREFUSED/ETIMEDOUT/ENOTFOUND/ECONNRESET/EPIPE` — los mismos
  que `shouldRetryDbConnectionError`/`isTransientDbConnectionError` en `src/utils/retry.ts`).
- Hay evidencia de auto-recuperación en los logs cercanos (mismo endpoint/job con éxito poco
  después, sin backlog visible).
- Ocurrió ≤3 veces en el historial completo de `state.json` (no solo en esta ventana).

**REAL** si se cumple CUALQUIERA:
- No es un código transitorio conocido (parece lógica de negocio / bug de aplicación).
- Deja backlog, huérfanos, o datos inconsistentes verificables.
- **Reclasificación**: un patrón ya catalogado como BLIP que acumula más de 5 ocurrencias en un
  período de 30 días — algo que pasa 1 vez por semana es un blip, lo mismo pasando todos los días
  deja de serlo aunque el código de error no cambie. Esto refleja el juicio aplicado manualmente
  hoy (se revisó la frecuencia en 7 días antes de decidir "no amerita fix").

## 6. Estado y deduplicación (`state.json`)

```json
{
  "lastScanAt": "2026-07-04T22:00:00.000Z",
  "knownPatterns": {
    "Can't reach database server at ?": {
      "classification": "blip",
      "firstSeenAt": "2026-07-03T20:57:56.000Z",
      "occurrenceTimestamps": ["2026-07-03T20:57:56.000Z", "2026-07-04T22:00:00.000Z"]
    }
  }
}
```

La llave es el string de `_pattern` tal cual (JSON admite claves con cualquier texto; no hace
falta hashearlo — es innecesario). `occurrenceTimestamps` es la lista de timestamps en que se vio
ese patrón; en cada corrida se poda a solo los últimos 30 días y su longitud ES el
`occurrencesLast30d` de la sección 5 — así el contador envejece solo en vez de crecer para
siempre.

## 7. Reporte y notificación

Reporte markdown por corrida, mismo tono/estructura que los reportes de `/investigate-prod` en
esta conversación: tabla de timeline, quién/qué/por qué/impacto/requiere-fix para cada REAL;
resumen de una línea por cada BLIP (por qué se descartó). Notificación (`PushNotification`) SOLO
si hubo ≥1 REAL — mensaje corto apuntando a que hay reporte nuevo, sin detalle (el detalle vive en
el reporte).

## 8. Manejo de errores del propio agente

- **Primera corrida sin `state.json`**: arranca en frío, sin tratarlo como error.
- **Falla la query a BetterStack** (timeout, auth, etc.): el reporte lo dice explícitamente y **NO
  se avanza `lastScanAt`** — la siguiente corrida reintenta la misma ventana en vez de dejar un
  hueco silencioso sin escanear.
- **El deep-dive de un hallazgo real truena a medias**: se reporta lo alcanzado a ver en vez de
  descartar el hallazgo en silencio (mejor un diagnóstico parcial visible que nada).
- **READ-ONLY absoluto**, igual que `/investigate-prod`: nunca Edit/Write/git commit/INSERT/
  UPDATE/DELETE sobre el código o la DB de negocio. Los únicos archivos que este agente escribe
  son su propio `state.json` y sus propios reportes.

## 9. Validación antes de activar el cron

Antes de crear el scheduled task, correr el prompt manualmente una vez contra los datos ya
conocidos de esta conversación (3-4 de julio 2026) y verificar que clasifique como BLIP
exactamente el blip de conectividad de 1-2s y el de "server closed the connection" de 60s — si el
diseño no reproduce el juicio manual de hoy, se ajusta el criterio antes de prender el cron
recurrente.

## 10. Relación con `/investigate-prod`

Este agente NO reemplaza el skill — lo reutiliza como motor de investigación profunda para
hallazgos REAL. `/investigate-prod` sigue existiendo tal cual para uso manual/interactivo cuando
el usuario pega un log a mano.

## 11. Fuera de alcance (futuro, no ahora)

- Paralelizar deep-dives si el volumen de hallazgos reales crece (hoy ~1/semana, no lo justifica).
- Monitorear otros servicios de Render además de avoqado-server.
- Cualquier automatización de "arréglalas todas" — sigue siendo 100% manual/interactivo.
