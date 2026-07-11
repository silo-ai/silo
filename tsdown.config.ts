import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  dts: true,
  copy: [{ from: 'src/report-viewer.css', to: 'dist' }],
})
