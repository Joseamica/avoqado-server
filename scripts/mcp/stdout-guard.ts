import { Writable } from 'node:stream'

/**
 * Reserve STDOUT exclusively for the MCP JSON-RPC protocol.
 *
 * The Avoqado app's winston logger (and any stray console.log) writes to
 * stdout — including at module-load time when services like Blumon/Email
 * initialize. On an MCP stdio server, stdout IS the protocol channel, so that
 * noise corrupts the JSON-RPC stream and the client fails the handshake
 * ("Failed to connect").
 *
 * Fix: capture the real stdout write, then point the global `process.stdout`
 * at stderr so ALL app logging becomes harmless. The MCP transport writes
 * through `mcpStdout` (below), which reaches the real stdout.
 *
 * IMPORTANT: this module MUST be imported FIRST in server.ts — before any
 * import that loads the logger or services — so the redirect is active before
 * anything writes to stdout.
 */

const realStdoutWrite = process.stdout.write.bind(process.stdout)

// Everything that would normally hit stdout now goes to stderr instead.
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write

/** The only writable that reaches the real stdout — hand this to the MCP transport. */
export const mcpStdout = new Writable({
  write(chunk, encoding, callback) {
    realStdoutWrite(chunk as string | Uint8Array, encoding as BufferEncoding, callback)
  },
})
