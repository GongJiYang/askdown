import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const target = process.env.RELEASE_TARGET;
const team = process.env.APPLE_TEAM_ID;
if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target) || !team) {
  throw new Error('macOS verification requires RELEASE_TARGET and APPLE_TEAM_ID.');
}
const folder = join('src-tauri', 'target', target, 'release', 'bundle', 'macos');
const apps = readdirSync(folder).filter(name => name.endsWith('.app'));
if (apps.length !== 1) throw new Error('Expected exactly one macOS application bundle.');
const app = join(folder, apps[0]);
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} verification failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout + result.stderr;
}
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
const signature = run('codesign', ['--display', '--verbose=4', app]);
if (!signature.includes(`TeamIdentifier=${team}`) || !signature.includes('Authority=Developer ID Application:')) {
  throw new Error('macOS bundle lacks the required Developer ID signature and team.');
}
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
console.log(`Verified Developer ID signing and stapled notarization for ${target}.`);
