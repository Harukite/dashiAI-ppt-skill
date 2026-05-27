#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const optionsFile = 'src/options.jsx';
const showcaseFile = 'examples/component-decks/all-layouts-showcase.jsx';

const options = readFileSync(optionsFile, 'utf8');
const showcase = readFileSync(showcaseFile, 'utf8');

const canonicalLayouts = [...options.matchAll(/^\s*(s\d{2}):\s*\{[\s\S]*?dataLayout:\s*'S(\d{2})'/gm)]
  .map((match) => ({ key: match[1], dataLayout: `S${match[2]}` }))
  .filter((layout) => layout.key === layout.dataLayout.toLowerCase());

const showcaseKeys = [...showcase.matchAll(/slide\('([^']+)'/g)].map((match) => match[1]);
const showcaseCanonicalKeys = showcaseKeys.filter((key) => /^s\d{2}$/.test(key));
const expectedKeys = canonicalLayouts.map((layout) => layout.key);

const missing = expectedKeys.filter((key) => !showcaseCanonicalKeys.includes(key));
const extra = showcaseCanonicalKeys.filter((key) => !expectedKeys.includes(key));
const duplicates = showcaseCanonicalKeys.filter((key, index) => showcaseCanonicalKeys.indexOf(key) !== index);

if (missing.length || extra.length || duplicates.length) {
  if (missing.length) console.error(`Missing layout(s) in ${showcaseFile}: ${missing.join(', ')}`);
  if (extra.length) console.error(`Unknown layout(s) in ${showcaseFile}: ${extra.join(', ')}`);
  if (duplicates.length) console.error(`Duplicate layout(s) in ${showcaseFile}: ${[...new Set(duplicates)].join(', ')}`);
  process.exit(1);
}

console.log(`Layout showcase covers ${expectedKeys.length} canonical layout(s): ${expectedKeys.join(', ')}`);
