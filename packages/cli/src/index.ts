#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const program = new Command();
program.name('ap').description('ActionPacks CLI (PoC)').version('0.2.1');

type CatalogIndex = { packs: { id: string; path: string }[] };
type StackFile = { name: string; packs: string[]; env?: string };
type LockFile = { createdAt: string; packs: { id: string; version: string; path: string }[] };

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

program
  .command('hello')
  .description('sanity check')
  .action(() => console.log('hi 👋'));

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
        } catch {}
      }
      console.log(`• ${p.id}${name ? ' — ' + name : ''}`);
    }
  });

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

program.parseAsync();
