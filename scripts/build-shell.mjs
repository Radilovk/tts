// Copy the web app into capacitor-shell/ (the folder Capacitor packs into the APK).
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = 'capacitor-shell';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const p of ['index.html', 'manifest.json', 'css', 'js', 'icons']) cpSync(p, `${OUT}/${p}`, { recursive: true });

// Optional build-time key, same as the GitHub Pages deploy
const key = process.env.GEMINI_API_KEY;
if (key) {
    const f = `${OUT}/js/config.js`;
    writeFileSync(f, readFileSync(f, 'utf8').replace('__GEMINI_API_KEY__', key));
}
console.log('capacitor-shell ready');
