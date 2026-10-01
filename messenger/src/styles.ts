/**
 * All messenger CSS. It lives in a closed shadow root, so nothing here can
 * leak out and host selectors cannot reach in. The host element itself is in
 * the page's tree, so every :host declaration is !important: inside a shadow
 * tree an important :host rule beats even `* { all: unset !important }` on the
 * page (CSS Scoping, cascade by tree context). Design tokens are declared on
 * `.dk`, not :host, because page rules could otherwise override custom
 * properties set on the host element.
 *
 * Daykeeper look: off-white #FCFBF9 and white surfaces, true-black text, black
 * pill buttons, generous radii, soft shadows, no outline borders. Fonts come
 * from the system (Satoshi if the page already has it); nothing is fetched.
 */
export const css = String.raw`
:host {
  all: initial !important;
  position: fixed !important;
  inset: auto !important;
  width: 0 !important;
  height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  transform: none !important;
  filter: none !important;
  contain: none !important;
  overflow: visible !important;
  pointer-events: none !important;
  z-index: var(--dk-z, 2147483000) !important;
}

.dk {
  --bg: #fcfbf9;
  --surface: #ffffff;
  --surface-2: #f4f2ee;
  --text: #000000;
  --muted: #5f5a53;
  --faint: #6f6960;
  --hairline: rgba(0, 0, 0, 0.06);
  --accent: #000000;
  --on-accent: #ffffff;
  --bubble-me: var(--accent);
  --on-bubble-me: var(--on-accent);
  --badge: #d4331f;
  --danger: #b42318;
  --focus: #000000;
  --shadow-panel: 0 24px 64px rgba(28, 22, 14, 0.16),
    0 4px 14px rgba(28, 22, 14, 0.06);
  --shadow-card: 0 1px 2px rgba(28, 22, 14, 0.04),
    0 8px 24px rgba(28, 22, 14, 0.06);
  --shadow-bubble: 0 1px 2px rgba(28, 22, 14, 0.06),
    0 2px 10px rgba(28, 22, 14, 0.04);
  --shadow-launcher: 0 10px 28px rgba(0, 0, 0, 0.22),
    0 2px 6px rgba(0, 0, 0, 0.12);
  --font: "Satoshi", ui-sans-serif, system-ui, -apple-system, "Segoe UI",
    "Helvetica Neue", Helvetica, Arial, sans-serif;
  --display: "Apple Garamond", "Iowan Old Style", "Palatino Linotype",
    Palatino, "Book Antiqua", Georgia, serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --gap: 20px;
  --vvh: 100dvh;
  --vvtop: 0px;
  color-scheme: light;
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.45;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

.dk[data-theme="dark"] {
  --bg: #0e0d0c;
  --surface: #171614;
  --surface-2: #211f1c;
  --text: #f5f3ef;
  --muted: #b3ada4;
  --faint: #8f897f;
  --hairline: rgba(255, 255, 255, 0.07);
  --accent: #f5f3ef;
  --on-accent: #0e0d0c;
  --badge: #ef5a45;
  --danger: #ff8a7a;
  --focus: #f5f3ef;
  --shadow-panel: 0 24px 64px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(255, 255, 255, 0.06);
  --shadow-card: 0 0 0 1px rgba(255, 255, 255, 0.04);
  --shadow-bubble: none;
  --shadow-launcher: 0 10px 28px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(255, 255, 255, 0.08);
  color-scheme: dark;
}

.dk *,
.dk *::before,
.dk *::after {
  box-sizing: border-box;
}

:where(.dk) button,
:where(.dk) textarea {
  font: inherit;
  color: inherit;
  letter-spacing: inherit;
}

:where(.dk) button {
  margin: 0;
  border: 0;
  background: none;
  padding: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.dk :focus {
  outline: none;
}

.dk [hidden]:not(.panel) {
  display: none !important;
}

.dk :focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.dk svg {
  display: block;
  flex: none;
}

.sr {
  position: absolute !important;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ---------- launcher ---------- */

.launcher {
  position: fixed;
  inset-block-end: var(--gap);
  inset-inline-end: var(--gap);
  width: 60px;
  height: 60px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-launcher);
  pointer-events: auto;
  transition: transform 200ms var(--ease), box-shadow 200ms var(--ease);
}

.dk[data-position="left"] .launcher,
.dk[data-position="left"] .panel {
  inset-inline-end: auto;
  inset-inline-start: var(--gap);
}

.launcher:hover {
  transform: scale(1.04);
}

.launcher:active {
  transform: scale(0.96);
}

.launcher .icon {
  grid-area: 1 / 1;
  transition: transform 220ms var(--ease), opacity 160ms var(--ease);
}

.launcher .icon-close {
  opacity: 0;
  transform: rotate(-60deg) scale(0.6);
}

.dk[data-open="true"] .launcher .icon-chat {
  opacity: 0;
  transform: rotate(60deg) scale(0.6);
}

.dk[data-open="true"] .launcher .icon-close {
  opacity: 1;
  transform: none;
}

.badge {
  position: absolute;
  inset-block-start: -3px;
  inset-inline-end: -3px;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--badge);
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
  line-height: 22px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px var(--bg);
  animation: pop 260ms var(--ease);
}

.badge[hidden] {
  display: none;
}

@keyframes pop {
  from {
    transform: scale(0.4);
    opacity: 0;
  }
}

/* ---------- panel ---------- */

.panel {
  position: fixed;
  inset-block-end: calc(var(--gap) + 76px);
  inset-inline-end: var(--gap);
  width: 400px;
  height: min(704px, calc(100dvh - var(--gap) - 100px));
  min-height: 360px;
  max-width: calc(100vw - 2 * var(--gap));
  border-radius: 26px;
  background: var(--bg);
  box-shadow: var(--shadow-panel);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto;
  transform-origin: bottom right;
  transition: opacity 180ms var(--ease), transform 220ms var(--ease),
    visibility 0s linear 0s;
}

.dk[data-position="left"] .panel {
  transform-origin: bottom left;
}

.dk[data-no-launcher="true"] .panel {
  inset-block-end: var(--gap);
  height: min(704px, calc(100dvh - 2 * var(--gap)));
}

.panel[hidden] {
  display: flex;
  visibility: hidden;
  opacity: 0;
  transform: translateY(12px) scale(0.98);
  pointer-events: none;
  transition: opacity 160ms var(--ease), transform 200ms var(--ease),
    visibility 0s linear 200ms;
}

.topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 64px;
  padding: 10px 10px 10px 16px;
  padding-inline: 16px 10px;
}

.view-thread .topbar {
  padding-inline-start: 6px;
  background: var(--bg);
  box-shadow: 0 1px 0 var(--hairline);
  position: relative;
  z-index: 1;
}

.topbar-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.topbar-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar-sub {
  display: block;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.icon-button {
  width: 44px;
  height: 44px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  color: var(--text);
  flex: none;
  transition: background-color 160ms var(--ease);
}

.icon-button:hover {
  background: var(--surface-2);
}

.monogram {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  flex: none;
  display: grid;
  place-items: center;
  background: var(--accent);
  color: var(--on-accent);
  font-family: var(--display);
  font-size: 18px;
  line-height: 1;
  padding-top: 2px;
  user-select: none;
}

.monogram.small {
  width: 28px;
  height: 28px;
  font-size: 14px;
}

.monogram.large {
  width: 52px;
  height: 52px;
  font-size: 26px;
}

.monogram.person {
  background: var(--surface-2);
  color: var(--text);
  font-family: var(--font);
  font-weight: 700;
  font-size: 12px;
  padding-top: 0;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--hairline) transparent;
  position: relative;
}

/* ---------- home ---------- */

.home {
  padding: 4px 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hero {
  padding: 18px 8px 16px;
}

.hero-title {
  margin: 0;
  font-family: var(--display);
  font-weight: 400;
  font-size: 34px;
  line-height: 1.08;
  letter-spacing: -0.01em;
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: pre-line;
}

.hero-title.long {
  font-size: 24px;
  line-height: 1.2;
}

.card {
  background: var(--surface);
  border-radius: 20px;
  box-shadow: var(--shadow-card);
}

.start {
  padding: 20px;
}

.card-title {
  margin: 0 0 4px;
  font-size: 15.5px;
  font-weight: 700;
  letter-spacing: -0.005em;
}

.card-body {
  margin: 0 0 16px;
  color: var(--muted);
  font-size: 14px;
}

.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 20px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
  font-size: 14.5px;
  letter-spacing: 0.005em;
  transition: transform 140ms var(--ease), opacity 140ms var(--ease);
}

.pill:hover {
  opacity: 0.88;
}

.pill:active {
  transform: scale(0.98);
}

.list-card {
  padding: 6px;
}

.list-heading {
  margin: 0;
  padding: 12px 12px 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--muted);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 10px 12px;
  border-radius: 14px;
  text-align: start;
  transition: background-color 140ms var(--ease);
}

.row:hover {
  background: var(--surface-2);
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-preview {
  display: block;
  font-size: 14.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row.unread .row-preview {
  font-weight: 700;
}

.row-meta {
  display: block;
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--badge);
  flex: none;
}

.chev {
  color: var(--faint);
}

.footer {
  padding: 4px 0 2px;
  text-align: center;
  font-size: 12px;
  color: var(--faint);
}

.footer a {
  color: inherit;
  text-decoration: none;
  font-weight: 500;
}

.footer a:hover {
  color: var(--text);
}

/* ---------- thread ---------- */

.thread {
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.intro {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 22px 16px 26px;
}

.intro-name {
  margin: 8px 0 0;
  font-size: 16px;
  font-weight: 700;
}

.intro-greeting {
  margin: 0;
  max-width: 300px;
  color: var(--muted);
  font-size: 14px;
  overflow-wrap: anywhere;
}

.messages {
  display: flex;
  flex-direction: column;
}

.history-load {
  align-self: center;
  min-height: 36px;
  margin: 8px 0 4px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.history-load:disabled {
  opacity: 0.65;
}

.history-status {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
  text-align: center;
}

.msg {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 100%;
  margin-top: 3px;
}

.msg.first {
  margin-top: 14px;
}

.msg.me {
  align-items: flex-end;
}

.author {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text);
  max-width: 100%;
}

.author-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.bubble {
  max-width: 82%;
  padding: 10px 14px;
  border-radius: 20px;
  background: var(--surface);
  box-shadow: var(--shadow-bubble);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 15px;
  line-height: 1.45;
}

.msg:not(.me):not(.first) .bubble {
  border-start-start-radius: 8px;
}

.msg:not(.me):not(.last) .bubble {
  border-end-start-radius: 8px;
}

.msg.me .bubble {
  background: var(--bubble-me);
  color: var(--on-bubble-me);
  box-shadow: none;
}

.msg.me:not(.first) .bubble {
  border-start-end-radius: 8px;
}

.msg.me:not(.last) .bubble {
  border-end-end-radius: 8px;
}

.msg.me.pending .bubble {
  opacity: 0.62;
}

.msg.me.failed .bubble {
  opacity: 0.9;
}

.bubble a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
}

.bubble code {
  font-family: var(--mono);
  font-size: 0.88em;
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--surface-2);
}

.msg.me .bubble code {
  background: rgba(127, 127, 127, 0.25);
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 5px 4px 0;
  font-size: 12px;
  color: var(--muted);
  min-height: 16px;
}

.meta[hidden] {
  display: none;
}

.meta.error {
  color: var(--danger);
  font-weight: 500;
}

.link-button {
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 2px;
  color: inherit;
  min-height: 32px;
  padding: 0 4px;
}

.system {
  align-self: center;
  max-width: 88%;
  margin: 16px 0 4px;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.jump {
  position: absolute;
  inset-inline: 0;
  margin-inline: auto;
  inset-block-end: 12px;
  width: max-content;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 700;
  box-shadow: var(--shadow-launcher);
}

.jump[hidden] {
  display: none;
}

.body-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

/* ---------- composer ---------- */

.composer {
  flex: none;
  padding: 10px 14px 14px;
  background: var(--bg);
}

.field {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 6px 6px 6px 16px;
  padding-inline: 16px 6px;
  border-radius: 24px;
  background: var(--surface);
  box-shadow: var(--shadow-card), 0 0 0 1px var(--hairline);
  transition: box-shadow 160ms var(--ease);
}

.field:focus-within {
  box-shadow: var(--shadow-card), 0 0 0 1px var(--text);
}

.field textarea {
  flex: 1;
  min-width: 0;
  display: block;
  margin: 0;
  border: 0;
  outline: none;
  background: transparent;
  resize: none;
  padding: 9px 0;
  min-height: 38px;
  max-height: 140px;
  font-size: 15px;
  line-height: 20px;
  color: var(--text);
  overflow-y: auto;
}

.field textarea::placeholder {
  color: var(--faint);
  opacity: 1;
}

.field textarea:focus-visible {
  outline: none;
}

.send {
  width: 38px;
  height: 38px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--accent);
  color: var(--on-accent);
  flex: none;
  transition: opacity 140ms var(--ease), transform 140ms var(--ease);
}

.send:disabled {
  opacity: 0.22;
  cursor: default;
}

.send:not(:disabled):active {
  transform: scale(0.94);
}

.composer-note {
  margin: 6px 8px 0;
  font-size: 12px;
  color: var(--muted);
  text-align: end;
}

.composer-note.error {
  color: var(--danger);
  text-align: start;
}

.composer-note[hidden] {
  display: none;
}

/* ---------- states ---------- */

.banner {
  flex: none;
  margin: 0 14px 6px;
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--surface-2);
  font-size: 13px;
  color: var(--text);
}

.banner[hidden] {
  display: none;
}

.state {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px 36px 48px;
  gap: 10px;
}

.state-icon {
  width: 56px;
  height: 56px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text);
  margin-bottom: 8px;
}

.state-title {
  margin: 0;
  font-family: var(--display);
  font-weight: 400;
  font-size: 26px;
  line-height: 1.15;
}

.state-body {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 14px;
  max-width: 280px;
}

.skeleton {
  padding: 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skel {
  height: 14px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    var(--surface-2) 0%,
    var(--surface) 50%,
    var(--surface-2) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.3s linear infinite;
}

.skel.block {
  height: 72px;
  border-radius: 20px;
}

@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}

/* ---------- small screens: full-screen sheet ---------- */

@media (max-width: 639.98px) {
  .panel {
    inset: 0;
    inset-block-start: var(--vvtop);
    inset-block-end: auto;
    width: 100vw;
    max-width: none;
    height: var(--vvh);
    min-height: 0;
    border-radius: 0;
    box-shadow: none;
    transform-origin: bottom center;
    padding-block-start: env(safe-area-inset-top);
    padding-inline: env(safe-area-inset-left) env(safe-area-inset-right);
  }

  .dk[data-position="left"] .panel {
    inset-inline-start: 0;
  }

  .dk[data-no-launcher="true"] .panel {
    height: var(--vvh);
    inset-block-end: auto;
  }

  .panel[hidden] {
    transform: translateY(24px);
  }

  .composer {
    padding-block-end: max(14px, env(safe-area-inset-bottom));
  }

  .field textarea {
    font-size: 16px;
  }

  .dk[data-open="true"] .launcher {
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
  }

  .hero-title {
    font-size: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dk *,
  .dk *::before,
  .dk *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}

@media (forced-colors: active) {
  .launcher,
  .pill,
  .send,
  .bubble,
  .card,
  .field {
    border: 1px solid CanvasText;
  }
}
`;
