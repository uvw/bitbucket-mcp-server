# Bitbucket MCP Server Setup Guide

## Step 1: Choose a credential

Bitbucket Cloud offers three, and they authenticate differently. Pick by blast
radius.

| Credential | Auth | Reaches | Use it for |
|---|---|---|---|
| **API token with scopes** | Basic — your **email** + the token | everything your account can | day-to-day use across many repos |
| **Repository access token** | **Bearer** — no username | exactly one repository | automation, and anything you are still testing |
| **Workspace access token** | **Bearer** — no username | one workspace | fleet-wide automation |

Access tokens reject Basic auth outright, so they must go in `BITBUCKET_TOKEN`.
That is bearer auth and needs no username. It does **not** switch the server to
Server/DC — the dialect comes from the base URL (see `BITBUCKET_DIALECT` in the
README).

App passwords still work but are on the way out; prefer an API token.

## Step 2: Create it

**API token with scopes** — <https://id.atlassian.com/manage-profile/security/api-tokens>,
"Create API token **with scopes**", then choose Bitbucket. Minimum for the
default tool set:

- Account: Read
- Repositories: Read, Write
- Pull requests: Read, Write

Add these only if you intend to use the management tools:

- Repositories: **Admin** — branch restrictions, branching model, Pipelines
  on/off, repository settings, default reviewers, deploy keys, repo creation
- Pipelines: **Admin** — pipeline variables and deployment environments
- Projects: **Admin** — project-scope settings
- Webhooks: Read, Write, **Delete** — deleting a webhook is a separate scope
  from creating one
- Repositories: **Delete** — only for `delete_repository`

**Repository or workspace access token** — repository or workspace settings →
Access tokens. The same Admin scopes appear there, limited to that
repository/workspace.

Copy the value immediately; it is shown once.

Your credentials are what your account can already do, narrowed by scope. If a
call fails with 403, read `error.detail.required` in the response: it names the
exact scope that was missing, and that is usually a box you did not tick rather
than a repository permission.

## Step 3: Find Your Workspace (Optional but Recommended)

Your workspace is the organization or team name in Bitbucket. To find it:

1. Look at any of your repository URLs:
   - Example: `https://bitbucket.org/mycompany/my-repo`
   - In this case, "mycompany" is your workspace

2. Or go to your workspace dashboard:
   - Click on "Workspaces" in the top navigation
   - Your workspaces will be listed there

## Example Credentials

Here's what your credentials should look like:

Basic auth, with an API token:

```
BITBUCKET_USERNAME=you@example.com   # your Atlassian account email
BITBUCKET_APP_PASSWORD=ATATT3x...    # the API token
```

Bearer auth, with a repository or workspace access token:

```
BITBUCKET_TOKEN=ATCTT3x...           # no username needed
```

To turn the management tools on (both are off by default):

```
BITBUCKET_MANAGEMENT=true            # exposes the read tools
BITBUCKET_MANAGEMENT_WRITE=true      # also allows the mutating ones
```

## Common Issues

1. **401 with an API token**: `BITBUCKET_USERNAME` must be your account **email**, not your Bitbucket nickname.
2. **401 with an access token**: those are bearer-only. Put it in `BITBUCKET_TOKEN`, not `BITBUCKET_APP_PASSWORD`, and leave the username unset.
3. **403 "Your credentials lack one or more required privilege scopes"**: the response's `error.detail.required` names the scope. Re-mint with it ticked — this is not a repository-permission problem.
4. **A management tool is missing from the tool list**: it is opt-in. Set `BITBUCKET_MANAGEMENT=true`, and `BITBUCKET_MANAGEMENT_WRITE=true` for the mutating ones, then restart the client.
5. **Truncated secret**: seeding a long token through a shell prompt can clip it at 128 characters. API tokens are longer than that — check the stored length.

## Next Steps

Once you have these credentials, share them with me and I'll configure the MCP server for you. The credentials will be stored securely in your MCP settings configuration.
