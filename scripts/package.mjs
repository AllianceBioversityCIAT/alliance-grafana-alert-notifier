import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const packageDir = path.join(rootDir, 'package');
const zipPath = path.join(rootDir, 'grafana-alert-lambda.zip');

rmSync(packageDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });

cpSync(distDir, path.join(packageDir, 'dist'), { recursive: true });
cpSync(path.join(rootDir, 'package.json'), path.join(packageDir, 'package.json'));

console.log('Installing production dependencies...');
execSync('npm install --omit=dev', {
  cwd: packageDir,
  stdio: 'inherit',
});

console.log('Creating deployment zip...');
if (process.platform === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${packageDir}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' },
  );
} else {
  execSync(`cd "${packageDir}" && zip -r "${zipPath}" .`, {
    stdio: 'inherit',
  });
}

console.log(`Package created at ${zipPath}`);
