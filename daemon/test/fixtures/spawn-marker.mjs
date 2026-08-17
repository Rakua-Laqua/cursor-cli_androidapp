import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const markerPath = process.argv[2];
const mockPath = process.argv[3];
if (typeof markerPath !== 'string' || typeof mockPath !== 'string') {
  process.stderr.write('spawn-marker requires marker and mock paths\n');
  process.exit(1);
}

writeFileSync(markerPath, `${process.pid}\n`);

const child = spawn(process.execPath, [mockPath], {
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
