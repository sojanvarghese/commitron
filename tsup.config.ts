import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  minify: false, // Keep readable for CLI debugging
  splitting: false, // Single bundle for CLI
  treeshake: true,
  external: [
    // Keep these as external dependencies
    '@google/generative-ai',
    'chalk',
    'commander',
    'inquirer',
    'ora',
    'simple-git',
  ],
  esbuildOptions(options) {
    options.banner = {
      js: '#!/usr/bin/env node',
    };
  },
  onSuccess: 'echo "Build completed successfully!"',
});
