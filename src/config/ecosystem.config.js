module.exports = {
  apps: [
    {
      name: 'avoqado-backend', // 1. Nombre de la aplicación
      script: './dist/server.js', // 2a. Ruta al script JS compilado (producción)
      // --- Opcional: Configuración para ejecutar directamente con ts-node (más para desarrollo) ---
      // script: 'ts-node',          // 2b. Comando para ejecutar ts-node
      // args: './src/server.ts',    // 2b. Argumento para ts-node: el script TS principal
      // interpreter_args: '-r tsconfig-paths/register', // Opcional: si usas alias de paths en tsconfig

      instances: 'max', // 3. Número de instancias: 'max' usa todos los núcleos disponibles (modo cluster).
      //    También puedes usar un número fijo, ej: 2.
      //    'max' (o cualquier número > 1) activa el modo cluster de PM2,
      //    lo que permite a Node.js manejar múltiples conexiones concurrentemente
      //    distribuyendo la carga entre los procesos worker.
      //    Usa 'max' para producción para aprovechar todos los núcleos.
      //    Usa 1 (o 'fork' mode implícito) si tu app no está diseñada para cluster
      //    o para desarrollo/debugging más simple.

      exec_mode: 'cluster', // Necesario para 'instances' > 1 o 'max'. El modo 'fork' es el default si instances = 1.

      autorestart: true, // 6. Reinicio automático: true para reiniciar la app si crashea.
      watch: false, // 7. Monitoreo de cambios: false para producción.
      //    Poner a 'true' (o un array de paths) reinicia la app al detectar cambios.
      //    Útil en desarrollo, pero no recomendado en producción por reinicios inesperados.
      //    Para producción, es mejor un pipeline de CI/CD para desplegar cambios.

      max_memory_restart: '1G', // Opcional: Reinicia la app si excede esta cantidad de RAM.

      env: {
        // Variables de entorno comunes a todos los ambientes (si no se especifica env_production, etc.)
        NODE_ENV: 'development', // Por defecto a development si no se especifica otro env_*
      },
      env_production: {
        // 4. Variables de entorno específicas para PM2 en producción
        NODE_ENV: 'production',
        // Aquí puedes añadir otras variables de entorno necesarias para producción:
        // PORT: 3000,
        // DATABASE_URL: 'tu_url_de_produccion',
        // ACCESS_TOKEN_SECRET: 'tu_secreto_jwt_de_produccion',
        // COOKIE_SECRET: 'tu_secreto_de_cookie_de_produccion',
        // LOG_LEVEL: 'info',
        // LOG_DIR: '/var/log/avoqado-backend' // Asegúrate que PM2 tenga permisos de escritura
      },
      // env_staging: { ... } // Puedes añadir otros entornos

      // 5. Opciones para el manejo de logs de PM2
      // PM2 fusionará los logs de stdout y stderr de tu aplicación.
      // Por defecto, los guarda en ~/.pm2/logs/
      // Puedes especificar rutas personalizadas:
      out_file: './logs/avoqado-backend-out.log', // Ruta para logs de salida estándar
      error_file: './logs/avoqado-backend-error.log', // Ruta para logs de error
      merge_logs: true, // Fusiona logs de todas las instancias en un solo archivo por tipo (out/error)
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z', // Formato de fecha para los logs de PM2
    },
    // Puedes añadir más aplicaciones aquí si es necesario
    // {
    //   name: 'otra-app',
    //   script: './otra-app/server.js',
    //   ...
    // }
  ],

  // Opcional: Sección de despliegue (para usar PM2 deploy)
  // deploy: {
  //   production: {
  //     user: 'node_user',
  //     host: 'tu_servidor_ip',
  //     ref: 'origin/main', // Rama de git
  //     repo: 'git@github.com:tu_usuario/tu_repo.git', // URL del repositorio
  //     path: '/var/www/avoqado-backend', // Ruta en el servidor donde se desplegará
  //     'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
  //     env: {
  //       NODE_ENV: 'production'
  //     }
  //   }
  // }
}
