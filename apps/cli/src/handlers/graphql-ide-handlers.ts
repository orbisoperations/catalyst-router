import { Hono } from 'hono'
import type { GraphqlIdeInput } from '../types.js'

export type GraphqlIdeResult =
  | { success: true; data: { url: string; server: ReturnType<typeof Bun.serve> } }
  | { success: false; error: string }

/**
 * Generate GraphiQL HTML page with Explorer plugin
 * Uses CDN resources from esm.sh
 */
function generateGraphiQLHtml(graphqlEndpoint: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Catalyst GraphQL IDE</title>
  <link rel="stylesheet" href="https://esm.sh/graphiql@3.0.10/graphiql.min.css" />
  <link rel="stylesheet" href="https://esm.sh/@graphiql/plugin-explorer@3.0.1/dist/style.css" />
  <style>
    body { margin: 0; height: 100vh; }
    #graphiql { height: 100vh; }
  </style>
</head>
<body>
  <div id="graphiql"></div>
  <script type="importmap">
    {
      "imports": {
        "react": "https://esm.sh/react@18.2.0",
        "react-dom": "https://esm.sh/react-dom@18.2.0",
        "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
        "graphiql": "https://esm.sh/graphiql@3.0.10?external=react,react-dom",
        "@graphiql/plugin-explorer": "https://esm.sh/@graphiql/plugin-explorer@3.0.1?external=react,react-dom,graphiql"
      }
    }
  </script>
  <script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { GraphiQL } from 'graphiql';
    import { explorerPlugin } from '@graphiql/plugin-explorer';

    const endpoint = '${graphqlEndpoint}';

    const fetcher = async (graphQLParams) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graphQLParams),
      });
      return response.json();
    };

    const explorer = explorerPlugin();

    const root = createRoot(document.getElementById('graphiql'));
    root.render(
      React.createElement(GraphiQL, {
        fetcher,
        plugins: [explorer],
        defaultEditorToolsVisibility: true,
      })
    );
  </script>
</body>
</html>`
}

/**
 * Open URL in default browser (cross-platform)
 */
async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', url]
        : ['xdg-open', url]

  const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
}

/**
 * Start GraphiQL IDE server
 */
export async function startGraphqlIdeHandler(input: GraphqlIdeInput): Promise<GraphqlIdeResult> {
  try {
    const app = new Hono()

    // Serve GraphiQL HTML at root
    app.get('/', (c) => {
      return c.html(generateGraphiQLHtml(input.endpoint))
    })

    // Health check
    app.get('/health', (c) => c.json({ status: 'ok' }))

    const server = Bun.serve({
      fetch: app.fetch,
      port: input.port,
      hostname: '0.0.0.0',
    })

    const url = `http://localhost:${input.port}`

    // Open browser if requested
    if (input.open) {
      await openBrowser(url)
    }

    return { success: true, data: { url, server } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
