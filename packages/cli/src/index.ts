#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const program = new Command();
program.name('ap').description('ActionPacks CLI (PoC)').version('0.1.0');

function loadYaml<T = any>(p: string): T {
  const raw = fs.readFileSync(p, 'utf8');
  return yaml.load(raw) as T;
}

function findCatalogRoot(preferred: string): string | null {
  // CLI runs from packages/cli when using workspace scripts.
  const candidates = [
    path.resolve(process.cwd(), preferred),                // e.g. catalog (if you run from repo root)
    path.resolve(process.cwd(), '..', '..', preferred),    // ../../catalog (when running from packages/cli)
  ];
  for (const c of candidates) {
    const idx = path.join(c, 'index.yaml');
    if (fs.existsSync(idx)) return c;
  }
  return null;
}

program
  .command('hello')
  .description('sanity check')
  .action(() => console.log('hi 👋'));

const catalog = program.command('catalog').description('Catalog operations');

catalog
  .command('list')
  .description('List available packs from catalog/index.yaml')
  .option('--catalog <path>', 'Catalog root', 'catalog')
  .action((opts) => {
    const catalogRoot = findCatalogRoot(opts.catalog);
    if (!catalogRoot) {
      console.error(
        `No catalog index found. Tried: ${path.resolve(process.cwd(), opts.catalog)}/index.yaml and ${path.resolve(process.cwd(), '..', '..', opts.catalog)}/index.yaml`,
      );
      process.exit(1);
    }

    // Load index
    const indexPath = path.join(catalogRoot, 'index.yaml');
    const idx = loadYaml<{ packs: { id: string; path: string }[] }>(indexPath);
    if (!idx?.packs?.length) {
      console.log('No packs found.');
      return;
    }

    console.log('Available packs:\n');
    for (const p of idx.packs) {
      // Resolve pack folder relative to the catalog root if not absolute
      const packDir = path.isAbsolute(p.path) ? p.path : path.join(catalogRoot, p.path);
      let name = '';
      try {
        const meta = loadYaml<{ name?: string }>(path.join(packDir, 'pack.yaml'));
        name = meta?.name ?? '';
      } catch {
        // ignore
      }
      console.log(`• ${p.id}${name ? ' — ' + name : ''}`);
    }
  });

program.parseAsync();
