# Devin

Devin runs on the environment machine through Devin CLI. Install
[Devin CLI](https://docs.devin.ai/cli), run `devin auth login` on that machine,
then enable **Devin** in **Settings → Providers**. If T3 Code cannot find
`devin`, set **Binary path** to the CLI executable.

T3 Code reads the models available to the signed-in account. Refresh the
provider after changing accounts or subscriptions. Choose a model family in the
composer, then use its controls to set the thinking level and, when available,
Fast mode or the context window.

## Fusion

[Fusion](https://docs.devin.ai/cli/fusion) requires Devin CLI 3000.10.20 or
newer and an eligible paid plan. Choose **Fusion** in the model picker, select
the lead and sidekick, then choose **Use Fusion**. The composer controls
configure the selected lead's thinking level and Fast mode. You can switch back
to a regular model in the same thread.

## Skills and T3 Code tools

Type `$` in the composer to choose a skill discovered by Devin CLI for the
current workspace. T3 Code invokes one selected skill per message and passes
the rest of the message as its arguments.

When the installed CLI advertises support, Devin can use T3 Code's browser and
device tools through the T3-managed MCP server. The available tools depend on
the capabilities granted to that environment.

## Sessions and remote use

T3 Code forwards permission requests and supports cancellation, images, file
attachments, and automatic context compaction through `/compact`. Conversation
rewind is unavailable because Devin ACP cannot restore an earlier point in a
native session.

Remote clients use the Devin installation, credentials, models, and workspace
on the server machine. This works the same over a local connection, Tailscale,
or T3 Connect. Install and authenticate Devin on that server, not on the phone
or browser controlling it.

Use **Update now** on the Devin provider card to run the CLI updater when T3
Code can resolve the configured executable.

## Authentication troubleshooting

If your terminal is signed in but T3 Code reports **Not authenticated**, make
sure both processes use the same credential directory. Devin stores
`credentials.toml` under `$XDG_DATA_HOME/devin` when that variable is set,
otherwise under `~/.local/share/devin` on macOS and Linux. Windows uses
`%APPDATA%\devin`. See
[Devin's credential documentation](https://docs.devin.ai/cli/enterprise/devin-auth#credentials-file-location).

After correcting the environment, refresh the Devin provider status.
