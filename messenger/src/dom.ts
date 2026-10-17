/**
 * Minimal DOM builders. Everything is created with createElement /
 * createElementNS / textContent, so the messenger never parses HTML and runs
 * under `require-trusted-types-for 'script'`.
 */
type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "class") element.className = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

const SVG = "http://www.w3.org/2000/svg";

/** 24×24 stroke icons (1.8px, round caps), paths only. */
const ICONS = {
  chat: [
    "M20 11.5c0 4.14-3.8 7.5-8.5 7.5-1.15 0-2.25-.2-3.25-.57L4 20l1.2-3.6C4.44 15.1 4 13.84 4 12.5 4 8.36 7.8 5 12.5 5S20 7.36 20 11.5Z",
  ],
  close: ["M6 6l12 12", "M18 6 6 18"],
  down: ["m6 9 6 6 6-6"],
  back: ["m15 6-6 6 6 6"],
  next: ["m9 6 6 6-6 6"],
  send: ["M12 19V5", "m5 12 7-7 7 7"],
  plus: ["M12 5v14", "M5 12h14"],
  alert: ["M12 8v5", "M12 16.5v.01", "M12 3 2.5 20h19L12 3Z"],
  offline: [
    "M3 3l18 18",
    "M8.5 16.5a5 5 0 0 1 7 0",
    "M5 12.9a10 10 0 0 1 5.2-2.7",
    "M14.8 10.3A10 10 0 0 1 19 12.9",
    "M2 9.4a15 15 0 0 1 4.3-2.6",
    "M10.6 5.1A15 15 0 0 1 22 9.4",
    "M12 20h.01",
  ],
  pause: ["M10 9v6", "M14 9v6", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"],
  sparkle: [
    "M12 3.5l1.9 5.1a2 2 0 0 0 1.2 1.2l5.1 1.9-5.1 1.9a2 2 0 0 0-1.2 1.2L12 20.5l-1.9-5.1a2 2 0 0 0-1.2-1.2L3.8 12.3l5.1-1.9a2 2 0 0 0 1.2-1.2L12 3.5Z",
  ],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(
  doc: Document,
  name: IconName,
  size = 24,
  className = "",
  strokeWidth = 1.8,
): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", name === "sparkle" ? "currentColor" : "none");
  svg.setAttribute("stroke", name === "sparkle" ? "none" : "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  for (const d of ICONS[name]) {
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** First letter (grapheme-ish) of a name, for monogram avatars. */
export function initial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "·";
  const first = Array.from(trimmed)[0] ?? "·";
  return first.toLocaleUpperCase();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const letters =
    parts.length === 1 ? [parts[0]] : [parts[0], parts[parts.length - 1]];
  return letters.map((part) => initial(part!)).join("");
}

/**
 * A person's round avatar: their initials, with their photo laid over them
 * when there is one. A photo that fails to load (blocked by the host page's
 * CSP, gone, offline) removes itself and the initials show through. The
 * photo is requested without a referrer, so the support origin never learns
 * which page the visitor is on.
 */
export function avatar(
  doc: Document,
  name: string,
  url: string | null,
  className = "",
): HTMLSpanElement {
  const span = h(
    doc,
    "span",
    {
      class: `avatar${className ? ` ${className}` : ""}`,
      "aria-hidden": "true",
    },
    initials(name),
  );
  if (url) {
    const img = h(doc, "img", {
      alt: "",
      referrerpolicy: "no-referrer",
      decoding: "async",
      draggable: "false",
    });
    img.addEventListener("error", () => img.remove(), { once: true });
    img.src = url;
    span.append(img);
  }
  return span;
}

/**
 * The inbox's round mark: the name's initial on the accent, replaced by the
 * company logo on a light disc once the logo has loaded. A logo that is slow,
 * blocked by the host page's CSP, gone or offline leaves the initial. Rebuilds
 * only when the name or logo changed; events from an image a rebuild already
 * dropped are ignored.
 */
export function markInto(
  doc: Document,
  mark: HTMLElement,
  name: string,
  logoUrl: string | null,
): void {
  const letter = initial(name || "D");
  const key = `${letter}\u0000${logoUrl ?? ""}`;
  if (mark.dataset.mark === key) return;
  mark.dataset.mark = key;
  mark.classList.remove("logo");
  mark.replaceChildren(letter);
  if (!logoUrl) return;
  const img = h(doc, "img", {
    alt: "",
    referrerpolicy: "no-referrer",
    decoding: "async",
    draggable: "false",
  });
  img.addEventListener(
    "load",
    () => {
      if (img.parentNode === mark) mark.classList.add("logo");
    },
    { once: true },
  );
  img.addEventListener(
    "error",
    () => {
      if (img.parentNode === mark) img.remove();
    },
    { once: true },
  );
  img.src = logoUrl;
  mark.append(img);
}

/** A new inbox mark; see markInto. */
export function inboxMark(
  doc: Document,
  name: string,
  logoUrl: string | null,
  className = "",
): HTMLSpanElement {
  const mark = h(doc, "span", {
    class: `monogram${className ? ` ${className}` : ""}`,
    "aria-hidden": "true",
  });
  markInto(doc, mark, name, logoUrl);
  return mark;
}

/** Up to three overlapping avatars, each tucked under the next. */
export function avatarStack(
  doc: Document,
  team: readonly { name: string; avatarUrl: string | null }[],
  className = "",
): HTMLSpanElement {
  const stack = h(doc, "span", {
    class: `stack${className ? ` ${className}` : ""}`,
    "aria-hidden": "true",
    "data-count": Math.min(team.length, 3),
  });
  for (const member of team.slice(0, 3))
    stack.append(avatar(doc, member.name, member.avatarUrl));
  return stack;
}
