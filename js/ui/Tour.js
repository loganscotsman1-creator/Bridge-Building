// A short click-through tutorial. Each step can switch tabs and highlight one part of the screen
// (found by its data-tour attribute). Shown once on a first visit; the header's Tutorial button
// replays it.
import { html, useEffect, useLayoutEffect, useState } from '../lib/preact.js';

const DONE_KEY = 'bss.tourDone.v2'; // bump when the tour changes enough that everyone should see it again

export const TOUR = [
  {
    tab: 'design',
    title: 'Welcome to the Build Sequencer',
    body: 'This tool helps your team plan how to build the bridge on competition day. Mark up screenshots of your bridge, set up your crew, then try build orders and watch them play out on this year\'s official site layout. An example bridge is loaded so you can follow along.',
  },
  {
    target: 'tabs',
    title: 'Work left to right',
    body: 'Each tab is one part of the setup. Most teams fill in tabs 1–4 once, then spend their time in 5 (Build sequence) and 6 (Simulate) trying different orders.',
  },
  {
    tab: 'design', target: 'canvas',
    title: '1 · Your bridge, from screenshots',
    body: 'Drop in a side-view screenshot from your CAD program (or paste it with Ctrl+V). Then place a box outline over each member: every box is at most the rule\'s 3\'-6" × 6" × 4" size box, and everything inside one box is one welded, rigid member.',
  },
  {
    tab: 'design', target: 'checklist',
    title: 'Follow the checklist',
    body: 'Set the scale, place member boxes (drag along a member, or click to stamp a full-size box; they snap edge-to-edge), put bolts where boxes touch, and mark which members stand on a footing. Each step goes green when it\'s done. Then do the top view for the laterals.',
  },
  {
    tab: 'design', target: 'modes',
    title: 'Markup tools',
    body: 'These buttons match the checklist. In Select, drag a box to move it, drag its handles to shorten, narrow or rotate it (never bigger than the size box). Each tool has a keyboard shortcut (hover to see it), and Ctrl+Z undoes anything.',
  },
  {
    tab: 'site', target: 'site-canvas',
    title: '2 · The site',
    body: 'The 2027 official layout is already set up: staging yards, construction zones, footings, riverbank, river and transportation zone. Adjust it for local conditions, and drag the bridge, builders, tools and members to where they start.',
  },
  {
    tab: 'site', target: 'site-library',
    title: 'Next year\'s rules',
    body: 'The layout and the year\'s rule numbers (box size, builders, assembly size, time limit, cost formula) are saved together. Save one to your browser, download it for a teammate, or load one from the team\'s shared library.',
  },
  {
    tab: 'tools', target: 'tools',
    title: '3 · Tools',
    body: 'Add fastening tools (with time per bolt) and temporary supports like jack stands (with time to place and remove), and how many of each you have.',
  },
  {
    tab: 'crew', target: 'crew',
    title: '4 · Crew',
    body: 'One card per builder (up to 6): a role (or "any task") and which tools and nuts & bolts they grab when the clock starts. Builders can\'t cross the river, so the side they start on is the side they work from; pieces are handed across.',
  },
  {
    tab: 'crew', target: 'timing',
    title: 'Timing',
    body: 'How fast people walk and carry, how long aligning a connection and fastening a bolt take, how far someone can reach and how far apart two builders can hand off a piece. Time your practice builds and put the real numbers here.',
  },
  {
    tab: 'sequence', target: 'steps',
    title: '5 · Build sequence',
    body: 'The build order. Drag steps to reorder them, or name who carries and who fastens each piece. Click a step to see the bridge at that point in the 3D view.',
  },
  {
    tab: 'sequence', target: 'assemblies',
    title: 'Assemblies and supports',
    body: 'Group 2–3 members into assemblies that are bolted together in the staging yard and carried in as one piece, and add steps that place or remove temporary supports.',
  },
  {
    tab: 'sequence', target: 'total',
    title: 'Instant feedback',
    body: 'Build time and construction cost update after every change, and rule problems (such as a piece that doesn\'t start on a footing, or everyone stuck holding) are listed under the 3D view. Duplicate a plan to compare variations.',
  },
  {
    tab: 'simulate', target: 'play',
    title: '6 · Watch it play out',
    body: 'Play the build on the site plan and the 3D view, or drag the slider to any moment.',
  },
  {
    tab: 'simulate', target: 'gantt',
    title: 'Who is doing what',
    body: 'One row per builder over time. Orange is holding a piece, yellow is aligning and fastening. Click anywhere to jump there. Below it, the holding-time table shows how long each piece had to be held, and why.',
  },
  {
    target: 'file',
    title: 'Save and share',
    body: 'Your work autosaves in this browser. "Save file" downloads the whole project for a teammate, "Open…" loads one, and "Example" brings back this sample. Replay this tutorial any time with the Tutorial button.',
  },
];

export function tourSeen() {
  try { return !!localStorage.getItem(DONE_KEY); } catch { return true; }
}

function markSeen() {
  try { localStorage.setItem(DONE_KEY, '1'); } catch { /* private mode */ }
}

export function Tour({ setTab, onClose }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = TOUR[i];
  const last = i === TOUR.length - 1;

  const close = () => { markSeen(); onClose(); };

  // Switch tab, then find the highlighted element once the tab has rendered.
  useLayoutEffect(() => {
    if (step.tab) setTab(step.tab);
    setRect(null);
    if (!step.target) return;
    let tries = 0, timer;
    const find = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { setRect({ x: r.left, y: r.top, w: r.width, h: r.height }); return; }
      }
      if (tries++ < 40) timer = setTimeout(find, 25);
    };
    timer = setTimeout(find, 0);
    return () => clearTimeout(timer);
  }, [i]);

  useEffect(() => {
    const onResize = () => {
      const el = step.target && document.querySelector(`[data-tour="${step.target}"]`);
      if (el) { const r = el.getBoundingClientRect(); setRect({ x: r.left, y: r.top, w: r.width, h: r.height }); }
    };
    // Capture keys first so the canvas shortcuts underneath don't also react.
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); last ? close() : setI(i + 1); }
      else if (e.key === 'ArrowLeft') { if (i > 0) setI(i - 1); }
      else return;
      e.stopPropagation();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('keydown', onKey, true); };
  });

  // Place the card next to the highlight, or in the middle for steps without one.
  const vw = window.innerWidth, vh = window.innerHeight;
  const cardW = Math.min(380, vw - 24);
  let style;
  if (rect) {
    const gap = 16, cardH = 230;
    const clampTop = (t) => Math.min(Math.max(12, t), vh - cardH - 12);
    const clampLeft = (l) => Math.min(Math.max(12, l), vw - cardW - 12);
    let top, left;
    if (rect.y + rect.h + gap + cardH < vh) { top = rect.y + rect.h + gap; left = clampLeft(rect.x + rect.w / 2 - cardW / 2); } // below
    else if (rect.y - gap - cardH > 0) { top = rect.y - gap - cardH; left = clampLeft(rect.x + rect.w / 2 - cardW / 2); } // above
    else if (rect.x - gap - cardW > 0) { left = rect.x - gap - cardW; top = clampTop(rect.y + 20); } // left of it
    else if (rect.x + rect.w + gap + cardW < vw) { left = rect.x + rect.w + gap; top = clampTop(rect.y + 20); } // right of it
    else { top = clampTop(rect.y + 20); left = clampLeft(rect.x + rect.w / 2 - cardW / 2); } // fills the screen: sit inside
    style = { top: top + 'px', left: left + 'px', width: cardW + 'px' };
  } else {
    style = { top: '50%', left: '50%', width: cardW + 'px', transform: 'translate(-50%, -50%)' };
  }

  return html`<div class="tour" role="dialog" aria-modal="true" aria-label="Tutorial">
    ${rect
      ? html`<div class="tour-hole" style=${{ left: rect.x - 6 + 'px', top: rect.y - 6 + 'px', width: rect.w + 12 + 'px', height: rect.h + 12 + 'px' }}></div>`
      : html`<div class="tour-shade"></div>`}
    <div class="tour-card" style=${style}>
      <div class="tour-count">${i + 1} of ${TOUR.length}</div>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
      <div class="tour-dots">${TOUR.map((_, k) => html`<i class=${k === i ? 'on' : ''} onClick=${() => setI(k)}></i>`)}</div>
      <div class="row">
        <button class="link" onClick=${close}>Skip tutorial</button>
        <span class="spacer"></span>
        ${i > 0 && html`<button onClick=${() => setI(i - 1)}>Back</button>`}
        <button class="primary" onClick=${() => (last ? close() : setI(i + 1))}>${last ? 'Finish' : i === 0 ? 'Show me around' : 'Next'}</button>
      </div>
    </div>
  </div>`;
}
