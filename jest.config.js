// Updated jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**',
    '!src/scripts/**',
    '!src/config/**',
    '!src/app.ts',
    '!src/server.ts',
  ],

  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],

  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    'src/services/dashboard/': {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    'src/services/pos-sync/': {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },

  verbose: true,
  detectOpenHandles: true,
  forceExit: true,

  // Project-based configuration — each project defines its own
  // setupFilesAfterEnv, moduleNameMapper, and testMatch
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
      transform: {
        // isolatedModules: transpile-only (no per-file type-checking) in tests.
        // Type safety is still enforced by `npm run build` / `pre-deploy` (tsc).
        // Without this, ts-jest keeps the full TS program (incl. the huge Prisma
        // type graph, 206+ models) in memory → ~3 GB heap PER worker. On the CI
        // runner, 2 workers × 3 GB + ts-jest native overhead exceed the container
        // memory → the OS SIGKILLs Jest workers, surfacing as
        // "Jest worker encountered N child process exceptions, exceeding retry limit".
        // Transpile-only drops this to ~80 MB/worker and slashes runtime.
        '^.+\\.(ts|tsx|js|jsx|mjs)$': ['ts-jest', { isolatedModules: true }],
      },
      // satori|satori-html|ultrahtml are pure ESM and ship `import`
      // syntax in their dist. Without transforming them, ts-jest
      // chokes on the import statement at runtime.
      transformIgnorePatterns: ['node_modules/(?!(@scure|@noble|otplib|@otplib|satori|satori-html|ultrahtml))'],
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
        '^pdf-to-img$': '<rootDir>/tests/__mocks__/pdf-to-img.ts',
        // ultrahtml uses an `exports` map with only the `import`
        // condition, which the default jest resolver can't satisfy.
        // Point both the root and the subpath exports directly at
        // their bundled ESM files (then transformed by ts-jest via
        // the allowlist above).
        '^ultrahtml$': '<rootDir>/node_modules/ultrahtml/dist/index.js',
        '^ultrahtml/transformers/(.*)$': '<rootDir>/node_modules/ultrahtml/dist/transformers/$1.js',
      },
    },
    {
      displayName: 'api-tests',
      testMatch: ['<rootDir>/tests/api-tests/**/*.api.test.ts'],
      transform: {
        // isolatedModules: transpile-only (no per-file type-checking) in tests.
        // Type safety is still enforced by `npm run build` / `pre-deploy` (tsc).
        // Without this, ts-jest keeps the full TS program (incl. the huge Prisma
        // type graph, 206+ models) in memory → ~3 GB heap PER worker. On the CI
        // runner, 2 workers × 3 GB + ts-jest native overhead exceed the container
        // memory → the OS SIGKILLs Jest workers, surfacing as
        // "Jest worker encountered N child process exceptions, exceeding retry limit".
        // Transpile-only drops this to ~80 MB/worker and slashes runtime.
        '^.+\\.(ts|tsx|js|jsx|mjs)$': ['ts-jest', { isolatedModules: true }],
      },
      transformIgnorePatterns: ['node_modules/(?!(@scure|@noble|otplib|@otplib|satori|satori-html|ultrahtml))'],
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
        '^pdf-to-img$': '<rootDir>/tests/__mocks__/pdf-to-img.ts',
        // ultrahtml uses an `exports` map with only the `import`
        // condition, which the default jest resolver can't satisfy.
        // Point both the root and the subpath exports directly at
        // their bundled ESM files (then transformed by ts-jest via
        // the allowlist above).
        '^ultrahtml$': '<rootDir>/node_modules/ultrahtml/dist/index.js',
        '^ultrahtml/transformers/(.*)$': '<rootDir>/node_modules/ultrahtml/dist/transformers/$1.js',
      },
    },
    {
      displayName: 'workflows',
      testMatch: ['<rootDir>/tests/workflows/**/*.workflow.test.ts'],
      transform: {
        // isolatedModules: transpile-only (no per-file type-checking) in tests.
        // Type safety is still enforced by `npm run build` / `pre-deploy` (tsc).
        // Without this, ts-jest keeps the full TS program (incl. the huge Prisma
        // type graph, 206+ models) in memory → ~3 GB heap PER worker. On the CI
        // runner, 2 workers × 3 GB + ts-jest native overhead exceed the container
        // memory → the OS SIGKILLs Jest workers, surfacing as
        // "Jest worker encountered N child process exceptions, exceeding retry limit".
        // Transpile-only drops this to ~80 MB/worker and slashes runtime.
        '^.+\\.(ts|tsx|js|jsx|mjs)$': ['ts-jest', { isolatedModules: true }],
      },
      transformIgnorePatterns: ['node_modules/(?!(@scure|@noble|otplib|@otplib|satori|satori-html|ultrahtml))'],
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
        '^pdf-to-img$': '<rootDir>/tests/__mocks__/pdf-to-img.ts',
        // ultrahtml uses an `exports` map with only the `import`
        // condition, which the default jest resolver can't satisfy.
        // Point both the root and the subpath exports directly at
        // their bundled ESM files (then transformed by ts-jest via
        // the allowlist above).
        '^ultrahtml$': '<rootDir>/node_modules/ultrahtml/dist/index.js',
        '^ultrahtml/transformers/(.*)$': '<rootDir>/node_modules/ultrahtml/dist/transformers/$1.js',
      },
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      transform: {
        // isolatedModules: transpile-only (no per-file type-checking) in tests.
        // Type safety is still enforced by `npm run build` / `pre-deploy` (tsc).
        // Without this, ts-jest keeps the full TS program (incl. the huge Prisma
        // type graph, 206+ models) in memory → ~3 GB heap PER worker. On the CI
        // runner, 2 workers × 3 GB + ts-jest native overhead exceed the container
        // memory → the OS SIGKILLs Jest workers, surfacing as
        // "Jest worker encountered N child process exceptions, exceeding retry limit".
        // Transpile-only drops this to ~80 MB/worker and slashes runtime.
        '^.+\\.(ts|tsx|js|jsx|mjs)$': ['ts-jest', { isolatedModules: true }],
      },
      transformIgnorePatterns: ['node_modules/(?!(@scure|@noble|otplib|@otplib|satori|satori-html|ultrahtml))'],
      setupFilesAfterEnv: ['<rootDir>/tests/__helpers__/integration-setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@tests/(.*)$': '<rootDir>/tests/$1',
        '^pdf-to-img$': '<rootDir>/tests/__mocks__/pdf-to-img.ts',
        // ultrahtml uses an `exports` map with only the `import`
        // condition, which the default jest resolver can't satisfy.
        // Point both the root and the subpath exports directly at
        // their bundled ESM files (then transformed by ts-jest via
        // the allowlist above).
        '^ultrahtml$': '<rootDir>/node_modules/ultrahtml/dist/index.js',
        '^ultrahtml/transformers/(.*)$': '<rootDir>/node_modules/ultrahtml/dist/transformers/$1.js',
      },
    },
  ],

  // 🔥 NEW: Better error handling and reporting
  errorOnDeprecated: true,

  // 🔥 NEW: Performance and memory settings
  maxWorkers: '50%',
  cache: true,
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',
}
