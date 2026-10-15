// Integración en paralelo en el CI (14-oct-2026): con CI_DB_POR_PROCESO=1, cada proceso de Jest usa su propia copia de la
// base desechable del CI (`<nombre>_<JEST_WORKER_ID>`, creada con TEMPLATE en ci-cd.yml), así dos archivos nunca se pisan
// los datos. Corre antes que integration-setup.ts, cuya guarda sigue revisando la URL final.
// Sin la variable (la Mac, cualquier otra corrida) no hace nada: la integración usa la base de siempre.
const proceso = process.env.JEST_WORKER_ID
if (process.env.CI_DB_POR_PROCESO === '1' && proceso) {
  for (const llave of ['TEST_DATABASE_URL', 'DATABASE_URL'] as const) {
    const valor = process.env[llave]
    if (valor) {
      const url = new URL(valor)
      url.pathname = `${url.pathname}_${proceso}`
      process.env[llave] = url.toString()
    }
  }
}
