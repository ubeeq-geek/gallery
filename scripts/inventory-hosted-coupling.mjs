import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', 'cdk.out']);
const patterns = [/eversally/ig, /nightframe/ig];
const categories = [
  ['brand', /^(apps\/(web|admin|landing)|.*brand\.)/],
  ['policy', /(policy|safety|support|moderation|regional)/],
  ['billing', /billing|commercial/],
  ['infrastructure', /^(infra|scripts\/validate|scripts\/qualify)/],
  ['documentation', /^(README|docs\/)/],
  ['other', /.*/]
];
const totals = Object.fromEntries(categories.map(([name]) => [name, { files: 0, references: 0 }]));

const visit = (directory) => {
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) visit(file);
    else if (/\.(?:ts|tsx|js|mjs|json|md|html|css|ya?ml)$/i.test(file)) {
      const content = readFileSync(file, 'utf8');
      const references = patterns.reduce((count, pattern) => count + (content.match(pattern)?.length || 0), 0);
      if (!references) continue;
      const path = relative(root, file);
      const [category] = categories.find(([, matcher]) => matcher.test(path)) || categories.at(-1);
      totals[category].files += 1;
      totals[category].references += references;
    }
  }
};

visit(root);
console.log(JSON.stringify(totals, null, 2));

