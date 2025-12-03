// Mock for pdf-to-img ESM module
// This module uses ESM syntax that Jest can't handle out of the box

export const pdf = jest.fn().mockImplementation(() => ({
  [Symbol.asyncIterator]: async function* () {
    // Yield a mock image buffer
    yield Buffer.from('mock-pdf-page-image')
  },
}))
