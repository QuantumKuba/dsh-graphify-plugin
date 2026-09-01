import readline from 'node:readline'

const tools = [
  { name: 'query_graph', description: 'Query the graph.', inputSchema: { type: 'object' } },
  { name: 'graph_stats', description: 'Read graph statistics.', inputSchema: { type: 'object' } },
  { name: 'future_tool', description: 'A tool added by a future Graphify release.', inputSchema: { type: 'object' } },
]

const resources = [
  { uri: 'graphify://report', name: 'Graph Report', mimeType: 'text/markdown' },
]

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {} } })
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
  if (request.method === 'resources/read') {
    send({ jsonrpc: '2.0', id: request.id, result: { contents: [{ uri: request.params.uri, text: '# Graph Report' }] } })
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
