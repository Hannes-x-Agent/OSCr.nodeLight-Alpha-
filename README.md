# OSCrnode Light 0.1A

[**Download for macOS — Apple Silicon**](https://github.com/Hannes-x-Agent/OSCr.nodeLight-Alpha-/releases/latest/download/OSCrnode-Light-0.1A-macOS-Apple-Silicon.zip) · [**Download for Windows — 64-bit**](https://github.com/Hannes-x-Agent/OSCr.nodeLight-Alpha-/releases/latest/download/OSCrnode-Light-0.1A-Windows-x64.zip)

A modular OSC control surface built with [osc.js](https://github.com/colinbdclark/osc.js/).

The app is distributed as a self-contained desktop download. No Node.js installation or terminal setup is needed to run a packaged build.

## Features

- Add unlimited slider, trigger-button, toggle-button, single-point XY, and two-point XY modules
- Editable and persistent control titles
- Compact zoom-safe responsive masonry grid: three columns on wide screens, two on medium screens, and one on narrow screens; shorter/collapsed cards pull later cards upward without overlapping
- Drag-to-reorder module layout with persisted order
- Per-module parameter, live-control, and movement locks: movement uses a red outline, parameter lock makes the card black while leaving its live control available, and the live-control lock makes the card red with its controls visibly subdued
- Minimal borderless lock icons, with the movement lock immediately beside the drag handle
- Per-module compact collapse mode that preserves the primary live control
- A separate deletion safety lock that starts locked on every launch
- Editable OSC addresses
- Editable slider minimum, maximum, step, float/integer type, and direct numeric value
- Editable trigger/toggle values and float/integer type
- Direct numeric entry for every XY coordinate
- Editable XY output scale and float/integer type
- Editable individual XY value names and paired-point names
- Together, paired, or individual multi-value OSC output
- Four storable position presets per XY module
- Persistent values, points, presets, modules, names, destination, zoom, and log visibility
- Add unlimited custom message senders
- Sticky side area with a live Devices list and Activity log, plus a shared show/hide toggle
- Devices list mirrors every module/custom sender and flashes green with its most recent locally sent OSC payload
- Green live and connected status indicators
- Exact supplied `OSCrnodeLightLogo.svg`, bundled with Geist font references
- Short compact Destination panel and tighter section spacing
- White fixed Destination/Add Module panels with slightly heavier black frames
- Collapse control anchored at the far-right edge of every module header
- Control-locked and fully locked modules use a bright-red background, white text, and subdued locked content
- Interface zoom from 70% to 140%
- Geist is bundled for the full interface and baked directly into the SVG logo for consistent rendering on Mac and Windows

## XY address modes

For a two-point pad with base address `/position`, value names `x1`, `y1`, `x2`, `y2`, and pair names `a`, `b`:

- Together: `/position [x1, y1, x2, y2]`
- Paired: `/position/a [x1, y1]` and `/position/b [x2, y2]`
- Individual: `/position/x1`, `/position/y1`, `/position/x2`, `/position/y2`

## Position presets

1. Move the XY point or points to the desired position.
2. Click **Store**.
3. Click **P1**, **P2**, **P3**, or **P4**.
4. Click that preset button normally to recall and transmit the saved values.

## Run from source

```sh
npm install
npm start
```

Then open <http://127.0.0.1:4175>.

## Build the Mac app

```sh
npm run package:mac
```

The Apple Silicon app is created at:

`dist/OSCrnode Light 0.1A-darwin-arm64/OSCrnode Light 0.1A.app`

## Build the Windows app

```sh
npm run package:win
```

The 64-bit Windows app is created at:

`dist/OSCrnode Light 0.1A-win32-x64/OSCrnode Light 0.1A.exe`

## Verify

```sh
npm run check
npm run verify
npm run verify:ui
```

The Windows package is built natively by the tagged-release GitHub workflow. It should still be launch-tested on a real Windows machine before production use.

Geist is bundled under the SIL Open Font License. Its license is at `assets/licenses/GEIST-LICENSE.txt`.
