/**
 * Message text is untrusted. It is never parsed as HTML: this turns a small,
 * safe subset of the Markdown that AI and human agents commonly type into DOM
 * nodes built with createElement/textContent only.
 *
 * Supported: paragraphs and line breaks (via CSS pre-wrap), **bold**,
 * `inline code`, [label](https://…) links and bare http(s) URLs. Everything
 * else renders literally. Links open in a new tab without a referrer or
 * opener, and only http/https/mailto targets are ever linked.
 */

export type RichNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const TOKEN =
  /\*\*([^*\n][^*\n]*?)\*\*|`([^`\n]+)`|\[([^\]\n]{1,200})\]\(([^()\s]{1,2000})\)|((?:https?:\/\/|mailto:)[^\s<>"']{2,2000})/g;

export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url.href;
}

export function parseRichText(input: string): RichNode[] {
  const nodes: RichNode[] = [];
  const push = (node: RichNode) => {
    const last = nodes[nodes.length - 1];
    if (node.kind === "text" && last?.kind === "text") last.text += node.text;
    else if (node.text) nodes.push(node);
  };
  let cursor = 0;
  for (const match of input.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    push({ kind: "text", text: input.slice(cursor, index) });
    const [whole, bold, code, label, target, bare] = match;
    if (bold !== undefined) push({ kind: "bold", text: bold });
    else if (code !== undefined) push({ kind: "code", text: code });
    else if (label !== undefined && target !== undefined) {
      const href = safeHref(target);
      push(
        href
          ? { kind: "link", text: label, href }
          : { kind: "text", text: whole },
      );
    } else if (bare !== undefined) {
      // Trailing sentence punctuation is almost never part of the URL.
      const trimmed = bare.replace(/[.,;:!?)\]]+$/, "");
      const href = safeHref(trimmed);
      if (href) {
        push({ kind: "link", text: trimmed, href });
        push({ kind: "text", text: bare.slice(trimmed.length) });
      } else push({ kind: "text", text: bare });
    }
    cursor = index + whole.length;
  }
  push({ kind: "text", text: input.slice(cursor) });
  return nodes;
}

export function renderRichText(doc: Document, input: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const node of parseRichText(input)) {
    if (node.kind === "text") {
      fragment.append(doc.createTextNode(node.text));
    } else if (node.kind === "bold") {
      const strong = doc.createElement("strong");
      strong.textContent = node.text;
      fragment.append(strong);
    } else if (node.kind === "code") {
      const code = doc.createElement("code");
      code.textContent = node.text;
      fragment.append(code);
    } else {
      const link = doc.createElement("a");
      link.href = node.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer nofollow ugc";
      link.referrerPolicy = "no-referrer";
      link.textContent = node.text;
      fragment.append(link);
    }
  }
  return fragment;
}
