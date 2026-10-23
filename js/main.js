import { html, render } from './lib/preact.js';
import { setProject } from './model/store.js';
import { loadAutosave } from './model/storage.js';
import { normalizeProject } from './model/schema.js';
import { createExampleProject } from './model/example.js';
import { App } from './ui/App.js';

// Reopen whatever was last being worked on in this browser; first visit gets the example.
const saved = loadAutosave();
let project;
try {
  project = normalizeProject(saved || createExampleProject());
} catch (e) {
  console.error('Saved project could not be loaded, starting from the example', e);
  project = normalizeProject(createExampleProject());
}
setProject(project);
render(html`<${App} />`, document.getElementById('app'));
