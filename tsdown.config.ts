import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/bin.ts', 'src/index.ts', 'src/report-viewer-pretext.ts'],
  format: ['esm'],
  dts: true,
  deps: {
    alwaysBundle: ['@chenglou/pretext'],
    onlyBundle: false,
  },
  copy: [{ from: 'src/report-viewer.css', to: 'dist' }],
})
