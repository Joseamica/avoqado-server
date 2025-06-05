# Avoqado Backend Server

Backend para Avoqado, una plataforma tecnológica integral para la gestión y operación de restaurantes. Este servidor maneja la lógica de
negocio, la autenticación, la interacción con la base de datos y la comunicación en tiempo real para las diferentes interfaces de Avoqado,
incluyendo el Dashboard de Administración, la Terminal Portátil (TPV) para el personal y la Plataforma Web Móvil para Clientes (QR).

## ✨ Características Principales (Backend)

- API RESTful robusta (con potencial para GraphQL).
- Autenticación y autorización basadas en JWT (tokens de acceso y refresco).
- Gestión de sesiones persistentes (usando PostgreSQL).
- Validación de entradas con Zod.
- Soporte para operaciones multi-tenant (Organización -> Venue).
- Gestión de roles y permisos para el personal (`Staff`).
- Integración con Prisma ORM para PostgreSQL.
- Manejo estructurado de logs con Winston.
- Preparado para comunicación en tiempo real con Socket.IO.
- Preparado para mensajería asíncrona con RabbitMQ.
- Documentación de API con Swagger/OpenAPI.
- Manejo de procesos en producción con PM2.
- Cobertura de pruebas de integración con Jest y Supertest.

## 🛠️ Stack Tecnológico

- **Lenguaje:** TypeScript
- **Framework:** Node.js con Express.js
- **ORM:** Prisma
- **Base de Datos:** PostgreSQL
- **Autenticación:** JSON Web Tokens (JWT)
- **Validación:** Zod
- **Logging:** Winston
- **Gestión de Sesiones:** `express-session` con `connect-pg-simple`
- **Tiempo Real (Planeado/Integrado):** Socket.IO
- **Mensajería Asíncrona (Planeado/Integrado):** RabbitMQ
- **Gestor de Procesos (Producción):** PM2
- **Testing:** Jest & Supertest
- **Documentación API:** Swagger/OpenAPI

## 🚀 Requisitos Previos

- Node.js (v18.x o superior recomendado)
- npm o yarn
- PostgreSQL (servidor local o en la nube)
- RabbitMQ (servidor local o en la nube, si se usa la funcionalidad de mensajería)
- PM2 instalado globalmente (para ejecución en modo producción): `npm install pm2 -g`

## ⚙️ Instalación y Configuración Local

1.  **Clona el repositorio (si aplica):**

    ```bash
    git clone [https://github.com/TU_USUARIO/avoqado-server.git](https://github.com/TU_USUARIO/avoqado-server.git)
    cd avoqado-server
    ```

2.  **Instala las dependencias:**

    ```bash
    npm install
    # o
    yarn install
    ```

3.  **Configura las Variables de Entorno:** Crea un archivo `.env` en la raíz del proyecto. Puedes copiar `env.example` (si lo creas) o
    basarte en la siguiente plantilla:

    ```env
    # Aplicación
    NODE_ENV=development
    PORT=3000
    API_PREFIX=/api/v1

    # Base de Datos (Prisma)
    DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE_NAME?schema=public"

    # JWT Secrets (¡Usa valores largos, aleatorios y diferentes!)
    ACCESS_TOKEN_SECRET="TU_SECRETO_PARA_TOKEN_DE_ACCESO_MUY_SEGURO"
    REFRESH_TOKEN_SECRET="TU_OTRO_SECRETO_PARA_TOKEN_DE_REFRESCO_MUY_SEGURO"
    ACCESS_TOKEN_EXPIRATION="15m" # ej. 15 minutos
    REFRESH_TOKEN_EXPIRATION="7d" # ej. 7 días

    # Session & Cookie Secrets
    SESSION_SECRET="TU_SECRETO_PARA_SESIONES_MUY_SEGURO"
    COOKIE_SECRET="TU_SECRETO_PARA_COOKIES_FIRMADAS_MUY_SEGURO" # Puede ser el mismo que SESSION_SECRET si solo firmas cookies de sesión
    SESSION_COOKIE_NAME="avoqado.sid"
    SESSION_MAX_AGE_MS="86400000" # ej. 1 día en milisegundos

    # CORS (ejemplo, ajusta a tus necesidades)
    CORS_ALLOWED_ORIGINS="http://localhost:3001,http://localhost:3002,[https://dashboard.avoqado.app](https://dashboard.avoqado.app),[https://qr.avoqado.app](https://qr.avoqado.app)"

    # Logging
    LOG_LEVEL="debug" # O 'info', 'warn', 'error'

    # RabbitMQ (si se usa)
    # RABBITMQ_URL="amqp://user:password@localhost:5672"

    # Límites para Body Parser
    BODY_JSON_LIMIT="1mb"
    BODY_URLENCODED_LIMIT="5mb"
    ```

4.  **Configura la Base de Datos con Prisma:** Ejecuta las migraciones para crear el schema en tu base de datos PostgreSQL.
    ```bash
    npx prisma migrate dev
    ```
    (Opcional) Si tienes un script de seed para poblar datos iniciales:
    ```bash
    npx prisma db seed
    ```

## ▶️ Ejecutar la Aplicación

- **Modo Desarrollo (con `nodemon` y `ts-node` para recarga automática):**

  ```bash
  npm run start:dev
  # o
  yarn start:dev
  ```

  La aplicación estará disponible (por defecto) en `http://localhost:3000`.

- **Modo Producción (con PM2):** Primero, compila el código TypeScript a JavaScript:
  ```bash
  npm run build
  # o
  yarn build
  ```
  Luego, inicia la aplicación con PM2 usando tu `ecosystem.config.js`:
  ```bash
  npm run start:prod
  # o
  yarn start:prod
  ```
  Para ver los logs de PM2: `pm2 logs` Para monitorear: `pm2 monit`

## 🧪 Ejecutar Pruebas

Para ejecutar las pruebas de integración y unitarias configuradas con Jest:

```bash
npm test
# o
yarn test
```
