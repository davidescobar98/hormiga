// Thin launcher for electron-vite.
// Some hosts (e.g. terminals embedded in other Electron apps) export ELECTRON_RUN_AS_NODE,
// which makes Electron start as plain Node and breaks the app. We clear it before spawning.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
