import { readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

// Compile the production TypeScript service, without replacing its functions
// or SQL. Platform request identity is deliberately outside this core module.
async function compile(name) {
  const path = new URL(`../lib/${name}.ts`, import.meta.url);
  const source = await readFile(path, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: path.pathname,
  }).outputText;
}

// A sibling module gives Node normal package resolution for production's
// runtime dependencies (currently zod). Remove the ephemeral output after
// import; no implementation function is replaced or patched by the harness.
const compiledPath = new URL(`.compiled-studio-${randomUUID()}.mjs`, import.meta.url);
const mentionsPath = new URL(`.compiled-mentions-${randomUUID()}.mjs`, import.meta.url);
let production, mentions;
try {
  await writeFile(mentionsPath, await compile('mentions'));
  const compiled = (await compile('studio')).replace(
    /from (['"])(?:\.\/mentions|@\/lib\/mentions)\1/g,
    `from '${mentionsPath.href}'`,
  );
  await writeFile(compiledPath, compiled);
  [production, mentions] = await Promise.all([import(compiledPath.href), import(mentionsPath.href)]);
} finally {
  await Promise.all([compiledPath, mentionsPath].map(path => unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  })));
}
export { production, mentions };
