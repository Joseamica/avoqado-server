---
name: investigate-prod
description: Investigación automatizada de errores de producción de avoqado-server. READ-ONLY absoluto. Adaptada para correr desde una rutina en la nube: las rutas son relativas al repo clonado.
---

<!-- NOTA (migración a la nube):
     Esta es la versión de `investigate-prod` que vive DENTRO del repo, para
     que las rutinas en la nube puedan usarla — en la nube solo existen los
     skills que estén en el repositorio clonado.

     Diferencia con la versión local (~/.claude/commands/investigate-prod.md):
     las rutas absolutas de la Mac se cambiaron por rutas relativas al repo.
     El resto es idéntico, incluida la regla READ-ONLY.

     Si editas una, edita la otra. -->

Investigacion automatizada de errores de produccion en Avoqado. El usuario pega un log de error y tu trabajo es correr la pelicula completa
para diagnosticar la causa raiz. READ-ONLY absoluto.

Argumento: $ARGUMENTS (el log de error pegado por el usuario)

## REGLA ABSOLUTA: READ-ONLY

```
PROHIBIDO:
- Edit, Write, NotebookEdit          (no modificar archivos)
- git commit, git push, git checkout (no tocar git)
- INSERT, UPDATE, DELETE en DB       (solo SELECT)
- Crear issues, PRs, mensajes        (no posts)
- Cualquier MCP tool que modifique estado externo

PERMITIDO:
- Bash: grep, find, psql (SELECT only)
- Read: leer archivos del codebase
- BetterStack: query (read logs)
- AskUserQuestion: pedir clarificacion
```

Si descubres un bug, NO lo arregles. Reporta el diagnostico y deja que el usuario decida.

## Configuracion

### Base de datos de produccion

- Connection string: env var `PROD_DATABASE_URL`
- Si no esta definida, pedir al usuario que la pegue
- SOLO ejecutar queries SELECT. Nunca INSERT/UPDATE/DELETE.

### BetterStack Logs (Render)

- Source ID: `1720702` (render log stream)
- Hot storage (ultimos 30 min): `FROM remote(t284025_render_log_stream_logs)`
- Cold storage (historico): `FROM s3Cluster(primary, t284025_render_log_stream_s3)` con `_row_type = 1`
- Tool: `mcp__betterstack__query` con `source_id: 1720702` y `table: "t284025.render_log_stream"`
- Siempre usar `JSONExtract(raw, ..., 'Nullable(String)')` para campos del JSON

### Codebase

- Repo principal: `.`
- Codigo fuente: `src/`
- Schema Prisma: `prisma/schema.prisma`

## PLAYBOOK: 5 Fases

Ejecuta las 5 fases en orden. Las fases 2, 3 y 4 se pueden correr en paralelo.

### Fase 1 — Extraer contexto del error

Del log pegado por el usuario en $ARGUMENTS, extraer:

- **Timestamp** (convertir a UTC si tiene offset)
- **Mensaje de error** (el texto exacto para grep)
- **IDs** (patrones cuid: 25 chars, prefijo `c`; UUIDs; numeros)
- **Endpoint** (method + URL del request)
- **Status code**
- **CorrelationID** (si existe)
- **IP** del cliente

Si falta el timestamp, preguntar al usuario la hora aproximada.

### Fase 2 — Localizar origen en el codigo

```bash
grep -rn 'MENSAJE_DE_ERROR_EXACTO' ./src/
```

Buscar el texto exacto del error. Si no hay match, buscar fragmentos clave. Una vez encontrado:

1. Leer el archivo/linea para entender la condicion que dispara el error
2. Identificar el controller y service involucrados
3. Entender que query o validacion falla

### Fase 3 — BetterStack logs

Determinar si usar hot o cold storage:

- Error hace < 30 min → `remote(t284025_render_log_stream_logs)`
- Error hace > 30 min → `s3Cluster(primary, t284025_render_log_stream_s3)` con `_row_type = 1`

**Query 1: Request completo** — buscar por correlationId o por URL+timestamp en ventana de +-2 minutos:

```sql
SELECT
  dt,
  JSONExtract(raw, 'message', 'Nullable(String)') AS full_msg,
  JSONExtract(raw, 'level', 'Nullable(String)') AS level,
  JSONExtract(raw, 'message', 'userId', 'Nullable(String)') AS userId,
  JSONExtract(raw, 'message', 'venueId', 'Nullable(String)') AS venueId,
  JSONExtract(raw, 'message', 'role', 'Nullable(String)') AS role,
  JSONExtract(raw, 'message', 'statusCode', 'Nullable(Int64)') AS status,
  JSONExtract(raw, 'message', 'method', 'Nullable(String)') AS method,
  JSONExtract(raw, 'message', 'url', 'Nullable(String)') AS url,
  JSONExtract(raw, 'message', 'durationMs', 'Nullable(Float64)') AS durationMs,
  JSONExtract(raw, 'message', 'userAgent', 'Nullable(String)') AS userAgent
FROM <SOURCE>
WHERE
  _row_type = 1  -- solo para s3Cluster
  AND dt BETWEEN '<TIMESTAMP - 2min>' AND '<TIMESTAMP + 2min>'
  AND JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%<ID_PRINCIPAL>%'
ORDER BY dt ASC
LIMIT 30
```

**Query 2: Contexto amplio** — si hay un tag/prefijo de log (ej. `[ORG SALE VERIFICATION]`), buscar todos los logs con ese prefijo en la
ventana de tiempo para ver la secuencia de acciones del usuario.

De los logs extraer:

- userId, venueId, role del Request End
- userAgent (Chrome/Firefox, Windows/Mac, mobile)
- Secuencia temporal de acciones
- Si hubo requests previos exitosos al mismo endpoint

### Fase 4 — Base de datos de produccion

Construir queries SELECT basandote en lo encontrado en Fases 2-3.

**Paso 4a: Consultar la entidad principal**

- Si el error dice "X not found", verificar si el ID existe en la tabla
- Usar `information_schema.columns` si no conoces la estructura de la tabla:
  ```sql
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'NombreTabla' ORDER BY ordinal_position;
  ```

**Paso 4b: Verificar relaciones cascade**

- Si la entidad no existe, revisar en `prisma/schema.prisma` las relaciones con `onDelete: Cascade`
- Verificar si el parent (Payment, Venue, etc.) fue eliminado

**Paso 4c: ActivityLog**

```sql
SELECT id, action, entity, "entityId", "staffId", "venueId", "createdAt"
FROM "ActivityLog"
WHERE "entityId" = '<ID>'
   OR ("createdAt" BETWEEN '<TIMESTAMP - 5min>' AND '<TIMESTAMP + 5min>'
       AND entity ILIKE '%<ENTITY_NAME>%')
ORDER BY "createdAt" DESC
LIMIT 20;
```

**Paso 4d: Contexto adicional**

- Identificar al staff: `SELECT "firstName", "lastName", email FROM "Staff" WHERE id = '<userId>'`
- Identificar el venue: `SELECT id, name FROM "Venue" WHERE id = '<venueId>'`
- Cualquier tabla relevante segun el contexto del error

### Fase 5 — Reconstruir timeline y diagnostico

Compilar TODA la evidencia en un reporte estructurado:

```
## Reporte de Investigacion

**Quien:** [nombre staff] ([email], role [ROLE]) desde [userAgent resumido].

**Que hizo:** [Secuencia de acciones con timestamps en tabla]

| Hora (UTC) | Request | Detalle | Status |
|---|---|---|---|
| HH:MM:SS | METHOD /endpoint | contexto | 200/404/500 |

**Que fallo:** [El request especifico y su respuesta]

**Por que:** [Causa raiz basada en evidencia — referenciar archivo:linea del codigo]

**Impacto:** [Que vio el usuario, si hay datos afectados, si es aislado o recurrente]

**Requiere fix?** [Si/No + explicacion]
- Error esperado (race condition, dato stale, user error) → No
- Bug real (logica incorrecta, validacion faltante) → Si + describir que arreglar
```

## Notas operativas

- Correr Fase 2, 3 y 4 en **paralelo** siempre que sea posible
- Si el error es generico ("Internal server error"), buscar por correlationId en BetterStack
- Si no hay correlationId, buscar por timestamp + endpoint exacto
- Para errores recurrentes, ampliar ventana de BetterStack y hacer `GROUP BY _pattern`
- El reporte debe ser en **espanol**
