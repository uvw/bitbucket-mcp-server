import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools/registry.js';
import { toolDefinitions } from '../tools/definitions.js';
import {
  isManageBranchRestrictionArgs,
  isManageRepositoryPermissionArgs,
  isDeleteRepositoryArgs,
  isUpdateRepositorySettingsArgs,
  isManagePipelineVariableArgs,
} from '../tools/guards.js';
import { isConflictError } from '../core/api-client.js';
import type { ToolDefinition } from '../types/index.js';

// ── gating ───────────────────────────────────────────────────────────────────
// The management group can change branch permissions and delete repositories,
// so what it takes to expose it is a safety property, not a preference.

const noop = async () => ({ content: [{ type: 'text', text: 'ok' }] });

const def = (over: Partial<ToolDefinition>): ToolDefinition => ({
  name: 'x', description: 'd', inputSchema: {}, group: 'management', availability: 'cloud_only', ...over,
});

function registry(opts: { isServer?: boolean; groups?: string[] | null; enabled?: boolean; allowWrite?: boolean }) {
  const r = new ToolRegistry(opts.isServer ?? false, opts.groups ?? null, {
    enabled: opts.enabled ?? false,
    allowWrite: opts.allowWrite ?? false,
  });
  r.register(def({ name: 'mgmt_read' }), noop);
  r.register(def({ name: 'mgmt_write', mutates: true }), noop);
  r.register(def({ name: 'pr_tool', group: 'pr_core', availability: 'both' }), noop);
  r.register(def({ name: 'srv_tool', group: 'search', availability: 'server_only' }), noop);
  return r;
}
const names = (r: ToolRegistry) => r.listDefinitions().map(d => d.name).sort();

test('management is hidden by default, even with no group filter set', () => {
  // enabledGroups null means "every group" for ordinary tools, which is exactly
  // why management cannot rely on that mechanism.
  const r = registry({});
  assert.deepEqual(names(r), ['pr_tool']);
});

test('BITBUCKET_MANAGEMENT exposes reads but still not writes', () => {
  const r = registry({ enabled: true });
  assert.deepEqual(names(r), ['mgmt_read', 'pr_tool']);
});

test('writes need the second gate as well', () => {
  const r = registry({ enabled: true, allowWrite: true });
  assert.deepEqual(names(r), ['mgmt_read', 'mgmt_write', 'pr_tool']);
});

test('allowWrite alone does nothing without enabled', () => {
  const r = registry({ allowWrite: true });
  assert.deepEqual(names(r), ['pr_tool']);
});

test('a hidden management tool is not callable by name', async () => {
  const r = registry({ enabled: true }); // reads only
  await assert.rejects(() => r.dispatch('mgmt_write', {}), /Unknown tool/);
  await assert.rejects(() => registry({}).dispatch('mgmt_read', {}), /Unknown tool/);
});

test('cloud_only tools disappear on Server, server_only on Cloud', () => {
  const cloud = registry({ enabled: true, allowWrite: true });
  assert.ok(names(cloud).includes('mgmt_read'));
  assert.ok(!names(cloud).includes('srv_tool'));
  const server = registry({ isServer: true, enabled: true, allowWrite: true });
  assert.deepEqual(names(server), ['pr_tool', 'srv_tool']);
});

test('an explicit group filter still applies on top of the gates', () => {
  const r = registry({ enabled: true, allowWrite: true, groups: ['pr_core'] });
  assert.deepEqual(names(r), ['pr_tool']);
  const only = registry({ enabled: true, allowWrite: true, groups: ['management'] });
  assert.deepEqual(names(only), ['mgmt_read', 'mgmt_write']);
});

// ── shipped definitions ──────────────────────────────────────────────────────

test('every management definition is cloud_only and mutating ones are marked', () => {
  const mgmt = toolDefinitions.filter(t => t.group === 'management');
  assert.ok(mgmt.length >= 20, `expected the management surface, got ${mgmt.length}`);
  for (const t of mgmt) {
    assert.equal(t.availability, 'cloud_only', `${t.name} must be cloud_only`);
  }
  // Anything that writes must be flagged, or the write gate silently leaks it.
  const shouldMutate = mgmt.filter(t => /^(manage_|update_|create_|delete_)/.test(t.name));
  for (const t of shouldMutate) {
    assert.equal(t.mutates, true, `${t.name} looks mutating but is not flagged`);
  }
  const readOnly = mgmt.filter(t => /^(get_|list_)/.test(t.name));
  for (const t of readOnly) {
    assert.notEqual(t.mutates, true, `${t.name} looks read-only but is flagged mutating`);
  }
});

test('every mutating management tool accepts dry_run', () => {
  const mutating = toolDefinitions.filter(t => t.group === 'management' && t.mutates);
  for (const t of mutating) {
    const props = (t.inputSchema as any).properties ?? {};
    assert.ok(props.dry_run, `${t.name} must accept dry_run`);
  }
});

// ── guards ───────────────────────────────────────────────────────────────────

test('manage_branch_restriction: action and numeric strictness', () => {
  const ok = { workspace: 'w', repository: 'r', action: 'set', kind: 'push', pattern: 'main' };
  assert.equal(isManageBranchRestrictionArgs(ok), true);
  assert.equal(isManageBranchRestrictionArgs({ ...ok, action: 'nuke' }), false);
  assert.equal(isManageBranchRestrictionArgs({ ...ok, branch_match_kind: 'sideways' }), false);
  assert.equal(isManageBranchRestrictionArgs({ ...ok, value: 1.5 }), false);
  assert.equal(isManageBranchRestrictionArgs({ ...ok, users: ['a', 2] }), false);
  assert.equal(isManageBranchRestrictionArgs({ ...ok, restriction_id: 0 }), false);
  assert.equal(isManageBranchRestrictionArgs({ workspace: 'w', action: 'set' }), true); // handler rejects missing repo
});

test('manage_repository_permission: exactly one subject', () => {
  const base = { workspace: 'w', repository: 'r', action: 'set', permission: 'read' };
  assert.equal(isManageRepositoryPermissionArgs({ ...base, user: 'u' }), true);
  assert.equal(isManageRepositoryPermissionArgs({ ...base, group: 'g' }), true);
  // Both is ambiguous and neither has no target. Reject each.
  assert.equal(isManageRepositoryPermissionArgs({ ...base, user: 'u', group: 'g' }), false);
  assert.equal(isManageRepositoryPermissionArgs(base), false);
  assert.equal(isManageRepositoryPermissionArgs({ ...base, user: 'u', permission: 'root' }), false);
});

test('delete_repository: confirmation string is required by the guard', () => {
  assert.equal(isDeleteRepositoryArgs({ workspace: 'w', repository: 'r', confirm_full_name: 'w/r' }), true);
  assert.equal(isDeleteRepositoryArgs({ workspace: 'w', repository: 'r' }), false);
  assert.equal(isDeleteRepositoryArgs({ workspace: 'w', repository: 'r', confirm_full_name: 42 }), false);
});

test('update_repository_settings / pipeline variable: optional types stay strict', () => {
  assert.equal(isUpdateRepositorySettingsArgs({ workspace: 'w', repository: 'r', is_private: true }), true);
  assert.equal(isUpdateRepositorySettingsArgs({ workspace: 'w', repository: 'r', is_private: 'yes' }), false);
  assert.equal(isUpdateRepositorySettingsArgs({ workspace: 'w', repository: 'r', dry_run: 1 }), false);
  assert.equal(isManagePipelineVariableArgs({ workspace: 'w', action: 'set', key: 'K', value: 'V' }), true);
  assert.equal(isManagePipelineVariableArgs({ workspace: 'w', action: 'set', secured: 'true' }), false);
});

// ── conflict detection ───────────────────────────────────────────────────────
// "Set" falls back from create to update on a conflict, so recognising one is
// what keeps the operation idempotent. Bitbucket signals it two different ways.

test('isConflictError: 409, prose, and non-conflicts', () => {
  assert.equal(isConflictError({ status: 409 }), true);
  assert.equal(isConflictError({ originalError: { response: { status: 409 } } }), true);
  // Branch restrictions answer 400 with the clash in the message.
  assert.equal(
    isConflictError({ status: 400, message: 'a branch restriction with that kind (push) and pattern (main) already exists (id=1)' }),
    true
  );
  assert.equal(
    isConflictError({ status: 400, originalError: { response: { data: { error: { message: 'Conflict' } } } } }),
    true
  );
  // Anything else must propagate. Swallowing it turns a real failure into a
  // silent no-op update attempt.
  assert.equal(isConflictError({ status: 403, message: 'Forbidden' }), false);
  assert.equal(isConflictError({ status: 404, message: 'Not found' }), false);
  assert.equal(isConflictError({}), false);
  assert.equal(isConflictError(undefined), false);
});

// ── handler behaviour with a stubbed client ──────────────────────────────────
// These three bugs all reported success while doing the wrong thing, so they
// are the ones worth pinning.

import { ManagementHandlers } from '../handlers/management-handlers.js';

type Sent = { method: string; path: string; body?: any };

function stubHandlers(responses: Record<string, any> = {}) {
  const sent: Sent[] = [];
  const client: any = {
    clampPageSize: (n: number) => Math.min(n, 100),
    invalidateRef: () => {},
    getIsServer: () => false,
    makeRequest: async (method: string, path: string, body?: any) => {
      sent.push({ method, path, body });
      const key = `${method} ${path.split('?')[0]}`;
      if (key in responses) return responses[key];
      if (method === 'get') return { values: [] };
      return {};
    },
  };
  const cfg: any = { pagination: { defaultListLimit: 25 }, output: {} };
  return { h: new ManagementHandlers(client, cfg), sent };
}
const textOf = (r: any) => r.content[0].text;

test('dry_run never echoes a secured variable value', async () => {
  const { h, sent } = stubHandlers();
  const r = await h.handleManagePipelineVariable({
    workspace: 'w', repository: 'r', action: 'set',
    key: 'K', value: 'SUPERSECRET', secured: true, dry_run: true,
  });
  assert.ok(!textOf(r).includes('SUPERSECRET'), 'secured value leaked into dry_run output');
  assert.match(textOf(r), /redacted/);
  // A dry run must not write. Only the reconciliation read may go out.
  assert.equal(sent.filter(s => s.method !== 'get').length, 0, 'a dry run wrote');
});

test('dry_run does show a non-secured value, and still writes nothing', async () => {
  const { h, sent } = stubHandlers();
  const r = await h.handleManagePipelineVariable({
    workspace: 'w', repository: 'r', action: 'set', key: 'K', value: 'plain', dry_run: true,
  });
  assert.match(textOf(r), /plain/);
  assert.equal(sent.filter(s => s.method !== 'get').length, 0, 'a dry run wrote');
});

test('an empty variable value is sent, not dropped', async () => {
  const { h, sent } = stubHandlers();
  await h.handleManagePipelineVariable({
    workspace: 'w', repository: 'r', action: 'set', key: 'K', value: '',
  });
  const write = sent.find(s => s.method === 'post' || s.method === 'put');
  assert.ok(write, 'no write was sent');
  // compactObject drops '', which turned "clear this variable" into a no-op
  // that still reported success.
  assert.equal(write!.body.value, '', 'empty value was dropped from the body');
  assert.equal(write!.body.key, 'K');
});

test('repo-only tools reject project_key instead of ignoring it', async () => {
  const { h } = stubHandlers();
  await assert.rejects(
    () => h.handleListBranchRestrictions({ workspace: 'w', repository: 'r', project_key: 'P' }),
    /no project scope/
  );
  // And a repo-or-project tool rejects being given both.
  await assert.rejects(
    () => h.handleGetBranchingModel({ workspace: 'w', repository: 'r', project_key: 'P' }),
    /not both/
  );
});

test('delete_repository refuses without an exact confirmation, even on dry_run', async () => {
  const { h, sent } = stubHandlers();
  const wrong = await h.handleDeleteRepository({ workspace: 'w', repository: 'r', confirm_full_name: 'w/other' });
  assert.equal(wrong.isError, true);
  assert.equal(sent.length, 0, 'a refused delete still sent a request');
  const dry = await h.handleDeleteRepository({
    workspace: 'w', repository: 'r', confirm_full_name: 'w/r', dry_run: true,
  });
  assert.match(textOf(dry), /dry_run/);
  assert.equal(sent.filter(s => s.method === 'delete').length, 0, 'dry_run issued a DELETE');
});

test('branch restriction set updates the existing record rather than adding one', async () => {
  const { h, sent } = stubHandlers({
    'get /repositories/w/r/branch-restrictions': {
      values: [{ id: 7, kind: 'require_approvals_to_merge', branch_match_kind: 'glob', pattern: 'main', value: 1 }],
    },
  });
  await h.handleManageBranchRestriction({
    workspace: 'w', repository: 'r', action: 'set',
    kind: 'require_approvals_to_merge', pattern: 'main', value: 2,
  });
  assert.equal(sent.filter(s => s.method === 'post').length, 0, 'a duplicate was created');
  const put = sent.find(s => s.method === 'put');
  assert.equal(put!.path, '/repositories/w/r/branch-restrictions/7');
  assert.equal(put!.body.value, 2);
});

test('project_key is a field on update_repository_settings, a mistake elsewhere', async () => {
  const { h, sent } = stubHandlers();
  // Moving a repository into a project is a legitimate edit, so the guard that
  // rejects project_key on repo-only tools must not reach this one.
  await h.handleUpdateRepositorySettings({
    workspace: 'w', repository: 'r', project_key: 'LIB',
  });
  const put = sent.find(s => s.method === 'put');
  assert.equal(put!.path, '/repositories/w/r');
  assert.deepEqual(put!.body.project, { key: 'LIB' });
  // Still refused where it can only be a mistake.
  await assert.rejects(
    () => h.handleManagePipelinesConfig({ workspace: 'w', repository: 'r', enabled: true, project_key: 'LIB' }),
    /no project scope/
  );
});

test("Bitbucket's error detail is surfaced, not flattened to Bad request", async () => {
  const sent: Sent[] = [];
  const client: any = {
    clampPageSize: (n: number) => n,
    invalidateRef: () => {},
    getIsServer: () => false,
    makeRequest: async (method: string, path: string) => {
      sent.push({ method, path });
      throw {
        status: 400,
        message: 'Bad request',
        originalError: {
          response: {
            status: 400,
            data: { error: { message: 'Bad request', detail: 'Cannot stop pipeline result that is already complete with status PASSED' } },
          },
        },
      };
    },
  };
  const h = new ManagementHandlers(client, { pagination: { defaultListLimit: 25 }, output: {} } as any);
  await assert.rejects(
    () => h.handleManagePipelineRun({ workspace: 'w', repository: 'r', action: 'stop', pipeline_uuid: 'p' }),
    /already complete with status PASSED/
  );
});
