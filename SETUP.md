# 🥑 Avoqado Server - Setup Guide

Complete setup guide for local development. Get up and running in 10 minutes!

---

## 📋 Table of Contents

- [Prerequisites](#-prerequisites)
- [Quick Start (5 minutes)](#-quick-start-5-minutes)
- [Full Setup](#-full-setup)
- [Blumon SDK Setup](#-blumon-sdk-setup)
- [Available Commands](#-available-commands)
- [Troubleshooting](#-troubleshooting)

---

## 🔧 Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** 20.x or later ([Download](https://nodejs.org/))
- **PostgreSQL** 14+ ([Download](https://www.postgresql.org/download/))
- **Redis** (optional, but recommended) ([Download](https://redis.io/download))
- **Git** ([Download](https://git-scm.com/downloads))

### Verify Installation

```bash
node --version  # v20.x.x
npm --version   # 10.x.x
psql --version  # PostgreSQL 14+
redis-cli --version  # redis-cli 7.x.x (optional)
```

---

## ⚡ Quick Start (5 minutes)

Get the server running with minimal configuration:

### 1. Clone & Install

```bash
git clone <repository-url>
cd avoqado-server
npm install
```

### 2. Create PostgreSQL Database

```bash
# Create database
createdb av-db-25

# Or using psql:
psql postgres
CREATE DATABASE "av-db-25";
\q
```

### 3. Setup Environment Variables

```bash
# Copy example file
cp .env.example .env

# Edit .env and set minimum required variables:
# - DATABASE_URL (PostgreSQL connection string)
# - JWT_SECRET (generate with: openssl rand -base64 32)
# - SESSION_SECRET (generate with: openssl rand -base64 32)
```

### 4. Run Migrations & Seed

```bash
# Run database migrations
npm run migrate

# Seed database with sample data
npm run seed
```

### 5. Start Server

```bash
npm run dev
```

🎉 **Server running at**: `http://localhost:12344`

**Test it**:

```bash
curl http://localhost:12344/health
# Response: {"status":"ok"}
```

---

## 🔨 Full Setup

For complete functionality including Blumon payments, Stripe subscriptions, and all features:

### Step 1: Database Setup

```bash
# Create main database
createdb av-db-25

# Optional: Create separate test database
createdb av-db-test
```

### Step 2: Redis Setup (Optional)

**macOS (Homebrew)**:

```bash
brew install redis
brew services start redis
```

**Linux (Ubuntu/Debian)**:

```bash
sudo apt-get install redis-server
sudo systemctl start redis
```

**Verify**:

```bash
redis-cli ping  # Should return: PONG
```

### Step 3: Environment Variables

Copy and configure all required environment variables:

```bash
cp .env.example .env
```

**Edit `.env` and configure**:

#### 🔴 Required (Minimum)

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/av-db-25
JWT_SECRET=$(openssl rand -base64 32)
SESSION_SECRET=$(openssl rand -base64 32)
REDIS_URL=redis://localhost:6379  # If using Redis
```

#### 🟡 Optional (Add as needed)

```env
# OpenAI (for chatbot)
OPENAI_API_KEY=sk-proj-xxxxx

# Stripe (for subscriptions)
STRIPE_SECRET_KEY=sk_test_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx

# Blumon (for payments)
USE_BLUMON_MOCK=true  # Set to false for real API
BLUMON_MASTER_USERNAME=your_email@example.com
BLUMON_MASTER_PASSWORD=your_password

# Email (Resend)
RESEND_API_KEY=re_xxxxx
```

### Step 4: Database Migrations

```bash
# Generate Prisma Client
npx prisma generate

# Run migrations
npm run migrate

# Seed database
npm run seed
```

**Expected output**:

```
✅ Database reset completed successfully
✅ Created 7 global features
✅ Created 300 customers
✅ Created 2 venues (Avoqado Full + Avoqado Empty)
✅ Created 5 sample checkout sessions
🎉 Intelligent Prisma seed completed successfully!
```

### Step 5: Start Development Server

```bash
npm run dev
```

**Server logs**:

```
🚀 Server is running on http://localhost:12344
📊 Swagger docs available at http://localhost:12344/api-docs
🔌 Socket.IO server initialized
✅ PostgreSQL connected
✅ Redis connected
```

---

## 💰 Blumon E-commerce SDK Setup (Web Checkout)

**⚠️ IMPORTANT**: This section is for **Blumon E-commerce Integration (Web Checkout)**.

If you need **Blumon Android SDK (Physical Terminals)**, see `docs/BLUMON_MULTI_MERCHANT_ANALYSIS.md` instead.

### What's the Difference?

- **This setup** → Online payments, web store checkout, `EcommerceMerchant` model
- **Android SDK** → In-person payments, PAX terminals, `MerchantAccount` model
- **Full distinction**: See `docs/BLUMON_TWO_INTEGRATIONS.md`

---

Blumon E-commerce requires OAuth 2.0 authentication for checkout sessions.

### Option 1: Mock Mode (Recommended for Development)

No setup required! Mock mode provides unlimited testing without consuming API limits.

```env
# .env
USE_BLUMON_MOCK=true
```

**Test it**:

```bash
npm run blumon:mock
```

### Option 2: Real Blumon API

#### Step 1: Get Credentials

Contact Blumon sales team (Edgardo) for:

- Master merchant email
- Master merchant password

#### Step 2: Configure

```env
# .env
USE_BLUMON_MOCK=false
BLUMON_MASTER_USERNAME=your_email@example.com
BLUMON_MASTER_PASSWORD=your_password
```

#### Step 3: Authenticate

```bash
npm run blumon:auth
```

**Expected output**:

```
✅ Master merchant authenticated successfully
✅ Access token expires in: 23h 59m
✅ Credentials saved to database
```

#### Step 4: Test Checkout Flow

```bash
# Create a test session
npm run blumon:session

# List active sessions
npm run blumon:sessions

# Open dashboard
npm run dev:dashboard
```

### Blumon CLI Commands (Stripe-style)

```bash
npm run blumon:help       # Show all available commands
npm run blumon:auth       # Authenticate master credentials
npm run blumon:session    # Create test checkout session
npm run blumon:sessions   # List active sessions
npm run blumon:webhook    # Simulate webhook event
npm run blumon:merchant   # Check merchant status
npm run blumon:mock       # Test with mock service
npm run blumon:flow       # Test complete flow
```

---

## 📚 Available Commands

### Development

```bash
npm run dev                  # Start dev server with hot reload
npm run dev:simple-logging   # Start with console logging (no JSON)
npm run dev:dashboard        # Open session dashboard
npm run dev:logs             # Tail latest log file
npm run dev:clean-sessions   # Clean up old sessions
```

### Database

```bash
npm run migrate              # Run Prisma migrations
npm run seed                 # Seed database with sample data
npm run studio               # Open Prisma Studio
npx prisma db pull           # Pull schema from database
npx prisma db push           # Push schema to database
```

### Testing

```bash
npm test                     # Run all tests
npm run test:unit            # Run unit tests only
npm run test:integration     # Run integration tests
npm run test:api             # Run API tests
npm run test:watch           # Run tests in watch mode
npm run test:coverage        # Generate coverage report
```

### Code Quality

```bash
npm run format               # Format code with Prettier
npm run lint                 # Run ESLint
npm run lint:fix             # Fix ESLint issues automatically
npm run check:unused         # Detect unused files
npm run check:dead-code      # Detect dead code
```

### Blumon SDK

```bash
npm run blumon:help          # Show Blumon CLI help
npm run blumon:auth          # Authenticate Blumon
npm run blumon:session       # Create test session
npm run blumon:sessions      # List sessions
npm run blumon:webhook       # Simulate webhook
npm run blumon:merchant      # Check merchant status
npm run blumon:mock          # Test with mock service
npm run sdk:test             # Test SDK endpoints
npm run sdk:errors           # Test error parser
```

### Build & Deploy

```bash
npm run build                # Build for production
npm start                    # Start production server
npm run pre-deploy           # Pre-deployment checks
```

---

## 🐛 Troubleshooting

### Database Connection Failed

**Error**: `Error: P1001: Can't reach database server`

**Solutions**:

```bash
# 1. Check PostgreSQL is running
sudo systemctl status postgresql  # Linux
brew services list  # macOS

# 2. Verify credentials in .env
echo $DATABASE_URL

# 3. Test connection
psql $DATABASE_URL -c "SELECT 1;"

# 4. Check PostgreSQL logs
tail -f /var/log/postgresql/postgresql-14-main.log  # Linux
tail -f /usr/local/var/log/postgres.log  # macOS
```

### Redis Connection Failed

**Error**: `Redis connection failed`

**Solutions**:

```bash
# 1. Check Redis is running
redis-cli ping  # Should return PONG

# 2. Start Redis
brew services start redis  # macOS
sudo systemctl start redis  # Linux

# 3. Optional: Disable Redis (fallback to memory sessions)
# Remove or comment REDIS_URL in .env
```

### Migration Drift

**Error**: `Datasource "db": PostgreSQL database "av-db-25", schema "public" at "localhost:5432"`
`Your database schema is not in sync with your migration history.`

**Solution**:

```bash
# Reset database (WARNING: Deletes all data!)
npx prisma migrate reset --force

# Or apply missing migrations
npm run migrate
```

### Port Already in Use

**Error**: `Error: listen EADDRINUSE: address already in use :::12344`

**Solution**:

```bash
# Find and kill process using port 12344
lsof -ti:12344 | xargs kill -9

# Or change PORT in .env
PORT=12345
```

### Blumon Authentication Failed

**Error**: `❌ Blumon authentication failed`

**Solutions**:

1. **Check credentials**:

   ```env
   BLUMON_MASTER_USERNAME=correct_email@example.com
   BLUMON_MASTER_PASSWORD=correct_password
   ```

2. **Use mock mode for testing**:

   ```env
   USE_BLUMON_MOCK=true
   ```

3. **Check Blumon API status**:
   ```bash
   curl https://sandbox-auth.blumonpay.com/health
   ```

### Seed Script Fails

**Error**: `PrismaClientKnownRequestError: Unique constraint failed`

**Solution**:

```bash
# Reset database completely
npx prisma migrate reset --force

# Re-run migrations and seed
npm run migrate
npm run seed
```

### TypeScript Errors After Pull

**Error**: `Cannot find module '@/utils/prismaClient'`

**Solution**:

```bash
# Regenerate Prisma Client
npx prisma generate

# Clear build cache
rm -rf dist/
npm run build
```

---

## 📖 Additional Documentation

- **Architecture**: `CLAUDE.md` - Complete system architecture
- **Blumon SDK**: `docs/BLUMON_SDK_INTEGRATION_STATUS.md` - SDK implementation status
- **Permissions**: `docs/PERMISSIONS_SYSTEM.md` - Role-based access control
- **Inventory**: `docs/INVENTORY_REFERENCE.md` - FIFO batch tracking
- **Chatbot**: `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md` - AI assistant system
- **Testing**: `tests/README.md` - Testing guide

---

## 🆘 Getting Help

- **Blumon CLI**: `npm run blumon:help`
- **Check logs**: `npm run dev:logs`
- **Open dashboard**: `npm run dev:dashboard`
- **API docs**: http://localhost:12344/api-docs (when server running)

---

## ✅ Verification Checklist

After setup, verify everything works:

- [ ] ✅ Server starts: `npm run dev`
- [ ] ✅ Database connected: Check server logs for "PostgreSQL connected"
- [ ] ✅ Health check: `curl http://localhost:12344/health`
- [ ] ✅ Migrations ran: `npx prisma migrate status`
- [ ] ✅ Seed data loaded: Check for sample venues in database
- [ ] ✅ Blumon authenticated: `npm run blumon:merchant`
- [ ] ✅ Dashboard accessible: `npm run dev:dashboard`
- [ ] ✅ Tests pass: `npm test`

---

**Happy coding! 🥑**
