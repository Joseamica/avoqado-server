# Deploy: Merge develop → main

Merge directo de `develop` hacia `main` en AMBOS repositorios, luego push a remote. Sin verificaciones pre-deploy (usa `/safe-deploy` si
quieres correr pre-deploy primero).

## Repositorios

- **Dashboard**: `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`
- **Server**: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server`

## Instrucciones

### Fase 1: Verificar estado de git

Para CADA repo, asegurar que estamos en develop y al día:

```bash
git checkout develop
git pull origin develop
```

Luego verificar divergencia:

```bash
git fetch origin
git log --oneline origin/main..origin/develop  # commits nuevos en develop
git log --oneline origin/develop..origin/main  # commits que main tiene y develop no
```

Mostrar al usuario un resumen claro:

```
📊 Estado:
  Server:    develop tiene 3 commits nuevos, main al día ✅
  Dashboard: develop tiene 5 commits nuevos, main al día ✅
```

### Fase 2: Analizar escenarios

**Escenario A - Normal (main detrás de develop):**

- `origin/main..origin/develop` muestra commits → hay cambios que mergear
- `origin/develop..origin/main` vacío → main no tiene nada extra
- Acción: fast-forward merge directo → continuar a Fase 3

**Escenario B - Main está adelante (divergencia):**

- `origin/develop..origin/main` muestra commits → main tiene cambios que develop no
- DETENERSE y ADVERTIR al usuario
- Mostrar exactamente qué commits tiene main que develop no
- Opciones:
  1. Merge main → develop primero, resolver conflictos, luego volver a intentar
  2. Si los commits en main son erróneos, preguntar si forzar (el usuario decide)
- NUNCA hacer force push sin confirmación explícita

**Escenario C - Ya sincronizados:**

- Ambos logs vacíos → informar que ya están al día
- No hacer nada

### Fase 3: Ejecutar merge (por cada repo)

```bash
git checkout main
git pull origin main
git merge develop --ff-only
```

Si `--ff-only` falla → DETENERSE, informar al usuario.

### Fase 4: Push a remote

```bash
git push origin main
```

### Fase 5: Volver a develop

```bash
git checkout develop
```

### Fase 6: Reporte final

```
✅ Deploy completado:
  Server:    3 commits mergeados y pusheados a main
  Dashboard: 5 commits mergeados y pusheados a main

Ambos repos en rama develop.
```

## Reglas estrictas

- NUNCA crear Pull Requests - merge directo
- NUNCA hacer force push sin permiso explícito
- Siempre intentar fast-forward primero
- Si hay conflictos, mostrarlos y esperar instrucciones
- Siempre hacer fetch antes de cualquier operación
- Siempre volver a develop al terminar
