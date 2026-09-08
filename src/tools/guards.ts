// Runtime argument validation for tool handlers. Guards check required
// fields and types strictly, stay permissive on optionals (schemas advertise
// the contract; guards are the safety net).

export type AttachmentInput =
  | string
  | { file_path: string; alt_text?: string; render?: 'image' | 'link' | 'auto' };

const isObj = (a: any): a is Record<string, unknown> => typeof a === 'object' && a !== null;
const str = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string';
// Numeric guards are integer-strict: `typeof x === 'number'` would admit
// NaN/Infinity/floats into ids, versions, and limits.
export const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const optInt = (v: unknown): boolean => v === undefined || Number.isInteger(v);
const optPosInt = (v: unknown): boolean => v === undefined || isPosInt(v);
export const optNonNegInt = (v: unknown): boolean =>
  v === undefined || (Number.isInteger(v) && (v as number) >= 0);
const optBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
const optStrArr = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'));

function isAttachmentInput(v: unknown): v is AttachmentInput {
  if (typeof v === 'string') return true;
  return isObj(v) && str(v.file_path) && optStr(v.alt_text) &&
    (v.render === undefined || ['image', 'link', 'auto'].includes(v.render as string));
}

const optAttachments = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.every(isAttachmentInput));

function repoScoped(a: any): boolean {
  return isObj(a) && str(a.workspace) && str(a.repository);
}

// ── Pull requests ────────────────────────────────────────────────────────────

export function isGetPullRequestArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number;
  include_comments?: boolean; include_file_changes?: boolean; include_tasks?: boolean;
  comment_limit?: number;
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) &&
    optBool(a.include_comments) && optBool(a.include_file_changes) &&
    optBool(a.include_tasks) && optPosInt(a.comment_limit);
}

export function isListPullRequestsArgs(a: any): a is {
  workspace: string; repository?: string; state?: string; author?: string;
  role?: string; limit?: number; start?: number;
} {
  return isObj(a) && str(a.workspace) && optStr(a.repository) &&
    (a.state === undefined || ['OPEN', 'MERGED', 'DECLINED', 'ALL'].includes(a.state as string)) &&
    optStr(a.author) &&
    (a.role === undefined || ['AUTHOR', 'REVIEWER', 'PARTICIPANT'].includes(a.role as string)) &&
    optPosInt(a.limit) && optNonNegInt(a.start);
}

export function isCreatePullRequestArgs(a: any): a is {
  workspace: string; repository: string; title: string;
  source_branch: string; destination_branch: string;
  description?: string; reviewers?: string[]; close_source_branch?: boolean;
  attachments?: AttachmentInput[];
} {
  return repoScoped(a) && str(a.title) && str(a.source_branch) && str(a.destination_branch) &&
    optStr(a.description) && optStrArr(a.reviewers) && optBool(a.close_source_branch) &&
    optAttachments(a.attachments);
}

export function isUpdatePullRequestArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number; version?: number;
  title?: string; description?: string; destination_branch?: string;
  reviewers?: string[]; attachments?: AttachmentInput[];
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) && optNonNegInt(a.version) &&
    optStr(a.title) && optStr(a.description) && optStr(a.destination_branch) &&
    optStrArr(a.reviewers) && optAttachments(a.attachments);
}

export function isMergePullRequestArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number; version?: number;
  merge_strategy?: string; close_source_branch?: boolean; commit_message?: string;
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) && optNonNegInt(a.version) &&
    (a.merge_strategy === undefined || ['merge-commit', 'squash', 'fast-forward'].includes(a.merge_strategy)) &&
    optBool(a.close_source_branch) && optStr(a.commit_message);
}

export function isDeclinePullRequestArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number;
  version?: number; comment?: string;
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) &&
    optNonNegInt(a.version) && optStr(a.comment);
}

export function isListPrCommitsArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number;
  limit?: number; start?: number; include_build_status?: boolean;
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) &&
    optPosInt(a.limit) && optNonNegInt(a.start) && optBool(a.include_build_status);
}

// ── Comments & tasks ─────────────────────────────────────────────────────────

export function isAddCommentArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number; comment_text: string;
  parent_comment_id?: number; file_path?: string; line_number?: number;
  line_type?: 'ADDED' | 'REMOVED' | 'CONTEXT'; suggestion?: string; suggestion_end_line?: number;
  code_snippet?: string; search_context?: { before?: string[]; after?: string[] };
  match_strategy?: 'strict' | 'best'; severity?: 'NORMAL' | 'BLOCKER';
  attachments?: AttachmentInput[];
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) && str(a.comment_text) &&
    optPosInt(a.parent_comment_id) && optStr(a.file_path) && optPosInt(a.line_number) &&
    (a.line_type === undefined || ['ADDED', 'REMOVED', 'CONTEXT'].includes(a.line_type)) &&
    optStr(a.suggestion) && optPosInt(a.suggestion_end_line) && optStr(a.code_snippet) &&
    (a.search_context === undefined ||
      (isObj(a.search_context) && optStrArr(a.search_context.before) && optStrArr(a.search_context.after))) &&
    (a.match_strategy === undefined || ['strict', 'best'].includes(a.match_strategy)) &&
    (a.severity === undefined || ['NORMAL', 'BLOCKER'].includes(a.severity)) &&
    optAttachments(a.attachments);
}

export const MANAGE_COMMENT_ACTIONS = ['edit', 'delete', 'resolve', 'reopen', 'to_task', 'to_comment'] as const;

export function isManageCommentArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number; comment_id: number;
  action: (typeof MANAGE_COMMENT_ACTIONS)[number]; text?: string; version?: number;
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) &&
    isPosInt(a.comment_id) &&
    MANAGE_COMMENT_ACTIONS.includes(a.action) &&
    optStr(a.text) && optNonNegInt(a.version);
}

// ── Review ───────────────────────────────────────────────────────────────────

export function isGetPullRequestDiffArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number;
  context_lines?: number; include_patterns?: string[]; exclude_patterns?: string[];
  file_path?: string; ignore_whitespace?: boolean;
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) &&
    optNonNegInt(a.context_lines) && optStrArr(a.include_patterns) && optStrArr(a.exclude_patterns) &&
    optStr(a.file_path) && optBool(a.ignore_whitespace);
}

export function isSetReviewStatusArgs(a: any): a is {
  workspace: string; repository: string; pull_request_id: number;
  status: 'APPROVED' | 'NEEDS_WORK' | 'UNAPPROVED'; comment?: string;
} {
  return repoScoped(a) && isPosInt(a.pull_request_id) &&
    ['APPROVED', 'NEEDS_WORK', 'UNAPPROVED'].includes(a.status) && optStr(a.comment);
}

// ── Branches & commits ───────────────────────────────────────────────────────

export function isListBranchesArgs(a: any): a is {
  workspace: string; repository: string; filter?: string; limit?: number; start?: number;
} {
  return repoScoped(a) && optStr(a.filter) && optPosInt(a.limit) && optNonNegInt(a.start);
}

export function isGetBranchArgs(a: any): a is {
  workspace: string; repository: string; branch_name: string; include_merged_prs?: boolean;
} {
  return repoScoped(a) && str(a.branch_name) && optBool(a.include_merged_prs);
}

export function isDeleteBranchArgs(a: any): a is {
  workspace: string; repository: string; branch_name: string; expected_head?: string;
} {
  return repoScoped(a) && str(a.branch_name) && optStr(a.expected_head);
}

export function isListBranchCommitsArgs(a: any): a is {
  workspace: string; repository: string; branch_name: string;
  limit?: number; start?: number; since?: string; until?: string; author?: string;
  include_merge_commits?: boolean; search?: string; include_build_status?: boolean;
} {
  return repoScoped(a) && str(a.branch_name) && optPosInt(a.limit) && optNonNegInt(a.start) &&
    optStr(a.since) && optStr(a.until) && optStr(a.author) &&
    optBool(a.include_merge_commits) && optStr(a.search) && optBool(a.include_build_status);
}

export function isGetCommitDetailArgs(a: any): a is {
  workspace: string; repository: string; commit_id: string;
  context_lines?: number; include_patterns?: string[]; exclude_patterns?: string[];
  file_path?: string; detail?: 'diff' | 'files';
} {
  return repoScoped(a) && str(a.commit_id) && optNonNegInt(a.context_lines) &&
    optStrArr(a.include_patterns) && optStrArr(a.exclude_patterns) && optStr(a.file_path) &&
    (a.detail === undefined || ['diff', 'files'].includes(a.detail));
}

// ── Files ────────────────────────────────────────────────────────────────────

export function isListDirectoryContentArgs(a: any): a is {
  workspace: string; repository: string; path?: string; branch?: string;
} {
  return repoScoped(a) && optStr(a.path) && optStr(a.branch);
}

export function isGetFileContentArgs(a: any): a is {
  workspace: string; repository: string; file_path: string; branch?: string;
  start_line?: number; line_count?: number; full_content?: boolean;
} {
  return repoScoped(a) && str(a.file_path) && optStr(a.branch) &&
    optInt(a.start_line) && optPosInt(a.line_count) && optBool(a.full_content);
}

export function isGetFileBlameArgs(a: any): a is {
  workspace: string; repository: string; file_path: string; branch?: string;
  start_line?: number; line_count?: number;
} {
  return repoScoped(a) && str(a.file_path) && optStr(a.branch) &&
    optInt(a.start_line) && optPosInt(a.line_count);
}

// ── Discovery ────────────────────────────────────────────────────────────────

export function isListProjectsArgs(a: any): a is {
  workspace?: string; name?: string; permission?: string; limit?: number; start?: number;
} {
  return isObj(a) && optStr(a.workspace) && optStr(a.name) && optStr(a.permission) &&
    optPosInt(a.limit) && optNonNegInt(a.start);
}

export function isListRepositoriesArgs(a: any): a is {
  workspace?: string; name?: string; permission?: string; limit?: number; start?: number;
} {
  return isObj(a) && optStr(a.workspace) && optStr(a.name) && optStr(a.permission) &&
    optPosInt(a.limit) && optNonNegInt(a.start);
}

// ── Attachments ──────────────────────────────────────────────────────────────

export function isManageAttachmentsArgs(a: any): a is {
  workspace: string; repository: string; action: 'download' | 'delete'; attachment_id: string | number;
} {
  return repoScoped(a) && ['download', 'delete'].includes(a.action) &&
    (typeof a.attachment_id === 'string' || typeof a.attachment_id === 'number');
}

// ── Repository management ────────────────────────────────────────────────────
// Every management tool needs a workspace. `repository` and `project_key` stay
// optional here and the handler reconciles them, since it knows whether the
// tool is repo-only or repo-or-project. Requiring one in the guard would reject
// the other scope before the handler could explain the difference.

const mgmtBase = (a: any): boolean => isObj(a) && str(a.workspace) && optStr(a.repository) && optStr(a.project_key);
const mgmtWrite = (a: any): boolean => mgmtBase(a) && optBool(a.dry_run);

export function isManagementReadArgs(a: any): a is {
  workspace: string; repository?: string; limit?: number;
} {
  return mgmtBase(a) && optPosInt(a.limit);
}

export function isManagementScopedReadArgs(a: any): a is {
  workspace: string; repository?: string; project_key?: string; limit?: number;
} {
  return mgmtBase(a) && optPosInt(a.limit);
}

export function isUpdateRepositorySettingsArgs(a: any): a is {
  workspace: string; repository: string; name?: string; description?: string;
  is_private?: boolean; fork_policy?: string; has_issues?: boolean; has_wiki?: boolean;
  language?: string; main_branch?: string; project_key?: string; dry_run?: boolean;
} {
  return mgmtWrite(a) && optStr(a.name) && optStr(a.description) && optBool(a.is_private) &&
    optStr(a.fork_policy) && optBool(a.has_issues) && optBool(a.has_wiki) &&
    optStr(a.language) && optStr(a.main_branch);
}

export function isManageBranchRestrictionArgs(a: any): a is {
  workspace: string; repository: string; action: 'set' | 'delete'; kind?: string;
  pattern?: string; branch_match_kind?: 'glob' | 'branching_model'; branch_type?: string;
  value?: number; users?: string[]; groups?: string[]; restriction_id?: number; dry_run?: boolean;
} {
  return mgmtWrite(a) && ['set', 'delete'].includes(a.action as string) &&
    optStr(a.kind) && optStr(a.pattern) && optStr(a.branch_type) &&
    (a.branch_match_kind === undefined || ['glob', 'branching_model'].includes(a.branch_match_kind as string)) &&
    optInt(a.value) && optStrArr(a.users) && optStrArr(a.groups) && optPosInt(a.restriction_id);
}

export function isManageBranchingModelArgs(a: any): a is {
  workspace: string; repository?: string; project_key?: string;
  development?: object; production?: object; branch_types?: object[]; dry_run?: boolean;
} {
  return mgmtWrite(a) &&
    (a.development === undefined || isObj(a.development)) &&
    (a.production === undefined || isObj(a.production)) &&
    (a.branch_types === undefined || (Array.isArray(a.branch_types) && a.branch_types.every(isObj)));
}

export function isManageDefaultReviewerArgs(a: any): a is {
  workspace: string; repository?: string; project_key?: string;
  action: 'add' | 'remove'; user: string; dry_run?: boolean;
} {
  return mgmtWrite(a) && ['add', 'remove'].includes(a.action as string) && str(a.user);
}

export function isManageRepositoryPermissionArgs(a: any): a is {
  workspace: string; repository?: string; project_key?: string;
  action: 'set' | 'remove'; user?: string; group?: string;
  permission?: 'read' | 'write' | 'admin'; dry_run?: boolean;
} {
  if (!mgmtWrite(a) || !['set', 'remove'].includes(a.action as string)) return false;
  if (!optStr(a.user) || !optStr(a.group)) return false;
  // Exactly one subject: both would be ambiguous, neither has no target.
  if (!!a.user === !!a.group) return false;
  return a.permission === undefined || ['read', 'write', 'admin'].includes(a.permission as string);
}

export function isManagePipelinesConfigArgs(a: any): a is {
  workspace: string; repository: string; enabled: boolean; dry_run?: boolean;
} {
  return mgmtWrite(a) && typeof a.enabled === 'boolean';
}

export function isListPipelineVariablesArgs(a: any): a is {
  workspace: string; repository?: string; environment_uuid?: string; limit?: number;
} {
  return mgmtBase(a) && optStr(a.environment_uuid) && optPosInt(a.limit);
}

export function isManagePipelineVariableArgs(a: any): a is {
  workspace: string; repository?: string; environment_uuid?: string;
  action: 'set' | 'delete'; key?: string; value?: string; secured?: boolean;
  variable_uuid?: string; dry_run?: boolean;
} {
  return mgmtWrite(a) && ['set', 'delete'].includes(a.action as string) &&
    optStr(a.environment_uuid) && optStr(a.key) && optStr(a.value) &&
    optBool(a.secured) && optStr(a.variable_uuid);
}

export function isManagePipelineRunArgs(a: any): a is {
  workspace: string; repository: string; action: 'trigger' | 'stop';
  ref_name?: string; ref_type?: string; selector_type?: string; selector_pattern?: string;
  variables?: object[]; pipeline_uuid?: string; dry_run?: boolean;
} {
  return mgmtWrite(a) && ['trigger', 'stop'].includes(a.action as string) &&
    optStr(a.ref_name) && optStr(a.ref_type) && optStr(a.selector_type) &&
    optStr(a.selector_pattern) && optStr(a.pipeline_uuid) &&
    (a.variables === undefined || (Array.isArray(a.variables) && a.variables.every(isObj)));
}

export function isListWebhooksArgs(a: any): a is {
  workspace: string; repository?: string; limit?: number;
} {
  return mgmtBase(a) && optPosInt(a.limit);
}

export function isManageWebhookArgs(a: any): a is {
  workspace: string; repository?: string; action: 'create' | 'update' | 'delete';
  uuid?: string; url?: string; description?: string; active?: boolean;
  events?: string[]; dry_run?: boolean;
} {
  return mgmtWrite(a) && ['create', 'update', 'delete'].includes(a.action as string) &&
    optStr(a.uuid) && optStr(a.url) && optStr(a.description) && optBool(a.active) && optStrArr(a.events);
}

export function isManageDeployKeyArgs(a: any): a is {
  workspace: string; repository: string; action: 'add' | 'delete';
  key?: string; label?: string; key_id?: number; dry_run?: boolean;
} {
  return mgmtWrite(a) && ['add', 'delete'].includes(a.action as string) &&
    optStr(a.key) && optStr(a.label) && optPosInt(a.key_id);
}

export function isManageEnvironmentArgs(a: any): a is {
  workspace: string; repository: string; action: 'create' | 'delete';
  name?: string; environment_type?: string; rank?: number;
  environment_uuid?: string; dry_run?: boolean;
} {
  return mgmtWrite(a) && ['create', 'delete'].includes(a.action as string) &&
    optStr(a.name) && optStr(a.environment_type) && optNonNegInt(a.rank) && optStr(a.environment_uuid);
}

export function isCreateRepositoryArgs(a: any): a is {
  workspace: string; repository: string; name?: string; description?: string;
  is_private?: boolean; fork_policy?: string; has_issues?: boolean; has_wiki?: boolean;
  language?: string; project_key?: string; dry_run?: boolean;
} {
  return repoScoped(a) && optBool(a.dry_run) && optStr(a.name) && optStr(a.description) &&
    optBool(a.is_private) && optStr(a.fork_policy) && optBool(a.has_issues) &&
    optBool(a.has_wiki) && optStr(a.language) && optStr(a.project_key);
}

export function isDeleteRepositoryArgs(a: any): a is {
  workspace: string; repository: string; confirm_full_name: string; dry_run?: boolean;
} {
  return repoScoped(a) && optBool(a.dry_run) && str(a.confirm_full_name);
}
