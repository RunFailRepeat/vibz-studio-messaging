import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// Execute production handlers. Only module paths and Cloudflare's environment
// transport are adapted to Node; authentication/business functions stay intact.
const root = new URL('../', import.meta.url);
const temporary = await mkdtemp(fileURLToPath(new URL('.routes-', import.meta.url)));
const directory = pathToFileURL(`${temporary}/`);
const modules = {
  'studio.mjs': 'lib/studio.ts',
  'mentions.mjs': 'lib/mentions.ts',
  'server.mjs': 'lib/server.ts',
  'mcp-tools.mjs': 'lib/mcp-tools.ts',
  'api.mjs': 'app/api/[...path]/route.ts',
  'mcp.mjs': 'app/mcp/route.ts',
};
const imports = new Map([
  ['cloudflare:workers', './edge-env.mjs'],
  ['./studio', './studio.mjs'],
  ['./mentions', './mentions.mjs'],
  ['@/lib/studio', './studio.mjs'],
  ['@/lib/mentions', './mentions.mjs'],
  ['@/lib/server', './server.mjs'],
  ['@/lib/mcp-tools', './mcp-tools.mjs'],
]);
let routes;
try {
  await writeFile(new URL('edge-env.mjs', directory), 'export const env = {};\n');
  for (const [output, input] of Object.entries(modules)) {
    const source = await readFile(new URL(input, root), 'utf8');
    const compiled = ts.transpileModule(source, {
      fileName: input,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const resolved = compiled.replace(/from (['"])([^'"]+)\1/g, (whole, quote, name) =>
      imports.has(name) ? `from ${quote}${imports.get(name)}${quote}` : whole);
    await writeFile(new URL(output, directory), resolved);
  }
  const [edge, core, api, mcp] = await Promise.all([
    import(new URL('edge-env.mjs', directory)),
    import(new URL('studio.mjs', directory)),
    import(new URL('api.mjs', directory)),
    import(new URL('mcp.mjs', directory)),
  ]);
  routes = { env: edge.env, StudioService: core.StudioService, api, mcp };
} finally {
  await rm(directory, { recursive: true, force: true });
}
export { routes };
