# Gemini Code Assistant Context

This document provides context for the Gemini Code Assistant to understand the Avoqado backend server project.

## Project Overview

This is the backend server for Avoqado, a comprehensive technology platform for restaurant management. It's a Node.js/TypeScript application
built with Express.js, Prisma, and PostgreSQL.

The server exposes a RESTful API that handles business logic, authentication, database interactions, and real-time communication for various
Avoqado interfaces, including the admin dashboard, a portable terminal (TPV), and a mobile web platform for customers.

### Key Technologies

- **Language:** TypeScript
- **Framework:** Node.js with Express.js
- **ORM:** Prisma
- **Database:** PostgreSQL
- **Authentication:** JSON Web Tokens (JWT)
- **Real-time Communication:** Socket.IO
- **Deployment:** Docker, Fly.io (demo), Render (staging, production)
- **Testing:** Jest (unit, API, workflow, integration)
- **Linting:** ESLint with Prettier

### Architecture

The application follows a standard layered architecture:

- **Controllers:** Handle incoming HTTP requests, validate data using Zod schemas, and delegate business logic to services.
- **Services:** Contain the core business logic, interacting with the database through the Prisma client.
- **Routes:** Define the API endpoints and are organized by feature/module.
- **Middleware:** Used for core functionalities like authentication, logging, and error handling.

The project is structured as a multi-tenant application, with `Organization` and `Venue` as the core entities.

## Building and Running

### Development (Docker Recommended)

1.  **Start all services:**
    ```bash
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
    ```
2.  **Run database migrations:**
    ```bash
    docker exec avoqado-server-dev npx prisma migrate deploy
    ```
3.  The API will be available at `http://localhost:3000`.

### Development (Manual)

1.  **Install dependencies:**
    ```bash
    npm install
    ```
2.  **Set up `.env` file:** Copy `.env.example` to `.env` and fill in the required variables.
3.  **Run migrations:**
    ```bash
    npx prisma migrate dev
    ```
4.  **Start the server:**
    ```bash
    npm run dev
    ```

### Production

The application is deployed using Docker containers on Fly.io (for demo) and Render (for staging and production). The deployments are
triggered by a CI/CD pipeline.

The production build is created with `npm run build` and the application is started with `npm start`.

## Development Conventions

- **Code Style:** The project uses ESLint and Prettier to enforce a consistent code style. Linting can be run with `npm run lint`.
- **Testing:** The project has a comprehensive test suite using Jest. Tests are organized by type (unit, API, workflow, integration) and can
  be run with the following commands:
  - `npm test`: Run all tests.
  - `npm run test:unit`: Run unit tests.
  - `npm run test:api`: Run API tests.
  - `npm run test:workflows`: Run workflow tests.
  - `npm run test:integration`: Run integration tests.
  - `npm run test:coverage`: Generate a coverage report.
- **Commits:** (Inferring from the presence of `CHANGELOG.md`) The project likely follows a conventional commit format.
- **Branching:** (Inferring from `render.yaml`) The `develop` branch is used for staging, and the `main` branch is used for production.
