# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build and Development
- `npm run build` - Compile TypeScript to `dist/` directory using tsc and tsc-alias
- `npm run dev` - Start development server with hot reload using nodemon and pino-pretty logging
- `npm start` - Start production server from compiled JavaScript in dist/

### Database Operations
- `npm run migrate` - Run Prisma database migrations (`prisma migrate dev`)
- `npm run studio` - Launch Prisma Studio for database exploration

### Testing
- `npm test` - Run all tests with Jest
- `npm run test:unit` - Run only unit tests (`tests/unit`)
- `npm run test:api` - Run only API integration tests (`tests/api-tests`)
- `npm run test:workflows` - Run workflow tests (`tests/workflows`)
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage reports
- `npm run test:ci` - Run tests in CI mode (no watch, with coverage)

### Module-Specific Testing
- `npm run test:dashboard` - Test dashboard functionality
- `npm run test:pos-sync` - Test POS synchronization features
- `npm run test:tpv` - Test TPV (Terminal Portátil de Ventas) functionality
- `npm run test:orders` - Test order management
- `npm run test:auth` - Test authentication workflows
- `npm run test:communication` - Test socket and RabbitMQ communication

### Code Quality
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint:fix` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier

## Architecture Overview

This is a restaurant management platform backend with multi-tenant architecture supporting:

### Core Business Domains
- **Organizations** - Multi-tenant root entities
- **Venues** - Individual restaurant locations
- **Staff Management** - Role-based access control (ADMIN, MANAGER, CASHIER, VIEWER)
- **Menu & Product Management** - Menu categories, products, and pricing
- **Order Processing** - Order lifecycle management
- **POS Integration** - Real-time synchronization with Point-of-Sale systems
- **Payment Processing** - Transaction and payment management

### Technical Stack
- **Framework**: Express.js with TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Real-time Communication**: Socket.IO for live updates
- **Message Queue**: RabbitMQ for POS command processing
- **Session Management**: Redis-backed sessions
- **Authentication**: JWT with refresh tokens
- **Validation**: Zod schemas
- **Testing**: Jest with comprehensive unit, API, and workflow tests

### Layered Architecture
The codebase follows a clean layered architecture:
```
Routes → Middleware → Controllers → Services → Prisma (Database)
```

- **Routes** (`/src/routes/`) - HTTP endpoint definitions with middleware chains
- **Controllers** (`/src/controllers/`) - HTTP request orchestration (thin layer)
- **Services** (`/src/services/`) - Business logic implementation (core layer)
- **Middlewares** (`/src/middlewares/`) - Cross-cutting concerns (auth, validation, logging)
- **Schemas** (`/src/schemas/`) - Zod validation schemas and TypeScript types

### Key Service Areas
- **Dashboard Services** (`/src/services/dashboard/`) - Admin interface logic
- **TPV Services** (`/src/services/tpv/`) - Point-of-sale terminal operations
- **POS Sync Services** (`/src/services/pos-sync/`) - External POS system integration
- **Communication** (`/src/communication/`) - Socket.IO and RabbitMQ handlers

### Database Schema
Multi-tenant PostgreSQL schema managed by Prisma:
- Organization → Venue hierarchy
- Staff with venue-specific roles
- Product catalog with categories
- Order management with items and payments
- POS synchronization tracking

### Real-time Features
- Socket.IO server for live updates (`/src/communication/sockets/`)
- Room-based broadcasting for venue-specific events
- Business event controllers for order/payment notifications

### Message Processing
- RabbitMQ integration for POS command queuing
- Command listener for database-triggered events
- Retry service for failed command processing
- Event consumer for external POS system events

## Docker Environment

The project includes comprehensive Docker setup:
- Development: `docker-compose -f docker-compose.yml -f docker-compose.dev.yml up -d`
- Production: `docker-compose up -d`
- Database migrations in container: `docker exec avoqado-server-dev npx prisma migrate deploy`

Services:
- **avoqado-server-dev** (port 3000) - Main application
- **avoqado-postgres** (port 5434) - PostgreSQL database  
- **avoqado-redis** (port 6379) - Session storage
- **avoqado-rabbitmq** (ports 5672, 15672) - Message broker

## Testing Strategy

Comprehensive test suite organized by type:
- **Unit Tests** (`tests/unit/`) - Service and utility function testing
- **API Tests** (`tests/api-tests/`) - HTTP endpoint integration testing  
- **Workflow Tests** (`tests/workflows/`) - End-to-end business process testing

Test configuration includes coverage thresholds (70% global, 80% for critical services) and project-based Jest setup for parallel execution.

## Development Notes

- The server includes graceful shutdown handling for all services (HTTP, Socket.IO, RabbitMQ, database connections)
- Development mode provides JWT token generation endpoint: `POST /api/dev/generate-token`
- Swagger documentation available at `/api-docs`
- Winston logging with correlation IDs for request tracing
- Multi-environment configuration via environment variables