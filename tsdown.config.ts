import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  sourcemap: true,
  platform: 'node',
  external: [/^@deepseek-ai\//],
  outDir: 'lib',
  outputOptions: {
    entryFileNames: '[name].js',
  },
})
