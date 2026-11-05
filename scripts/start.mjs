// Runs the built Go server (dist/litex, or dist/litex.exe on Windows) from the project root.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const bin = process.platform === 'win32' ? 'dist/litex.exe' : 'dist/litex';
if (!existsSync(bin)) {
  console.error(`${bin} not found. Run \`npm run build\` first.`);
  process.exit(1);
}
const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
