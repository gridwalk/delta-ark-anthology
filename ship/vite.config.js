import { defineConfig } from 'vite';

/* The anthology serves the ship at /ship/, from embeds/ship/. build.js copies
   that folder into dist/ unchanged. Thus this build writes straight into
   embeds/ship/, and all asset URLs start with /ship/. */
export default defineConfig({
  base: '/ship/',
  build: {
    outDir: '../embeds/ship',
    emptyOutDir: true,
    target: 'esnext', // main.js uses top-level await
  },
});
