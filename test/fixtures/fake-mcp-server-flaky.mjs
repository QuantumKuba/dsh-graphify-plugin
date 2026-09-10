import fs from 'node:fs'
import readline from 'node:readline'

// Configurable flaky server: exits immediately for the first FAIL_COUNT connections,
// then behaves as a normal MCP server. Uses a marker file to track attempt count
// across process restarts.
const failCount = parseInt(process.env.FAIL_COUNT || '0', 10)
const attemptFile = process.env.ATTEMPT_FILE
const triggerFile = process.env.TRIGGER_FILE

let shouldCheckFailure = true
if (triggerFile && !fs.existsSync(triggerFile)) {
  shouldCheckFailure = false
}

let currentAttempt = 0

if (shouldCheckFailure && attemptFile) {
  try {
    if (fs.existsSync(attemptFile)) {
      currentAttempt = parseInt(fs.readFileSync(attemptFile, 'utf8').trim(), 10) || 0
    }
    fs.writeFileSync(attemptFile, String(currentAttempt + 1), 'utf8')
  } catch {
    // Ignore filesystem errors
  }
}

if (shouldCheckFailure && currentAttempt < failCount) {
  // Simulate handshake failure: exit before responding to initialize
  process.stderr.write(`Simulated failure ${currentAttempt + 1}/${failCount}\n`)
  process.exit(1)
}

// Normal MCP server behavior
const tools = [
  { name: 'query_graph', description: 'Query the graph.', inputSchema: { type: 'object' } },
  { name: 'graph_stats', description: 'Read graph statistics.', inputSchema: { type: 'object' } },
]

const resources = [
  { uri: 'graphify://report', name: 'Graph Report', mimeType: 'text/markdown' },
]

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'graphify-mcp-flaky', version: '0.9.57' },
      },
    })
    return
  }
  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    return
  }
  if (request.method === 'resources/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { resources } })
    return
  }
  if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] },
    })
  }
})
