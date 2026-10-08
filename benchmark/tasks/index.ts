import type { TaskCard } from './types.ts'

export const BENCHMARK_TASKS: TaskCard[] = [
  {
    id: 'task-01-route-match',
    title: 'Route Path Matching & Layer Evaluation',
    category: 'discovery',
    difficulty: 'easy',
    prompt:
      'Where is the core route matching regex and path-to-regexp evaluation logic implemented in Express? Identify the specific class and method responsible for testing if a layer path matches an incoming request URL.',
    groundTruth: {
      primaryFiles: ['lib/router/layer.js'],
      relevantSymbols: ['Layer', 'Layer.prototype.match', 'match'],
      directDeps: ['lib/router/index.js', 'lib/router/route.js'],
      forbiddenDistractors: [
        'test/app.router.js',
        'test/Route.js',
        'test/Router.js',
        'examples/route-separation/index.js',
      ],
    },
    evaluationCriteria:
      'Must identify lib/router/layer.js and the Layer.match method without opening test files.',
  },
  {
    id: 'task-02-dispatch-pipeline',
    title: 'HTTP Request Dispatch Pipeline Tracing',
    category: 'pipeline_tracing',
    difficulty: 'medium',
    prompt:
      'Trace how an incoming HTTP request is dispatched from the top-level application down through the routing engine to an individual route layer. What is the exact sequence of core files and methods called during request handling?',
    groundTruth: {
      primaryFiles: ['lib/application.js', 'lib/router/index.js', 'lib/router/layer.js'],
      relevantSymbols: ['app.handle', 'router.handle', 'layer.handle_request'],
      expectedPath: ['lib/application.js', 'lib/router/index.js', 'lib/router/layer.js'],
      directDeps: ['lib/express.js', 'lib/middleware/init.js', 'lib/router/route.js'],
      forbiddenDistractors: ['test/app.listen.js', 'test/res.send.js'],
    },
    evaluationCriteria:
      'Must trace the 3-hop pipeline: application.js (app.handle) -> router/index.js (router.handle) -> router/layer.js (layer.handle_request).',
  },
  {
    id: 'task-03-blast-radius-send',
    title: 'Blast Radius of Modifying res.send()',
    category: 'blast_radius',
    difficulty: 'medium',
    prompt:
      'Before refactoring `res.send()` in response.js, identify all internal Express response methods that directly call or delegate into `res.send()`. Which methods will break if res.send signature changes?',
    groundTruth: {
      primaryFiles: ['lib/response.js'],
      relevantSymbols: ['res.send', 'res.json', 'res.jsonp', 'res.sendFile', 'res.sendStatus', 'res.format'],
      directDeps: ['lib/application.js', 'lib/request.js'],
      forbiddenDistractors: [
        'test/res.send.js',
        'test/res.json.js',
        'test/res.jsonp.js',
        'test/res.format.js',
      ],
    },
    evaluationCriteria:
      'Must identify response.js and internal callers (json, jsonp, sendFile, sendStatus, format) while filtering out the 20+ test fixtures.',
  },
  {
    id: 'task-04-god-nodes',
    title: 'Central Architectural Hubs & God Nodes',
    category: 'architectural_hubs',
    difficulty: 'easy',
    prompt:
      'What are the primary architectural hubs (god nodes) and top-level entry points of this repository? Identify the highest-centrality modules that connect routing, app lifecycle, and HTTP response handling.',
    groundTruth: {
      primaryFiles: [
        'lib/express.js',
        'lib/application.js',
        'lib/router/index.js',
        'lib/response.js',
      ],
      relevantSymbols: ['createApplication', 'app', 'Router', 'res'],
      directDeps: ['lib/request.js', 'lib/view.js'],
    },
    evaluationCriteria:
      'Must identify express.js as the primary entry point, and application.js, router/index.js, response.js as core hubs.',
  },
  {
    id: 'task-05-prototype-wiring',
    title: 'Custom Request & Response Prototype Lifecycle Wiring',
    category: 'lifecycle_wiring',
    difficulty: 'medium',
    prompt:
      'How does Express wire its custom Request and Response prototypes into the native Node.js HTTP server request lifecycle during app initialization? Where is the connection established?',
    groundTruth: {
      primaryFiles: ['lib/application.js', 'lib/middleware/init.js'],
      relevantSymbols: ['app.init', 'app.defaultConfiguration', 'init'],
      directDeps: ['lib/request.js', 'lib/response.js', 'lib/express.js'],
      forbiddenDistractors: ['test/app.request.js', 'test/app.response.js'],
    },
    evaluationCriteria:
      'Must locate application.js (app.init) and middleware/init.js where prototypes are assigned to req/res per incoming connection.',
  },
  {
    id: 'task-06-param-compilation',
    title: 'Route Parameter Callback Compilation & Processing',
    category: 'parameter_handling',
    difficulty: 'medium',
    prompt:
      'Where does Express handle route parameter callbacks registered via `app.param()` or `router.param()`? Find where parameter names are parsed, stored, and executed during route handling.',
    groundTruth: {
      primaryFiles: ['lib/router/index.js'],
      relevantSymbols: ['proto.param', 'proto.process_params'],
      directDeps: ['lib/application.js', 'lib/router/layer.js'],
      forbiddenDistractors: ['test/app.param.js', 'test/router.param.js'],
    },
    evaluationCriteria:
      'Must pinpoint lib/router/index.js methods proto.param and proto.process_params.',
  },
  {
    id: 'task-07-view-engine',
    title: 'Template Engine Resolution & View Rendering',
    category: 'subsystem_resolution',
    difficulty: 'easy',
    prompt:
      'Which module is responsible for resolving view template paths on disk, determining engine extensions, and invoking the template engine render function?',
    groundTruth: {
      primaryFiles: ['lib/view.js'],
      relevantSymbols: ['View', 'View.prototype.render', 'View.prototype.resolve'],
      directDeps: ['lib/application.js'],
      forbiddenDistractors: ['test/app.render.js', 'test/res.render.js', 'test/view.test.js'],
    },
    evaluationCriteria:
      'Must identify lib/view.js as the dedicated view template resolver and renderer.',
  },
  {
    id: 'task-08-subrouter-mounting',
    title: 'Nested Sub-Router Mounting & Prefix Isolation',
    category: 'router_mounting',
    difficulty: 'medium',
    prompt:
      'How does Express isolate path prefixes when mounting a sub-app or nested Router via `app.use("/prefix", subRouter)`? Which component strips or restores the mountpath prefix during route traversal?',
    groundTruth: {
      primaryFiles: ['lib/router/layer.js', 'lib/router/index.js'],
      relevantSymbols: ['Layer.prototype.handle_request', 'proto.handle'],
      directDeps: ['lib/application.js'],
      forbiddenDistractors: ['test/app.use.js', 'test/Router.js'],
    },
    evaluationCriteria:
      'Must identify router/layer.js (layer.handle_request adjusting req.url) and router/index.js.',
  },
  {
    id: 'task-09-error-middleware-arity',
    title: 'Error Middleware Arity Differentiation (4-param vs 3-param)',
    category: 'bug_localization',
    difficulty: 'medium',
    prompt:
      'When an error is passed to `next(err)`, where does Express distinguish 4-argument error-handling middleware `(err, req, res, next)` from regular 3-argument middleware `(req, res, next)`?',
    groundTruth: {
      primaryFiles: ['lib/router/layer.js'],
      relevantSymbols: ['Layer.prototype.handle_error', 'fn.length === 4'],
      directDeps: ['lib/router/route.js', 'lib/router/index.js'],
      forbiddenDistractors: ['test/app.router.js', 'test/res.format.js'],
    },
    evaluationCriteria:
      'Must pinpoint lib/router/layer.js (Layer.prototype.handle_error inspecting fn.length === 4).',
  },
  {
    id: 'task-10-content-negotiation',
    title: 'Content Negotiation & Request Header Delegation',
    category: 'interface_delegation',
    difficulty: 'easy',
    prompt:
      'Where does Express implement request content negotiation methods such as `req.accepts()`, `req.acceptsCharsets()`, and `req.is()`? What external libraries does it delegate to?',
    groundTruth: {
      primaryFiles: ['lib/request.js'],
      relevantSymbols: ['req.accepts', 'req.is', 'accepts', 'type-is'],
      directDeps: ['package.json'],
      forbiddenDistractors: ['test/req.accepts.js', 'test/req.is.js'],
    },
    evaluationCriteria:
      'Must identify lib/request.js and its delegation to accepts and type-is.',
  },
]
