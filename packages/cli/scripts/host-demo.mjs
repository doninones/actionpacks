#!/usr/bin/env node
// Minimal "host" that consumes an exported ActionPacks bundle.
// Usage:
//   node scripts/host-demo.mjs \
//     --bundle ../../dist/it-ops-mcp \
//     --tool issues-basic@1.0.0:create_issue \
//     --file ../../samples/create_issue.ok.json \
//     --assume-yes

import fs from 'fs';
import path from 'path';
import process from 'process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--tool') out.tool = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--assume-yes') out.assumeYes = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function parseSelector(sel) {
  const i = sel.indexOf(':');
  if (i <= 0) throw new Error(`Invalid --tool "${sel}". Use <packId>:<toolName>`);
  return { packId: sel.slice(0, i), toolName: sel.slice(i + 1) };
}

const opts = parseArgs(process.argv);
if (!opts.bundle || !opts.tool || !opts.file) {
  console.error('Usage: --bundle <dir> --tool <pack@ver:tool> --file <payload.json> [--assume-yes]');
  process.exit(1);
}
const { packId, toolName } = parseSelector(opts.tool);

const bundleDir = path.resolve(process.cwd(), opts.bundle);
const manifestPath = path.join(bundleDir, 'actionpack.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`Not an ActionPacks bundle: missing ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pack = (manifest.packs || []).find(p => p.id === packId);
if (!pack) {
  console.error(`Pack ${packId} not found in manifest.`);
  process.exit(1);
}
const tool = (pack.tools || []).find(t => t.name === toolName);
if (!tool) {
  console.error(`Tool ${toolName} not found in ${packId}.`);
  process.exit(1);
}

const schemaPath = path.join(bundleDir, tool.schema);
if (!fs.existsSync(schemaPath)) {
  console.error(`Schema file missing: ${schemaPath}`);
  process.exit(1);
}
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

let payload;
try {
  payload = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), opts.file), 'utf8'));
} catch (e) {
  console.error(`Failed to read payload: ${(e && e.message) || e}`);
  process.exit(1);
}

// 1) Schema validation
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const ok = validate(payload);
const issues = [];
if (!ok) {
  for (const err of validate.errors || []) {
    const where = err.instancePath || '/';
    issues.push(`schema: ${where} ${err.message}`);
  }
}

// 2) Allowlist enforcement (from export manifest)
const allowlist = Array.isArray(tool.allowlist) ? tool.allowlist : [];
if (allowlist.length) {
  const bad = Object.keys(payload).filter(k => !allowlist.includes(k));
  if (bad.length) issues.push(`allowlist: unexpected fields ${bad.join(', ')}`);
}

// 3) Confirmation heuristic (host decides). If tool has obvious side effects => confirm.
const sideEffects = (tool.side_effects || []).map(s => String(s).toLowerCase());
const needsConfirm = sideEffects.some(s => ['send', 'create', 'update', 'delete', 'write', 'post'].includes(s));
const confirmMessage = `Proceed with ${toolName}?`;

// Status
let status = 'ok';
if (issues.length) status = 'blocked';
else if (needsConfirm && !opts.assumeYes) status = 'needs-confirmation';

const result = {
  status,
  pack: packId,
  tool: toolName,
  schema: path.relative(process.cwd(), schemaPath),
  allowlist,
  side_effects: sideEffects,
  confirm: { required: needsConfirm, message: confirmMessage },
  payload
};

console.log(JSON.stringify(result, null, 2));

if (issues.length) {
  console.log('\nIssues:');
  for (const i of issues) console.log(' -', i);
  process.exit(1);
}
if (needsConfirm && !opts.assumeYes) {
  console.log(`\n⚠️  Confirmation required: "${confirmMessage}" (pass --assume-yes)`);
  process.exit(2);
}

// Mock execution success
console.log('\n✅ Host accepted the call (mock execution).');
