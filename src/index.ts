#!/usr/bin/env node
import v8 from 'node:v8';
import { loadConfig } from './config/index.js';
import { summarizeError } from './core/redact.js';
import { BitbucketMcpServer } from './server.js';

// Entry point: load config (all policy lives there), validate credentials,
// start the server. Everything else is wired inside BitbucketMcpServer.

// Defense in depth against regex denial of service: ask V8 to fall back to
// its linear-time regexp engine when a match backtracks excessively. The
// primary guards live in src/core/safe-regex.ts; this is best-effort and
// harmless where unsupported.
try {
  v8.setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks');
} catch {
  // unsupported V8 flag — the static + probe + deadline guards still apply
}

const config = loadConfig();

// Bearer credentials carry their own identity, so a username is only required
// for Basic auth. Bitbucket Cloud repository and workspace access tokens are
// bearer-only and have no username.
if (!config.auth.token && (!config.auth.username || !config.auth.appPassword)) {
  console.error(
    'Error: Basic auth needs BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD. ' +
      'Or set BITBUCKET_TOKEN for bearer auth: a Server/DC personal access token, ' +
      'or a Bitbucket Cloud repository/workspace access token.'
  );
  process.exit(1);
}

// Node's default handler prints the whole rejection value (which for an
// escaped axios error would include the Authorization header).
process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', summarizeError(reason));
  process.exit(1);
});

new BitbucketMcpServer(config).run().catch(error => {
  console.error('Fatal:', summarizeError(error));
  process.exit(1);
});
