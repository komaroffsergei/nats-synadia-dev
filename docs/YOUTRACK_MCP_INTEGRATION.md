# YouTrack MCP Integration

`synadia-nats-agents` can work with YouTrack in two modes:

- `mcp` - production mode. The gateway calls `yt-mcp-ruby` over internal MCP
  HTTP, and this project does not need `YOUTRACK_TOKEN`.
- `rest` - fallback mode. The gateway calls YouTrack REST directly and requires
  `YOUTRACK_TOKEN`.

`codex_worker` never receives YouTrack credentials in either mode.

## Runtime Flow

```text
YouTrack webhook
  -> nats-synadia-dev_app /youtrack/webhook
  -> JetStream job
  -> nats-synadia-dev_codex_worker
  -> JetStream result
  -> nats-synadia-dev_app gateway
  -> MCP HTTP tools/call
  -> agents_yt_mcp_ruby
  -> YouTrack REST API
```

## Required yt-mcp-ruby Tools

The gateway checks these tools on `/youtrack/api-check`:

```text
get_current_user
search_issues
get_issue
get_issue_comments
get_custom_fields
update_custom_fields
add_issue_comment
```

If `yt-mcp-ruby` is deployed with a read-only `ENABLED_TOOLS` allowlist, add
`update_custom_fields` and `add_issue_comment` to that allowlist. MCP ingress
should stay internal; only `/health` should be public.

## synadia-nats-agents Variables

Set these in GitLab CI/CD variables for this project:

```text
YOUTRACK_MCP_URL=http://agents_yt_mcp_ruby:9292
YOUTRACK_MCP_EXTERNAL_NETWORK=yt-mcp-ruby-internal
YOUTRACK_API_CHECK_PROJECT=CS
YOUTRACK_BASE_URL=https://yt.giscloud.ru
```

Do not set `YOUTRACK_TOKEN` for the production MCP path. Leave
`YOUTRACK_WEBHOOK_TOKEN` if YouTrack webhook requests are protected by a shared
secret.

## Shared Swarm Network

Both stacks must join the same external overlay network:

```text
agents_yt_mcp_ruby
nats-synadia-dev_app
```

`stack/deploy.sh` creates `YOUTRACK_MCP_EXTERNAL_NETWORK` when it is set. The
`yt-mcp-ruby` deployment must also attach `agents_yt_mcp_ruby` to the same
network. The old `yt-mcp-ruby_app` DNS name remains as a compatibility alias.

## Verification

From any machine:

```bash
curl -sS https://nats-synadia-dev.gis-master.ru/youtrack/api-check | jq
```

Expected production signal:

```json
{
  "mode": "mcp",
  "token": "not_required_mcp"
}
```

The `mcp_tools`, `mcp_current_user`, `mcp_search_top1`, `mcp_comments_api`,
`mcp_codex_session_field`, and `mcp_custom_fields` checks must be `ok: true`.
