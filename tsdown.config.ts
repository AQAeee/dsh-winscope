/**
 * tsdown build for the dsh-winscope external plugin: the host half as plain
 * ESM for the profile Loader, the browser half as one CJS closure bundle
 * whose externals are exactly the platform seed modules (community-standard
 * external client build, adapted from dsh-sentinel / dsh-better-sidebar).
 *
 * Host half (lib/index.js): @deepseek-ai/* and cordis stay external —
 * `dsh plugin add` installs plugins where the host's own packages resolve,
 * so external users need zero npm installs.
 *
 * Client half (lib/client.js): registers itself with
 * window.__ModuleLoader__.load({ id: 'dsh-winscope', factory }) — the id MUST
 * equal the cordis loader entry name (cordis.patch.yml `name`), which is also
 * the id the client-modules boot graph serves under /plugins/<id>/client.js.
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-winscope'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

export default [
  {
    name: `${PLUGIN_ID}/node`,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // The dsh-loop convention: host packages resolve inside the profile.
    external: [/^@deepseek-ai\//, 'cordis'],
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // External wins for module-table entries; every other dependency inlines.
    noExternal: (id: string) =>
      (CLIENT_EXTERNALS as readonly string[]).includes(id) ? undefined : true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
