// Demo pages for the mock site. Every page ships a strict CSP: no inline
// script except the snippet (allowed by its SHA-256), no inline styles,
// Trusted Types enforced, and connections only to the mock gateway.
import { createHash } from "node:crypto";

const THEMES = new Set(["auto", "light", "dark"]);

function bootOptions(query, gatewayUrl, publishableKey) {
  const options = { publishableKey, gatewayUrl };
  if (THEMES.has(query.get("theme"))) options.theme = query.get("theme");
  if (query.get("position") === "left") options.position = "left";
  if (query.get("hideLauncher") === "1") options.hideLauncher = true;
  if (query.get("key") === "unknown")
    options.publishableKey = `dk_pk_${"Unknown".padEnd(32, "0")}`;
  return options;
}

const escapeScript = (text) => text.replace(/</g, "\\u003c");

export function pages({ path, query, gatewayUrl, publishableKey }) {
  if (path !== "/" && path !== "/hostile") return null;
  const hostile = path === "/hostile";
  const options = bootOptions(query, gatewayUrl, publishableKey);
  const snippet =
    escapeScript(`window.Daykeeper=window.Daykeeper||function(){(Daykeeper.q=Daykeeper.q||[]).push(arguments)};
Daykeeper('boot',${JSON.stringify(options)});
document.addEventListener('click',function(e){var t=e.target&&e.target.closest&&e.target.closest('[data-dk-new]');if(t){Daykeeper('showNewMessage','Hi! I have a question about my order.')}});`);
  const hash = createHash("sha256").update(snippet).digest("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'sha256-${hash}'`,
    `connect-src ${gatewayUrl}`,
    "style-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Fern &amp; Field — demo site${hostile ? " (hostile CSS)" : ""}</title>
<link rel="stylesheet" href="/site.css">
${hostile ? '<link rel="stylesheet" href="/hostile.css">' : ""}
<script>${snippet}</script>
<script async src="/messenger.js"></script>
</head>
<body>
<header class="nav"><strong>Fern &amp; Field</strong><nav><a href="#">Shop</a><a href="#">Journal</a><a href="#">Help</a></nav></header>
<main>
<h1>Linen for slow mornings.</h1>
<p class="lede">Washed flax bedding, made in small batches. This is a synthetic demo page for the Daykeeper Messenger mock gateway${hostile ? ", with deliberately hostile page CSS" : ""}.</p>
<p><button type="button" class="cta" data-dk-new>Ask a question</button></p>
<section class="grid">
<article><div class="swatch s1"></div><h2>Oat duvet cover</h2><p>From $180</p></article>
<article><div class="swatch s2"></div><h2>Clay sheet set</h2><p>From $140</p></article>
<article><div class="swatch s3"></div><h2>Moss pillowcases</h2><p>From $48</p></article>
</section>
<section class="copy">
<h2>Care</h2>
<p>Wash cool, dry low, and let the fabric soften with every cycle. Questions about sizing, delivery or returns? Our team answers in the chat.</p>
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. Donec ullamcorper nulla non metus auctor fringilla. Vestibulum id ligula porta felis euismod semper.</p>
<p>Cras mattis consectetur purus sit amet fermentum. Maecenas faucibus mollis interdum. Nullam quis risus eget urna mollis ornare vel eu leo. Aenean lacinia bibendum nulla sed consectetur.</p>
</section>
</main>
</body>
</html>`;
  return { html, csp: query.get("csp") === "0" ? null : csp };
}
