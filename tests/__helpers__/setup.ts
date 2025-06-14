// tests/__helpers__/setup.ts

// This file is executed once per test file after the test framework is setup 
// but before the tests are run.

// You can add global mocks, setup, or configuration here.
// For example, you might want to mock a global module:
// jest.mock('some-module', () => ({
//   // ...mock implementation
// }));

// Or setup a test database connection if needed for integration tests

console.log('Jest global setup file loaded.');

// Clear all mocks before each test to ensure test isolation
beforeEach(() => {
  jest.clearAllMocks();
});

// You can also add global afterEach or afterAll hooks if necessary
// afterAll(async () => {
//   // Clean up resources, e.g., close database connections
// });
