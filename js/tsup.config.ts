import { defineConfig } from 'tsup';

// bundle: false — transpile each src/**/*.ts to dist/**/*.js one-to-one,
// mirroring tsc's old output layout. Several load-bearing assumptions in
// src/ (e.g. src/mcp/index.ts's GIT_MCP_SERVER_ENTRY, which walks up from
// `import.meta.url` a fixed number of directories to find node_modules) and
// the "run node dist/db/migrate.js directly" deploy path
// (src/db/migrate.ts, CLAUDE.md "Migrations") depend on dist/ mirroring
// src/'s directory structure and each file's depth under the repo root — a
// single bundled output would change both. Path aliases (`@/*`) are left
// unresolved by esbuild in this mode (esbuild only rewrites them while
// bundling), so `pnpm build` still runs tsc-alias afterward, same as it did
// after plain tsc.
//
// dts: false — tsup's own declaration-file step (rollup-plugin-dts) bundles
// its own TypeScript version internally, which crashes against this
// project's TypeScript 7 (`Cannot read properties of undefined (reading
// 'useCaseSensitiveFileNames')`). `pnpm build` runs a plain
// `tsc --emitDeclarationOnly` afterward instead, using our own TypeScript
// install — same tool that generated .d.ts files before this migration.
export default defineConfig({
  entry: ['src/**/*.ts'],
  format: ['esm'],
  target: 'es2023',
  outDir: 'dist',
  tsconfig: 'tsconfig.build.json',
  bundle: false,
  splitting: false,
  sourcemap: true,
  dts: false,
  clean: true,
});
