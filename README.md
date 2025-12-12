# Avoqado Backend Server

Backend para Avoqado, una plataforma tecnológica integral multi-sector para la gestión y operación de negocios (restaurantes, hoteles, gimnasios, retail, servicios, entretenimiento y más). Este servidor maneja la lógica de
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

## 🚀 Instalación Rápida con Docker (Recomendado)

### Requisitos Previos

- [Docker](https://www.docker.com/get-started)
- [Git](https://git-scm.com/)

### Instalación en Cualquier Plataforma (Windows/macOS/Linux)

1. **Clona el repositorio:**

   ```bash
   git clone https://github.com/TU_USUARIO/avoqado-server.git
   cd avoqado-server
   ```

2. **Inicia todos los servicios con Docker:**

   ```bash
   # Para desarrollo (con hot reload)
   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

   # Para producción
   docker compose up -d
   ```

3. **Ejecuta las migraciones de base de datos:**

   ```bash
   docker exec avoqado-server-dev npx prisma migrate deploy
   ```

4. **¡Listo! La aplicación está corriendo en:**
   - **API:** http://localhost:3000
   - **RabbitMQ Management:** http://localhost:15672 (usuario: `avoqado_user`, contraseña: `avoqado_password`)
   - **PostgreSQL:** localhost:5434
   - **Redis:** localhost:6379

### Comandos Útiles de Docker

```bash
# Ver logs de la aplicación
docker compose logs app -f

# Ver estado de todos los servicios
docker compose ps

# Parar todos los servicios
docker compose down

# Parar y eliminar volúmenes (reinicio completo)
docker compose down -v

# Acceder al contenedor de la aplicación
docker exec -it avoqado-server-dev bash

# Ver logs de un servicio específico
docker compose logs postgres
docker compose logs redis
docker compose logs rabbitmq
```

## ⚙️ Instalación Manual (Sin Docker)

### Requisitos Previos

- Node.js (v20.x o superior recomendado)
- npm o yarn
- PostgreSQL (servidor local o en la nube)
- Redis (servidor local o en la nube)
- RabbitMQ (servidor local o en la nube)
- PM2 instalado globalmente: `npm install pm2 -g`

### Pasos de Instalación

1. **Clona el repositorio:**

   ```bash
   git clone https://github.com/TU_USUARIO/avoqado-server.git
   cd avoqado-server
   ```

2. **Instala las dependencias:**

   ```bash
   npm install
   ```

3. **Configura las variables de entorno:** Crea un archivo `.env` basado en `.env.example`:

   ```bash
   cp .env.example .env
   ```

   Edita el archivo `.env` con tus configuraciones:

   ```env
   # Base de datos
   DATABASE_URL=postgresql://usuario:contraseña@localhost:5432/avoqado_db

   # Redis
   REDIS_URL=redis://localhost:6379

   # RabbitMQ
   RABBITMQ_URL=amqp://usuario:contraseña@localhost:5672

   # Autenticación
   JWT_SECRET=tu_jwt_secret_muy_seguro
   SESSION_SECRET=tu_session_secret_muy_seguro

   # Aplicación
   NODE_ENV=development
   PORT=3000
   ```

4. **Ejecuta las migraciones de base de datos:**

   ```bash
   npx prisma migrate dev
   ```

5. **(Opcional) Pobla la base de datos con datos iniciales:**
   ```bash
   npx prisma db seed
   ```

## ▶️ Ejecutar la Aplicación (Instalación Manual)

### Modo Desarrollo

```bash
npm run dev
```

La aplicación estará disponible en `http://localhost:3000`.

### Modo Producción

1. **Compila el código TypeScript:**

   ```bash
   npm run build
   ```

2. **Inicia con PM2:**

   ```bash
   npm run start
   ```

3. **Comandos útiles de PM2:**
   ```bash
   pm2 logs        # Ver logs
   pm2 monit       # Monitorear
   pm2 stop all    # Parar todos los procesos
   pm2 restart all # Reiniciar todos los procesos
   ```

## 🪟 Instrucciones Específicas para Windows

### Opción 1: Docker (Recomendado para Windows)

1. **Instala Docker Desktop para Windows:**

   - Descarga desde: https://www.docker.com/products/docker-desktop
   - Asegúrate de habilitar WSL 2 si se solicita

2. **Instala Git para Windows:**

   - Descarga desde: https://git-scm.com/download/win

3. **Abre PowerShell o Command Prompt y sigue los pasos de Docker arriba**

### Opción 2: Instalación Manual en Windows

1. **Instala Node.js:**

   - Descarga el instalador desde: https://nodejs.org/
   - Versión recomendada: 20.x LTS

2. **Instala PostgreSQL:**

   - Descarga desde: https://www.postgresql.org/download/windows/
   - Durante la instalación, recuerda tu usuario y contraseña

3. **Instala Redis (usando Chocolatey o descarga manual):**

   ```powershell
   # Con Chocolatey
   choco install redis-64

   # O descarga desde: https://github.com/microsoftarchive/redis/releases
   ```

4. **Instala RabbitMQ:**

   - Descarga desde: https://www.rabbitmq.com/install-windows.html
   - Requiere Erlang/OTP (se instala automáticamente)

5. **Sigue los pasos de instalación manual descritos arriba**

### Solución de Problemas en Windows

- Si tienes problemas con permisos, ejecuta PowerShell como Administrador
- Si npm install falla, intenta: `npm install --force`
- Para problemas con Python/C++ building tools: `npm install --global windows-build-tools`

## 🐳 Arquitectura de Servicios Docker

La configuración de Docker incluye los siguientes servicios:

| Servicio               | Puerto      | Descripción                                     |
| ---------------------- | ----------- | ----------------------------------------------- |
| **avoqado-server-dev** | 3000        | Aplicación Node.js (desarrollo con hot reload)  |
| **avoqado-postgres**   | 5434        | Base de datos PostgreSQL                        |
| **avoqado-redis**      | 6379        | Cache Redis                                     |
| **avoqado-rabbitmq**   | 5672, 15672 | Message broker (puerto 15672 para interfaz web) |

### Credenciales por Defecto (Solo Desarrollo)

- **PostgreSQL**: usuario `avoqado_user`, contraseña `avoqado_password`, base de datos `avoqado_db`
- **RabbitMQ**: usuario `avoqado_user`, contraseña `avoqado_password`
- **Redis**: Sin autenticación

## 🧪 Ejecutar Pruebas

### Con Docker

```bash
# Ejecutar todas las pruebas en el contenedor
docker exec avoqado-server-dev npm test

# Ejecutar pruebas específicas
docker exec avoqado-server-dev npm run test:unit
docker exec avoqado-server-dev npm run test:api
docker exec avoqado-server-dev npm run test:coverage
```

### Sin Docker

```bash
npm test                    # Todas las pruebas
npm run test:unit          # Pruebas unitarias
npm run test:api           # Pruebas de API
npm run test:coverage      # Con cobertura de código
npm run test:watch         # Modo watch
```

## 🔧 Configuración Avanzada

### Variables de Entorno Importantes

```env
# Configuración de la aplicación
NODE_ENV=development|production
PORT=3000
LOG_LEVEL=debug|info|warn|error

# Base de datos
DATABASE_URL=postgresql://user:password@host:port/database

# Servicios externos
REDIS_URL=redis://host:port
RABBITMQ_URL=amqp://user:password@host:port

# Seguridad
JWT_SECRET=tu_secreto_jwt_muy_seguro
SESSION_SECRET=tu_secreto_session_muy_seguro
```

### Desarrollo Local vs Docker

| Aspecto              | Desarrollo Local                  | Docker                               |
| -------------------- | --------------------------------- | ------------------------------------ |
| **Instalación**      | Compleja (múltiples dependencias) | Simple (solo Docker)                 |
| **Tiempo de setup**  | 30-60 minutos                     | 5-10 minutos                         |
| **Aislamiento**      | No                                | Sí                                   |
| **Portabilidad**     | Dependiente del SO                | Independiente del SO                 |
| **Performance**      | Nativa                            | Ligeramente menor                    |
| **Recomendado para** | Desarrollo intensivo              | Setup rápido, nuevos desarrolladores |

## 🚨 Solución de Problemas Comunes

### Docker

```bash
# Error de puertos ocupados
docker compose down
# Cambiar puertos en docker-compose.yml si es necesario

# Problemas de permisos en volúmenes
docker compose down -v
docker compose up -d

# Ver logs detallados
docker compose logs -f [service_name]

# Limpiar todo Docker
docker system prune -a --volumes
```

### Base de Datos

```bash
# Resetear base de datos
docker exec avoqado-server-dev npx prisma migrate reset

# Ver estado de migraciones
docker exec avoqado-server-dev npx prisma migrate status

# Generar cliente Prisma
docker exec avoqado-server-dev npx prisma generate
```
