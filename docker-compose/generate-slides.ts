import PptxGenJS from 'pptxgenjs'

// ─── Theme ───────────────────────────────────────────────────────────────────

const T = {
  BG: '1B1F2B',
  BG_DARK: '141724',
  BG_BOX: '252A3A',
  BORDER: '3A4055',

  WHITE: 'FFFFFF',
  TEXT: 'E8ECF1',
  MUTED: '8B95A5',

  BLUE: '4A9EFF',
  TEAL: '00D1B2',
  ORANGE: 'FF8C42',
  PURPLE: 'A37EFF',
  RED: 'FF5C5C',
  GREEN: '4ADE80',

  FONT: 'Arial',
  MONO: 'Courier New',
} as const

type Slide = PptxGenJS.Slide

// ─── Helpers ─────────────────────────────────────────────────────────────────

function heading(slide: Slide, text: string, opts?: { y?: number; fontSize?: number }) {
  slide.addText(text, {
    x: 0.6,
    y: opts?.y ?? 0.3,
    w: 8.8,
    h: 0.6,
    fontSize: opts?.fontSize ?? 28,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })
}

function subheading(slide: Slide, text: string, y?: number) {
  slide.addText(text, {
    x: 0.6,
    y: y ?? 0.85,
    w: 8.8,
    h: 0.4,
    fontSize: 16,
    fontFace: T.FONT,
    color: T.MUTED,
  })
}

function box(
  slide: Slide,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  accent?: string
) {
  slide.addText(label, {
    x,
    y,
    w,
    h,
    fontSize: 11,
    fontFace: T.FONT,
    color: T.TEXT,
    bold: true,
    align: 'center',
    valign: 'middle',
    shape: 'roundRect' as unknown as PptxGenJS.ShapeType,
    rectRadius: 0.08,
    fill: { color: T.BG_BOX },
    line: { color: accent ?? T.BORDER, width: 1.2 },
  })
}

function arrow(
  slide: Slide,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts?: { color?: string; dashed?: boolean; label?: string; labelY?: number }
) {
  const flipH = x2 < x1
  const flipV = y2 < y1
  slide.addShape('line' as unknown as PptxGenJS.ShapeType, {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1) || 0.001,
    h: Math.abs(y2 - y1) || 0.001,
    flipH,
    flipV,
    line: {
      color: opts?.color ?? T.MUTED,
      width: 1.2,
      dashType: opts?.dashed ? 'dash' : 'solid',
      endArrowType: 'triangle',
    },
  })
  if (opts?.label) {
    const lx = Math.min(x1, x2)
    const lw = Math.abs(x2 - x1) || 0.5
    const ly = opts.labelY ?? Math.min(y1, y2) - 0.22
    slide.addText(opts.label, {
      x: lx,
      y: ly,
      w: lw,
      h: 0.22,
      fontSize: 8,
      fontFace: T.FONT,
      color: T.MUTED,
      align: 'center',
    })
  }
}

function line(
  slide: Slide,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts?: { color?: string; dashed?: boolean }
) {
  const flipH = x2 < x1
  const flipV = y2 < y1
  slide.addShape('line' as unknown as PptxGenJS.ShapeType, {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1) || 0.001,
    h: Math.abs(y2 - y1) || 0.001,
    flipH,
    flipV,
    line: {
      color: opts?.color ?? T.BORDER,
      width: 1,
      dashType: opts?.dashed ? 'dash' : 'solid',
    },
  })
}

function codeBlock(slide: Slide, text: string, x: number, y: number, w: number, h: number) {
  slide.addText(text, {
    x,
    y,
    w,
    h,
    fontSize: 10,
    fontFace: T.MONO,
    color: T.TEXT,
    valign: 'top',
    shape: 'roundRect' as unknown as PptxGenJS.ShapeType,
    rectRadius: 0.06,
    fill: { color: '0D1117' },
    margin: [6, 10, 6, 10],
  })
}

function callout(
  slide: Slide,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  accent?: string
) {
  slide.addText(text, {
    x,
    y,
    w,
    h,
    fontSize: 11,
    fontFace: T.FONT,
    color: T.TEXT,
    valign: 'middle',
    shape: 'roundRect' as unknown as PptxGenJS.ShapeType,
    rectRadius: 0.06,
    fill: { color: T.BG_BOX },
    line: { color: accent ?? T.BLUE, width: 1.5 },
    margin: [4, 10, 4, 10],
  })
}

type TableRow = PptxGenJS.TableRow
type TableCell = PptxGenJS.TableCell

function themedTable(
  slide: Slide,
  headers: string[],
  rows: string[][],
  x: number,
  y: number,
  w: number,
  opts?: { accent?: string; fontSize?: number }
) {
  const accent = opts?.accent ?? T.BLUE
  const fs = opts?.fontSize ?? 10
  const colW = w / headers.length

  const headerRow: TableRow = headers.map(
    (h) =>
      ({
        text: h,
        options: {
          bold: true,
          fontSize: fs,
          fontFace: T.FONT,
          color: T.WHITE,
          fill: { color: accent },
          align: 'left',
          margin: [3, 6, 3, 6],
          border: { type: 'none' },
        },
      }) as TableCell
  )

  const bodyRows: TableRow[] = rows.map((row, i) =>
    row.map(
      (cell) =>
        ({
          text: cell,
          options: {
            fontSize: fs,
            fontFace: T.FONT,
            color: T.TEXT,
            fill: { color: i % 2 === 0 ? T.BG_BOX : T.BG },
            align: 'left',
            margin: [3, 6, 3, 6],
            border: { type: 'none' },
          },
        }) as TableCell
    )
  )

  slide.addTable([headerRow, ...bodyRows], {
    x,
    y,
    w,
    colW: Array(headers.length).fill(colW),
    border: { type: 'none' },
  })
}

function bullets(
  slide: Slide,
  items: Array<string | { text: string; sub?: boolean; color?: string }>,
  x: number,
  y: number,
  w: number,
  opts?: { fontSize?: number }
) {
  const fs = opts?.fontSize ?? 13
  const textItems = items.map((item) => {
    const isObj = typeof item === 'object'
    const text = isObj ? item.text : item
    const indent = isObj && item.sub ? 1 : 0
    return {
      text,
      options: {
        fontSize: indent ? fs - 1 : fs,
        fontFace: T.FONT,
        color: isObj && item.color ? item.color : T.TEXT,
        bullet: { indent: indent ? 20 : 10, code: indent ? '2013' : '2022' },
        indentLevel: indent,
        paraSpaceAfter: 4,
      },
    }
  })
  slide.addText(textItems as PptxGenJS.TextProps[], { x, y, w, h: items.length * 0.34 })
}

// ─── Masters ─────────────────────────────────────────────────────────────────

function defineMasters(pres: PptxGenJS) {
  pres.defineSlideMaster({
    title: 'TITLE',
    background: { color: T.BG_DARK },
    objects: [
      {
        rect: { x: 0.75, y: 3.4, w: 8.5, h: 0.006, fill: { color: T.BLUE } },
      },
    ],
    slideNumber: { x: 9.2, y: '95%', color: T.MUTED, fontSize: 8 },
  })

  pres.defineSlideMaster({
    title: 'CONTENT',
    background: { color: T.BG },
    objects: [
      {
        rect: { x: 0, y: 0, w: '100%', h: 0.04, fill: { color: T.BLUE } },
      },
    ],
    slideNumber: { x: 9.2, y: '95%', color: T.MUTED, fontSize: 8 },
  })
}

// ─── Slide Builders ──────────────────────────────────────────────────────────

// 1. Title
function buildTitle(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'TITLE' })
  s.addText('Catalyst Router', {
    x: 0.75,
    y: 1.6,
    w: 8.5,
    h: 1,
    fontSize: 42,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })
  s.addText('BGP-Inspired Service Discovery\nwith Envoy Data Plane', {
    x: 0.75,
    y: 3.6,
    w: 8.5,
    h: 0.8,
    fontSize: 18,
    fontFace: T.FONT,
    color: T.MUTED,
    lineSpacingMultiple: 1.3,
  })
  s.addText('Architecture & Demo Walkthrough', {
    x: 0.75,
    y: 4.5,
    w: 8.5,
    h: 0.4,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.BLUE,
  })
}

// 2. Agenda
function buildAgenda(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Agenda')

  const sections = [
    { title: 'Architecture Overview', desc: 'The core pod layout and control/data plane split' },
    {
      title: 'BGP-Inspired Routing',
      desc: 'How the orchestrator discovers and propagates services',
    },
    {
      title: 'Authentication & Authorization',
      desc: 'ES384 JWTs, Cedar policies, and scoped clients',
    },
    { title: 'Auth Gap: mTLS Roadmap', desc: 'Current state and where certificate binding fits' },
    { title: 'Envoy as Transport', desc: 'xDS control plane and listener/cluster model' },
    { title: 'Demo Architecture', desc: '3-stack Docker Compose with 8 isolated networks' },
    { title: 'Multi-Hop Walkthrough', desc: 'End-to-end request from Stack C through B to A' },
  ]

  sections.forEach((sec, i) => {
    const yBase = 1.15 + i * 0.6
    s.addText(`${i + 1}`, {
      x: 0.6,
      y: yBase,
      w: 0.4,
      h: 0.4,
      fontSize: 16,
      fontFace: T.FONT,
      color: T.BLUE,
      bold: true,
      align: 'center',
      valign: 'middle',
      shape: 'roundRect' as unknown as PptxGenJS.ShapeType,
      rectRadius: 0.06,
      fill: { color: T.BG_BOX },
    })
    s.addText(sec.title, {
      x: 1.15,
      y: yBase,
      w: 5,
      h: 0.25,
      fontSize: 15,
      fontFace: T.FONT,
      color: T.WHITE,
      bold: true,
    })
    s.addText(sec.desc, {
      x: 1.15,
      y: yBase + 0.24,
      w: 7,
      h: 0.22,
      fontSize: 11,
      fontFace: T.FONT,
      color: T.MUTED,
    })
  })
}

// 3. Architecture Overview
function buildArchitecture(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Architecture Overview')
  subheading(s, 'Each node is a self-contained pod with control plane + data plane')

  // Control plane container
  s.addText('Control Plane', {
    x: 1.5,
    y: 1.45,
    w: 2,
    h: 0.25,
    fontSize: 10,
    fontFace: T.FONT,
    color: T.MUTED,
    italic: true,
  })
  s.addShape('rect' as unknown as PptxGenJS.ShapeType, {
    x: 1.5,
    y: 1.7,
    w: 5.5,
    h: 2.0,
    fill: { color: '1E2233' },
    line: { color: T.BORDER, width: 1, dashType: 'dash' },
    rectRadius: 0.1,
  })

  // Orchestrator (center)
  box(s, 'Orchestrator', 3.0, 2.0, 2.0, 0.55, T.BLUE)
  // Auth
  box(s, 'Auth Service', 1.7, 2.8, 1.7, 0.5, T.ORANGE)
  // Envoy Service
  box(s, 'Envoy Service\n(xDS)', 4.6, 2.8, 1.7, 0.5, T.PURPLE)

  // Lines from orchestrator to sidecars
  arrow(s, 3.5, 2.55, 2.55, 2.8, { label: 'RPC', labelY: 2.55 })
  arrow(s, 4.5, 2.55, 5.45, 2.8, { label: 'RPC', labelY: 2.55 })

  // Data plane
  s.addText('Data Plane', {
    x: 1.5,
    y: 3.85,
    w: 2,
    h: 0.25,
    fontSize: 10,
    fontFace: T.FONT,
    color: T.MUTED,
    italic: true,
  })
  box(s, 'Envoy Proxy', 2.8, 4.15, 2.9, 0.55, T.PURPLE)

  // xDS arrow from envoy service to proxy
  arrow(s, 5.45, 3.3, 4.25, 4.15, { label: 'xDS gRPC (ADS)', labelY: 3.5, color: T.PURPLE })

  // External arrows
  box(s, 'Clients', 0.3, 4.15, 1.2, 0.55, T.TEAL)
  arrow(s, 1.5, 4.42, 2.8, 4.42, { label: 'HTTP / gRPC' })

  box(s, 'Peer Nodes', 7.0, 4.15, 1.5, 0.55, T.GREEN)
  arrow(s, 5.7, 4.42, 7.0, 4.42, { label: 'Envoy Mesh' })

  // Peer WS arrow
  box(s, 'Peer\nOrchestrators', 7.0, 2.0, 1.5, 0.55, T.GREEN)
  arrow(s, 5.0, 2.27, 7.0, 2.27, { label: 'WebSocket RPC' })

  // Key insight
  callout(
    s,
    'Orchestrator decides routing policy. Envoy executes traffic forwarding. Auth gates every operation.',
    0.6,
    4.95,
    8.8,
    0.45,
    T.BLUE
  )
}

// 4. BGP Concepts
function buildBGPConcepts(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'BGP-Inspired Routing')
  subheading(s, "Adapted from the internet's routing protocol for service-level discovery")

  // Left column - Standard BGP
  s.addText('Standard BGP', {
    x: 0.6,
    y: 1.4,
    w: 4,
    h: 0.35,
    fontSize: 16,
    fontFace: T.FONT,
    color: T.MUTED,
    bold: true,
  })
  bullets(
    s,
    [
      'Routes IP prefixes (10.0.0.0/24)',
      'Next hop = IP address',
      'AS_PATH prevents routing loops',
      'Forwarding at IP layer',
      'iBGP within an AS, eBGP between',
    ],
    0.6,
    1.8,
    4.0
  )

  // Right column - Catalyst BGP
  s.addText('Catalyst Routing', {
    x: 5.4,
    y: 1.4,
    w: 4,
    h: 0.35,
    fontSize: 16,
    fontFace: T.FONT,
    color: T.BLUE,
    bold: true,
  })
  bullets(
    s,
    [
      'Routes service names (books-api)',
      'Next hop = Node FQDN + Envoy port',
      'nodePath prevents routing loops',
      'Forwarding via Envoy proxy',
      'iBGP implemented, eBGP reserved',
    ],
    5.4,
    1.8,
    4.2
  )

  // Mapping table
  themedTable(
    s,
    ['BGP Concept', 'Catalyst Equivalent', 'Example'],
    [
      ['Autonomous System', 'Domain', 'somebiz.local.io'],
      ['CIDR Prefix', 'Service Name', 'books-api'],
      ['AS_PATH', 'nodePath', '["node-b", "node-a"]'],
      ['Next Hop IP', 'envoyAddress + envoyPort', 'envoy-proxy-a:10001'],
      ['UPDATE message', 'InternalProtocolUpdate', '{ action: "add", route, nodePath }'],
    ],
    0.6,
    3.7,
    8.8
  )
}

// 5. BGP Protocol Flow
function buildBGPProtocol(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Peering Protocol Flow')
  subheading(s, 'Three-stage handshake with full table sync on connect')

  // Node A lifeline
  const aX = 2.5
  const bX = 7.0
  const topY = 1.5
  const botY = 4.5

  box(s, 'Node A', aX - 0.6, topY, 1.2, 0.4, T.BLUE)
  box(s, 'Node B', bX - 0.6, topY, 1.2, 0.4, T.TEAL)

  // Lifelines
  line(s, aX, topY + 0.4, aX, botY, { dashed: true, color: T.BORDER })
  line(s, bX, topY + 0.4, bX, botY, { dashed: true, color: T.BORDER })

  // Step 1
  const y1 = 2.2
  arrow(s, aX, y1, bX, y1, { color: T.BLUE, label: '1. addPeer(B) -> open(nodeA_info)' })

  // Step 2
  const y2 = 2.7
  arrow(s, bX, y2, aX, y2, {
    color: T.TEAL,
    label: '2. InternalProtocolOpen -> sync full route table to A',
  })

  // Step 3
  const y3 = 3.2
  arrow(s, aX, y3, bX, y3, {
    color: T.BLUE,
    label: '3. InternalProtocolConnected -> sync full route table to B',
  })

  // Step 4
  const y4 = 3.7
  arrow(s, aX, y4, bX, y4, { color: T.GREEN, label: '4. InternalProtocolUpdate (ongoing)' })
  arrow(s, bX, y4 + 0.3, aX, y4 + 0.3, {
    color: T.GREEN,
    label: '   Route adds/removes propagate bidirectionally',
  })

  // Loop prevention callout
  callout(
    s,
    'Loop Prevention: every route carries nodePath[] — an ordered list of node FQDNs it has traversed. If a node sees itself in the path, the route is dropped.',
    0.6,
    4.65,
    8.8,
    0.55,
    T.ORANGE
  )
}

// 6. Route Table
function buildRouteTable(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Route Table & Action/Reducer')
  subheading(s, 'Event-sourced state management inspired by Redux + BGP RIB')

  // Dispatch flow
  box(s, 'Action\n(Event)', 0.6, 1.55, 1.3, 0.65, T.BLUE)
  arrow(s, 1.9, 1.87, 2.3, 1.87, { color: T.BLUE })
  box(s, 'handleAction\n(Sync Reducer)', 2.3, 1.55, 1.8, 0.65, T.TEAL)
  arrow(s, 4.1, 1.87, 4.5, 1.87, { color: T.TEAL })
  box(s, 'New State', 4.5, 1.55, 1.3, 0.65, T.GREEN)
  arrow(s, 5.8, 1.87, 6.2, 1.87, { color: T.GREEN })
  box(s, 'handleNotify\n(Async Effects)', 6.2, 1.55, 1.8, 0.65, T.PURPLE)
  arrow(s, 8.0, 1.87, 8.4, 1.87, { color: T.PURPLE })
  box(s, 'RPC to\nPeers/Envoy', 8.4, 1.55, 1.3, 0.65, T.ORANGE)

  // Route table sections
  themedTable(
    s,
    ['Section', 'Contains', 'Source', 'Purpose'],
    [
      [
        'local.routes',
        'DataChannelDefinition[]',
        'CLI / Admin API',
        'Services this node originates',
      ],
      ['internal.peers', 'PeerRecord[]', 'addPeer / protocol', 'Connected peer state + peerToken'],
      [
        'internal.routes',
        'InternalRoute[]',
        'Peer UPDATE msgs',
        'Services learned from iBGP peers',
      ],
      ['external', '(reserved)', 'Future eBGP', 'Cross-domain federation'],
    ],
    0.6,
    2.5,
    8.8
  )

  // Action types
  s.addText('Action Types', {
    x: 0.6,
    y: 3.85,
    w: 3,
    h: 0.3,
    fontSize: 12,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })

  codeBlock(
    s,
    'Peer Management         Route Management        Protocol (iBGP)\n' +
      '─────────────────       ──────────────────      ─────────────────────────\n' +
      'LocalPeerCreate         LocalRouteCreate        InternalProtocolOpen\n' +
      'LocalPeerUpdate         LocalRouteDelete        InternalProtocolClose\n' +
      'LocalPeerDelete                                 InternalProtocolConnected\n' +
      '                                                InternalProtocolUpdate',
    0.6,
    4.15,
    8.8,
    1.2
  )
}

// 7. Auth Token Architecture
function buildAuthTokens(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Authentication: ES384 JWTs + Cedar')
  subheading(s, 'Every RPC call is gated by token validation and Cedar policy evaluation')

  // JWT structure
  codeBlock(
    s,
    '{\n' +
      '  "alg": "ES384",\n' +
      '  "sub": "node-a.somebiz.local.io",      // Subject\n' +
      '  "iss": "catalyst",                      // Issuer\n' +
      '  "principal": "CATALYST::NODE",           // Cedar principal type\n' +
      '  "entity": {\n' +
      '    "trustedDomains": ["somebiz.local.io"],\n' +
      '    "trustedNodes": []\n' +
      '  },\n' +
      '  "cnf": { "x5t#S256": "..." },           // Future: cert binding (RFC 8705)\n' +
      '  "jti": "unique-id", "exp": ..., "iat": ...\n' +
      '}',
    0.6,
    1.35,
    5.0,
    2.5
  )

  // Principal types table
  s.addText('Principal Types', {
    x: 5.9,
    y: 1.35,
    w: 3.5,
    h: 0.3,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })
  themedTable(
    s,
    ['Principal', 'Permissions'],
    [
      ['ADMIN', 'All actions'],
      ['NODE', 'IBGP_CONNECT, UPDATE'],
      ['NODE_CUSTODIAN', 'PEER_*, IBGP_*'],
      ['DATA_CUSTODIAN', 'ROUTE_CREATE, DELETE'],
      ['USER', 'LOGIN'],
    ],
    5.9,
    1.7,
    3.7,
    { accent: T.ORANGE, fontSize: 9 }
  )

  // Scoped clients
  s.addText('Scoped Client Model', {
    x: 0.6,
    y: 4.0,
    w: 4,
    h: 0.3,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })

  box(s, 'NetworkClient\n(Peer Mgmt)', 0.6, 4.4, 2.5, 0.55, T.BLUE)
  box(s, 'DataChannel\n(Routes)', 3.4, 4.4, 2.5, 0.55, T.TEAL)
  box(s, 'IBGPClient\n(Internal Protocol)', 6.2, 4.4, 2.5, 0.55, T.PURPLE)

  callout(
    s,
    'Cedar policy engine evaluates: Can this principal perform this action on this resource?',
    0.6,
    5.1,
    8.8,
    0.35,
    T.ORANGE
  )
}

// 8. Peer Token Exchange
function buildPeerTokenExchange(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Peer Token Exchange')
  subheading(s, 'Each node has its OWN auth service — cross-minting enables peering')

  const aX = 1.5
  const authX = 4.8
  const bX = 8.0
  const topY = 1.5

  box(s, 'Node A\nOrchestrator', aX - 0.7, topY, 1.6, 0.55, T.BLUE)
  box(s, "Auth-B\n(Node B's Auth)", authX - 0.8, topY, 1.8, 0.55, T.ORANGE)
  box(s, 'Node B\nOrchestrator', bX - 0.7, topY, 1.6, 0.55, T.TEAL)

  // Lifelines
  line(s, aX, topY + 0.55, aX, 4.2, { dashed: true })
  line(s, authX, topY + 0.55, authX, 4.2, { dashed: true })
  line(s, bX, topY + 0.55, bX, 4.2, { dashed: true })

  // Step 1: Admin mints peer token
  const y1 = 2.4
  s.addText('1', {
    x: 0.3,
    y: y1 - 0.08,
    w: 0.3,
    h: 0.25,
    fontSize: 11,
    fontFace: T.FONT,
    color: T.BLUE,
    bold: true,
  })
  arrow(s, aX, y1, authX, y1, { color: T.ORANGE, label: 'Mint peer token for Node A' })

  // Step 2: Token returned
  const y2 = 2.85
  s.addText('2', {
    x: 0.3,
    y: y2 - 0.08,
    w: 0.3,
    h: 0.25,
    fontSize: 11,
    fontFace: T.FONT,
    color: T.BLUE,
    bold: true,
  })
  arrow(s, authX, y2, aX, y2, { color: T.ORANGE, label: 'JWT signed by Auth-B returned' })

  // Step 3: Node A stores and presents to B
  const y3 = 3.3
  s.addText('3', {
    x: 0.3,
    y: y3 - 0.08,
    w: 0.3,
    h: 0.25,
    fontSize: 11,
    fontFace: T.FONT,
    color: T.BLUE,
    bold: true,
  })
  arrow(s, aX, y3, bX, y3, { color: T.BLUE, label: 'Connect + present peerToken' })

  // Step 4: B validates via its auth
  const y4 = 3.75
  s.addText('4', {
    x: 0.3,
    y: y4 - 0.08,
    w: 0.3,
    h: 0.25,
    fontSize: 11,
    fontFace: T.FONT,
    color: T.BLUE,
    bold: true,
  })
  arrow(s, bX, y4, authX, y4, { color: T.TEAL, label: 'Validate token with local Auth-B' })

  // Step 5: iBGP established
  s.addText('5', {
    x: 0.3,
    y: 4.15,
    w: 0.3,
    h: 0.25,
    fontSize: 11,
    fontFace: T.FONT,
    color: T.GREEN,
    bold: true,
  })

  callout(
    s,
    'iBGP session established — bidirectional route sync begins',
    0.6,
    4.15,
    8.8,
    0.35,
    T.GREEN
  )

  callout(
    s,
    'Key: The peerToken is the ONLY credential used. If it is missing or invalid, connection fails with CRITICAL error.',
    0.6,
    4.65,
    8.8,
    0.45,
    T.RED
  )
}

// 9. Auth Gap - mTLS Roadmap
function buildAuthGap(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Auth Gap: Where mTLS Will Be')
  subheading(s, 'Current JWT-only auth vs future certificate-bound tokens')

  // Current State box
  s.addText('Current State', {
    x: 0.6,
    y: 1.4,
    w: 4.0,
    h: 0.35,
    fontSize: 16,
    fontFace: T.FONT,
    color: T.ORANGE,
    bold: true,
  })
  s.addShape('rect' as unknown as PptxGenJS.ShapeType, {
    x: 0.6,
    y: 1.8,
    w: 4.0,
    h: 2.2,
    fill: { color: T.BG_BOX },
    line: { color: T.ORANGE, width: 1.5 },
    rectRadius: 0.08,
  })
  bullets(
    s,
    [
      'JWT over unencrypted WebSocket',
      'Token alone is sufficient to authenticate',
      'No channel binding to transport',
      'Token theft = full impersonation',
      { text: 'Sufficient for dev/testing', color: T.MUTED },
    ],
    0.8,
    1.9,
    3.6,
    { fontSize: 12 }
  )

  // Future State box
  s.addText('Future: mTLS + DPoP', {
    x: 5.4,
    y: 1.4,
    w: 4.0,
    h: 0.35,
    fontSize: 16,
    fontFace: T.FONT,
    color: T.GREEN,
    bold: true,
  })
  s.addShape('rect' as unknown as PptxGenJS.ShapeType, {
    x: 5.4,
    y: 1.8,
    w: 4.2,
    h: 2.2,
    fill: { color: T.BG_BOX },
    line: { color: T.GREEN, width: 1.5 },
    rectRadius: 0.08,
  })
  bullets(
    s,
    [
      'Mutual TLS on all peer connections',
      'cnf claim binds JWT to cert (RFC 8705)',
      'SHA-256 thumbprint matching',
      'Sender-constrained: token useless without key',
      { text: 'Production security model', color: T.GREEN },
    ],
    5.6,
    1.9,
    3.8,
    { fontSize: 12 }
  )

  // Arrow between
  s.addText('>>>', {
    x: 4.5,
    y: 2.6,
    w: 1.0,
    h: 0.4,
    fontSize: 20,
    fontFace: T.FONT,
    color: T.BLUE,
    align: 'center',
    bold: true,
  })

  // What's already built
  s.addText("What's Already in Place", {
    x: 0.6,
    y: 4.2,
    w: 4,
    h: 0.3,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })
  bullets(
    s,
    [
      { text: 'Token structure has cnf claim field', color: T.GREEN },
      { text: 'Token store tracks certificateFingerprint', color: T.GREEN },
      { text: 'ADR 0007 specifies the architecture', color: T.GREEN },
    ],
    0.6,
    4.5,
    4.0,
    { fontSize: 11 }
  )

  // What's missing
  s.addText("What's Missing", {
    x: 5.4,
    y: 4.2,
    w: 4,
    h: 0.3,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })
  bullets(
    s,
    [
      { text: 'TLS termination on WebSocket endpoints', color: T.RED },
      { text: 'Client certificate validation in Hono', color: T.RED },
      { text: 'Thumbprint matching during token verify', color: T.RED },
    ],
    5.4,
    4.5,
    4.2,
    { fontSize: 11 }
  )
}

// 10. Envoy xDS Control Plane
function buildEnvoyXDS(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Envoy: xDS Control Plane')
  subheading(s, 'ADS (Aggregated Discovery Service) over gRPC')

  // Flow diagram
  box(s, 'Orchestrator', 0.6, 1.8, 1.7, 0.55, T.BLUE)
  arrow(s, 2.3, 2.07, 3.0, 2.07, { label: 'Capnweb RPC' })
  box(s, 'Envoy Service\n(xDS Server)', 3.0, 1.8, 2.0, 0.55, T.PURPLE)
  arrow(s, 5.0, 2.07, 5.7, 2.07, { label: 'ADS gRPC' })
  box(s, 'Envoy Proxy\n(Data Plane)', 5.7, 1.8, 2.0, 0.55, T.PURPLE)

  // Snapshot cache
  box(s, 'Snapshot\nCache', 3.5, 2.6, 1.2, 0.5, T.BG_BOX)
  line(s, 4.0, 2.35, 4.0, 2.6, { color: T.PURPLE })

  // Protocol details
  bullets(
    s,
    [
      'Single gRPC stream carries all resource types (ADS)',
      'State of the World (SotW) — full config push each snapshot',
      'CDS sent before LDS (prevents traffic blackholing)',
      'Version-based ACK/NACK for consistency',
    ],
    0.6,
    3.3,
    5.0,
    { fontSize: 12 }
  )

  // Resource naming table
  themedTable(
    s,
    ['Resource', 'Type', 'Naming Pattern', 'Example'],
    [
      ['Ingress Listener', 'LDS', 'ingress_{channel}', 'ingress_books-api'],
      ['Egress Listener', 'LDS', 'egress_{channel}_via_{peer}', 'egress_books-api_via_node-b'],
      ['Local Cluster', 'CDS', 'local_{channel}', 'local_books-api'],
      ['Remote Cluster', 'CDS', 'remote_{channel}_via_{peer}', 'remote_books-api_via_node-b'],
    ],
    0.6,
    4.25,
    9.0,
    { accent: T.PURPLE, fontSize: 9 }
  )
}

// 11. Envoy Listener/Cluster Model
function buildEnvoyListeners(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Listener & Cluster Model')
  subheading(s, 'Ingress serves remote peers — Egress reaches remote services')

  // Ingress flow
  s.addText('INGRESS (serving remote peers)', {
    x: 0.6,
    y: 1.4,
    w: 5,
    h: 0.3,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.TEAL,
    bold: true,
  })
  box(s, 'Remote Peer', 0.6, 1.85, 1.4, 0.5, T.GREEN)
  arrow(s, 2.0, 2.1, 2.4, 2.1, { color: T.TEAL })
  box(s, 'ingress_books-api\n:10001', 2.4, 1.85, 2.0, 0.5, T.PURPLE)
  arrow(s, 4.4, 2.1, 4.8, 2.1, { color: T.TEAL })
  box(s, 'local_books-api', 4.8, 1.85, 1.7, 0.5, T.PURPLE)
  arrow(s, 6.5, 2.1, 6.9, 2.1, { color: T.TEAL })
  box(s, 'books:8080', 6.9, 1.85, 1.4, 0.5, T.TEAL)

  // Egress flow
  s.addText('EGRESS (reaching remote services)', {
    x: 0.6,
    y: 2.7,
    w: 5,
    h: 0.3,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.ORANGE,
    bold: true,
  })
  box(s, 'Local App', 0.6, 3.15, 1.4, 0.5, T.BLUE)
  arrow(s, 2.0, 3.4, 2.4, 3.4, { color: T.ORANGE })
  box(s, 'egress_books-api\n_via_node-a :10011', 2.4, 3.15, 2.2, 0.5, T.PURPLE)
  arrow(s, 4.6, 3.4, 5.0, 3.4, { color: T.ORANGE })
  box(s, 'remote_books-api\n_via_node-a', 5.0, 3.15, 2.0, 0.5, T.PURPLE)
  arrow(s, 7.0, 3.4, 7.4, 3.4, { color: T.ORANGE })
  box(s, 'node-a\n:10001', 7.4, 3.15, 1.3, 0.5, T.GREEN)

  // Protocol awareness table
  s.addText('Protocol-Aware Configuration', {
    x: 0.6,
    y: 3.9,
    w: 5,
    h: 0.3,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })
  themedTable(
    s,
    ['Protocol', 'Codec', 'WebSocket', 'Timeout'],
    [
      ['http', 'HTTP/1.1', 'No', 'Default'],
      ['http:graphql', 'HTTP/1.1', 'Yes (subscriptions)', 'Disabled'],
      ['http:grpc', 'HTTP/2', 'No', 'Disabled (streaming)'],
    ],
    0.6,
    4.25,
    8.8,
    { accent: T.PURPLE, fontSize: 10 }
  )

  callout(
    s,
    'Port allocation: sequential from configurable pool. Each service gets a unique listener port.',
    0.6,
    5.05,
    8.8,
    0.35,
    T.PURPLE
  )
}

// 12. Demo Topology
function buildDemoTopology(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, '3-Stack Demo Architecture')
  subheading(s, 'A <-> B <-> C topology — B is transit, no direct A-C peering')

  const stackW = 2.2
  const stackH = 3.0
  const aX = 0.8
  const bX = 3.9
  const cX = 7.0

  // Stack containers
  const drawStack = (label: string, x: number, accent: string, services: string[]) => {
    s.addShape('rect' as unknown as PptxGenJS.ShapeType, {
      x,
      y: 1.4,
      w: stackW,
      h: stackH,
      fill: { color: '1E2233' },
      line: { color: accent, width: 1.5, dashType: 'dash' },
      rectRadius: 0.1,
    })
    s.addText(label, {
      x,
      y: 1.4,
      w: stackW,
      h: 0.3,
      fontSize: 12,
      fontFace: T.FONT,
      color: accent,
      bold: true,
      align: 'center',
    })

    services.forEach((svc, i) => {
      const svcY = 1.8 + i * 0.5
      const svcAccent = svc.includes('Auth')
        ? T.ORANGE
        : svc.includes('Orch')
          ? T.BLUE
          : svc.includes('Envoy') || svc.includes('xDS')
            ? T.PURPLE
            : T.TEAL
      box(s, svc, x + 0.15, svcY, stackW - 0.3, 0.38, svcAccent)
    })
  }

  drawStack('Stack A', aX, T.BLUE, [
    'Auth-A',
    'Orchestrator-A',
    'Envoy (xDS)',
    'Envoy Proxy',
    'books-a',
  ])
  drawStack('Stack B', bX, T.TEAL, [
    'Auth-B',
    'Orchestrator-B',
    'Envoy (xDS)',
    'Envoy Proxy',
    'books-b',
  ])
  drawStack('Stack C', cX, T.ORANGE, [
    'Auth-C',
    'Orchestrator-C',
    'Envoy (xDS)',
    'Envoy Proxy',
    'curl-client',
  ])

  // Mesh lines — draw through the actual service rows
  const orchRow = 2.3 + 0.19 // center of Orchestrator-X boxes
  const envoyRow = 3.3 + 0.19 // center of Envoy Proxy boxes
  const lineLeft = aX + stackW // right edge of Stack A
  const lineRight = cX // left edge of Stack C

  // Orchestrator mesh line (between the orchestrator boxes)
  line(s, lineLeft, orchRow, lineRight, orchRow, { color: T.BLUE, dashed: true })
  s.addText('orchestrator-mesh', {
    x: lineLeft,
    y: orchRow - 0.2,
    w: lineRight - lineLeft,
    h: 0.18,
    fontSize: 7,
    fontFace: T.MONO,
    color: T.BLUE,
    align: 'center',
  })

  // Envoy mesh line (between the envoy proxy boxes)
  line(s, lineLeft, envoyRow, lineRight, envoyRow, { color: T.PURPLE, dashed: true })
  s.addText('envoy-mesh', {
    x: lineLeft,
    y: envoyRow + 0.03,
    w: lineRight - lineLeft,
    h: 0.18,
    fontSize: 7,
    fontFace: T.MONO,
    color: T.PURPLE,
    align: 'center',
  })

  // Peering indicators
  callout(s, 'A <-> B  and  B <-> C  (B is transit node)', 0.6, 4.55, 8.8, 0.3, T.GREEN)
}

// 13. Network Isolation
function buildNetworkIsolation(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, '8 Docker Networks')
  subheading(
    s,
    'Strict isolation — control plane and data plane never cross stacks except via mesh'
  )

  themedTable(
    s,
    ['Network', 'Type', 'Connects', 'Subnet'],
    [
      ['stack-a-control', 'Control', 'auth-a, orch-a, envoy-svc-a, envoy-proxy-a', '172.28.1.0/28'],
      ['stack-a-data', 'Data', 'envoy-proxy-a, books-a', '172.28.1.16/28'],
      ['stack-b-control', 'Control', 'auth-b, orch-b, envoy-svc-b, envoy-proxy-b', '172.28.2.0/28'],
      ['stack-b-data', 'Data', 'envoy-proxy-b, books-b', '172.28.2.16/28'],
      ['stack-c-control', 'Control', 'auth-c, orch-c, envoy-svc-c, envoy-proxy-c', '172.28.3.0/28'],
      ['stack-c-data', 'Data', 'envoy-proxy-c, curl-client', '172.28.3.16/28'],
      ['orchestrator-mesh', 'Cross-stack', 'orch-a, orch-b, orch-c', '172.28.10.0/28'],
      [
        'envoy-mesh',
        'Cross-stack',
        'envoy-proxy-a, envoy-proxy-b, envoy-proxy-c',
        '172.28.11.0/28',
      ],
    ],
    0.6,
    1.3,
    8.8,
    { fontSize: 9 }
  )

  // Key insights
  s.addText('Key Design Principles', {
    x: 0.6,
    y: 4.0,
    w: 4,
    h: 0.3,
    fontSize: 13,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })
  bullets(
    s,
    [
      'Auth services are stack-local only (no cross-stack auth access)',
      'Downstream services (books, curl) cannot reach other stacks',
      'Only orchestrators and envoy proxies join cross-stack meshes',
      'Control plane mesh (BGP) and data plane mesh (traffic) are separate',
    ],
    0.6,
    4.3,
    9.0,
    { fontSize: 12 }
  )
}

// 14. Demo Walkthrough
function buildDemoSteps(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Demo Walkthrough')
  subheading(s, 'From cold start to cross-node GraphQL query in 8 steps')

  const steps = [
    {
      num: '1',
      title: 'Start Auth Services',
      desc: 'Each stack mints its own system admin token',
      accent: T.ORANGE,
    },
    {
      num: '2',
      title: 'Extract System Tokens',
      desc: 'Parse tokens from container logs for CLI use',
      accent: T.ORANGE,
    },
    {
      num: '3',
      title: 'Start Full Stacks',
      desc: '15 containers across 8 networks come up',
      accent: T.BLUE,
    },
    {
      num: '4',
      title: 'Register Routes',
      desc: 'books-a on Stack A, books-b on Stack B',
      accent: T.TEAL,
    },
    {
      num: '5',
      title: 'Mint Peer Tokens',
      desc: 'Cross-auth token exchange for A<->B, B<->C',
      accent: T.ORANGE,
    },
    {
      num: '6',
      title: 'Create Peer Connections',
      desc: 'iBGP sessions establish, full table sync',
      accent: T.BLUE,
    },
    {
      num: '7',
      title: 'Verify Route Propagation',
      desc: 'Stack C learns both books-a and books-b via transit B',
      accent: T.GREEN,
    },
    {
      num: '8',
      title: 'End-to-End Traffic Test',
      desc: 'curl from Stack C queries books-a on Stack A (2-hop)',
      accent: T.GREEN,
    },
  ]

  steps.forEach((step, i) => {
    const col = i < 4 ? 0 : 1
    const row = i % 4
    const x = col === 0 ? 0.6 : 5.2
    const yBase = 1.35 + row * 0.95

    // Number badge
    s.addText(step.num, {
      x,
      y: yBase,
      w: 0.4,
      h: 0.4,
      fontSize: 14,
      fontFace: T.FONT,
      color: T.WHITE,
      bold: true,
      align: 'center',
      valign: 'middle',
      shape: 'roundRect' as unknown as PptxGenJS.ShapeType,
      rectRadius: 0.2,
      fill: { color: step.accent },
    })

    // Title
    s.addText(step.title, {
      x: x + 0.5,
      y: yBase,
      w: 3.5,
      h: 0.3,
      fontSize: 14,
      fontFace: T.FONT,
      color: T.WHITE,
      bold: true,
    })

    // Description
    s.addText(step.desc, {
      x: x + 0.5,
      y: yBase + 0.3,
      w: 3.8,
      h: 0.25,
      fontSize: 11,
      fontFace: T.FONT,
      color: T.MUTED,
    })
  })
}

// 15. Multi-Hop Request Path
function buildMultiHop(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, 'Multi-Hop: C -> B -> A')
  subheading(s, 'A request from Stack C reaches a service on Stack A through transit node B')

  // Flow boxes — 5 stages across the slide
  const yFlow = 1.5
  const bh = 0.6

  box(s, 'curl-client\n(Stack C)', 0.2, yFlow, 1.6, bh, T.ORANGE)
  arrow(s, 1.8, yFlow + 0.3, 2.1, yFlow + 0.3, { color: T.ORANGE })
  box(s, 'envoy-proxy-c\n(egress)', 2.1, yFlow, 1.6, bh, T.PURPLE)
  arrow(s, 3.7, yFlow + 0.3, 4.0, yFlow + 0.3, { color: T.PURPLE })
  box(s, 'envoy-proxy-b\n(transit)', 4.0, yFlow, 1.6, bh, T.PURPLE)
  arrow(s, 5.6, yFlow + 0.3, 5.9, yFlow + 0.3, { color: T.PURPLE })
  box(s, 'envoy-proxy-a\n(ingress)', 5.9, yFlow, 1.6, bh, T.PURPLE)
  arrow(s, 7.5, yFlow + 0.3, 7.8, yFlow + 0.3, { color: T.TEAL })
  box(s, 'books-a\n:8080', 7.8, yFlow, 1.4, bh, T.TEAL)

  // Network labels
  s.addText('envoy-mesh', {
    x: 2.5,
    y: yFlow + bh + 0.02,
    w: 5,
    h: 0.2,
    fontSize: 8,
    fontFace: T.MONO,
    color: T.PURPLE,
    align: 'center',
  })
  line(s, 2.1, yFlow + bh + 0.16, 7.5, yFlow + bh + 0.16, { color: T.PURPLE, dashed: true })

  // Port rewriting explanation
  s.addText('Port Rewriting at Each Hop', {
    x: 0.6,
    y: 2.55,
    w: 4,
    h: 0.3,
    fontSize: 14,
    fontFace: T.FONT,
    color: T.WHITE,
    bold: true,
  })

  // Port rewriting table — cleaner than a code block for this content
  themedTable(
    s,
    ['Node', 'nodePath', 'envoyPort', 'Target', 'Role'],
    [
      ['Stack C', '["node-b", "node-a"]', '10012', 'envoy-proxy-b:10012', 'Egress (2 hops)'],
      ['Stack B', '["node-a"]', '10001', 'envoy-proxy-a:10001', 'Transit'],
      ['Stack A', '[]', '10001', 'books:8080', 'Ingress (origin)'],
    ],
    0.6,
    2.9,
    8.8,
    { fontSize: 10 }
  )

  callout(
    s,
    'Each node re-advertises routes with its own egress port. The nodePath grows at each hop, enabling loop detection.',
    0.6,
    4.15,
    8.8,
    0.45,
    T.PURPLE
  )
}

// 16. Summary
function buildSummary(pres: PptxGenJS) {
  const s = pres.addSlide({ masterName: 'CONTENT' })
  heading(s, "Summary & What's Next")

  // Divider line between columns
  line(s, 5.0, 1.3, 5.0, 4.6, { color: T.BORDER, dashed: true })

  // What we built
  s.addText('What We Built', {
    x: 0.6,
    y: 1.15,
    w: 4,
    h: 0.35,
    fontSize: 16,
    fontFace: T.FONT,
    color: T.GREEN,
    bold: true,
  })
  const built = [
    'BGP-inspired service discovery (iBGP)',
    'Action/reducer event-sourced state',
    'ES384 JWT + Cedar authorization',
    'Envoy xDS data plane (LDS + CDS)',
    'Multi-hop cross-node routing',
    '3-stack demo with full isolation',
  ]
  built.forEach((item, i) => {
    s.addText(`\u2713  ${item}`, {
      x: 0.6,
      y: 1.6 + i * 0.4,
      w: 4.2,
      h: 0.34,
      fontSize: 13,
      fontFace: T.FONT,
      color: T.TEXT,
    })
  })

  // What's next
  s.addText("What's Next", {
    x: 5.3,
    y: 1.15,
    w: 4,
    h: 0.35,
    fontSize: 16,
    fontFace: T.FONT,
    color: T.BLUE,
    bold: true,
  })
  const next = [
    'mTLS channel binding (RFC 8705)',
    'eBGP for cross-domain federation',
    'RDS/EDS for advanced traffic mgmt',
    'Certificate rotation automation',
    'GraphQL federation over the mesh',
    'Keepalive / hold timer support',
  ]
  next.forEach((item, i) => {
    s.addText(`\u2192  ${item}`, {
      x: 5.3,
      y: 1.6 + i * 0.4,
      w: 4.3,
      h: 0.34,
      fontSize: 13,
      fontFace: T.FONT,
      color: T.TEXT,
    })
  })

  // Bottom tagline
  callout(
    s,
    'Catalyst Router — Distributed service mesh, one node at a time.',
    0.6,
    4.3,
    8.8,
    0.4,
    T.BLUE
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_16x9'
  pres.title = 'Catalyst Router'
  pres.author = 'Catalyst Team'
  pres.subject = 'Architecture & Demo Walkthrough'

  defineMasters(pres)

  buildTitle(pres)
  buildAgenda(pres)
  buildArchitecture(pres)
  buildBGPConcepts(pres)
  buildBGPProtocol(pres)
  buildRouteTable(pres)
  buildAuthTokens(pres)
  buildPeerTokenExchange(pres)
  buildAuthGap(pres)
  buildEnvoyXDS(pres)
  buildEnvoyListeners(pres)
  buildDemoTopology(pres)
  buildNetworkIsolation(pres)
  buildDemoSteps(pres)
  buildMultiHop(pres)
  buildSummary(pres)

  const outPath = 'docker-compose/catalyst-router-deck.pptx'
  await pres.writeFile({ fileName: outPath })
  console.log(`Generated: ${outPath}`)
}

main()
