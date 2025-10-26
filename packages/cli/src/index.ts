#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const program = new Command();
program.name('ap').description('ActionPacks CLI (PoC)').version('0.4.0');

type CatalogIndex = { packs: { id: string; path: string }[] };
type StackFile = { name: string; packs: string[]; env?: string };
type LockFile = { createdAt: string; packs: { id: string; version: string; path: string }[] };

type PackMeta = {
  name?: string;
  capabilities?: string[];
  tools?: {
    name: string;
    schema: string; // relative path to JSON schema from pack root
    ['x-actionpack']?: {
      side_effects?: string[];
      allowlist_fields?: string[];
    };
  }[];
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
};

type Policies = {
  generatedAt?: string;
  stack?: string;
  rules: Array<{
    pack: string;
    tool: string;
    description?: string;
    confirm?: { message?: string; required?: boolean };
    allowlist?: string[];
    rateLimit?: { maxCalls: number; windowSec: number };
  }>;
};

function loadYaml<T = any>(p: string): T {
  const raw = fs.readFileSync(p, 'utf8');
  return yaml.load(raw) as T;
}
function saveYaml(p: string, obj: any) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(obj, { noRefs: true, lineWidth: 120 }), 'utf8');
}
function findCatalogRoot(preferred: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), preferred),
    path.resolve(process.cwd(), '..', '..', preferred), // monorepo root fallback
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.yaml'))) return c;
  }
  return null;
}
function resolveStackDir(p: string): string {
  const candidates = [
    path.resolve(process.cwd(), p),
    path.resolve(process.cwd(), '..', '..', p), // monorepo root fallback
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) || fs.existsSync(path.dirname(c))) return c;
  }
  return path.resolve(process.cwd(), '..', '..', p);
}
function parsePackId(packId: string) {
  const at = packId.lastIndexOf('@');
  if (at <= 0) return { name: packId, version: 'latest' };
  return { name: packId.slice(0, at), version: packId.slice(at + 1) };
}
function parseToolSelector(sel: string): { packId: string; toolName: string } {
  const i = sel.indexOf(':');
  if (i <= 0) {
    console.error(`Invalid --tool selector "${sel}". Use: <packId>:<toolName>`);
    process.exit(1);
  }
  return { packId: sel.slice(0, i), toolName: sel.slice(i + 1) };
}

/* ---------------------------
 * hello
 * ------------------------- */
program
  .command('hello')
  .description('sanity check')
  .action(() => console.log('hi 👋'));

/* ---------------------------
 * catalog list
 * ------------------------- */
const catalogCmd = program.command('catalog').description('Catalog operations');

catalogCmd
  .command('list')
  .description('List available packs from catalog/index.yaml')
  .option('--catalog <path>', 'Catalog root', 'catalog')
  .action((opts) => {
    const catalogRoot = findCatalogRoot(opts.catalog);
    if (!catalogRoot) {
      console.error('No catalog found (looked in ./catalog and ../../catalog)');
      process.exit(1);
    }
    const indexPath = path.join(catalogRoot, 'index.yaml');
    const idx = loadYaml<CatalogIndex>(indexPath);
    if (!idx?.packs?.length) {
      console.log('No packs found.');
      return;
    }
    console.log('Available packs:\n');
    for (const p of idx.packs) {
      let name = '';
      const packYaml = path.join(catalogRoot, p.path, 'pack.yaml');
      if (fs.existsSync(packYaml)) {
        try {
          const meta = loadYaml<{ name?: string }>(packYaml);
          name = meta?.name ?? '';
        } catch {
          // ignore
        }
      }
      console.log(`• ${p.id}${name ? ' — ' + name : ''}`);
    }
  });

/* ---------------------------
 * init stack
 * ------------------------- */
program
  .command('init')
  .argument('<stackPath>', 'Path to new stack directory (e.g., stacks/it-ops)')
  .option('--name <name>', 'Stack display name', 'My Stack')
  .option('--env <env>', 'Environment label', 'staging')
  .description('Initialize a new stack directory with stack.yaml')
  .action((stackPath, opts) => {
    const dir = resolveStackDir(stackPath);
    const stackFile = path.join(dir, 'stack.yaml');
    if (fs.existsSync(stackFile)) {
      console.log(`Stack already exists at ${stackFile}`);
      return;
    }
    const stack: StackFile = { name: opts.name, env: opts.env, packs: [] };
    saveYaml(stackFile, stack);
    console.log(`Created ${stackFile}`);
  });

/* ---------------------------
 * add pack to stack + update lock
 * ------------------------- */
program
  .command('add')
  .argument('<packId>', 'Pack ID, e.g., issues-basic@1.0.0')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .option('--catalog <path>', 'Catalog root', 'catalog')
  .description('Add a pack to a stack and update stack.lock.json')
  .action((packId, opts) => {
    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    if (!fs.existsSync(stackFile)) {
      console.error(`No stack at ${stackFile}. Run: ap init ${opts.stack}`);
      process.exit(1);
    }
    const stack = loadYaml<StackFile>(stackFile);
    stack.packs = stack.packs || [];

    if (!stack.packs.includes(packId)) {
      stack.packs.push(packId);
      saveYaml(stackFile, stack);
      console.log(`Added ${packId} to ${stackFile}`);
    } else {
      console.log(`${packId} already present in ${stackFile}`);
    }

    const lockPath = path.join(stackDir, 'stack.lock.json');
    const now = new Date().toISOString();
    let lock: LockFile = fs.existsSync(lockPath)
      ? JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      : { createdAt: now, packs: [] };

    const catalogRoot = findCatalogRoot(opts.catalog);
    if (!catalogRoot) {
      console.error('No catalog found (looked in ./catalog and ../../catalog)');
      process.exit(1);
    }
    const idx = loadYaml<CatalogIndex>(path.join(catalogRoot, 'index.yaml'));
    const hit = idx.packs.find((p) => p.id === packId);
    if (!hit) {
      console.error(`Pack ${packId} not found in catalog index.`);
      process.exit(1);
    }
    const { name, version } = parsePackId(packId);
    const resolvedPath = path.join(catalogRoot, hit.path.replace(/^catalog\//, ''));

    const existing = lock.packs.find(
      (p) => p.id === packId || (p.id.startsWith(name + '@') && p.version === version),
    );
    if (existing) {
      existing.id = packId;
      existing.version = version;
      existing.path = resolvedPath;
    } else {
      lock.packs.push({ id: packId, version, path: resolvedPath });
    }
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');
    console.log(`Updated ${lockPath}`);
  });

/* ---------------------------
 * policies suggest
 * ------------------------- */
program
  .command('policies')
  .description('Policies operations')
  .command('suggest')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .option('--catalog <path>', 'Catalog root', 'catalog')
  .option('--rateLimit <n>', 'Default calls per window per tool', '20')
  .option('--windowSec <s>', 'Rate limit window seconds', '60')
  .action((opts) => {
    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    const lockFile = path.join(stackDir, 'stack.lock.json');

    if (!fs.existsSync(stackFile) || !fs.existsSync(lockFile)) {
      console.error(`Missing stack and/or lock. Run 'ap init …' and 'ap add …' first.`);
      process.exit(1);
    }
    const stack = loadYaml<StackFile>(stackFile);
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockFile;

    const catalogRoot = findCatalogRoot(opts.catalog);
    if (!catalogRoot) {
      console.error('No catalog found (looked in ./catalog and ../../catalog)');
      process.exit(1);
    }

    const defaultLimit = Math.max(1, parseInt(String(opts.rateLimit), 10));
    const defaultWindow = Math.max(1, parseInt(String(opts.windowSec), 10));

    const out: Policies = {
      generatedAt: new Date().toISOString(),
      stack: stack.name || path.basename(stackDir),
      rules: [],
    };

    for (const p of lock.packs) {
      const packDir = p.path;
      const packYaml = path.join(packDir, 'pack.yaml');
      if (!fs.existsSync(packYaml)) {
        console.warn(`Warn: pack.yaml missing for ${p.id} at ${packDir}`);
        continue;
      }
      const meta = loadYaml<PackMeta>(packYaml);

      for (const tool of meta.tools || []) {
        const schemaPath = path.join(packDir, tool.schema);
        let schema: JsonSchema | null = null;
        if (fs.existsSync(schemaPath)) {
          try {
            schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
          } catch (e) {
            console.warn(`Warn: schema parse failed for ${schemaPath}: ${(e as Error).message}`);
          }
        }

        const se = (tool['x-actionpack']?.side_effects || []).map((s) => String(s).toLowerCase());
        const needsConfirm = se.some((s) =>
          ['send', 'create', 'update', 'delete', 'write', 'post'].includes(s),
        );

        const explicitAllow = tool['x-actionpack']?.allowlist_fields || [];
        const schemaProps = schema?.properties ? Object.keys(schema.properties) : [];
        const inferredAllow = schemaProps.filter(
          (k) => !/(password|secret|token|apikey|api_key|auth|bearer|credential)/i.test(k),
        );

        out.rules.push({
          pack: p.id,
          tool: tool.name,
          confirm: needsConfirm ? { message: `Proceed with ${tool.name}?`, required: true } : { required: false },
          allowlist: explicitAllow.length ? explicitAllow : inferredAllow,
          rateLimit: { maxCalls: defaultLimit, windowSec: defaultWindow },
          description: schema?.description,
        });
      }
    }

    const dest = path.join(stackDir, 'policies.yaml');
    saveYaml(dest, out);
    console.log(`Generated ${dest}`);
  });

/* ---------------------------
 * dry-run
 * ------------------------- */
program
  .command('dry-run')
  .requiredOption('--tool <packId:toolName>', 'Tool selector, e.g., issues-basic@1.0.0:create_issue')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .option('--catalog <path>', 'Catalog root', 'catalog')
  .option('--json <payload>', 'Inline JSON payload')
  .option('--file <path>', 'Path to a JSON file with the payload')
  .option('--assume-yes', 'Assume confirmations are approved', false)
  .option('--callsSoFar <n>', 'Simulate calls made in the current window', '0')
  .description('Validate input against schema, enforce policies, and print a no-side-effects call preview')
  .action((opts) => {
    const { packId, toolName } = parseToolSelector(opts.tool);

    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    const lockFile = path.join(stackDir, 'stack.lock.json');
    const policiesFile = path.join(stackDir, 'policies.yaml');

    if (!fs.existsSync(stackFile) || !fs.existsSync(lockFile)) {
      console.error(`Missing stack and/or lock. Run 'ap init …' and 'ap add …' first.`);
      process.exit(1);
    }
    if (!fs.existsSync(policiesFile)) {
      console.error(`Missing policies.yaml. Run: ap policies suggest --stack ${opts.stack}`);
      process.exit(1);
    }

    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockFile;
    const pol = loadYaml<Policies>(policiesFile);

    const packLocked = lock.packs.find((p) => p.id === packId);
    if (!packLocked) {
      console.error(`Pack ${packId} not present in lockfile. Did you run 'ap add ${packId}'?`);
      process.exit(1);
    }

    const packDir = packLocked.path;
    const packYaml = path.join(packDir, 'pack.yaml');
    if (!fs.existsSync(packYaml)) {
      console.error(`pack.yaml not found at ${packYaml}`);
      process.exit(1);
    }
    const meta = loadYaml<PackMeta>(packYaml);
    const toolMeta = (meta.tools || []).find((t) => t.name === toolName);
    if (!toolMeta) {
      console.error(`Tool ${toolName} not found in ${packId}`);
      process.exit(1);
    }

    // Load schema
    const schemaPath = path.join(packDir, toolMeta.schema);
    let schema: JsonSchema | null = null;
    if (fs.existsSync(schemaPath)) {
      try {
        schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      } catch (e) {
        console.warn(`Warn: schema parse failed for ${schemaPath}: ${(e as Error).message}`);
      }
    }

    // Load payload
    let payload: any = {};
    if (opts.json && opts.file) {
      console.error('Provide either --json or --file, not both.');
      process.exit(1);
    }
    if (opts.json) {
      try {
        payload = JSON.parse(String(opts.json));
      } catch (e) {
        console.error(`Invalid JSON in --json: ${(e as Error).message}`);
        process.exit(1);
      }
    } else if (opts.file) {
      const p = path.resolve(process.cwd(), String(opts.file));
      try {
        payload = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        console.error(`Invalid JSON file ${p}: ${(e as Error).message}`);
        process.exit(1);
      }
    } else {
      console.error('No payload given. Provide --json or --file.');
      process.exit(1);
    }

    // 1) Schema validation (if schema present)
    const issues: string[] = [];
    if (schema) {
      const ajv = new Ajv({ allErrors: true, strict: false });
      addFormats(ajv);
      const validate = ajv.compile(schema as any);
      const ok = validate(payload);
      if (!ok) {
        for (const err of validate.errors || []) {
          issues.push(`schema: ${err.instancePath || '/'} ${err.message}`);
        }
      }
    }

    // 2) Policies enforcement
    // Find matching rule
    const rule =
      pol.rules.find((r) => r.pack === packId && r.tool === toolName) ||
      pol.rules.find((r) => r.pack.startsWith(packId.split('@')[0] + '@') && r.tool === toolName);

    let needsConfirm = false;
    let confirmMessage = '';
    let allowlist: string[] = [];
    let rateLimit = { maxCalls: 20, windowSec: 60 };

    if (rule) {
      needsConfirm = !!rule.confirm?.required;
      confirmMessage = rule.confirm?.message || `Proceed with ${toolName}?`;
      allowlist = rule.allowlist || [];
      if (rule.rateLimit) rateLimit = rule.rateLimit;
    } else {
      // No rule: default conservative (no allowlist block, no confirm)
      allowlist = [];
      needsConfirm = false;
    }

    // allowlist enforcement: if allowlist given, ensure payload keys are subset
    if (allowlist.length > 0) {
      const bad = Object.keys(payload).filter((k) => !allowlist.includes(k));
      if (bad.length) issues.push(`allowlist: unexpected fields ${bad.join(', ')}`);
    }

    // rate limit simulation
    const callsSoFar = Math.max(0, parseInt(String(opts.callsSoFar), 10) || 0);
    const wouldExceed = callsSoFar + 1 > rateLimit.maxCalls;

    // 3) Output preview
    const preview = {
      status:
        issues.length > 0
          ? 'blocked'
          : needsConfirm && !opts.assumeYes
          ? 'needs-confirmation'
          : wouldExceed
          ? 'rate-limited'
          : 'ok',
      pack: packId,
      tool: toolName,
      packPath: packDir,
      schema: schemaPath,
      policies: {
        confirmRequired: needsConfirm,
        confirmMessage,
        allowlist,
        rateLimit,
        callsSoFar,
        wouldExceed,
      },
      payload, // echo back
    };

    // Pretty print
    console.log('--- DRY RUN ---');
    console.log(JSON.stringify(preview, null, 2));

    if (issues.length) {
      console.log('\nPolicy/Schema issues:');
      for (const i of issues) console.log(' -', i);
      process.exit(1);
    }
    if (wouldExceed) {
      console.log(
        `\nRate limit would be exceeded (${callsSoFar + 1}/${rateLimit.maxCalls} within ${rateLimit.windowSec}s).`,
      );
      process.exit(1);
    }
    if (needsConfirm && !opts.assumeYes) {
      console.log(`\nConfirmation required: "${confirmMessage}" (use --assume-yes to bypass in dry-run)`);
      // still exit non-zero to indicate action not yet allowed
      process.exit(2);
    }

    console.log('\nDry-run succeeded. This call would be allowed to execute by the host.');
  });

/* ---------------------------
 * exec (safe mock execution)
 * ------------------------- */
program
  .command('exec')
  .requiredOption('--tool <packId:toolName>', 'Tool selector, e.g., issues-basic@1.0.0:create_issue')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .option('--catalog <path>', 'Catalog root', 'catalog')
  .option('--json <payload>', 'Inline JSON payload')
  .option('--file <path>', 'Path to a JSON file with the payload')
  .option('--assume-yes', 'Assume confirmations are approved', false)
  .option('--callsSoFar <n>', 'Simulate calls made in the current window', '0')
  .description('Validate + (mock) execute a tool via adapters. No real side-effects.')
  .action(async (opts) => {
    // Reuse the exact same pipeline as dry-run, but proceed to mock-adapter when "ok"
    const { packId, toolName } = parseToolSelector(opts.tool);

    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    const lockFile = path.join(stackDir, 'stack.lock.json');
    const policiesFile = path.join(stackDir, 'policies.yaml');

    if (!fs.existsSync(stackFile) || !fs.existsSync(lockFile)) {
      console.error(`Missing stack and/or lock. Run 'ap init …' and 'ap add …' first.`);
      process.exit(1);
    }
    if (!fs.existsSync(policiesFile)) {
      console.error(`Missing policies.yaml. Run: ap policies suggest --stack ${opts.stack}`);
      process.exit(1);
    }

    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockFile;
    const pol = loadYaml<Policies>(policiesFile);

    const packLocked = lock.packs.find((p) => p.id === packId);
    if (!packLocked) {
      console.error(`Pack ${packId} not present in lockfile. Did you run 'ap add ${packId}'?`);
      process.exit(1);
    }

    const packDir = packLocked.path;
    const packYaml = path.join(packDir, 'pack.yaml');
    if (!fs.existsSync(packYaml)) {
      console.error(`pack.yaml not found at ${packYaml}`);
      process.exit(1);
    }
    const meta = loadYaml<PackMeta>(packYaml);
    const toolMeta = (meta.tools || []).find((t) => t.name === toolName);
    if (!toolMeta) {
      console.error(`Tool ${toolName} not found in ${packId}`);
      process.exit(1);
    }

    // Load schema
    const schemaPath = path.join(packDir, toolMeta.schema);
    let schema: JsonSchema | null = null;
    if (fs.existsSync(schemaPath)) {
      try {
        schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      } catch (e) {
        console.warn(`Warn: schema parse failed for ${schemaPath}: ${(e as Error).message}`);
      }
    }

    // Load payload
    let payload: any = {};
    if (opts.json && opts.file) {
      console.error('Provide either --json or --file, not both.');
      process.exit(1);
    }
    if (opts.json) {
      try {
        payload = JSON.parse(String(opts.json));
      } catch (e) {
        console.error(`Invalid JSON in --json: ${(e as Error).message}`);
        process.exit(1);
      }
    } else if (opts.file) {
      const p = path.resolve(process.cwd(), String(opts.file));
      try {
        payload = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        console.error(`Invalid JSON file ${p}: ${(e as Error).message}`);
        process.exit(1);
      }
    } else {
      console.error('No payload given. Provide --json or --file.');
      process.exit(1);
    }

    // 1) Schema validation
    const issues: string[] = [];
    if (schema) {
      const ajv = new Ajv({ allErrors: true, strict: false });
      addFormats(ajv);
      const validate = ajv.compile(schema as any);
      const ok = validate(payload);
      if (!ok) {
        for (const err of validate.errors || []) {
          issues.push(`schema: ${err.instancePath || '/'} ${err.message}`);
        }
      }
    }

    // 2) Policies enforcement
    const rule =
      pol.rules.find((r) => r.pack === packId && r.tool === toolName) ||
      pol.rules.find((r) => r.pack.startsWith(packId.split('@')[0] + '@') && r.tool === toolName);

    let needsConfirm = false;
    let confirmMessage = '';
    let allowlist: string[] = [];
    let rateLimit = { maxCalls: 20, windowSec: 60 };

    if (rule) {
      needsConfirm = !!rule.confirm?.required;
      confirmMessage = rule.confirm?.message || `Proceed with ${toolName}?`;
      allowlist = rule.allowlist || [];
      if (rule.rateLimit) rateLimit = rule.rateLimit;
    }

    if (allowlist.length > 0) {
      const bad = Object.keys(payload).filter((k) => !allowlist.includes(k));
      if (bad.length) issues.push(`allowlist: unexpected fields ${bad.join(', ')}`);
    }

    const callsSoFar = Math.max(0, parseInt(String(opts.callsSoFar), 10) || 0);
    const wouldExceed = callsSoFar + 1 > rateLimit.maxCalls;

    if (issues.length) {
      console.log('❌ Validation failed:\n' + issues.map((i) => ' - ' + i).join('\n'));
      process.exit(1);
    }
    if (wouldExceed) {
      console.log(
        `⛔ Rate limit would be exceeded (${callsSoFar + 1}/${rateLimit.maxCalls} within ${rateLimit.windowSec}s).`,
      );
      process.exit(1);
    }
    if (needsConfirm && !opts.assumeYes) {
      console.log(`⚠️  Confirmation required: "${confirmMessage}" (rerun with --assume-yes)`);
      process.exit(2);
    }

    // 3) Mock adapters — NO real side-effects, just a deterministic result.
    type ExecResult = { ok: true; echo: any; message: string; tool: string; pack: string };
    const adapters: Record<string, (payload: any) => ExecResult> = {
      'issues-basic@1.0.0:create_issue': (pl) => ({
        ok: true,
        echo: pl,
        tool: 'create_issue',
        pack: 'issues-basic@1.0.0',
        message: `Simulated ticket creation: "${pl.title}" in project "${pl.project_key}"`,
      }),
      'email-basic@1.0.0:send_email': (pl) => ({
        ok: true,
        echo: pl,
        tool: 'send_email',
        pack: 'email-basic@1.0.0',
        message: `Simulated email to ${pl.to} with subject "${pl.subject}"`,
      }),
    };

    const key = `${packId}:${toolName}`;
    const adapter = adapters[key];
    if (!adapter) {
      console.log(
        `ℹ️ No adapter for ${key}. This is expected in the PoC—add one to 'adapters' when you wire a real integration.`,
      );
      console.log(
        JSON.stringify(
          {
            ok: true,
            simulated: true,
            tool: toolName,
            pack: packId,
            payload,
          },
          null,
          2,
        ),
      );
      return;
    }

    const result = adapter(payload);
    console.log(JSON.stringify(result, null, 2));
  });

/* ---------------------------
 * export (MCP bundle)
 * ------------------------- */
program
  .command('export')
  .description('Export a stack into a portable bundle')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .option('--format <fmt>', 'Export format (mcp)', 'mcp')
  .option('--out <dir>', 'Output directory (e.g., dist/it-ops-mcp)')
  .action((opts) => {
    const fmt = String(opts.format || 'mcp').toLowerCase();
    if (fmt !== 'mcp') {
      console.error(`Unsupported --format ${fmt}. Only "mcp" is supported right now.`);
      process.exit(1);
    }

    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    const lockFile = path.join(stackDir, 'stack.lock.json');
    const policiesFile = path.join(stackDir, 'policies.yaml');

    if (!fs.existsSync(stackFile)) {
      console.error(`Missing ${stackFile}. Run: ap init ${opts.stack}`);
      process.exit(1);
    }
    if (!fs.existsSync(lockFile)) {
      console.error(`Missing ${lockFile}. Run: ap add <pack@ver> --stack ${opts.stack}`);
      process.exit(1);
    }

    const stack = loadYaml<StackFile>(stackFile);
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockFile;

    // Decide an output directory (anchor to repo root via the stack dir)
    const repoRoot = path.resolve(stackDir, '..', '..');
    let outDir: string;
    if (opts.out) {
      outDir = path.isAbsolute(opts.out)
        ? opts.out
        : path.join(repoRoot, opts.out);
    } else {
      const defaultName = `${(stack.name || 'stack').toLowerCase().replace(/\s+/g, '-')}-mcp`;
      outDir = path.join(repoRoot, 'dist', defaultName);
    }
    fs.mkdirSync(outDir, { recursive: true });

    // Create standard folders
    const toolsDir = path.join(outDir, 'tools');
    const govDir = path.join(outDir, 'governance');
    const cfgDir = path.join(outDir, 'config');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(govDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });

    // Copy policies.yaml if present
    let policiesRel = '';
    if (fs.existsSync(policiesFile)) {
      const dest = path.join(govDir, 'policies.yaml');
      fs.copyFileSync(policiesFile, dest);
      policiesRel = 'governance/policies.yaml';
    }

    // Always copy stack.yaml for context
    fs.copyFileSync(stackFile, path.join(cfgDir, 'stack.yaml'));

    // Build manifest
    const manifest: any = {
      format: 'mcp',
      exportedAt: new Date().toISOString(),
      stack: { name: stack.name, env: stack.env },
      governance: policiesRel ? { policies: policiesRel } : {},
      packs: [] as any[]
    };

    // For each pack in stack, copy tool schemas and collect metadata
    for (const packId of (stack.packs || [])) {
      const locked = lock.packs.find(p => p.id === packId);
      if (!locked) {
        console.warn(`Warning: ${packId} is in stack but not in lockfile—skipping.`);
        continue;
      }
      const packDir = locked.path; // absolute path to catalog pack
      const metaPath = path.join(packDir, 'pack.yaml');
      if (!fs.existsSync(metaPath)) {
        console.warn(`Warning: Missing pack.yaml for ${packId} at ${metaPath}—skipping.`);
        continue;
      }

      const meta = loadYaml<PackMeta>(metaPath);
      const packOutDir = path.join(toolsDir, packId.replace(/\//g, '_'));
      fs.mkdirSync(packOutDir, { recursive: true });

      const tools: any[] = [];
      for (const t of (meta.tools ?? [])) {
        const schemaAbs = path.join(packDir, t.schema);
        if (!fs.existsSync(schemaAbs)) {
          console.warn(`Warning: Missing schema for ${packId}:${t.name} at ${schemaAbs}—skipping tool.`);
          continue;
        }
        const schemaRel = path.join('tools', packId.replace(/\//g, '_'), `${t.name}.json`);
        const schemaOut = path.join(outDir, schemaRel);
        fs.copyFileSync(schemaAbs, schemaOut);

        tools.push({
          name: t.name,
          schema: schemaRel,
          side_effects: t['x-actionpack']?.side_effects ?? [],
          allowlist: t['x-actionpack']?.allowlist_fields ?? []
        });
      }

      manifest.packs.push({
        id: packId,
        name: meta.name ?? undefined,
        capabilities: meta.capabilities ?? [],
        tools
      });
    }

    // Write manifest
    fs.writeFileSync(path.join(outDir, 'actionpack.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // Write README
    const readme = `# ${stack.name} – MCP Export

This folder is a **generated** ActionPacks bundle in **MCP** format.

## Contents
- \`actionpack.json\`: manifest with packs, tools, and schema references
- \`tools/\`: JSON Schemas for each tool
- \`governance/policies.yaml\`: (optional) governance rules copied from the stack
- \`config/stack.yaml\`: the original stack definition (for context)

## Using with an MCP host
Point your host at this folder and register the tools listed in \`actionpack.json\`.
Each tool lists a \`schema\` path (under \`tools/\`) and optional governance hints
(\`allowlist\`, \`side_effects\`). Enforcement is host-defined.

> Note: this bundle contains **no executable integrations**—it’s a portable description.
`;
    fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');

    console.log(`\nExported MCP bundle to: ${outDir}`);
    console.log(`- Manifest: ${path.join(outDir, 'actionpack.json')}`);
    if (policiesRel) console.log(`- Policies: ${path.join(outDir, policiesRel)}`);
    console.log('- Tool schemas placed under tools/');
  });

/* ---------------------------
 * lint (validate stack + lock + packs + schemas + policies)
 * ------------------------- */
program
  .command('lint')
  .description('Validate stack, lockfile, pack metadata, tool schemas, and policies')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .option('--catalog <path>', 'Catalog root', 'catalog')
  .action((opts) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const info: string[] = [];

    const pushErr = (m: string) => errors.push(`✖ ${m}`);
    const pushWarn = (m: string) => warnings.push(`⚠ ${m}`);
    const pushInfo = (m: string) => info.push(`• ${m}`);

    const print = (arr: string[]) => arr.forEach(m => console.log(m));
    const printAndExit = () => {
      console.log('\n=== Lint Report ===');
      if (info.length) { console.log('\nInfo:'); print(info); }
      if (warnings.length) { console.log('\nWarnings:'); print(warnings); }
      if (errors.length) { console.log('\nErrors:'); print(errors); }
      console.log('\nSummary:',
        `${errors.length} error(s),`,
        `${warnings.length} warning(s),`,
        `${info.length} info.`);
      process.exit(errors.length ? 1 : 0);
    };

    // 1) Stack files
    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    const lockFile = path.join(stackDir, 'stack.lock.json');
    const policiesFile = path.join(stackDir, 'policies.yaml');

    if (!fs.existsSync(stackFile)) pushErr(`Missing ${stackFile}`);
    if (!fs.existsSync(lockFile)) pushErr(`Missing ${lockFile}`);

    if (errors.length) {
      // Hard stop if the core files aren’t there
      printAndExit();
      return;
    }

    const stack = loadYaml<StackFile>(stackFile);
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockFile;

    if (!stack?.packs?.length) pushWarn(`Stack has no packs listed in ${stackFile}`);

    // 2) Ensure each stack pack is in lock + on disk
    const lockedById = new Map(lock.packs.map(p => [p.id, p]));
    for (const packId of (stack.packs || [])) {
      const lp = lockedById.get(packId);
      if (!lp) {
        pushErr(`Pack ${packId} is in stack.yaml but not in stack.lock.json`);
        continue;
      }
      if (!fs.existsSync(lp.path)) {
        pushErr(`Pack path missing on disk: ${lp.path} (from lockfile)`);
      } else {
        pushInfo(`Found ${packId} at ${lp.path}`);
      }
    }

    // 3) Validate pack.yaml + tool schemas
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    type ToolRef = { packId: string; toolName: string; schemaPath?: string; props: string[] };
    const stackTools: ToolRef[] = [];

    for (const packId of (stack.packs || [])) {
      const lp = lockedById.get(packId);
      if (!lp || !fs.existsSync(lp.path)) continue;

      const packYamlPath = path.join(lp.path, 'pack.yaml');
      if (!fs.existsSync(packYamlPath)) {
        pushErr(`Missing pack.yaml for ${packId} at ${packYamlPath}`);
        continue;
      }
      let meta: PackMeta;
      try {
        meta = loadYaml<PackMeta>(packYamlPath);
      } catch (e) {
        pushErr(`Failed to parse pack.yaml for ${packId}: ${(e as Error).message}`);
        continue;
      }

      for (const t of meta.tools || []) {
        const schemaAbs = path.join(lp.path, t.schema);
        if (!fs.existsSync(schemaAbs)) {
          pushErr(`Missing schema for ${packId}:${t.name} at ${schemaAbs}`);
          continue;
        }
        // Parse + compile schema
        let schema: any;
        try {
          schema = JSON.parse(fs.readFileSync(schemaAbs, 'utf8'));
        } catch (e) {
          pushErr(`Invalid JSON schema for ${packId}:${t.name} at ${schemaAbs}: ${(e as Error).message}`);
          continue;
        }
        try {
          ajv.compile(schema);
        } catch (e) {
          pushErr(`Schema does not compile for ${packId}:${t.name} at ${schemaAbs}: ${(e as Error).message}`);
          continue;
        }
        const props = schema?.properties ? Object.keys(schema.properties) : [];
        stackTools.push({ packId, toolName: t.name, schemaPath: schemaAbs, props });
      }
    }

    // 4) Policies cross-checks (optional if file missing)
    if (!fs.existsSync(policiesFile)) {
      pushWarn(`No policies.yaml found at ${policiesFile} (run: ap policies suggest --stack ${opts.stack})`);
    } else {
      let pol: Policies | null = null;
      try {
        pol = loadYaml<Policies>(policiesFile);
      } catch (e) {
        pushErr(`Failed to parse policies.yaml: ${(e as Error).message}`);
      }

      if (pol) {
        // Each (pack, tool) should have a rule
        for (const tr of stackTools) {
          const rule =
            pol.rules.find((r) => r.pack === tr.packId && r.tool === tr.toolName) ||
            pol.rules.find((r) => r.pack.startsWith(tr.packId.split('@')[0] + '@') && r.tool === tr.toolName);

          if (!rule) {
            pushWarn(`No policy rule for ${tr.packId}:${tr.toolName}`);
            continue;
          }

          // allowlist subset of schema props (if allowlist present)
          if (rule.allowlist && rule.allowlist.length && tr.props.length) {
            const extras = rule.allowlist.filter(k => !tr.props.includes(k));
            if (extras.length) {
              pushWarn(`Policy allowlist has fields not in schema for ${tr.packId}:${tr.toolName}: ${extras.join(', ')}`);
            }
          }

          // confirmation heuristic cross-check
          const locked = lockedById.get(tr.packId);
          const packYamlPath = locked ? path.join(locked.path, 'pack.yaml') : '';
          let meta: PackMeta | null = null;
          try { if (packYamlPath && fs.existsSync(packYamlPath)) meta = loadYaml<PackMeta>(packYamlPath); } catch {}
          const toolMeta = meta?.tools?.find(tt => tt.name === tr.toolName);
          const se = (toolMeta?.['x-actionpack']?.side_effects || []).map(s => String(s).toLowerCase());
          const hasSideEffects = se.some(s => ['send','create','update','delete','write','post'].includes(s));

          if (hasSideEffects && !rule.confirm?.required) {
            pushWarn(`Side-effecting tool ${tr.packId}:${tr.toolName} should probably require confirmation.`);
          }
          if (!hasSideEffects && rule.confirm?.required) {
            pushWarn(`Non side-effecting tool ${tr.packId}:${tr.toolName} is marked confirm-required (check intent).`);
          }
        }
      }
    }

    // 5) Print report and exit (errors => code 1)
    printAndExit();
  });

/* ---------------------------
 * packs (list what’s in the stack)
 * ------------------------- */
program
  .command('packs')
  .description('List packs in the stack with resolved paths')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .action((opts) => {
    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    const lockFile = path.join(stackDir, 'stack.lock.json');

    if (!fs.existsSync(stackFile) || !fs.existsSync(lockFile)) {
      console.error(`Missing stack and/or lock. Run 'ap init …' and 'ap add …' first.`);
      process.exit(1);
    }

    const stack = loadYaml<StackFile>(stackFile);
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockFile;

    if (!stack.packs?.length) {
      console.log('No packs in this stack.');
      return;
    }

    console.log(`Packs in ${stackFile}:\n`);
    for (const pid of stack.packs) {
      const locked = lock.packs.find(p => p.id === pid);
      if (locked) {
        console.log(`• ${pid}\n   -> ${locked.path}`);
      } else {
        console.log(`• ${pid}\n   -> (not in lockfile)`);
      }
    }
  });

/* ---------------------------
 * remove (drop a pack from the stack + lock)
 * ------------------------- */
program
  .command('remove')
  .argument('<packId>', 'Pack ID to remove, e.g., issues-basic@1.0.0')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .description('Remove a pack from stack.yaml and stack.lock.json')
  .action((packId, opts) => {
    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    const lockPath = path.join(stackDir, 'stack.lock.json');

    if (!fs.existsSync(stackFile)) {
      console.error(`No stack at ${stackFile}. Run: ap init ${opts.stack}`);
      process.exit(1);
    }

    const stack = loadYaml<StackFile>(stackFile);
    const before = stack.packs?.length || 0;
    stack.packs = (stack.packs || []).filter(p => p !== packId);

    if (stack.packs.length === before) {
      console.log(`${packId} was not present in ${stackFile}`);
    } else {
      saveYaml(stackFile, stack);
      console.log(`Removed ${packId} from ${stackFile}`);
    }

    if (fs.existsSync(lockPath)) {
      const lock: LockFile = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const beforeL = lock.packs.length;
      lock.packs = lock.packs.filter(p => p.id !== packId);
      if (lock.packs.length !== beforeL) {
        fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');
        console.log(`Updated ${lockPath}`);
      }
    }
  });

/* ---------------------------
 * bump (switch a pack version in stack + refresh lock entry)
 * ------------------------- */
program
  .command('bump')
  .argument('<packIdWithVersion>', 'Pack ID@version, e.g., issues-basic@1.0.1')
  .option('--stack <path>', 'Stack path', 'stacks/it-ops')
  .option('--catalog <path>', 'Catalog root', 'catalog')
  .description('Update a pack version in the stack and lockfile')
  .action((packIdWithVersion, opts) => {
    const { name, version } = parsePackId(packIdWithVersion);
    if (version === 'latest') {
      console.error('Please specify an explicit version (no "latest").');
      process.exit(1);
    }

    const stackDir = resolveStackDir(opts.stack);
    const stackFile = path.join(stackDir, 'stack.yaml');
    const lockPath = path.join(stackDir, 'stack.lock.json');
    if (!fs.existsSync(stackFile)) {
      console.error(`No stack at ${stackFile}. Run: ap init ${opts.stack}`);
      process.exit(1);
    }

    const stack = loadYaml<StackFile>(stackFile);
    const idx = (stack.packs || []).findIndex(p => p.startsWith(name + '@'));
    if (idx === -1) {
      console.error(`Pack ${name}@* not found in stack. Add it first.`);
      process.exit(1);
    }
    stack.packs[idx] = packIdWithVersion;
    saveYaml(stackFile, stack);
    console.log(`Updated ${stackFile}`);

    const now = new Date().toISOString();
    let lock: LockFile = fs.existsSync(lockPath)
      ? JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      : { createdAt: now, packs: [] };

    const catalogRoot = findCatalogRoot(opts.catalog || 'catalog');
    if (!catalogRoot) {
      console.error('No catalog found (looked in ./catalog and ../../catalog)');
      process.exit(1);
    }
    const idxYaml = loadYaml<CatalogIndex>(path.join(catalogRoot, 'index.yaml'));
    const hit = idxYaml.packs.find(p => p.id === packIdWithVersion);
    if (!hit) {
      console.error(`Version not found in catalog index: ${packIdWithVersion}`);
      process.exit(1);
    }

    const resolvedPath = path.join(catalogRoot, hit.path.replace(/^catalog\//, ''));
    const existing = lock.packs.find(p => p.id.startsWith(name + '@'));
    if (existing) {
      existing.id = packIdWithVersion;
      existing.version = version;
      existing.path = resolvedPath;
    } else {
      lock.packs.push({ id: packIdWithVersion, version, path: resolvedPath });
    }
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');
    console.log(`Updated ${lockPath}`);
  });

/* ---------------------------
 * verify (MCP bundle)
 * ------------------------- */
program
  .command('verify')
  .description('Verify an exported MCP bundle (paths + JSON Schemas)')
  .requiredOption('--bundle <dir>', 'Path to MCP export folder (e.g., dist/it-ops-mcp)')
  .action((opts) => {
    const bundleDir = path.resolve(process.cwd(), String(opts.bundle));
    const manifestPath = path.join(bundleDir, 'actionpack.json');

    if (!fs.existsSync(bundleDir)) {
      console.error(`Bundle directory not found: ${bundleDir}`);
      process.exit(1);
    }
    if (!fs.existsSync(manifestPath)) {
      console.error(`Missing manifest: ${manifestPath}`);
      process.exit(1);
    }

    // Load manifest
    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.error(`Invalid JSON in manifest: ${(e as Error).message}`);
      process.exit(1);
    }

    const errs: string[] = [];
    const warns: string[] = [];
    const infos: string[] = [];

    // Governance check (optional)
    if (manifest?.governance?.policies) {
      const polAbs = path.join(bundleDir, manifest.governance.policies);
      if (!fs.existsSync(polAbs)) {
        errs.push(`governance.policies not found: ${polAbs}`);
      } else {
        infos.push(`Found governance policies: ${manifest.governance.policies}`);
      }
    }

    // Prepare Ajv
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    // Tools & schemas
    const packs = Array.isArray(manifest?.packs) ? manifest.packs : [];
    if (!packs.length) warns.push('No packs listed in manifest.');

    for (const p of packs) {
      const tools = Array.isArray(p?.tools) ? p.tools : [];
      if (!tools.length) {
        warns.push(`Pack ${p?.id ?? '(unknown)'} has no tools.`);
      }
      for (const t of tools) {
        const schemaRel = t?.schema;
        if (!schemaRel || typeof schemaRel !== 'string') {
          errs.push(`Pack ${p?.id}: tool ${t?.name} missing "schema" path.`);
          continue;
        }
        const schemaAbs = path.join(bundleDir, schemaRel);
        if (!fs.existsSync(schemaAbs)) {
          errs.push(`Schema not found: ${schemaRel} (resolved ${schemaAbs})`);
          continue;
        }

        // Compile schema
        try {
          const s = JSON.parse(fs.readFileSync(schemaAbs, 'utf8'));
          ajv.compile(s); // throws on invalid schema
          infos.push(`OK schema: ${schemaRel}`);
        } catch (e) {
          errs.push(`Invalid schema ${schemaRel}: ${(e as Error).message}`);
        }
      }
    }

    // Report
    console.log('\n=== Verify Report ===\n');
    if (infos.length) {
      console.log('Info:');
      for (const i of infos) console.log('•', i);
      console.log();
    }
    if (warns.length) {
      console.log('Warnings:');
      for (const w of warns) console.log('•', w);
      console.log();
    }
    if (errs.length) {
      console.log('Errors:');
      for (const e of errs) console.log('•', e);
      console.log();
      process.exit(1);
    }

    console.log('Summary: bundle looks good ✅');
  });



program.parseAsync();
