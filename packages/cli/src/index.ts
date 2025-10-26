#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const program = new Command();
program.name('ap').description('ActionPacks CLI (PoC)').version('0.3.0');

type CatalogIndex = { packs: { id: string; path: string }[] };
type StackFile = { name: string; packs: string[]; env?: string };
type LockFile = { createdAt: string; packs: { id: string; version: string; path: string }[] };

type PackMeta = {
  name?: string;
  capabilities?: string[];
  tools?: {
    name: string;
    schema: string; // relative path to JSON schema
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

    const out: any = {
      generatedAt: new Date().toISOString(),
      stack: stack.name || path.basename(stackDir),
      rules: [] as any[],
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
        // load schema if present
        const schemaPath = path.join(packDir, tool.schema);
        let schema: JsonSchema | null = null;
        if (fs.existsSync(schemaPath)) {
          try {
            schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
          } catch (e) {
            console.warn(`Warn: schema parse failed for ${schemaPath}: ${(e as Error).message}`);
          }
        }

        // Heuristics:
        // 1) confirmations if side_effects indicate action (send|create|update|delete|write|post)
        const se = (tool['x-actionpack']?.side_effects || []).map((s) => String(s).toLowerCase());
        const needsConfirm = se.some((s) =>
          ['send', 'create', 'update', 'delete', 'write', 'post'].includes(s),
        );

        // 2) allowlists: use allowlist_fields, else infer safe props from schema
        const explicitAllow = tool['x-actionpack']?.allowlist_fields || [];
        const schemaProps = schema?.properties ? Object.keys(schema.properties) : [];
        const inferredAllow = schemaProps.filter(
          (k) => !/(password|secret|token|apikey|api_key|auth|bearer|credential)/i.test(k),
        );

        // 3) rate limits: default per tool
        const rule: any = {
          pack: p.id,
          tool: tool.name,
          confirm: needsConfirm ? { message: `Proceed with ${tool.name}?`, required: true } : { required: false },
          allowlist: explicitAllow.length ? explicitAllow : inferredAllow,
          rateLimit: { maxCalls: defaultLimit, windowSec: defaultWindow },
        };
        if (schema?.description) rule.description = schema.description;

        out.rules.push(rule);
      }
    }

    const dest = path.join(stackDir, 'policies.yaml');
    saveYaml(dest, out);
    console.log(`Generated ${dest}`);
  });

program.parseAsync();
