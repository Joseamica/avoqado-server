# CI/CD Setup Guide

## Required GitHub Secrets

To enable integration tests in CI/CD, you need to configure the following GitHub secret:

### `TEST_DATABASE_URL`

**Purpose**: PostgreSQL database connection string for running integration tests in GitHub Actions.

**Format**:

```
postgresql://username:password@host:port/database?sslmode=require
```

**How to set up**:

1. **Create a test database** in any PostgreSQL provider (Fly Postgres, Railway, Supabase, etc.):

   - Create a new database for CI testing
   - Copy the connection string

2. **Add secret to GitHub**:

   - Go to your repository → Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `TEST_DATABASE_URL`
   - Value: Paste your connection string
   - Click "Add secret"

3. **Verify**:
   - Push a commit to `develop` or `main` branch
   - Check GitHub Actions → CI/CD Pipeline
   - Verify "🏪 Run integration tests" step passes

## What Tests Run in CI/CD?

The CI/CD pipeline runs three types of tests:

1. **Unit Tests** (`npm run test:unit`)

   - Mocked tests for business logic
   - Fast execution (~2-5 seconds)
   - No database required

2. **Integration Tests** (`npm run test:integration`) ⭐ NEW

   - Real PostgreSQL database
   - Tests complete flows (order → payment → inventory)
   - Concurrency and race condition tests
   - Execution time: ~15-30 seconds

3. **Build Verification**
   - TypeScript compilation
   - ESLint checks
   - Application build

## CI/CD Flow

```
Push to develop/main
    ↓
📏 ESLint
    ↓
🔍 TypeScript Compilation
    ↓
🗄️ Generate Prisma Client
    ↓
🏗️ Build Application
    ↓
🧪 Run Unit Tests
    ↓
🏪 Run Integration Tests ⭐ NEW
    ↓
✅ All checks passed
    ↓
🚀 Deploy to Staging/Production
```

## What Integration Tests Validate

### FIFO Batch Concurrency (5 tests)

- Concurrent order processing with limited stock
- Row-level locking (FOR UPDATE NOWAIT)
- Race condition prevention
- No double-deduction in concurrent scenarios
- Stress test with 5 simultaneous orders

### Order-Payment-Inventory Flow (5 tests)

- Full payment with sufficient stock (happy path)
- Payment failure with insufficient stock
- Partial payments (inventory only deducted when fully paid)
- Mixed products (some tracked, some not)
- Regression tests (existing functionality still works)

## Troubleshooting

### Tests fail locally but pass in CI

- Check your local `DATABASE_URL` in `.env`
- Ensure local database has migrations applied: `npx prisma migrate dev`

### Tests pass locally but fail in CI

- Check `TEST_DATABASE_URL` secret is set correctly
- Verify test database has migrations applied
- Check GitHub Actions logs for specific error

### Integration tests timeout

- Increase timeout in `jest.config.js` (currently 30000ms)
- Check database connection latency
- Verify Neon database is not paused (cold start)

## Security Notes

- ⚠️ **Never commit database URLs to git**
- ✅ Test database should be isolated from production
- ✅ Use separate credentials for test database
- ✅ Consider using Neon's branching feature for ephemeral test databases

## Future Enhancements

- [ ] Add API integration tests to CI/CD
- [ ] Add workflow tests to CI/CD
- [ ] Set up database seeding for consistent test data
- [ ] Add performance benchmarks
- [ ] Implement parallel test execution for faster CI
