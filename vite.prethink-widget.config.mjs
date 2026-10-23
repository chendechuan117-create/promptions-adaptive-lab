import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

// MCP Apps resources ship as one HTML document. All React code and styles are
// bundled locally; the iframe needs no asset fetches or third-party CDN.
function inlineWidgetAssets() {
  return {
    name: 'prethink-inline-widget',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlEntry = Object.entries(bundle).find(([name]) => name.endsWith('.html'));
      if (!htmlEntry || htmlEntry[1].type !== 'asset') throw new Error('Widget HTML was not generated');
      let html = String(htmlEntry[1].source);
      const used = new Set();
      html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (_tag, source) => {
        const name = source.replace(/^\.\//, '').replace(/^\//, '');
        const item = bundle[name];
        if (!item || item.type !== 'chunk' || item.imports.length || item.dynamicImports.length) throw new Error(`Widget script is not self-contained: ${source}`);
        used.add(name);
        return `<script type="module">${item.code.replace(/<\/script/gi, '<\\/script')}</script>`;
      });
      html = html.replace(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g, (_tag, source) => {
        const name = source.replace(/^\.\//, '').replace(/^\//, '');
        const item = bundle[name];
        if (!item || item.type !== 'asset') throw new Error(`Widget stylesheet missing: ${source}`);
        used.add(name);
        return `<style>${String(item.source).replace(/<\/style/gi, '<\\/style')}</style>`;
      });
      if (/<script\b[^>]*\bsrc=|<link\b[^>]*\b(?:href|rel)="(?:[^\"]+\.css|modulepreload)"/i.test(html)) throw new Error('Widget contains external build assets');
      for (const name of used) delete bundle[name];
      delete bundle[htmlEntry[0]];
      this.emitFile({ type: 'asset', fileName: 'widget.html', source: html });
    },
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [inlineWidgetAssets()],
  build: {
    outDir: path.join(root, 'dist-prethink-widget'),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: path.join(root, 'prethink-widget.html'),
      output: { inlineDynamicImports: true },
    },
  },
});
