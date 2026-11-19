// node --test scripts/write-env-config.test.mjs
// Verifies which Supabase project each kind of build selects, and that production can never be
// selected by a preview/development/local build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnvConfig, PRODUCTION_REF, QA_REF, QA_DEFAULT } from "./write-env-config.mjs";

const PROD_URL = `https://${PRODUCTION_REF}.supabase.co`;
const PROD_KEY = "sb_publishable__NZtJ8Oxla1t4zHNrwccFw_EeUjC2br";
const QA_URL = `https://${QA_REF}.supabase.co`;
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "write-env-config.mjs");

test("production build selects the production project", () => {
  const c = resolveEnvConfig({ VERCEL_ENV: "production", VITE_SUPABASE_URL: PROD_URL, VITE_SUPABASE_PUBLISHABLE_KEY: PROD_KEY });
  assert.equal(c.environment, "production");
  assert.equal(c.projectRef, PRODUCTION_REF);
  assert.equal(c.imagePublicBase, null);
  assert.ok(c.allowedHosts.includes("taajamandi.vercel.app"));
});

test("production build fails without configuration or with the QA project", () => {
  assert.throws(() => resolveEnvConfig({ VERCEL_ENV: "production" }), /needs VITE_SUPABASE_URL/);
  assert.throws(() => resolveEnvConfig({ VERCEL_ENV: "production", VITE_SUPABASE_URL: QA_URL, VITE_SUPABASE_PUBLISHABLE_KEY: QA_DEFAULT.publishableKey }), /must use project/);
});

for (const vercelEnv of ["preview", "development", "", "staging"]) {
  test(`${vercelEnv || "unset"} build selects QA and refuses production`, () => {
    const viaDefault = resolveEnvConfig({ VERCEL_ENV: vercelEnv });
    assert.equal(viaDefault.environment, "qa");
    assert.equal(viaDefault.projectRef, QA_REF);
    const viaEnv = resolveEnvConfig({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: QA_URL, VITE_SUPABASE_PUBLISHABLE_KEY: QA_DEFAULT.publishableKey });
    assert.equal(viaEnv.projectRef, QA_REF);
    assert.throws(() => resolveEnvConfig({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: PROD_URL, VITE_SUPABASE_PUBLISHABLE_KEY: PROD_KEY }), /production project; refusing/);
    assert.throws(() => resolveEnvConfig({ VERCEL_ENV: vercelEnv, VITE_SUPABASE_URL: "https://abcdefghijabcdefghij.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "x" }), /must use the QA project/);
  });
}

test("secret and service-role keys are refused", () => {
  assert.throws(() => resolveEnvConfig({ VERCEL_ENV: "production", VITE_SUPABASE_URL: PROD_URL, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_abc" }), /secret key/);
  const fakeServiceJwt = ["e30", Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url"), "sig"].join(".");
  assert.throws(() => resolveEnvConfig({ VERCEL_ENV: "preview", VITE_SUPABASE_URL: QA_URL, VITE_SUPABASE_PUBLISHABLE_KEY: fakeServiceJwt }), /service_role key/);
});

test("CLI writes window.TAAJA_ENV for preview and exits non-zero when a preview points at production", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taaja-env-"));
  const out = path.join(dir, "env-config.js");
  const base = { ...process.env, VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: "" };
  execFileSync(process.execPath, [script, "--out", out], { env: { ...base, VERCEL_ENV: "preview" }, stdio: "pipe" });
  const win = {};
  new Function("window", fs.readFileSync(out, "utf8"))(win);
  assert.equal(win.TAAJA_ENV.projectRef, QA_REF);
  assert.ok(Object.isFrozen(win.TAAJA_ENV));
  assert.throws(() => execFileSync(process.execPath, [script, "--out", out],
    { env: { ...base, VERCEL_ENV: "preview", VITE_SUPABASE_URL: PROD_URL, VITE_SUPABASE_PUBLISHABLE_KEY: PROD_KEY }, stdio: "pipe" }));
});
