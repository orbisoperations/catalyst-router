# Live Topology Constellation

[Three.js](https://threejs.org/) is fun and festive. Everyone needs more whimsy. People also often process and retain information visually at higher levels. So here we have a standalone Three.js demo that visualizes a Catalyst-style mesh with fake streaming metrics. This idea can be expanded upon for future user interface.

Built as a design exploration for future UI, four interconnected nodes orbit in a 3D star field, each running gateway, envoy, orchestrator, auth, routing, and telemetry components that report health, latency, throughput, and jitter in real time.

## Quick start

Serve this directory with any static file server:

```bash
pnpm dlx serve .
```

Or with Python:

```bash
python3 -m http.server 4173
```

Then open the local URL printed to the terminal.

## What you'll see

- **4 mesh nodes** — West (edge), Core (control), East (edge), North (transit) — positioned in 3D space with arc links between them
- **12 orbiting components** — small spheres tethered to their parent node, each with independent health metrics
- **Live HUD panels** — left panel shows KPIs and events, right panel shows detail for the selected node or component
- **Inter-site links** with animated pulse particles traveling along quadratic bezier arcs
- **Health-reactive shaders** — each node core uses a custom lava/plasma shader that shifts color based on aggregated component health (green → amber → red)

## Interactions

| Input                     | Action                                              |
| ------------------------- | --------------------------------------------------- |
| Drag                      | Orbit the camera around the scene                   |
| Scroll wheel              | Zoom in / out                                       |
| Hover a node or component | Highlights it, shows tooltip metrics                |
| Click a node or component | Pins the selection in the detail panel              |
| **Team Personas** toggle  | Switches between technical labels and crew personas |

## Team Personas mode

Toggle "Team Personas" in the top bar to swap from infrastructure labels to a crew overlay. The names, titles, and statuses shown are sample data for demonstration purposes.

In this mode, inter-site links relabel to collaboration channels (pairing, review, handoff, mission sync) and crew status states rotate through "In Flow", "Debugging Rift", "Shipping", "On Call", and "Reviewing PRs".

## Architecture

```
index.html          ← single-file app, all CSS + JS inline
vendor/three/
  build/
    three.module.js ← Three.js ES module build
    three.core.js   ← Three.js core build
  addons/
    controls/
      OrbitControls.js
```

Everything runs client-side with no build step. The [Three.js](https://github.com/mrdoob/three.js) modules are vendored locally so the demo works fully offline — no CDN dependency.

## Key implementation details

- **Custom GLSL shaders** on each node core produce an animated lava/plasma effect with health-tinted emissive blending
- **Metric simulation** ticks every ~1.1s, randomizing component-level health/latency/throughput/jitter, then rolling up to site-level aggregates
- **Quadratic bezier arcs** connect sites with animated pulse meshes traveling the curve path
- **Canvas-generated textures** for node labels and link labels (rounded rect sprites)
- **Responsive layout** — three-column HUD collapses to stacked panels on narrow viewports

## Troubleshooting

If the 3D scene does not render, open browser DevTools Console and check for module or WebGL errors. The demo requires a browser with ES module and WebGL 2 support.
