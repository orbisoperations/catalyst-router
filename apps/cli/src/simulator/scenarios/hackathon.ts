/**
 * Hackathon scenario: 5 engineers setting up a mesh.
 *
 * Pure data — no logic. Each entry is an action with a delay (in seconds at 1x speed).
 * The runner applies the speed multiplier and executes sequentially.
 */

export type SimAction =
  | {
      type: 'create-peer'
      name: string
      endpoint: string
      domains?: string[]
      engineer: string
      comment: string
    }
  | { type: 'delete-peer'; name: string; engineer: string; comment: string }
  | {
      type: 'create-route'
      name: string
      endpoint: string
      protocol?: 'http' | 'http:graphql' | 'http:grpc' | 'tcp'
      engineer: string
      comment: string
    }
  | { type: 'delete-route'; name: string; engineer: string; comment: string }
  | { type: 'pause'; seconds: number; comment: string }

export const hackathonScenario: { name: string; description: string; actions: SimAction[] } = {
  name: 'hackathon',
  description: '5 engineers standing up a distributed mesh — setup, iteration, and demo prep',
  actions: [
    // =========================================================================
    // PHASE 1: "Everyone's setting up" (real-time: minutes 0-10)
    // =========================================================================
    { type: 'pause', seconds: 2, comment: '--- Phase 1: Setup ---' },

    // Eve starts — she's first, gets the infra up
    {
      type: 'create-route',
      name: 'sigint-east',
      endpoint: 'http://10.0.1.10:8080',
      protocol: 'http:graphql',
      engineer: 'Eve',
      comment: 'Deploying SIGINT feed ingestion',
    },
    { type: 'pause', seconds: 3, comment: '' },
    {
      type: 'create-route',
      name: 'fusion-cell',
      endpoint: 'http://10.0.1.11:8080',
      protocol: 'http:graphql',
      engineer: 'Eve',
      comment: 'Standing up the fusion cell',
    },
    { type: 'pause', seconds: 5, comment: '' },

    // Marcus joins — registering his sensor services
    {
      type: 'create-route',
      name: 'elint-processor',
      endpoint: 'http://10.0.2.10:9090',
      protocol: 'http:grpc',
      engineer: 'Marcus',
      comment: 'ELINT processor coming online',
    },
    { type: 'pause', seconds: 2, comment: '' },
    {
      type: 'create-route',
      name: 'radar-feed',
      endpoint: 'http://10.0.2.11:8080',
      protocol: 'http:graphql',
      engineer: 'Marcus',
      comment: 'Radar feed service',
    },
    { type: 'pause', seconds: 4, comment: '' },

    // Priya's node — she's doing HUMINT
    {
      type: 'create-route',
      name: 'humint-relay',
      endpoint: 'http://10.0.3.10:8080',
      protocol: 'http:graphql',
      engineer: 'Priya',
      comment: 'HUMINT relay going up',
    },
    { type: 'pause', seconds: 6, comment: '' },

    // Jake — comms and TAK
    {
      type: 'create-route',
      name: 'tak-gateway',
      endpoint: 'http://10.0.4.10:8087',
      protocol: 'tcp',
      engineer: 'Jake',
      comment: 'TAK gateway for CoT data',
    },
    { type: 'pause', seconds: 3, comment: '' },
    {
      type: 'create-route',
      name: 'voice-bridge',
      endpoint: 'http://10.0.4.11:8080',
      protocol: 'http:graphql',
      engineer: 'Jake',
      comment: 'Voice-to-text bridge',
    },
    { type: 'pause', seconds: 5, comment: '' },

    // Anika — imagery and geospatial
    {
      type: 'create-route',
      name: 'imagery-ingest',
      endpoint: 'http://10.0.5.10:8080',
      protocol: 'http:graphql',
      engineer: 'Anika',
      comment: 'Satellite imagery pipeline',
    },
    { type: 'pause', seconds: 2, comment: '' },
    {
      type: 'create-route',
      name: 'geospatial-api',
      endpoint: 'http://10.0.5.11:9090',
      protocol: 'http:grpc',
      engineer: 'Anika',
      comment: 'Geospatial query API',
    },
    { type: 'pause', seconds: 8, comment: '' },

    // Now peering begins — Eve connects to Marcus
    {
      type: 'create-peer',
      name: 'site-marcus',
      endpoint: 'ws://10.0.2.1:3000/rpc',
      engineer: 'Eve',
      comment: 'Peering with Marcus for ELINT data',
    },
    { type: 'pause', seconds: 4, comment: '' },

    // Marcus peers back
    {
      type: 'create-peer',
      name: 'site-priya',
      endpoint: 'ws://10.0.3.1:3000/rpc',
      domains: ['humint.mil'],
      engineer: 'Marcus',
      comment: 'Peering with Priya for HUMINT',
    },
    { type: 'pause', seconds: 3, comment: '' },

    // Jake peers — but typos the endpoint
    {
      type: 'create-peer',
      name: 'site-eve',
      endpoint: 'ws://10.0.1.1:3000/rpc',
      engineer: 'Jake',
      comment: 'Peering with Eve for fusion data',
    },
    { type: 'pause', seconds: 5, comment: '' },

    // Anika peers
    {
      type: 'create-peer',
      name: 'site-jake',
      endpoint: 'ws://10.0.4.1:3000/rpc',
      engineer: 'Anika',
      comment: 'Peering with Jake for TAK data',
    },

    // =========================================================================
    // PHASE 2: "It's working... mostly" (real-time: minutes 10-30)
    // =========================================================================
    { type: 'pause', seconds: 10, comment: '--- Phase 2: Iteration ---' },

    // Eve notices her endpoint is wrong, fixes it
    {
      type: 'delete-route',
      name: 'sigint-east',
      engineer: 'Eve',
      comment: 'Wrong port on SIGINT feed, fixing...',
    },
    { type: 'pause', seconds: 2, comment: '' },
    {
      type: 'create-route',
      name: 'sigint-east',
      endpoint: 'http://10.0.1.10:9090',
      protocol: 'http:grpc',
      engineer: 'Eve',
      comment: 'SIGINT feed back up with correct port and protocol',
    },
    { type: 'pause', seconds: 8, comment: '' },

    // Marcus adds another service
    {
      type: 'create-route',
      name: 'threat-classifier',
      endpoint: 'http://10.0.2.12:8080',
      protocol: 'http:graphql',
      engineer: 'Marcus',
      comment: 'ML threat classifier ready',
    },
    { type: 'pause', seconds: 6, comment: '' },

    // Priya realizes she needs to peer with Eve directly
    {
      type: 'create-peer',
      name: 'site-eve-direct',
      endpoint: 'ws://10.0.1.1:3000/rpc',
      engineer: 'Priya',
      comment: 'Direct peering with Eve — need fusion cell access',
    },
    { type: 'pause', seconds: 5, comment: '' },

    // Jake's TAK gateway has issues, tears it down and redeploys
    {
      type: 'delete-route',
      name: 'tak-gateway',
      engineer: 'Jake',
      comment: 'TAK gateway crashing, redeploying...',
    },
    { type: 'pause', seconds: 4, comment: '' },
    {
      type: 'create-route',
      name: 'tak-gateway-v2',
      endpoint: 'http://10.0.4.10:8088',
      protocol: 'tcp',
      engineer: 'Jake',
      comment: 'TAK gateway v2 — fixed the CoT parsing bug',
    },
    { type: 'pause', seconds: 7, comment: '' },

    // Anika adds a new peer to Marcus for imagery analysis
    {
      type: 'create-peer',
      name: 'site-marcus-imagery',
      endpoint: 'ws://10.0.2.1:3000/rpc',
      engineer: 'Anika',
      comment: "Need Marcus' threat classifier for imagery",
    },
    { type: 'pause', seconds: 6, comment: '' },

    // Marcus adds a dashboard route
    {
      type: 'create-route',
      name: 'ops-dashboard',
      endpoint: 'http://10.0.2.13:3000',
      protocol: 'http',
      engineer: 'Marcus',
      comment: 'Ops dashboard for the demo',
    },
    { type: 'pause', seconds: 5, comment: '' },

    // Eve peers with Anika for imagery
    {
      type: 'create-peer',
      name: 'site-anika',
      endpoint: 'ws://10.0.5.1:3000/rpc',
      engineer: 'Eve',
      comment: 'Peering with Anika — need imagery in fusion cell',
    },

    // =========================================================================
    // PHASE 3: "Demo prep panic" (real-time: minutes 30-45)
    // =========================================================================
    { type: 'pause', seconds: 12, comment: '--- Phase 3: Demo Prep ---' },

    // Priya accidentally deletes the wrong route
    {
      type: 'delete-route',
      name: 'humint-relay',
      engineer: 'Priya',
      comment: 'Oh no, wrong route! Meant to delete the test one',
    },
    { type: 'pause', seconds: 2, comment: '' },
    {
      type: 'create-route',
      name: 'humint-relay',
      endpoint: 'http://10.0.3.10:8080',
      protocol: 'http:graphql',
      engineer: 'Priya',
      comment: 'HUMINT relay restored — panic over',
    },
    { type: 'pause', seconds: 5, comment: '' },

    // Everyone adding last-minute routes
    {
      type: 'create-route',
      name: 'alert-service',
      endpoint: 'http://10.0.1.12:8080',
      protocol: 'http:graphql',
      engineer: 'Eve',
      comment: 'Real-time alerting for the demo',
    },
    { type: 'pause', seconds: 3, comment: '' },
    {
      type: 'create-route',
      name: 'sit-report-gen',
      endpoint: 'http://10.0.3.11:8080',
      protocol: 'http:graphql',
      engineer: 'Priya',
      comment: 'Auto-generated situation reports',
    },
    { type: 'pause', seconds: 3, comment: '' },
    {
      type: 'create-route',
      name: 'imagery-mosaic',
      endpoint: 'http://10.0.5.12:8080',
      protocol: 'http:graphql',
      engineer: 'Anika',
      comment: 'Real-time imagery mosaic viewer',
    },
    { type: 'pause', seconds: 4, comment: '' },

    // Jake establishes the final peer connection
    {
      type: 'create-peer',
      name: 'site-priya-tak',
      endpoint: 'ws://10.0.3.1:3000/rpc',
      engineer: 'Jake',
      comment: 'Final peer — TAK data to HUMINT for the demo',
    },
    { type: 'pause', seconds: 3, comment: '' },

    // Anika cleans up the test route
    {
      type: 'delete-route',
      name: 'geospatial-api',
      engineer: 'Anika',
      comment: 'Removing old geospatial API — replaced by mosaic viewer',
    },
    { type: 'pause', seconds: 2, comment: '' },
    {
      type: 'create-route',
      name: 'geospatial-v2',
      endpoint: 'http://10.0.5.11:9091',
      protocol: 'http:grpc',
      engineer: 'Anika',
      comment: 'Geospatial v2 — faster queries for the demo',
    },
    { type: 'pause', seconds: 5, comment: '' },

    // Final status
    { type: 'pause', seconds: 2, comment: '--- Simulation complete ---' },
  ],
}
