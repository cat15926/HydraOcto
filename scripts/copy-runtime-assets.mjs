import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc emits the TypeScript services. The review runner must travel with the same server build.
const build = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist/', import.meta.url));
for (const name of ['project-review-test.py', 'project-npm.py', 'project-web.py', 'project-git.py']) {
  const target = join(build, 'scripts/runtime', name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(new URL('./runtime/' + name, import.meta.url), target);
}
