import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'source', 'scripts', 'test']) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
process.stdout.write('模块语法检查完成\n');
