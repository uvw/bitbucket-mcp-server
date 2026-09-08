#!/usr/bin/env node
import { loadConfig } from './config/index.js';
import { BitbucketMcpServer } from './server.js';

// Entry point: load config (all policy lives there), validate credentials,
// start the server. Everything else is wired inside BitbucketMcpServer.

const config = loadConfig();

// Bearer credentials carry their own identity, so a username is only required
// for Basic auth. Demanding one unconditionally made Bitbucket Cloud repository
// and workspace access tokens — which are bearer-only — impossible to use.
if (!config.auth.token && (!config.auth.username || !config.auth.appPassword)) {
  console.error(
    'Error: Basic auth needs BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD. ' +
      'Alternatively set BITBUCKET_TOKEN for bearer auth — a Server/DC personal access token, ' +
      'or a Bitbucket Cloud repository/workspace access token.'
  );
  process.exit(1);
}

new BitbucketMcpServer(config).run().catch(error => {
  console.error('Fatal:', error);
  process.exit(1);
});
