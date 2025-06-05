module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/?(*.)+(spec|test).+(ts|tsx|js)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Automatically clear mock calls and instances between every test
  clearMocks: true,
  // The directory where Jest should output its coverage files
  coverageDirectory: 'coverage',
  // A list of paths to modules that run some code to configure or set up the testing framework before each test file in the suite is executed
  // setupFilesAfterEnv: ['./jest.setup.js'], // Uncomment if you need a setup file
  // You might need to tell Jest to use a specific .env file for tests
  // setupFiles: ['dotenv/config'], // If you want to load .env, or use a specific one for tests
};
