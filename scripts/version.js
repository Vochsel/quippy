// Version label shown on the home page: goes up by one with every commit.
import { execFileSync } from 'node:child_process';

export function gitVersion() {
  try {
    const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return `v0.${git('rev-list', '--count', 'HEAD')} · ${git('rev-parse', '--short', 'HEAD')}`;
  } catch {
    return 'dev';
  }
}
