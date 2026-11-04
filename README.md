# Steel Bridge Build Sequencer

A free, browser-based tool for planning, animating and comparing **build sequences** for the
AISC Student Steel Bridge Competition. Bring screenshots of the bridge you designed in your CAD
program, place box outlines over them to define the members and where the bolts go, set up your
tools and crew on this year's official site layout, then try different build orders and see how
long each one takes, what it costs, who is busy when, and how long someone has to hold each piece
while it is aligned and bolted.

**Open the app:** https://loganscotsman1-creator.github.io/Bridge-Building/

No install and no account. It runs in the browser. Your work autosaves in that browser, and
**Save file** downloads the whole project (members, site, crew, plans) as a `.bridge.json` file
you can send to teammates.

---

## How to use it

Work through the tabs left to right. The app opens with an example bridge on the 2027 site so you
can try each step before entering your own (**New** starts empty, **Example** reloads the sample).
A short click-through tutorial runs on your first visit; skip it, or replay it any time with the
**Tutorial** button in the header. (Its steps live in [`js/ui/Tour.js`](js/ui/Tour.js); edit the
text there when the app changes.)

### 1 · Members & bolts (from your screenshots)
Your bridge is already designed in another program; this tab turns screenshots of it into the
pieces the simulator works with. **Every member is a box outline** no bigger than the rule's size
box (3'-6" × 6" × 4" in 2027, rule 8.2.2.2), and **everything inside one box is one welded, rigid
member**. Bridges are usually two trusses joined by laterals, so you mark up a few views:

| View | Screenshot to use |
|---|---|
| **Side view** | A side elevation of one truss. If the other truss is a mirror image (the usual case), that's all you need: truss B is copied automatically, boxes and bolts included. |
| **Side view · truss B** | Only shown if you untick *Truss B mirrors truss A* (Bridge settings). Mark up the second truss the same way. |
| **Top view · laterals** | A plan view. The trusses appear on it automatically; you only place the laterals between them. |
| **Isometric screenshots** | One or more for reference, shown next to the 3D view built from your markup. If they don't match, a box is placed wrong. |
| **Member list** | Every member's size, weight, connections and bolts. |
| **Connections** | Every place two members touch, each with its own align time and time per bolt if the defaults don't fit (leave empty for the default), and whether it holds on bolts that are only inserted. Truss B copies use truss A's times. |

Before anything else, tab 1 asks **how far apart your footing supports are** (where the bridge
stands on the two footings, e.g. pier centers; 22'-0" by default). Your supports are centered on
the site's footings. Change it later in Bridge settings.

Each view then has a checklist on the right that walks you through it:

1. **Add the screenshot:** drag it onto the canvas, paste it with **Ctrl+V** straight from a
   screen-capture tool, or choose a file.
2. **Set the scale (S):** click the **west footing support**, then the **east** one, on the
   screenshot. The screenshot is scaled and moved so those two points sit the footing distance
   apart at ground level, on the program's footings. (In the top view, click truss A at each
   support. "Use two other points instead" lets you type coordinates for any two points.)
3. **Member boxes (M)**, one tool for everything:
   - **Draw:** drag on empty space along a member in the screenshot to drop a box over it, or
     click to stamp a full-size box. While you draw, the box **snaps edge-to-edge** to the boxes
     and footings around it (pink guide lines), squares up to vertical/horizontal/neighbours'
     angles, and its start snaps onto a nearby corner or edge.
   - **Edit:** click a box to select it and drag to move it (it snaps edge-to-edge again). Drag
     the **square edge handles** to push/pull that edge, the **corner nodes** to reshape the box
     (any shape is allowed as long as it still fits the size box; one that doesn't is shown in
     red and refused), and the round handle to rotate it. Drag a **"+" node** in the middle of an
     edge to add a corner there, for example to give a chord a gusset tab or a notch that makes
     more surfaces to connect to; double-click a corner to remove it. Notched (non-convex) shapes
     work too, as long as the outline doesn't cross itself. Click empty space to deselect.
   - Arrow keys nudge, R turns 90°, Ctrl+D copies, Delete removes, Shift while dragging turns
     snapping off, right-drag or Space+drag pans. You can pan in the middle of a drag too: hold
     Space or the right mouse button while moving a box, or carry it to the canvas edge and the
     view scrolls along.
   - **Lateral heights:** in the top view, select a lateral and set its height in the toolbar
     (type it, use ▲/▼ or PageUp/PageDown, or pick a truss member's level) any time after
     placing it.
   - **Boxes are 3D.** All three sizes together must fit the size box, whichever way they run. To
     make a member that goes across the bridge, draw a small box on the side view (say 6 × 4),
     then select it in the top view and drag its square handles across: it can reach 42 in
     because the other two sizes leave that much. A 30 × 4 box could only go 6 across, and a
     30 × 6 only 4. A member that reaches the other truss is one piece: it gets no mirror copy,
     and it connects to both trusses like a lateral.
4. **Place bolts (B):** wherever two boxes touch, the app shows a green line (edges snapped
   together) or a green area (boxes overlapping, e.g. a diagonal lapped onto a chord's gusset).
   Click anywhere on it to put a bolt there; bolts snap to ¼" steps along the edge. Orange means
   the boxes touch but have no bolt yet, which rule 9.5.1 doesn't allow. **Auto-fill** puts N
   bolts on every connection that has none. Where three or more boxes overlap, one click puts a
   single bolt through all of them (marked ×3, ×4…); it holds every connection in the stack and
   is fastened once. Select it to choose **when it goes in**: as soon as two of the members are
   joined, once all of them are in place, or when a particular member is placed. Until then it
   doesn't hold anything, so a piece may have to be held longer. A selected bolt also shows the
   time fields of each connection it's on. Tick **Holds with the bolt just inserted** where the
   bridge can rest on a bolt before its nut is on: it's pushed in quickly (Crew → Timing), the
   bridge counts it as connected, and it shows as only partly connected until a builder comes
   back to fasten it (its nut step in tab 5). A connection with **two or more bolts is rigid** (it
   can cantilever); the threshold is in Bridge settings.
5. **Check footing supports (F):** members whose bottom sits on a footing are found
   automatically; click a member to mark or unmark it by hand.

### 2 · Site & zones
The **2027 official layout** from the Site Plan Diagram is set up out of the box: west staging
yard (tools, nuts & bolts and builders areas), west construction zone with its footing, riverbank,
river, east construction zone with its footing, transportation zone, and east staging yard
(members, builders, nuts & bolts and tools areas). Adjust it for local conditions (for example the
host may shorten the transportation zone), and drag the bridge, builders, tools and members to
where they start (members are stacked in the members area until you move them; when there are too many to
lie side by side they're drawn overlapping so they all stay inside it).

**Competition rules** (in the same tab) holds the numbers that change each year: member box size,
most builders, most members per assembly, where assemblies are made, time limits and the
construction cost formula.

Layouts and their rules change every year, so they're saved and shared together, separately from
projects:
- **Save to this browser** keeps a personal copy.
- **Download file** saves a `.site.json` you can send to someone or add to the shared library.
- **Shared library** lists every layout in this repo's [`library/sites`](library/sites) folder.
  See [Adding next year's layout](#adding-next-years-layout).
- **Reset to 2027 layout** puts the official layout back.

### 3 · Tools
A tool can list the **pieces it's assembled from** (each with a time); a builder then needs an
"assemble a tool" step before it can be used. Fastening tools (time to fasten a nut, e.g. an impact driver), temporary supports (time to place and
remove, e.g. a jack stand under a member), and anything else. Builders can't cross the river to
fetch a tool, so give each side its own.

### 4 · Crew & timing
- **Builders** (at most 6 in 2027): name, which **side of the river** they work from, and what
  they grab when the clock starts. There are no roles: what each builder does is set step by step
  in tab 5.
  - *May be in* can limit a builder to certain zones.
- **Timing:** walking and carrying speed, pick-up / hand-off time, align time per connection, time
  to place a bolt, time to fasten a nut by hand, **align and nut times in the staging yard** (for
  making assemblies, when they differ from the bridge), gear-up time, the slowdown when
  multitasking, reach, and **hand-off distance** (how far apart two builders can stand and still
  pass a piece across the river).
- **Bolts carried:** how many bolts each builder takes at the start (empty = as many as they
  need). The Simulate tab counts them down and warns if someone runs out.

### 5 · Build sequence
The plan is built **step by step**. Each step is one task for one builder:

- **Run a piece or assembly to the river** to hand off.
- **Receive a piece or assembly and run it to its place.** With nobody running it to the river,
  the builder picks it up from where it's staged.
- **Support the bridge in place**: until it stands without them, or for a set time.
- **Place a bolt in a member**: at the bridge, in the staging yard (making an assembly), or while
  that member is being run to its place.
- **Place and fasten a nut on a bolt**: at the bridge or in the staging yard. Choose a connection
  and all its bolts, or one bolt.
- **Assemble a tool** from the pieces listed in the Tools tab.
- **Pass a tool to another builder.**
- **Other task**: write in what it is and how long it takes.
- **Place or remove a support tool** (a jack stand) under a member.

Each builder does their steps in list order, starting each one as soon as they're free and what it
needs is ready: a receiver waits at the river for the runner, a nut waits for its bolt, a support
waits for its piece to be placed. So steps by different builders overlap on their own. Drag steps
(or use ↑ ↓) to reorder them. If a plan can never finish, it tells you who is stuck and on what.

**Multitasking:** tick *At the same time as their previous step* on any step. It starts when the
builder's previous step starts and shares their time, for example fastening a nut while supporting
the bridge, or placing a bolt in a member while running it to its place. It takes longer by the
slowdown in Crew → Timing, the builder doesn't walk for it, and their next normal step waits for
both.

**The timeline** under the list is adjustable. Drag the right end of a support bar (or an "other
task" bar) to change how long it lasts. Click a support bar and use **Hand over to someone else** to
have another builder take over once they've finished another step; the first builder lets go at
that moment and moves on. Letting go too soon shows up as a piece that would fall. The timeline in
the Simulate tab can be adjusted the same way.

**Auto-build plan** fills in a working plan to edit from: footings first, west to east, trusses
before laterals, using whoever can get there soonest (builders with a fastening tool fasten, others
carry). Plans saved before step-by-step planning are converted this way when opened. Which pieces
are assemblies, the staging layout and the times all carry through. **Duplicate** copies a plan so
you can try a variation, and **Compare plans** shows every plan's time and construction cost side
by side.

**Making assemblies:** click 2–3 pieces in the 3D view (they turn yellow), then **Make
assembly**. Each assembly gets its own color. Its bolts and nuts are steps "in the staging yard",
and it can't be picked up until every nut is on. **Edit** on an assembly card lets you click pieces
in or out of it. Every piece in the 3D views is labeled with its name (**Names** hides them); scroll
to zoom in where they're crowded, and drag to rotate.

The build time and construction cost update on every change. Problems are listed under the 3D
view; click one to jump to its step.

### 6 · Staging
Plan where every member lies. Drag members from the list onto the yard, drag them around (they
snap together; Shift places freely), and turn them with R. A member can sit any way up: rather than
a full 3D shape, it switches between three simple views as seen from above, with the buttons on the
selected member or the V key (also while dragging it in):
- **Side:** lying flat, showing its outline from tab 1.
- **Top:** lying on its edge, covering its length × its size across the bridge.
- **Front:** standing on end, covering just its depth × its size across the bridge.

The view only changes what the member covers on the ground and whether assembly pieces touch. It
doesn't change the time to pick it up. Members you haven't placed stay stacked
automatically in the members area. For **assemblies**, place the members touching where they bolt
(or press **Lay out** to put them together the way they're built): a green dot marks each touching
connection, and it uses the shorter "staged touching" times. Any connection can have its own align
and per-bolt time here.

### 7 · Simulate
Bolts are animated: each one travels from the builder putting it in to its spot and is fastened
there. Across the bridge, green dots are fastened, amber rings are only inserted (and their members
get an amber outline, since they're only partly connected), and small gray rings aren't in yet. The
toolbar keeps a running count, and each builder shows how many bolts they have left.

Play back the build on the site plan and the 3D view, scrub the timeline, and read:
- the **Gantt chart** of every builder (walking, carrying, handing off, holding, aligning,
  fastening, ...)
- **holding time** per piece: how long someone held it, split into waiting for a fastener and
  aligning + bolting
- each builder's busy, idle and holding time, how many pieces were handed across, and the
  construction cost

---

## The rules and physics it models

Rule numbers are from the 2027 rules; the numbers themselves live in the site's rules settings so
they can be updated for a new year.

- **8.2.2.2** every member fits the size box: box outlines can't be made bigger than it.
- **9.5.1** every place two members touch needs a connection: touching boxes without a bolt are
  flagged.
- **10.2.2** at most 6 builders.
- **10.3.6** builders never cross the river (the river spans the whole site, so each builder
  stays on their side); members start in the east staging yard, so pieces for the west side are
  **handed across** by a builder on each bank.
- **10.3.7** assemblies are 2–3 members, made only in a staging yard, where their members are
  staged.
- **10.3.8** a builder outside the staging yard carries one member or assembly at a time (plus
  any tools and nuts & bolts).
- **10.3.11** each constructed portion starts on a footing: a piece that touches neither a footing
  nor anything installed is an error.
- **10.3.12** builders touch the bridge only while standing in a construction zone, on a footing
  or on the riverbank.
- **10.3.14** no part of the bridge in the transportation zone or a staging yard.
- **10.4.2** a support placed in the river is flagged as an accident.
- **10.6** tools, nuts & bolts are picked up after the clock starts; members, tools and builders
  should start in their staging-yard areas.
- **10.8** over 30 minutes is flagged (scored as 180 minutes), over 45 minutes is halted.
- **10.9.1** builders finish in a staging yard and supports are picked back up.
- **6.2.5** construction cost = minutes × builders × $172,500 × 0.8 (with 4 or more builders).

"Basic physics" ([`js/sim/stability.js`](js/sim/stability.js)): pieces joined by rigid
connections move together as one body. A body is **stable** when it is held at two different
points by things that are already fixed (footings, supports, or stable pieces, through fastened
bolts), or at one point by a rigid connection. Two bodies pinned together, each already held
somewhere else and not in a straight line, lock that connection in place, which is how a
triangulated truss becomes rigid. A piece that isn't stable and that nobody is supporting would fall, and the plan says so. A held piece counts as fixed, so it can hold up whatever is bolted to it: once a lateral is
bolted to both trusses, the one builder holding the lateral holds both sides up, and the builders
holding the truss pieces let go (the holding table shows "then held up through L-1"). Supports set to last until the piece stands let go whenever everything stays up without them, with
the builder holding the newest piece keeping hold. Timed supports keep to their time.

A bolt that's only inserted counts as connected for all of this: you've said the bridge can rest
on it there.

Not modelled (yet): a single truss tipping sideways, deflection and member strength, clearances
and stringer checks (9.3), builders bumping into each other, and accident time penalties. These
are good places to improve the program.

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
| `js/model/schema.js` | Project file format, zone types and defaults. Start here. |
| `js/model/rules2027.js` | The 2027 site layout and rule numbers |
| `js/model/geometry.js` | Box members → 3D model, where boxes touch, mirroring, image calibration |
| `js/model/plan.js` | Units (member / assembly), staging layout, automatic order |
| `js/model/edit.js` | Edits that keep everything consistent (deleting, mirroring, auto-fill bolts) |
| `js/model/store.js`, `storage.js` | Undo/redo, autosave, files, the site library |
| `js/model/example.js` | The example bridge |
| `js/sim/simulate.js` | The build scheduler (who does what, when, and the rule checks) |
| `js/sim/stability.js` | Which pieces stand on their own |
| `js/sim/grid.js` | Walking paths, the two sides of the river, hand-off spots |
| `js/sim/playback.js` | Where everything is at time *t* (for the animation) |
| `js/ui/snap.js` | Box snapping |
| `js/ui/*.js` | One file per tab, plus the drawing canvases (`Annotator`, `PlanView`, `IsoView`, `Gantt`) |
| `library/sites/` | Shared site layouts (with their rules) |

To suggest a change: fork the repo (or get added as a collaborator), make a branch, and open a
pull request. Describe what you changed and how you tested it.

### Adding next year's layout
1. In the app, open the Site tab, change the zones to match the new Site Plan Diagram and update
   **Competition rules**, then click **Download file**.
2. On GitHub, open [`library/sites`](library/sites) → **Add file → Upload files**, and upload it
   (name it something like `2028-official.site.json`).
3. Edit [`library/sites/index.json`](library/sites/index.json) and add an entry:
   ```json
   { "name": "2028 official layout", "year": "2028", "file": "2028-official.site.json", "description": "From the 2028 rules" }
   ```
4. Commit (or open a pull request). Everyone sees it under **Shared library** once it's merged.
   To make it the layout new projects start with, also update `js/model/rules2027.js` (or add a
   new file for the year and point `schema.js` at it).

### Publishing the link
The app is served by GitHub Pages straight from the repository, with no build step. The workflow
in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the site on every push
to `main` (watch it under the repo's **Actions** tab). The link above updates a minute or two
after each push.
