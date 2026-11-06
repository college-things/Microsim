// Puts the product page at the site root and the web app under app/, ready for GitHub Pages.
// Run `npm run build:web` first.
import { cpSync, existsSync, rmSync } from "node:fs";
const out = "dist-site";
if (!existsSync("dist/index.html")) throw new Error("Build the web app first: npm run build:web");
rmSync(out, { recursive: true, force: true });
cpSync("site", out, { recursive: true });
cpSync("dist", `${out}/app`, { recursive: true });
console.log(`Site ready in ${out}/`);
