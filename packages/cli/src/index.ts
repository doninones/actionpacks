#!/usr/bin/env node
import { Command } from 'commander';
const program = new Command();
program.name('ap').description('ActionPacks CLI (PoC)').version('0.1.0');
program.command('hello').description('sanity check').action(() => console.log('hi 👋'));
program.parseAsync();
