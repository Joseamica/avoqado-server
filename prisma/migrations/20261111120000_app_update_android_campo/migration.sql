-- App de campo, bloque 3: carril propio de versiones para la app del promotor (`:campo`).
-- El valor nuevo no se usa dentro de esta migración (Postgres no deja usar un ADD VALUE antes del commit).
ALTER TYPE "AppPlatform" ADD VALUE 'ANDROID_CAMPO';

-- La llave única ahora incluye la plataforma: el índice anterior ya garantizaba (versionCode, environment) único, así que
-- todas las filas existentes cumplen la nueva.
DROP INDEX "AppUpdate_versionCode_environment_key";
CREATE UNIQUE INDEX "AppUpdate_versionCode_environment_platform_key" ON "AppUpdate"("versionCode", "environment", "platform");
