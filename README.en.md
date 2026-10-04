# dsh-winscope

**English** | [简体中文](README.md)

A DSH web plugin that embeds [WinScope](https://source.android.com/docs/core/graphics/winscope)
(Android graphics debugging) into the DSH right sidebar as two independent
panels — **WinScope A** and **WinScope B** — and exposes a set of `winscope_*`
AI tools so the agent can read the loaded traces and drive the timeline.

Load two traces side by side (two devices, or a before/after capture), then ask
the agent to explain what changed between them.

## Features

- **The AI reads WinScope data directly.** WinScope's hierarchy trees, node
  properties, and timeline are exposed to the agent through tools, so it can
  list traces, read any node's properties, track how a property changes over
  time, and seek the timeline on its own — no manual screenshots or
  copy-pasting.
- **Two sidebar panels.** Each panel hosts its own WinScope iframe, so A and B
  keep independent trace sets, selections, and timeline positions.
- **Built-in ADB proxy.** The Python `winscope_proxy.py` flow is re-implemented
  in Node and served same-origin under `/winscope-proxy`. No separately running
  Python proxy and no cross-origin configuration are needed.
- **Agent tool bridge.** A long-poll + `postMessage` bridge forwards AI tool
  calls into the live WinScope UI, so the agent reads exactly what you see.
- **Bundled WinScope build.** A ready-to-serve WinScope build ships in the
  release tarball; an external build directory can be configured instead.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js >= 20 | Host half runs inside the DSH profile process. |
| `adb` on `PATH` | The only hard runtime dependency. Needed for device capture (`/devices`, `/start`, `/end`, `/dump`, `/fetch`); loading a trace from a file works without it. |
| DSH web profile | The plugin registers routes on `webServer` and tools on `tools`. |
| [dsh-better-sidebar](https://github.com/omdsh-dev/dsh-better-sidebar) | Optional. Without it the plugin loads fine but registers no sidebar tabs. |

## Install

The Git repository tracks **sources only** (`src/`, build config, manifests).
`lib/` (compiled output) and `winscope-dist/` (the bundled WinScope build) are
not committed — they are produced by the build and shipped in the release
tarball. Install the plugin from a release tarball, not from the Git repo:

```bash
# 1. download the tarball from the latest release
#    https://github.com/AQAeee/dsh-winscope/releases

# 2. add it to the web profile
dsh plugin --profile web add ./dsh-winscope-0.1.0.tgz
```

`cordis.patch.yml` inside the package declares the bundle row, so the profile
picks up the plugin automatically — no manual profile edits.

To publish to a registry under your own scope, build and pack from source:

```bash
npm install
npm run build          # compiles src/ -> lib/
npm pack               # produces dsh-winscope-<version>.tgz
```

`winscope-dist/` must exist at pack time (it is declared in `files`).

## Configuration

Config is passed through the profile's plugin row. Both keys are optional.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `winscopeDist` | `string` | `''` | Absolute path to an external WinScope build directory to serve. Empty means "serve the build bundled with this plugin". |
| `toolTimeoutMs` | `number` | `30000` | How long an AI tool call waits for the browser panels to answer before failing. |

Example — serve an external WinScope build from the profile patch layer:

```yaml
- id: dsh-winscope
  config:
    winscopeDist: /absolute/path/to/winscope/dist
```

## Usage

1. Open the right sidebar's `+` menu and pick **WinScope A** (and optionally
   **WinScope B**).
2. Wait for the panel badge to read `已连接 (connected)` — WinScope is an
   Angular app and takes a moment to boot.
3. Load a trace: upload a `.winscope` file inside the panel, or capture one from
   a connected device through the built-in proxy.
4. Ask the agent about it. For a comparison, load the second trace in
   **WinScope B** and tell the agent which panel to use:

   > Compare the visibleRegion of layer X in panel A and panel B around 12.5s.

## AI tools

Every tool targets one panel (`A` or `B`) and returns WinScope's answer as JSON.

| Tool | Purpose |
| --- | --- |
| `winscope_list_traces` | List loaded traces: trace type, source file, entry count, first/last timestamp (ns), dump flag. **Call this first** to discover the valid time ranges. |
| `winscope_get_position` | Read the panel's currently selected timeline position. |
| `winscope_get_hierarchy` | Hierarchy (or property) tree **skeleton** at a time — ids, names, child counts. |
| `winscope_get_hierarchy_range` | A series of hierarchy snapshots across a time range. |
| `winscope_get_properties` | Full property tree of one node at a time. |
| `winscope_get_property_timeline` | Track a single property of one node across a time range (`{timestampNs, present, value}` points). |
| `winscope_get_node_timeline` | Track several properties of one node across a time range. |
| `winscope_seek` | Move the panel's timeline to a timestamp (the UI follows). |

Two WinScope-specific caveats are baked into the tool descriptions:
node ids can be **unstable across snapshots** in `SURFACE_FLINGER` traces — pass
`node_name` as a fallback; and ranges should be kept narrow around the moment
of interest, since snapshots are sampled.

A typical investigation: `winscope_list_traces` → `winscope_get_hierarchy` →
`winscope_get_properties` → `winscope_get_property_timeline`.

## How it works

```
AI tool call (Node)
   │  Bridge.request()  ── queue
   ▼
GET /winscope-bridge/poll   (browser long-poll, ~15s)
   │  postMessage into the panel's WinScope iframe
   ▼
WinScope cross-tool response
   │  POST /winscope-bridge/respond
   ▼
Bridge.respond() ── resolves the tool promise
```

Routes registered on the DSH web server:

| Path | Purpose |
| --- | --- |
| `/winscope/*` | Static WinScope build (`index.html`, hashed JS, `trace_processor.wasm`). Path traversal is rejected; responses are `no-cache`. |
| `/winscope-bridge/*` | `poll`, `respond`, `heartbeat` — the AI tool bridge. A panel counts as online while heartbeats keep arriving (30s window). |
| `/winscope-proxy/*` | ADB proxy: `config`, `devices`, `checkwayland`, `status`, `fetch`, `start`, `end`, `dump`. |

The proxy authenticates every call but `config` with a `Winscope-Token` header.
The token is generated on first boot and persisted to
`~/.config/winscope/.token` (`%USERPROFILE%\.config\winscope\.token` on
Windows), reusing an existing token from the Python proxy if one is present.
`GET /winscope-proxy/config` hands the token to the browser so the iframe can
be built; the endpoint is deliberately unauthenticated and should not be
exposed beyond localhost.

## Development

```bash
npm install
npm run build       # tsdown: lib/index.js (host, ESM) + lib/client.js (browser)
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
```

Source layout:

| Path | Contents |
| --- | --- |
| `src/index.ts` | Host entry: web server routes, static serving, token handling, tool registration. |
| `src/tools.ts` | The eight `winscope_*` tool definitions. |
| `src/bridge.ts` | Host-side request queue, long-poll drain, response matching, heartbeat tracking. |
| `src/shared.ts` | Wire types shared by both halves, plus the WinScope `MsgType` ids. |
| `src/client/index.tsx` | Browser half: sidebar tab registration, iframe embedding, the poll/postMessage bridge. |
| `src/proxy/` | Node port of `winscope_proxy.py`: `adb`, `sessions`, `targets`, `traceConfigs`, `server`, `config`. |

Build notes: the host half is plain ESM with `@deepseek-ai/*` and `cordis` left
external (they resolve inside the profile). The client half is a CJS closure
bundle whose only externals are the platform seed modules, self-registering
under `window.__ModuleLoader__.load({ id: 'dsh-winscope', ... })` — that id must
equal the loader entry name in `cordis.patch.yml`.

WinScope's cross-tool message ids in `src/shared.ts` mirror
`winscope/src/cross_tool/messages.ts`; the proxy `VERSION` in
`src/proxy/config.ts` mirrors `ProxyConnection#VERSION`. Keep both in sync when
upgrading the bundled WinScope build.

## Credits

WinScope is an Android Open Source Project tool. The bundled build and the
`winscope_proxy.py` reference implementation it ports belong to that project.

## License

GPL-3.0-only. See [LICENSE](LICENSE).