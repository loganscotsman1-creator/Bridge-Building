// The tutorial: a brief intro to the whole program on a first visit, then a few tips the first time
// each tab is opened. Each step can highlight one part of the screen (found by its data-tour
// attribute). The header's Tutorial button shows the current tab's tips again.
import { html, useEffect, useLayoutEffect, useState } from '../lib/preact.js';

const SEEN_KEY = 'bss.toursSeen';

// `v`: raise a tour's number when its part of the program changes, and everyone sees that tour once
// more (and only that one).
export const TOURS = {
  intro: {
    v: 1, title: 'Welcome',
    steps: [
      {
        title: 'Welcome to the Build Sequencer',
        body: 'Plan how your team builds the bridge on competition day: mark up your bridge, set up your crew, then try build orders and watch them play out on this year\'s official site. An example bridge is loaded so you can try everything.',
      },
      {
        target: 'tabs',
        title: 'Work left to right',
        body: 'Each tab is one part of the setup. Most teams fill in tabs 1–4 once, then spend their time in 5, 6 and 7 trying different orders. A few tips appear the first time you open each tab.',
      },
      {
        target: 'file',
        title: 'Save and share',
        body: 'Your work autosaves in this browser. Save file downloads the project for a teammate, and Open… loads one. The Tutorial button shows a tab\'s tips again.',
      },
    ],
  },
  design: {
    v: 1, title: 'Members & bolts',
    steps: [
      {
        target: 'checklist',
        title: 'Follow the checklist',
        body: 'Drop in a side-view screenshot from your CAD program and click the two footing supports to scale it. Then put a box over each member and bolts where boxes touch. Each step goes green when it\'s done.',
      },
      {
        target: 'modes',
        title: 'Drawing boxes',
        body: 'Drag on empty space to draw a box, and drag its handles to resize, reshape or rotate it. Boxes are 3D: in the top view, a small box can be extended across the bridge to make a lateral. Ctrl+Z undoes anything.',
      },
    ],
  },
  site: {
    v: 1, title: 'Site & zones',
    steps: [
      {
        target: 'site-canvas',
        title: 'The site',
        body: 'The 2027 official layout is already set up. Adjust it for local conditions, and drag the bridge, builders and tools to where they start.',
      },
      {
        target: 'site-library',
        title: 'Next year\'s rules',
        body: 'The layout and the year\'s rule numbers are saved together. Save one to your browser, download it for a teammate, or load one from the shared library.',
      },
    ],
  },
  tools: {
    v: 1, title: 'Tools',
    steps: [
      {
        target: 'tools',
        title: 'Your tools',
        body: 'Add fastening tools with the time to fasten a nut, temporary supports like jack stands, and how many of each you have. A tool can list the pieces it\'s assembled from.',
      },
    ],
  },
  crew: {
    v: 1, title: 'Crew & timing',
    steps: [
      {
        target: 'crew',
        title: 'Your builders',
        body: 'One card per builder: which side of the river they work from, and what they grab when the clock starts. What they do is set in tab 5.',
      },
      {
        target: 'timing',
        title: 'Timing',
        body: 'How fast people move and how long each job takes. Time your practice builds and put the real numbers here.',
      },
    ],
  },
  sequence: {
    v: 1, title: 'Build sequence',
    steps: [
      {
        target: 'seq-palette',
        title: 'Drag tasks onto a builder',
        body: 'Drag a task onto a builder\'s row, and a pop-up asks which piece it\'s for. Drop on the lower half of a bar to do both at once. Make an assembly works the same way: click the pieces that go together.',
      },
      {
        target: 'seq-timeline',
        title: 'Adjust the timeline',
        body: 'Each builder works left to right, starting each step as soon as they can. Drag a bar to reorder it or give it to someone else, and drag the end of a support bar to change how long they hold on.',
      },
      {
        target: 'seq-checks',
        title: 'Nothing gets missed',
        body: 'These counts and the marks on the bars show what\'s still missing, and hovering over a bar says why it\'s flagged. Still to do, on the right, lists it all and can be dragged straight onto a builder.',
      },
    ],
  },
  staging: {
    v: 1, title: 'Staging',
    steps: [
      {
        target: 'staging-list',
        title: 'Lay out the yard',
        body: 'Drag members from this list onto the yard. Press V to switch between side, top and front views, and R to turn one. Until you place them, they\'re stacked automatically.',
      },
      {
        target: 'staging-assemblies',
        title: 'Faster assemblies',
        body: 'Place an assembly\'s members touching where they bolt, or press Lay out. Those connections need less lining up, and you can set their times here.',
      },
    ],
  },
  simulate: {
    v: 1, title: 'Simulate',
    steps: [
      {
        target: 'play',
        title: 'Watch it play out',
        body: 'Play the build, or drag the slider to any moment. Bolts fly from the builder placing them and turn green once fastened; ones only inserted stay as amber rings.',
      },
      {
        target: 'gantt',
        title: 'Who is doing what',
        body: 'One row per builder over time. Click anywhere to jump there. Below it, the tables show how long each piece had to be held, and why.',
      },
    ],
  },
};

// Which tour is due, given what's been seen ({tour id: version}): the intro comes first, then the
// tips for the tab that's open.
export function dueTour(tab, seen) {
  const due = (id) => TOURS[id] && (seen[id] ?? 0) < TOURS[id].v;
  if (due('intro')) return 'intro';
  return due(tab) ? tab : null;
}

export function toursSeen() {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY)) || {};
  } catch {
    // Storage that can't be read is treated as seen, so the tips don't appear on every visit.
    return Object.fromEntries(Object.entries(TOURS).map(([id, t]) => [id, t.v]));
  }
}

function markSeen(ids) {
  const seen = toursSeen();
  for (const id of ids) seen[id] = TOURS[id].v;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* private mode */ }
}

export function Tour({ id, replay = false, onClose, onOverview }) {
  const tour = TOURS[id];
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = tour.steps[i];
  const last = i === tour.steps.length - 1;
  const isIntro = id === 'intro';

  const close = () => { markSeen([id]); onClose(); };
  const noMore = () => { markSeen(Object.keys(TOURS)); onClose(); };

  // Find the highlighted element once it has rendered.
  useLayoutEffect(() => {
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

  return html`<div class="tour" role="dialog" aria-modal="true" aria-label=${isIntro ? 'Tutorial' : tour.title + ' tips'}>
    ${rect
      ? html`<div class="tour-hole" style=${{ left: rect.x - 6 + 'px', top: rect.y - 6 + 'px', width: rect.w + 12 + 'px', height: rect.h + 12 + 'px' }}></div>`
      : html`<div class="tour-shade"></div>`}
    <div class="tour-card" style=${style}>
      <div class="tour-count">${tour.title}${tour.steps.length > 1 ? ` · ${i + 1} of ${tour.steps.length}` : ''}</div>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
      <div class="row">
        ${replay
          ? !isIntro && html`<button class="link" onClick=${onOverview}>See the intro</button>`
          : html`<button class="link" title="Don't show any more tips. The Tutorial button still shows them." onClick=${noMore}>No more tips</button>`}
        <span class="spacer"></span>
        ${i > 0 && html`<button onClick=${() => setI(i - 1)}>Back</button>`}
        <button class="primary" onClick=${() => (last ? close() : setI(i + 1))}>${!last ? 'Next' : isIntro ? 'Get started' : 'Got it'}</button>
      </div>
    </div>
  </div>`;
}
