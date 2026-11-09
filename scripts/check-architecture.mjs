#!/usr/bin/env node
/**
 * Architecture fitness check for the backend (no dependencies).
 *
 *  1. Parses every import in src/.
 *  2. Enforces the MVC layer rules documented in docs/mvc-structure.md.
 *  3. Detects circular dependencies between source files.
 *
 * Exit code 1 on any violation, so it can gate CI (`npm run check:architecture`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['src'];
const EXTENSIONS = ['.ts', '.tsx'];
/** Path aliases from tsconfig.json. */
const ALIASES = { '@shared': 'src/shared/index.ts' };

const toPosix = (path) => path.split(sep).join('/');
const rel = (path) => toPosix(relative(ROOT, path));

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return EXTENSIONS.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

const IMPORT_PATTERN =
  /(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function parseImports(file) {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const imports = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    imports.push({ specifier: match[2] ?? match[3], typeOnly: Boolean(match[1]) });
  }
  return imports;
}

function resolveSpecifier(fromFile, specifier) {
  let base = null;
  if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else if (ALIASES[specifier]) base = join(ROOT, ALIASES[specifier]);
  if (!base) return { external: specifier };
  for (const candidate of [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return { file: candidate };
  }
  return { unresolved: specifier };
}

/**
 * Layer rules: files matching `scope` must not depend on anything matching `forbid`.
 * Targets are matched against the project-relative path (internal) or the package name (external).
 */
const RULES = [
  {
    name: 'Models are pure domain code (no transport, framework, SDK or infrastructure)',
    scope: /^src\/mvc\/models\//,
    forbid: [
      /^fastify/,
      /^@fastify\//,
      /^ws$/,
      /^openai$/,
      /^pino/,
      /^src\/(?!mvc\/models\/|shared\/)/,
    ],
  },
  {
    name: 'Views only map models to DTOs',
    scope: /^src\/mvc\/views\//,
    forbid: [
      /^fastify/,
      /^ws$/,
      /^openai$/,
      /repositories\//,
      /providers\//,
      /websocket\//,
      /mvc\/controllers\//,
    ],
  },
  {
    name: 'Controllers coordinate services — never repositories, vendor providers or sockets',
    scope: /^src\/mvc\/controllers\//,
    forbid: [
      /^ws$/,
      /^openai$/,
      /repositories\//,
      /providers\/(llm|transcription)\//,
      /websocket\//,
      /mvc\/routes\//,
    ],
  },
  {
    name: 'Routes only declare endpoints (validation + controller delegation)',
    scope: /^src\/mvc\/routes\//,
    forbid: [/services\//, /repositories\//, /providers\//, /websocket\//, /mvc\/models\//],
  },
  {
    name: 'Services depend on provider/repository interfaces, never on transport or vendor adapters',
    scope: /^src\/services\//,
    forbid: [
      /^fastify/,
      /^@fastify\//,
      /^ws$/,
      /^openai$/,
      /mvc\/controllers\//,
      /mvc\/routes\//,
      /mvc\/views\//,
      /websocket\//,
      /middleware\//,
      /\.provider$/,
    ],
  },
  {
    name: 'Repositories only persist models',
    scope: /^src\/repositories\//,
    forbid: [/services\//, /mvc\/controllers\//, /providers\//, /websocket\//, /^fastify/],
  },
  {
    name: 'Providers are leaf adapters (no services, controllers, repositories or transport)',
    scope: /^src\/providers\//,
    forbid: [
      /services\//,
      /mvc\/controllers\//,
      /mvc\/routes\//,
      /repositories\//,
      /websocket\//,
      /middleware\//,
    ],
  },
  {
    name: 'Utilities, config and validators stay low-level',
    scope: /^src\/(utils|config|validators)\//,
    forbid: [
      /services\//,
      /mvc\/controllers\//,
      /mvc\/routes\//,
      /repositories\//,
      /providers\//,
      /websocket\//,
    ],
  },
  {
    name: 'The shared protocol contract depends on nothing but zod',
    scope: /^src\/shared\//,
    // Internal targets are project paths (src/...); any other bare name is an npm package.
    forbid: [/^src\/(?!shared\/)/, /^(?!zod$|src\/)[^.]/],
  },
];

const files = SOURCE_ROOTS.flatMap((root) => walk(join(ROOT, root)));
const graph = new Map();
const violations = [];
const unresolved = [];

for (const file of files) {
  const from = rel(file);
  const edges = [];
  for (const { specifier, typeOnly } of parseImports(file)) {
    const target = resolveSpecifier(file, specifier);
    if (target.unresolved) unresolved.push(`${from} → ${target.unresolved}`);
    const name = target.file ? rel(target.file) : (target.external ?? target.unresolved);
    if (target.file) edges.push({ to: name, typeOnly });
    for (const rule of RULES) {
      if (!rule.scope.test(from)) continue;
      if (rule.forbid.some((pattern) => pattern.test(name)))
        violations.push({ rule: rule.name, from, to: name });
    }
  }
  graph.set(from, edges);
}

// Cycle detection (Tarjan's strongly connected components), runtime imports only.
const cycles = [];
let index = 0;
const stack = [];
const meta = new Map();
function strongConnect(node) {
  meta.set(node, { index, low: index, onStack: true });
  index += 1;
  stack.push(node);
  for (const { to, typeOnly } of graph.get(node) ?? []) {
    if (typeOnly || !graph.has(to)) continue;
    if (!meta.has(to)) {
      strongConnect(to);
      meta.get(node).low = Math.min(meta.get(node).low, meta.get(to).low);
    } else if (meta.get(to).onStack) {
      meta.get(node).low = Math.min(meta.get(node).low, meta.get(to).index);
    }
  }
  if (meta.get(node).low === meta.get(node).index) {
    const component = [];
    let member;
    do {
      member = stack.pop();
      meta.get(member).onStack = false;
      component.push(member);
    } while (member !== node);
    if (component.length > 1) cycles.push(component);
  }
}
for (const node of graph.keys()) if (!meta.has(node)) strongConnect(node);

console.log(
  `Checked ${files.length} source files, ${[...graph.values()].reduce((n, e) => n + e.length, 0)} internal imports, ${RULES.length} layer rules.`,
);
if (unresolved.length) console.log(`\n✖ Unresolved imports:\n  ${unresolved.join('\n  ')}`);
if (violations.length) {
  console.log(`\n✖ Layer violations (${violations.length}):`);
  for (const v of violations) console.log(`  [${v.rule}]\n    ${v.from} → ${v.to}`);
}
if (cycles.length) {
  console.log(`\n✖ Circular dependencies (${cycles.length}):`);
  for (const cycle of cycles) console.log(`  ${cycle.join(' ⇄ ')}`);
}
if (violations.length || cycles.length || unresolved.length) process.exit(1);
console.log('✔ No layer violations, no circular dependencies.');
