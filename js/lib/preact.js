// Preact + htm in one ES module, loaded from a CDN so the app needs no build step.
// `html` is a tagged template that works like JSX: html`<div class=${cls}>${text}</div>`
export * from 'https://unpkg.com/htm@3.1.1/preact/standalone.module.js';
