# 🔍 Detección de Código No Utilizado

Este proyecto incluye herramientas para detectar código no utilizado de manera **informativa** (no eliminan nada automáticamente).

## 📦 Herramientas Instaladas

### 1. **unimported**
- Detecta archivos que no son importados por ningún otro archivo
- Identifica dependencias npm no utilizadas
- Rápido y simple

### 2. **knip**
- Análisis profundo de "dead code"
- Detecta exports no utilizados
- Identifica tipos TypeScript no usados
- Encuentra dependencias duplicadas
- Más completo pero más lento

## 🚀 Comandos Disponibles

```bash
# Detectar archivos no importados (rápido)
npm run check:unused

# Análisis completo de dead code (detallado)
npm run check:dead-code

# Ejecutar ambos análisis
npm run check:all

# Auto-actualizar lista de archivos pendientes (nuevo)
npm run update:unused-ignore
```

## 🔖 Sistema de Marcador @pending-implementation

**Propósito**: Marcar archivos completamente implementados pero que aún no están integrados en la aplicación.

### ¿Cuándo usarlo?

Usa el marcador `@pending-implementation` cuando:
- ✅ El archivo está completamente implementado y probado
- ✅ Se integrará pronto pero no inmediatamente
- ✅ Quieres excluirlo de la detección de código no utilizado
- ✅ Quieres documentar el estado de implementación para futuros desarrolladores

### Formato del marcador

```typescript
/**
 * @pending-implementation
 * [Nombre de la característica]
 *
 * STATUS: Implementado pero no aplicado a [dónde se usará].
 * Este [tipo de archivo] está listo para usar pero no se ha [acción de integración] aún.
 * Se aplicará gradualmente a [ubicaciones objetivo].
 *
 * Usage:
 * [Ejemplo de uso]
 */
```

### Ejemplo real

```typescript
/**
 * @pending-implementation
 * Feature Access Control Middleware
 *
 * STATUS: Implemented but not yet applied to routes.
 * This middleware is ready to use but hasn't been added to route definitions yet.
 * It will be gradually applied to premium/paid feature endpoints.
 *
 * Usage:
 * router.get('/analytics', authenticateTokenMiddleware, checkFeatureAccess('ANALYTICS'), ...)
 */
export function checkFeatureAccess(featureCode: string) {
  // ... implementation
}
```

### Cómo funciona

1. **Agrega el marcador** en los primeros 500 caracteres del archivo
2. **Ejecuta el script** de actualización:
   ```bash
   npm run update:unused-ignore
   ```
3. **El script automáticamente**:
   - Escanea `src/` buscando archivos con `@pending-implementation`
   - Actualiza `.unimportedrc.json` agregándolos a `ignoreUnimported`
   - Preserva otros archivos ignorados (`.d.ts`, `ecosystem.config.js`, etc.)

4. **Cuando integres el archivo**:
   - Elimina el marcador `@pending-implementation`
   - Ejecuta `npm run update:unused-ignore` nuevamente
   - El archivo se removerá automáticamente de la lista de ignorados

### Archivos actualmente pendientes

```bash
# Ver archivos marcados como pendientes
npm run update:unused-ignore
# Output mostrará: "📝 Found X files with @pending-implementation:"
```

### ⚠️ Importante

- El marcador es para archivos **LISTOS para usar**, no para código incompleto
- El marcador debe estar en los primeros 500 caracteres del archivo
- Ejecuta `npm run update:unused-ignore` después de agregar o remover marcadores
- El script es seguro: preserva configuraciones existentes de `.unimportedrc.json`

## ⚙️ Archivos de Configuración

- **`.unimportedrc.json`**: Configuración para unimported
- **`knip.json`**: Configuración para knip

## 📊 Qué Detectan

### Archivos No Utilizados
Archivos `.ts` que no son importados por ningún otro archivo en el proyecto.

**Ejemplo de output:**
```
─────┬────────────────────────────────────────────────────
     │ 9 unimported files
─────┼────────────────────────────────────────────────────
   1 │ src/routes/organization.routes.ts
   2 │ src/services/cleanup/liveDemoCleanup.service.ts
   3 │ src/utils/unitConversion.ts
```

### Dependencias No Utilizadas
Paquetes npm instalados que no se usan en ningún archivo.

**Ejemplo de output:**
```
─────┬────────────────────────────────────────────────────
     │ 10 unused dependencies
─────┼────────────────────────────────────────────────────
   1 │ axios
   2 │ handlebars
   3 │ pm2
```

### Exports No Utilizados
Funciones o tipos exportados que no son importados en ningún lugar.

**Ejemplo de output:**
```
Unused exports (86)
getSocketManager           function  src/communication/sockets/index.ts:120:17
ConflictError              class     src/errors/AppError.ts:38:14
```

## ⚠️ Importante: Solo Informativo

Estas herramientas **NO ELIMINAN CÓDIGO AUTOMÁTICAMENTE**. Solo te muestran un reporte.

Tú decides:
- ✅ Qué archivos eliminar
- ✅ Qué dependencias desinstalar
- ✅ Qué exports limpiar

## 🔄 Cuándo Ejecutar

Se recomienda ejecutar periódicamente:
- 📅 Mensualmente
- 🚀 Antes de releases importantes
- 🧹 Durante sesiones de limpieza de código
- 📦 Al reducir el tamaño del bundle

## ❓ Falsos Positivos

Algunos archivos marcados como "no usados" pueden ser:

1. **Scripts manuales**: Archivos que se ejecutan directamente
2. **Entry points alternativos**: Puntos de entrada no configurados
3. **Código preparado**: Features futuras ya implementadas
4. **Archivos de tipo**: TypeScript `.d.ts` que extienden tipos

**⚠️ Siempre revisa antes de eliminar**

## 🎯 Uso Recomendado

### Paso 1: Ejecutar análisis
```bash
npm run check:all
```

### Paso 2: Revisar resultados
Analiza la lista de archivos/dependencias marcados como no usados.

### Paso 3: Verificar manualmente
- Busca referencias en comentarios
- Verifica si son entry points
- Comprueba si son features futuras

### Paso 4: Eliminar con confianza
Una vez verificado, elimina:
- Archivos: `git rm src/path/to/unused.ts`
- Dependencias: `npm uninstall package-name`

## 📝 Ejemplo de Flujo de Trabajo

```bash
# 1. Ejecutar análisis
npm run check:unused

# 2. Revisar archivos marcados
# Ejemplo: src/utils/unitConversion.ts

# 3. Buscar si se usa en algún lugar
grep -r "unitConversion" src/

# 4. Si realmente no se usa, eliminar
git rm src/utils/unitConversion.ts

# 5. Commit
git add -A
git commit -m "chore: remove unused unitConversion utility"
```

## 🛠️ Personalizar Configuración

### Ignorar archivos específicos

Edita `.unimportedrc.json`:
```json
{
  "ignoreUnused": [
    "src/scripts/**/*.ts",
    "src/config/**/*.ts"
  ]
}
```

### Ignorar dependencias específicas

Edita `knip.json`:
```json
{
  "ignoreDependencies": [
    "@types/*",
    "typescript"
  ]
}
```

## 📚 Recursos

- [unimported docs](https://github.com/smeijer/unimported)
- [knip docs](https://knip.dev/)

## 💡 Tips

1. **No te agobies**: Es normal tener algunos archivos "no usados"
2. **Prioriza**: Enfócate primero en dependencias npm (reducen bundle size)
3. **Documenta**: Si un archivo parece no usado pero es necesario, agrégalo a `ignoreUnused`
4. **Team review**: Antes de eliminar archivos grandes, consulta con el equipo
