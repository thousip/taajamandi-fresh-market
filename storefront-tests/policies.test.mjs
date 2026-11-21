// Policy pages (Razorpay website review): linked from the storefront footer, self-contained, and stating only
// owner-decided rules (21 Nov 2026): cancel until packing starts; same-day damaged/missing reports refunded;
// online refunds in 3–5 working days; delivery ₹30 below ₹249, free from ₹249.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const PAGES = ["terms.html", "privacy.html", "refunds.html", "shipping.html", "contact.html"];

test("storefront footer links every policy page", () => {
  const html = read("index.html");
  const footer = html.slice(html.indexOf('<footer class="site-footer">'), html.indexOf("</footer>"));
  for (const p of PAGES) assert.ok(footer.includes(`href="/${p}"`), `footer links /${p}`);
});

test("each policy page exists, has its own title, the support contact, links to the others, and no placeholders", () => {
  for (const p of PAGES) {
    const html = read(path.join("public", p));
    assert.match(html, /<title>[^<]+ · TaajaMandi<\/title>/, p);
    assert.match(html, /<meta name="viewport"/, p);
    assert.ok(html.includes("https://wa.me/917671913761"), `${p} shows the WhatsApp support number`);
    for (const q of PAGES) if (q !== p) assert.ok(html.includes(`href="/${q}"`), `${p} links /${q}`);
    assert.doesNotMatch(html, /TODO|TBD|\[[A-Z ]+\]|lorem/i, `${p} has no placeholders`);
    assert.doesNotMatch(html, /<script/i, `${p} runs no scripts`);
  }
});

test("policy pages state the owner's decisions", () => {
  const refunds = read("public/refunds.html"), shipping = read("public/shipping.html");
  assert.match(refunds, /until we start packing it/);
  assert.match(refunds, /on the day of delivery/);
  assert.match(refunds, /3–5 working days/);
  assert.match(shipping, /free for orders of ₹249 or more/);
  assert.match(shipping, /₹30/);
});
