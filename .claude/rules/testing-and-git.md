# Testing & Quality Policies - Claude Operational Guide

> Rules Claude MUST follow when writing/modifying code. Not project docs - agent behavior rules.

---

## The Golden Rule: No Regressions

When you fix or implement something, you MUST NOT break something else. This is the most common source of production bugs.

**Before committing any change, verify:**

1. New feature works correctly
2. Existing features still work
3. Related features are unaffected

---

## Test Structure Requirement

Every test file should have BOTH sections:

```typescript
describe('Feature X', () => {
  // 1. NEW FEATURE TESTS (what you built)
  it('should do the new thing correctly', ...)
  it('should handle error cases', ...)
  it('should handle edge cases', ...)

  // 2. REGRESSION TESTS (what you didn't break)
  it('should still do existing thing A', ...)
  it('should still do existing thing B', ...)
  it('should not affect related thing C', ...)
})
```

---

## Testing Commands

```bash
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:api      # API integration tests
npm run test:workflows # End-to-end workflow tests
npm run test:tpv      # TPV-specific tests
npm run test:coverage # Generate coverage report
npm run test:watch    # Watch mode
npm run pre-deploy    # CI/CD simulation (MUST pass before push)
```

---

## Test Script Workflow (Temporary -> Permanent)

### Step 1: Create temporary script for rapid validation

```bash
touch scripts/temp-test-feature.ts
npx ts-node -r tsconfig-paths/register scripts/temp-test-feature.ts
```

### Step 2: Migrate to permanent Jest test

```bash
vim tests/unit/services/dashboard/feature.service.test.ts
npm test -- tests/unit/services/dashboard/feature.service.test.ts
```

### Step 3: Delete temporary script

```bash
rm scripts/temp-test-feature.ts
```

### Step 4: Commit only code + Jest test (NOT the script)

---

## Temporary File Naming

If you must keep a temporary script, mark it clearly:

```typescript
// Prefix with "temp-" or "debug-"
scripts / temp - find - venue - id.ts
scripts / debug - permissions.ts

// OR add DELETE comment at top
// DELETE AFTER: Temporary debugging script
// Purpose: Find venue IDs by name for testing
// Created: 2025-01-22
```

---

## Where Tests Go

| Type           | Directory                      | Characteristics                             |
| -------------- | ------------------------------ | ------------------------------------------- |
| Unit tests     | `tests/unit/**/*.test.ts`      | Mocked, fast, isolated. **COMMIT THESE.**   |
| API tests      | `tests/api-tests/**/*.test.ts` | Real DB, integration. **COMMIT THESE.**     |
| Workflow tests | `tests/workflows/**/*.test.ts` | End-to-end flows. **COMMIT THESE.**         |
| Temp scripts   | `scripts/temp-*.ts`            | Quick validation. **DELETE BEFORE COMMIT.** |

---

## Code Quality: Auto-Format Policy

After editing TypeScript/JavaScript files, run:

```bash
npm run format && npm run lint:fix
```

This ensures zero prettier/eslint warnings in commits.

---

## Pre-Commit Checklist

1. [ ] Does this change affect existing documentation?
2. [ ] Did I run `npm test` (full suite)?
3. [ ] Did I run `npm run pre-deploy`?
4. [ ] Did I delete temporary scripts?
5. [ ] No regressions in related features?
6. [ ] If schema change: Did I create a proper migration (NOT `db push`)?

---

## Git Policy

**NEVER commit, push, or make git changes without explicit user permission.**

- Before `git add` -> Ask user first
- Before `git commit` -> Ask user first
- Before `git push` -> Ask user first
- Before `git merge` -> Ask user first

Always ask: "Quieres que haga commit de estos cambios?"
