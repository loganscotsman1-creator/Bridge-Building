# Steel Bridge Build Sequencer

A free, browser-based tool for planning, animating and comparing **build sequences** for the
AISC Student Steel Bridge Competition. Enter your bridge design, the site layout, your tools and
your crew, then try different build orders and see how long each one takes, who is busy when,
and how long someone has to hold each piece while it is aligned and bolted.

**Open the app:** https://loganscotsman1-creator.github.io/Bridge-Building/
(after GitHub Pages is turned on, see [Publishing](#publishing-the-link)).

No install and no account. It runs in the browser. Your work autosaves in that browser, and
**Save file** downloads the whole project (design, site, crew, plans) as a `.bridge.json` file
you can send to teammates.

---

## How to use it

Work through the tabs left to right. The app opens with an example bridge so you can try each
step before entering your own (**New** starts empty, **Example** reloads the sample).

### 1 · Bridge design
Bridges are usually two trusses joined by laterals, so the design is entered from views:

| View | What you do |
|---|---|
| **Side view · truss A** | Load a side-view screenshot from your CAD model, calibrate it, then trace the members and bolts. |
| **Side view · truss B** | Only shown if you untick *Truss B mirrors truss A*. Otherwise truss B is generated as a mirror copy (members, joints and bolts). |
| **Top view · laterals** | Draw the members that connect the two trusses. Pick the chord level first so clicks snap to top-chord or bottom-chord joints. Truss members are drawn at their real tube width so you can check thicknesses. |
| **Isometric references** | Add one or more isometric screenshots to compare against the 3D view the app builds from your annotations. |
| **Members & size check** | Every member with its length, weight, outline and whether it fits the size box (4 × 6 × 42 in by default, editable). |

Tools in the drawing views (keyboard shortcut in brackets):
- **Calibrate image (C):** click two points you know (both bearings works well), type their real
  coordinates in inches, Apply. x runs along the span, z is up (y is across, in the top view).
- **Draw member (M):** click joints in order. A member can bend through several joints (a
  welded piece). Click empty space to add a joint there. Finish with Enter, a double-click, or
  by clicking the last joint again.
- **Add bolt (B):** click a member near the joint where the bolt goes. Each bolt belongs to the
  nearest end joint of the segment it sits on. **Two or more bolts at one member end make that
  joint rigid** (it can cantilever). This threshold is a setting.
- **Add node (N)** / **Select (V):** drag joints to adjust, or type exact coordinates in the panel.
  Tick **Bearing** on the joints that rest on the footings.
- Scroll to zoom, drag empty space to pan, Delete removes the selection, Ctrl+Z undoes.

Members that don't fit the box are drawn red. "Fits tilted" means it only fits diagonally in the box.

### 2 · Site & zones
Lay out the ground: **staging yard**, **construction zone**, **ground assembly areas**, **no-go
zones** (the river, out of bounds) and optional **walkways**. Drag zones and their corners, drag
the bridge into place, and drag the start points of builders, tools, nuts & bolts, and every
member (members are stacked in the staging yard automatically until you move them).

Layouts change every year, so they can be saved and shared separately from projects:
- **Save to this browser** keeps a personal copy.
- **Download file** saves a `.site.json` you can send to someone or add to the shared library.
- **Shared library** lists every layout in this repo's [`library/sites`](library/sites) folder.
  See [Adding a layout to the shared library](#adding-a-layout-to-the-shared-library).

### 3 · Tools
Fastening tools (time per bolt, e.g. an impact driver), temporary supports (time to place and
remove, e.g. a jack stand under a joint), and anything else. Set how many of each you have.

### 4 · Crew & timing
- **Builders:** name, role, where they may be, and what they grab when the clock starts.
  - *Any task* adapts to whatever is needed. *Carrier / holder*, *Fastener* and *Ground
    assembler* only get those jobs when the program assigns work automatically.
  - *May be in* limits a builder to certain zones (e.g. one side of the river).
- **Timing:** walking and carrying speed, pick-up time, align time per joint, hand-bolt time,
  time to add a member to a ground assembly, gear-up time, the slowdown when a carrier fastens
  their own piece one-handed, and reach (how far someone can lean, e.g. over the river).

### 5 · Build sequence
The plan is an ordered list of steps:
- **Install** a member or assembly (pick it up, carry it, place it, hold it, align, bolt).
- **Build** a ground assembly (fetch its members to an assembly area and bolt them together).
  Drag build steps earlier so assemblies are made while other work goes on.
- **Place / remove a support** under a joint.

Drag steps (or use ↑ ↓) to reorder. Each step can name its carrier and fastener, or leave them
on *Auto* (whoever can get there first). *Carrier fastens (solo)* has the holder bolt their own
piece. **New assembly → Edit**, then click members in the 3D view to group them. **Duplicate**
copies the plan so you can try a variation, and **Compare plans** shows all plans' times side by side.

The build time updates on every change. Problems (a piece nobody can reach, a piece that never
becomes stable, everyone stuck holding, unbolted joints, and more) are listed under the 3D view;
click one to jump to its step.

### 6 · Simulate
Play back the build on the site plan and the 3D view, scrub the timeline, and read:
- the **Gantt chart** of every builder (walking, carrying, holding, aligning, fastening, ...)
- **holding time** per piece: how long someone held it, split into waiting for a fastener and
  aligning + bolting
- each builder's busy, idle and holding time

---

## The rules and physics it models

Competition rules built in:
- A builder carries **one member or assembly at a time**, plus any number of tools and nuts & bolts.
- Tools and hardware are picked up **after the clock starts** (the gear-up at the start of every builder's timeline).
- Assemblies are built on the ground **only in assembly areas**.
- Builders stay out of no-go zones and inside their allowed zones. Paths go around obstacles.

"Basic physics" ([`js/sim/stability.js`](js/sim/stability.js)): a placed piece is **stable** when
it is held at two different points by things that are already fixed (bearings, supports, or stable
pieces, through fastened bolts), or at one point by a rigid joint (≥ the rigid-bolt count). Two
pieces bolted together at a joint, each already pinned somewhere else and not in a straight line,
lock that joint in place, which is how a triangulated truss becomes rigid. Until a piece is stable
the builder who placed it keeps holding it. If every builder ends up holding something, the plan
stops and tells you why.

Not modelled (yet): a single truss tipping sideways, deflection and member strength, builders
bumping into each other, and penalties. These are good places to improve the program.

---

## Working on the code

Plain JavaScript modules with no build step and no `npm install`. [Preact](https://preactjs.com)
and [htm](https://github.com/developit/htm) (a JSX-like syntax) load from a CDN.

**Run it locally:** a local web server is needed (browsers block modules opened straight from disk):

```bash
python serve.py
```

then open http://localhost:8000. Edit a file, reload the page.

**Tests:** open http://localhost:8000/tests/ with the server running. Please keep them passing
and add one when you fix a bug.

| Folder / file | What's in it |
|---|---|
| `js/model/schema.js` | Project file format and defaults. Start here. |
| `js/model/geometry.js` | 3D model from the annotations, mirroring, size-box check, image calibration |
| `js/model/plan.js` | Units (member / assembly), staging layout, automatic order |
| `js/model/edit.js` | Edits that keep everything consistent (deleting a joint, mirroring) |
| `js/model/store.js`, `storage.js` | Undo/redo, autosave, files, the site library |
| `js/model/example.js` | The example bridge and site |
| `js/sim/simulate.js` | The build scheduler (who does what, when) |
| `js/sim/stability.js` | Which pieces stand on their own |
| `js/sim/grid.js` | Walking paths around zones |
| `js/sim/playback.js` | Where everything is at time *t* (for the animation) |
| `js/ui/*.js` | One file per tab, plus the drawing canvases (`Annotator`, `PlanView`, `IsoView`, `Gantt`) |
| `library/sites/` | Shared site layouts |

To suggest a change: fork the repo (or get added as a collaborator), make a branch, and open a
pull request. Describe what you changed and how you tested it.

### Adding a layout to the shared library
1. In the app, lay out the site and click **Site → Download file**.
2. On GitHub, open [`library/sites`](library/sites) → **Add file → Upload files**, and upload it
   (name it something like `2027-official.site.json`).
3. Edit [`library/sites/index.json`](library/sites/index.json) and add an entry:
   ```json
   { "name": "2027 official layout", "year": "2027", "file": "2027-official.site.json", "description": "From the 2027 rules" }
   ```
4. Commit (or open a pull request). Everyone sees it under **Shared library** once it's merged.

### Publishing the link
The app is served by GitHub Pages straight from the repository, with no build step. A repo admin
turns it on once: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The
workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) then publishes the site
on every push to `main` (watch it under the repo's **Actions** tab). The link above works a
minute or two after each push.
