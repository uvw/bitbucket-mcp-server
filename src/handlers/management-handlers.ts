import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { BitbucketApiClient, isConflictError } from '../core/api-client.js';
import { compactObject, errorContent, jsonContent, textContent } from '../formatting/respond.js';
import type { BitbucketMcpConfig, ToolResponse } from '../types/index.js';
import * as g from '../tools/guards.js';

/**
 * Repository administration: branch restrictions, branching model, settings,
 * default reviewers, permissions, pipelines, webhooks, deploy keys,
 * environments, and repository lifecycle.
 *
 * Cloud only. Server/DC exposes a different admin API, so these register as
 * `cloud_only` rather than pretending to be portable.
 *
 * Two things shape every method. Most settings exist at repository and project
 * level, and project scope is what makes fleet alignment tractable: one call
 * covers every repository in the project. A repository holding its own explicit
 * setting is not changed by a project default. And every mutating tool takes
 * `dry_run`, which reports the request it would send and sends nothing.
 */
export class ManagementHandlers {
  constructor(
    private apiClient: BitbucketApiClient,
    private cfg: BitbucketMcpConfig
  ) {}

  // ── plumbing ───────────────────────────────────────────────────────────────

  /**
   * Repository or project base path. Exactly one of repository/project_key is
   * required. Preferring one silently would apply a fleet-wide change to a
   * single repository, or the reverse.
   */
  private resolveScope(args: any, what: string): { base: string; label: string } {
    const { workspace, repository, project_key } = args;
    if (repository && project_key) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Pass repository OR project_key for ${what}, not both. They are different blast radii.`
      );
    }
    if (repository) {
      return { base: `/repositories/${workspace}/${repository}`, label: `${workspace}/${repository}` };
    }
    if (project_key) {
      return { base: `/workspaces/${workspace}/projects/${project_key}`, label: `${workspace} project ${project_key}` };
    }
    throw new McpError(ErrorCode.InvalidParams, `${what} needs either repository or project_key.`);
  }

  private repoOnly(args: any, what: string): { base: string; label: string } {
    const { workspace, repository, project_key } = args;
    if (!repository) {
      throw new McpError(ErrorCode.InvalidParams, `${what} is repository-scoped. Pass repository.`);
    }
    // Accepting and ignoring project_key would read as a project-wide change
    // that silently hit one repository.
    if (project_key) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${what} has no project scope. Drop project_key, or use a tool that accepts it.`
      );
    }
    return { base: `/repositories/${workspace}/${repository}`, label: `${workspace}/${repository}` };
  }

  /**
   * Bitbucket names the scope it wanted in error.detail.required. Pass that
   * array through. A bare "403 Forbidden" sends people hunting through
   * repository permissions for an unticked box at mint time.
   */
  private async call<T>(method: 'get' | 'post' | 'put' | 'delete', path: string, body?: any): Promise<T> {
    try {
      return await this.apiClient.makeRequest<T>(method, path, body);
    } catch (error: any) {
      const detail = error?.originalError?.response?.data?.error?.detail ?? error?.response?.data?.error?.detail;
      const required: string[] | undefined = detail?.required;
      if (required?.length) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Bitbucket refused this call for lack of token scope. Required: ${required.join(', ')}. ` +
            `Re-mint the token with that scope ticked. Repository permissions are not the problem.`
        );
      }
      throw error;
    }
  }

  /**
   * Create-or-update against a collection whose listing may be stale.
   *
   * "Set" has to be idempotent: applying the same policy twice across a fleet
   * must not leave two records. The obvious implementation lists, then PUTs the
   * match or POSTs a new one. But Bitbucket's pipeline-variables collection is
   * eventually consistent, and a variable created a moment earlier is absent
   * from the next listing, so a create that should have been an update returns
   * 409.
   *
   * The listing is a hint, not the truth. On conflict, read again and update the
   * record that must exist. Branch restrictions get the same path; they report
   * the clash in prose, and parsing error text would be worse than asking.
   */
  private async createOrUpdate(
    collection: string,
    body: any,
    find: (values: any[]) => any | undefined,
    idOf: (record: any) => string | number,
    what: string
  ): Promise<{ record: any; action: 'created' | 'updated' }> {
    const list = async () => {
      const r = await this.call<any>('get', `${collection}?pagelen=${CLOUD_COLLECTION_SCAN}`);
      return (r.values || []) as any[];
    };

    const existing = find(await list());
    if (existing) {
      return { record: await this.call<any>('put', `${collection}/${idOf(existing)}`, body), action: 'updated' };
    }

    try {
      return { record: await this.call<any>('post', collection, body), action: 'created' };
    } catch (error: any) {
      if (!isConflictError(error)) throw error;
      const after = find(await list());
      if (!after) {
        throw new McpError(
          ErrorCode.InternalError,
          `${what} already exists but is not in the collection listing yet, so it cannot be updated. ` +
            `Bitbucket is briefly inconsistent here. Retry in a moment.`
        );
      }
      return { record: await this.call<any>('put', `${collection}/${idOf(after)}`, body), action: 'updated' };
    }
  }

  /** Uniform dry-run payload: the request that would go out, plus context. */
  private planned(method: string, path: string, body: any, current?: any, note?: string): ToolResponse {
    return jsonContent(
      compactObject({
        dry_run: true,
        would_send: compactObject({ method: method.toUpperCase(), path, body }),
        current: current ?? undefined,
        note: note ?? 'Nothing was sent. Re-run without dry_run to apply.',
      })
    );
  }

  private async currentOrNull(path: string): Promise<any> {
    try {
      return await this.apiClient.makeRequest<any>('get', path);
    } catch {
      return null;
    }
  }

  // ── repository settings ────────────────────────────────────────────────────

  async handleGetRepositorySettings(args: any): Promise<ToolResponse> {
    if (!g.isManagementReadArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for get_repository_settings');
    }
    const { base } = this.repoOnly(args, 'get_repository_settings');
    const r = await this.call<any>('get', base);
    return jsonContent(
      compactObject({
        full_name: r.full_name,
        slug: r.slug,
        name: r.name,
        description: r.description || undefined,
        is_private: r.is_private,
        fork_policy: r.fork_policy,
        main_branch: r.mainbranch?.name,
        project: r.project?.key,
        language: r.language || undefined,
        has_issues: r.has_issues,
        has_wiki: r.has_wiki,
        size: r.size,
        updated_on: r.updated_on,
      })
    );
  }

  async handleUpdateRepositorySettings(args: any): Promise<ToolResponse> {
    if (!g.isUpdateRepositorySettingsArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for update_repository_settings');
    }
    const { base, label } = this.repoOnly(args, 'update_repository_settings');
    const body: any = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.description !== undefined) body.description = args.description;
    if (args.is_private !== undefined) body.is_private = args.is_private;
    if (args.fork_policy !== undefined) body.fork_policy = args.fork_policy;
    if (args.has_issues !== undefined) body.has_issues = args.has_issues;
    if (args.has_wiki !== undefined) body.has_wiki = args.has_wiki;
    if (args.language !== undefined) body.language = args.language;
    if (args.main_branch !== undefined) body.mainbranch = { type: 'branch', name: args.main_branch };
    if (args.project_key !== undefined) body.project = { key: args.project_key };
    if (Object.keys(body).length === 0) {
      return errorContent('Nothing to change. Pass at least one field.');
    }
    // Renaming changes the slug, so clone URLs, webhook targets and CI
    // references built from it stop resolving.
    const notes: string[] = [];
    if (body.name !== undefined) notes.push('Renaming also changes the repository slug and therefore its clone URLs.');
    if (body.mainbranch) notes.push('The new main branch must already exist.');

    if (args.dry_run) {
      const current = await this.currentOrNull(base);
      return this.planned('put', base, body, current && {
        name: current.name, slug: current.slug, is_private: current.is_private,
        fork_policy: current.fork_policy, main_branch: current.mainbranch?.name,
        project: current.project?.key, has_issues: current.has_issues, has_wiki: current.has_wiki,
      }, notes.length ? notes.join(' ') : undefined);
    }
    const r = await this.call<any>('put', base, body);
    return jsonContent(
      compactObject({
        updated: label,
        full_name: r.full_name,
        slug: r.slug,
        name: r.name,
        main_branch: r.mainbranch?.name,
        project: r.project?.key,
        note: notes.length ? notes.join(' ') : undefined,
      })
    );
  }

  // ── branch restrictions ────────────────────────────────────────────────────

  async handleListBranchRestrictions(args: any): Promise<ToolResponse> {
    if (!g.isManagementReadArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for list_branch_restrictions');
    }
    const { base } = this.repoOnly(args, 'list_branch_restrictions');
    const limit = this.apiClient.clampPageSize(args.limit ?? this.cfg.pagination.defaultListLimit);
    const r = await this.call<any>('get', `${base}/branch-restrictions?pagelen=${limit}`);
    return jsonContent(
      compactObject({
        restrictions: (r.values || []).map((v: any) =>
          compactObject({
            id: v.id,
            kind: v.kind,
            branch_match_kind: v.branch_match_kind,
            pattern: v.pattern || undefined,
            branch_type: v.branch_type || undefined,
            value: v.value ?? undefined,
            users: (v.users || []).map((u: any) => u.nickname || u.display_name).filter(Boolean),
            groups: (v.groups || []).map((x: any) => x.slug || x.name).filter(Boolean),
          })
        ),
        has_more: !!r.next || undefined,
      })
    );
  }

  async handleManageBranchRestriction(args: any): Promise<ToolResponse> {
    if (!g.isManageBranchRestrictionArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_branch_restriction');
    }
    const { base, label } = this.repoOnly(args, 'manage_branch_restriction');
    const { action, kind, pattern, branch_match_kind = 'glob', branch_type, value, users, groups, restriction_id } = args;

    if (action === 'delete') {
      if (restriction_id === undefined) {
        return errorContent('delete needs restriction_id. list_branch_restrictions reports it.');
      }
      const path = `${base}/branch-restrictions/${restriction_id}`;
      if (args.dry_run) return this.planned('delete', path, undefined, await this.currentOrNull(path));
      await this.call('delete', path);
      return jsonContent({ deleted: restriction_id, repository: label });
    }

    if (!kind) return errorContent('set needs kind.');
    if (branch_match_kind === 'glob' && !pattern) {
      return errorContent('branch_match_kind "glob" needs a pattern (e.g. "main", "release/*").');
    }
    if (branch_match_kind === 'branching_model' && !branch_type) {
      return errorContent('branch_match_kind "branching_model" needs branch_type.');
    }

    const body: any = compactObject({
      kind,
      branch_match_kind,
      pattern: branch_match_kind === 'glob' ? pattern : undefined,
      branch_type: branch_match_kind === 'branching_model' ? branch_type : undefined,
      value: value ?? undefined,
      users: users ? users.map((u: string) => ({ uuid: u.startsWith('{') ? u : undefined, nickname: u.startsWith('{') ? undefined : u })).map(compactObject) : undefined,
      groups: groups ? groups.map((slug: string) => ({ slug })) : undefined,
    });

    // A restriction is a record, not a setting. POSTing the same kind and
    // pattern twice creates a second one and the pair compounds, so "set"
    // reconciles against what exists.
    const collection = `${base}/branch-restrictions`;
    const find = (values: any[]) =>
      values.find(
        v =>
          v.kind === kind &&
          v.branch_match_kind === branch_match_kind &&
          (branch_match_kind === 'glob' ? v.pattern === pattern : v.branch_type === branch_type)
      );

    if (args.dry_run) {
      const match = find(await this.call<any>('get', `${collection}?pagelen=${CLOUD_COLLECTION_SCAN}`).then((r: any) => r.values || []));
      return match
        ? this.planned('put', `${collection}/${match.id}`, body,
            { id: match.id, kind: match.kind, pattern: match.pattern, value: match.value ?? undefined },
            'A restriction with this kind and pattern exists. It would be UPDATED, not duplicated.')
        : this.planned('post', collection, body, null, 'No restriction with this kind and pattern exists. It would be CREATED.');
    }

    const { record, action: outcome } = await this.createOrUpdate(collection, body, find, r => r.id, 'That branch restriction');
    return jsonContent(
      compactObject({
        [outcome]: record.id,
        kind: record.kind,
        pattern: record.pattern ?? undefined,
        repository: label,
      })
    );
  }

  // ── branching model ────────────────────────────────────────────────────────

  async handleGetBranchingModel(args: any): Promise<ToolResponse> {
    if (!g.isManagementScopedReadArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for get_branching_model');
    }
    const { base, label } = this.resolveScope(args, 'get_branching_model');
    const [model, settings] = await Promise.all([
      this.currentOrNull(`${base}/branching-model`),
      this.currentOrNull(`${base}/branching-model/settings`),
    ]);
    if (!model && !settings) return errorContent(`No branching model readable for ${label}.`);
    return jsonContent(
      compactObject({
        scope: label,
        development: model?.development && { name: model.development.name, use_mainbranch: model.development.use_mainbranch },
        production: model?.production && { name: model.production.name, use_mainbranch: model.production.use_mainbranch, enabled: model.production.enabled },
        branch_types: (model?.branch_types || []).map((b: any) => ({ kind: b.kind, prefix: b.prefix })),
        settings_readable: settings ? true : false,
        settings_note: settings ? undefined : 'Settings need admin:repository (repo) or admin:project (project). The model above is the read-only resolved view.',
      })
    );
  }

  async handleManageBranchingModel(args: any): Promise<ToolResponse> {
    if (!g.isManageBranchingModelArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_branching_model');
    }
    const { base, label } = this.resolveScope(args, 'manage_branching_model');
    const body: any = {};
    if (args.development !== undefined) body.development = args.development;
    if (args.production !== undefined) body.production = args.production;
    if (args.branch_types !== undefined) body.branch_types = args.branch_types;
    if (Object.keys(body).length === 0) return errorContent('Nothing to change. Pass development, production, or branch_types.');
    const path = `${base}/branching-model/settings`;
    if (args.dry_run) return this.planned('put', path, body, await this.currentOrNull(path));
    const r = await this.call<any>('put', path, body);
    return jsonContent(
      compactObject({
        updated: label,
        development: r.development && { name: r.development.name, use_mainbranch: r.development.use_mainbranch },
        production: r.production && { name: r.production.name, enabled: r.production.enabled },
        branch_types: (r.branch_types || []).filter((b: any) => b.enabled).map((b: any) => ({ kind: b.kind, prefix: b.prefix })),
      })
    );
  }

  // ── default reviewers ──────────────────────────────────────────────────────

  async handleListDefaultReviewers(args: any): Promise<ToolResponse> {
    if (!g.isManagementScopedReadArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for list_default_reviewers');
    }
    const { base, label } = this.resolveScope(args, 'list_default_reviewers');
    const limit = this.apiClient.clampPageSize(args.limit ?? this.cfg.pagination.defaultListLimit);
    const r = await this.call<any>('get', `${base}/default-reviewers?pagelen=${limit}`);
    return jsonContent({
      scope: label,
      reviewers: (r.values || []).map((v: any) => compactObject({ uuid: v.uuid, nickname: v.nickname, display_name: v.display_name })),
    });
  }

  async handleManageDefaultReviewer(args: any): Promise<ToolResponse> {
    if (!g.isManageDefaultReviewerArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_default_reviewer');
    }
    const { base, label } = this.resolveScope(args, 'manage_default_reviewer');
    // The path takes a UUID or account id. A bare username is not a valid
    // selector here.
    const path = `${base}/default-reviewers/${encodeURIComponent(args.user)}`;
    if (args.action === 'remove') {
      if (args.dry_run) return this.planned('delete', path, undefined, await this.currentOrNull(path));
      await this.call('delete', path);
      return jsonContent({ removed: args.user, scope: label });
    }
    if (args.dry_run) return this.planned('put', path, {}, await this.currentOrNull(path));
    await this.call('put', path, {});
    return jsonContent({ added: args.user, scope: label });
  }

  // ── permissions ────────────────────────────────────────────────────────────

  async handleListRepositoryPermissions(args: any): Promise<ToolResponse> {
    if (!g.isManagementScopedReadArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for list_repository_permissions');
    }
    const { base, label } = this.resolveScope(args, 'list_repository_permissions');
    const limit = this.apiClient.clampPageSize(args.limit ?? this.cfg.pagination.defaultListLimit);
    const [users, groups] = await Promise.all([
      this.currentOrNull(`${base}/permissions-config/users?pagelen=${limit}`),
      this.currentOrNull(`${base}/permissions-config/groups?pagelen=${limit}`),
    ]);
    return jsonContent({
      scope: label,
      users: (users?.values || []).map((v: any) => compactObject({ user: v.user?.nickname || v.user?.display_name, uuid: v.user?.uuid, permission: v.permission })),
      groups: (groups?.values || []).map((v: any) => compactObject({ group: v.group?.slug || v.group?.name, permission: v.permission })),
    });
  }

  async handleManageRepositoryPermission(args: any): Promise<ToolResponse> {
    if (!g.isManageRepositoryPermissionArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_repository_permission');
    }
    const { base, label } = this.resolveScope(args, 'manage_repository_permission');
    const kind = args.group ? 'groups' : 'users';
    // The guard enforces exactly one of user/group. Re-check so the subject is
    // provably present before it reaches a URL path.
    const who: string | undefined = args.group ?? args.user;
    if (!who) return errorContent('Pass exactly one of user or group.');
    const path = `${base}/permissions-config/${kind}/${encodeURIComponent(who)}`;
    if (args.action === 'remove') {
      if (args.dry_run) return this.planned('delete', path, undefined, await this.currentOrNull(path));
      await this.call('delete', path);
      return jsonContent({ removed: who, kind, scope: label });
    }
    if (!args.permission) return errorContent('set needs permission (read, write, or admin).');
    const body = { permission: args.permission };
    if (args.dry_run) return this.planned('put', path, body, await this.currentOrNull(path));
    const r = await this.call<any>('put', path, body);
    return jsonContent({ set: who, kind, permission: r.permission ?? args.permission, scope: label });
  }

  // ── pipelines ──────────────────────────────────────────────────────────────

  async handleGetPipelinesConfig(args: any): Promise<ToolResponse> {
    if (!g.isManagementReadArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for get_pipelines_config');
    }
    const { base, label } = this.repoOnly(args, 'get_pipelines_config');
    const [config, schedules] = await Promise.all([
      this.currentOrNull(`${base}/pipelines_config`),
      this.currentOrNull(`${base}/pipelines_config/schedules`),
    ]);
    return jsonContent(
      compactObject({
        repository: label,
        enabled: config?.enabled,
        config_readable: config ? true : false,
        config_note: config ? undefined : 'pipelines_config needs admin:repository.',
        schedules: (schedules?.values || []).map((s: any) =>
          compactObject({ uuid: s.uuid, enabled: s.enabled, cron: s.cron_pattern, target_branch: s.target?.ref_name })
        ),
      })
    );
  }

  async handleManagePipelinesConfig(args: any): Promise<ToolResponse> {
    if (!g.isManagePipelinesConfigArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_pipelines_config');
    }
    const { base, label } = this.repoOnly(args, 'manage_pipelines_config');
    const path = `${base}/pipelines_config`;
    const body = { enabled: args.enabled };
    if (args.dry_run) return this.planned('put', path, body, await this.currentOrNull(path));
    const r = await this.call<any>('put', path, body);
    return jsonContent({ repository: label, enabled: r.enabled ?? args.enabled });
  }

  async handleListPipelineVariables(args: any): Promise<ToolResponse> {
    if (!g.isListPipelineVariablesArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for list_pipeline_variables');
    }
    const { path, label } = this.variableCollection(args);
    const limit = this.apiClient.clampPageSize(args.limit ?? this.cfg.pagination.defaultListLimit);
    const r = await this.call<any>('get', `${path}?pagelen=${limit}`);
    return jsonContent({
      scope: label,
      // The API never returns secured values. Report the flag so a caller can
      // tell empty from hidden.
      variables: (r.values || []).map((v: any) => compactObject({ uuid: v.uuid, key: v.key, secured: v.secured, value: v.secured ? undefined : v.value })),
    });
  }

  /** repo | workspace | deployment-environment variable collection. */
  private variableCollection(args: any): { path: string; label: string } {
    const { workspace, repository, environment_uuid } = args;
    if (environment_uuid) {
      if (!repository) throw new McpError(ErrorCode.InvalidParams, 'environment_uuid needs repository.');
      return {
        path: `/repositories/${workspace}/${repository}/deployments_config/environments/${environment_uuid}/variables`,
        label: `${workspace}/${repository} env ${environment_uuid}`,
      };
    }
    if (repository) {
      return { path: `/repositories/${workspace}/${repository}/pipelines_config/variables`, label: `${workspace}/${repository}` };
    }
    return { path: `/workspaces/${workspace}/pipelines-config/variables`, label: `workspace ${workspace}` };
  }

  async handleManagePipelineVariable(args: any): Promise<ToolResponse> {
    if (!g.isManagePipelineVariableArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_pipeline_variable');
    }
    const { path: collection, label } = this.variableCollection(args);
    if (args.action === 'delete') {
      if (!args.variable_uuid) return errorContent('delete needs variable_uuid. list_pipeline_variables reports it.');
      const path = `${collection}/${args.variable_uuid}`;
      if (args.dry_run) return this.planned('delete', path, undefined, null);
      await this.call('delete', path);
      return jsonContent({ deleted: args.variable_uuid, scope: label });
    }
    if (!args.key) return errorContent('set needs key.');
    // Built field by field rather than through compactObject, which drops ''.
    // Clearing a variable is a legitimate edit, and dropping the key made the
    // request a no-op that still reported success.
    const secured = args.secured ?? false;
    const body = { key: args.key, value: args.value ?? '', secured };
    // Variables are records with UUIDs, so setting an existing key is a PUT to
    // its uuid; POSTing the key again is a conflict, not an update.
    const find = (values: any[]) => values.find(v => v.key === args.key);

    if (args.dry_run) {
      // A secured value is write-only: the API never returns it, so echoing it
      // back here would be the one place it leaks.
      const shown = secured ? { ...body, value: '[redacted: secured]' } : body;
      const match = find(await this.call<any>('get', `${collection}?pagelen=${CLOUD_COLLECTION_SCAN}`).then((r: any) => r.values || []));
      return match
        ? this.planned('put', `${collection}/${match.uuid}`, shown,
            { uuid: match.uuid, key: match.key, secured: match.secured }, 'Key exists. It would be UPDATED in place.')
        : this.planned('post', collection, shown, null, 'Key does not exist. It would be CREATED.');
    }

    const { record, action: outcome } = await this.createOrUpdate(collection, body, find, r => r.uuid, `Variable ${args.key}`);
    return jsonContent(
      compactObject({ [outcome]: record.key ?? args.key, uuid: record.uuid, secured: record.secured, scope: label })
    );
  }

  async handleManagePipelineRun(args: any): Promise<ToolResponse> {
    if (!g.isManagePipelineRunArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_pipeline_run');
    }
    const { base, label } = this.repoOnly(args, 'manage_pipeline_run');
    if (args.action === 'stop') {
      if (!args.pipeline_uuid) return errorContent('stop needs pipeline_uuid.');
      const path = `${base}/pipelines/${args.pipeline_uuid}/stopPipeline`;
      if (args.dry_run) return this.planned('post', path, {}, null);
      await this.call('post', path, {});
      return jsonContent({ stopped: args.pipeline_uuid, repository: label });
    }
    if (!args.ref_name) return errorContent('trigger needs ref_name (the branch or tag to build).');
    const body: any = { target: compactObject({ ref_type: args.ref_type ?? 'branch', type: 'pipeline_ref_target', ref_name: args.ref_name }) };
    if (args.selector_pattern) {
      body.target.selector = { type: args.selector_type ?? 'custom', pattern: args.selector_pattern };
    }
    if (args.variables) body.variables = args.variables;
    const path = `${base}/pipelines/`;
    if (args.dry_run) return this.planned('post', path, body, null);
    const r = await this.call<any>('post', path, body);
    return jsonContent(compactObject({ triggered: r.uuid, build_number: r.build_number, state: r.state?.name, repository: label }));
  }

  // ── webhooks ───────────────────────────────────────────────────────────────

  async handleListWebhooks(args: any): Promise<ToolResponse> {
    if (!g.isListWebhooksArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for list_webhooks');
    }
    const { base, label } = this.hookScope(args);
    const limit = this.apiClient.clampPageSize(args.limit ?? this.cfg.pagination.defaultListLimit);
    const r = await this.call<any>('get', `${base}/hooks?pagelen=${limit}`);
    return jsonContent({
      scope: label,
      webhooks: (r.values || []).map((v: any) => compactObject({ uuid: v.uuid, description: v.description, url: v.url, active: v.active, events: v.events })),
    });
  }

  private hookScope(args: any): { base: string; label: string } {
    const { workspace, repository } = args;
    return repository
      ? { base: `/repositories/${workspace}/${repository}`, label: `${workspace}/${repository}` }
      : { base: `/workspaces/${workspace}`, label: `workspace ${workspace}` };
  }

  async handleManageWebhook(args: any): Promise<ToolResponse> {
    if (!g.isManageWebhookArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_webhook');
    }
    const { base, label } = this.hookScope(args);
    if (args.action === 'delete') {
      if (!args.uuid) return errorContent('delete needs uuid. list_webhooks reports it.');
      const path = `${base}/hooks/${encodeURIComponent(args.uuid)}`;
      if (args.dry_run) return this.planned('delete', path, undefined, await this.currentOrNull(path));
      // write:webhook and delete:webhook are separate scopes, so a token can
      // add hooks it cannot remove.
      await this.call('delete', path);
      return jsonContent({ deleted: args.uuid, scope: label });
    }
    if (args.action === 'update') {
      if (!args.uuid) return errorContent('update needs uuid.');
      const path = `${base}/hooks/${encodeURIComponent(args.uuid)}`;
      // Cloud rejects a partial hook PUT with a bare "Bad request", so read the
      // current hook and merge. Without this, changing only `active` fails and
      // the error says nothing about what was missing.
      const current = await this.currentOrNull(path);
      if (!current) return errorContent(`Webhook ${args.uuid} not found in ${label}.`);
      const body = {
        description: args.description ?? current.description,
        url: args.url ?? current.url,
        active: args.active ?? current.active,
        events: args.events ?? current.events,
      };
      if (args.dry_run) {
        return this.planned('put', path, body, {
          description: current.description, url: current.url, active: current.active, events: current.events,
        });
      }
      const r = await this.call<any>('put', path, body);
      return jsonContent({ updated: r.uuid, url: r.url, active: r.active, scope: label });
    }
    if (!args.url || !args.events?.length) return errorContent('create needs url and at least one event.');
    const body = {
      description: args.description ?? '',
      url: args.url,
      active: args.active ?? true,
      events: args.events,
    };
    const path = `${base}/hooks`;
    if (args.dry_run) return this.planned('post', path, body, null);
    const r = await this.call<any>('post', path, body);
    return jsonContent({ created: r.uuid, url: r.url, active: r.active, scope: label });
  }

  // ── deploy keys ────────────────────────────────────────────────────────────

  async handleListDeployKeys(args: any): Promise<ToolResponse> {
    if (!g.isManagementReadArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for list_deploy_keys');
    }
    const { base, label } = this.repoOnly(args, 'list_deploy_keys');
    const limit = this.apiClient.clampPageSize(args.limit ?? this.cfg.pagination.defaultListLimit);
    const r = await this.call<any>('get', `${base}/deploy-keys?pagelen=${limit}`);
    return jsonContent({
      repository: label,
      keys: (r.values || []).map((v: any) => compactObject({ id: v.id, label: v.label, comment: v.comment, last_used: v.last_used, added_on: v.added_on })),
    });
  }

  async handleManageDeployKey(args: any): Promise<ToolResponse> {
    if (!g.isManageDeployKeyArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_deploy_key');
    }
    const { base, label } = this.repoOnly(args, 'manage_deploy_key');
    if (args.action === 'delete') {
      if (args.key_id === undefined) return errorContent('delete needs key_id. list_deploy_keys reports it.');
      const path = `${base}/deploy-keys/${args.key_id}`;
      if (args.dry_run) return this.planned('delete', path, undefined, await this.currentOrNull(path));
      await this.call('delete', path);
      return jsonContent({ deleted: args.key_id, repository: label });
    }
    if (!args.key) return errorContent('add needs key (the public key text).');
    const body = compactObject({ key: args.key, label: args.label });
    const path = `${base}/deploy-keys`;
    if (args.dry_run) return this.planned('post', path, body, null);
    const r = await this.call<any>('post', path, body);
    return jsonContent({ added: r.id, label: r.label, repository: label });
  }

  // ── environments ───────────────────────────────────────────────────────────

  async handleListEnvironments(args: any): Promise<ToolResponse> {
    if (!g.isManagementReadArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for list_environments');
    }
    const { base, label } = this.repoOnly(args, 'list_environments');
    const limit = this.apiClient.clampPageSize(args.limit ?? this.cfg.pagination.defaultListLimit);
    const r = await this.call<any>('get', `${base}/environments?pagelen=${limit}`);
    return jsonContent({
      repository: label,
      environments: (r.values || []).map((v: any) => compactObject({ uuid: v.uuid, name: v.name, type: v.environment_type?.name, rank: v.rank })),
    });
  }

  async handleManageEnvironment(args: any): Promise<ToolResponse> {
    if (!g.isManageEnvironmentArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for manage_environment');
    }
    const { base, label } = this.repoOnly(args, 'manage_environment');
    if (args.action === 'delete') {
      if (!args.environment_uuid) return errorContent('delete needs environment_uuid. list_environments reports it.');
      const path = `${base}/environments/${encodeURIComponent(args.environment_uuid)}`;
      if (args.dry_run) return this.planned('delete', path, undefined, await this.currentOrNull(path));
      await this.call('delete', path);
      return jsonContent({ deleted: args.environment_uuid, repository: label });
    }
    if (!args.name) return errorContent('create needs name.');
    const body = {
      name: args.name,
      environment_type: { name: args.environment_type ?? 'Test' },
      rank: args.rank ?? 0,
    };
    const path = `${base}/environments`;
    if (args.dry_run) return this.planned('post', path, body, null);
    const r = await this.call<any>('post', path, body);
    return jsonContent({ created: r.uuid, name: r.name, type: r.environment_type?.name, repository: label });
  }

  // ── repository lifecycle ───────────────────────────────────────────────────

  async handleCreateRepository(args: any): Promise<ToolResponse> {
    if (!g.isCreateRepositoryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for create_repository');
    }
    const { workspace, repository } = args;
    const path = `/repositories/${workspace}/${repository}`;
    const body = compactObject({
      scm: 'git',
      name: args.name ?? repository,
      description: args.description,
      is_private: args.is_private ?? true,
      fork_policy: args.fork_policy,
      has_issues: args.has_issues,
      has_wiki: args.has_wiki,
      language: args.language,
      project: args.project_key ? { key: args.project_key } : undefined,
    });
    if (args.dry_run) return this.planned('post', path, body, null);
    const r = await this.call<any>('post', path, body);
    return jsonContent(compactObject({ created: r.full_name, slug: r.slug, is_private: r.is_private, project: r.project?.key }));
  }

  async handleDeleteRepository(args: any): Promise<ToolResponse> {
    if (!g.isDeleteRepositoryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for delete_repository');
    }
    const { workspace, repository, confirm_full_name } = args;
    const fullName = `${workspace}/${repository}`;
    // The API has no undo. Retyping the full name is the cheapest guard a
    // wrong-argument call cannot pass.
    if (confirm_full_name !== fullName) {
      return errorContent(
        `Refusing to delete: confirm_full_name must be exactly "${fullName}". ` +
          `This is irreversible and there is no undo in the API.`
      );
    }
    const path = `/repositories/${workspace}/${repository}`;
    if (args.dry_run) {
      return this.planned('delete', path, undefined, await this.currentOrNull(path), 'IRREVERSIBLE. Nothing was sent.');
    }
    await this.call('delete', path);
    this.apiClient.invalidateRef(workspace, repository, undefined);
    return textContent(`Repository ${fullName} deleted. This cannot be undone.`);
  }
}

/**
 * Records to scan when reconciling a "set". Cloud caps a page at 100, and these
 * collections are small, so one page covers any realistic repository.
 */
const CLOUD_COLLECTION_SCAN = 100;
