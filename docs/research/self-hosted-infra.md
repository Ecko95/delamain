# Self-Hosted AI Coding Agent Runtime Infrastructure

Research note for a single-operator Codex-peers host, current as of May 2026.

Assumption: the host runs coding agents that call hosted models such as OpenAI or Anthropic, while code execution happens locally in per-agent sandboxes. If you also plan to run local models on the same machine, split inference onto a separate GPU box.

## A. Hardware / OS baseline

- Practical baseline for a 5-agent host: `8 vCPU / 32 GB RAM / 500 GB NVMe / Ubuntu 24.04 LTS` or `Debian 12`.
- Practical baseline for a 10-20-agent host: `16-32 vCPU / 64-128 GB RAM / 1-2 TB NVMe / Ubuntu Server or Debian`.
- The docs for OpenHands still describe a single-machine minimum of a modern processor and 4 GB RAM for local use, and they explicitly tested Linux, macOS with Docker Desktop, and Windows via WSL + Docker Desktop. OpenHands Enterprise is documented as a Kubernetes deployment in your own VPC, which is the clearest current sign that the project expects Linux/containerized infrastructure for serious scale. [OpenHands local setup](https://docs.all-hands.dev/openhands/usage/local-setup), [OpenHands README](https://github.com/OpenHands/OpenHands)
- What people actually seem to run in 2026 is mostly Linux + Docker/Compose on cheap VPS or dedicated boxes, with recent operator posts clustering around Hetzner and other small-footprint hosts. A recent post aimed at agent hosting says the runtime/gateway/supervisor layer can fit in 1-2 vCPU and 4 GB RAM, while another suggests a modern quad-core with 64 GB DDR5 for concurrent multi-agent workloads; that combination is a good signal that the agent-control plane is lightweight, but concurrency pushes you into real RAM and NVMe. [Hermify blog](https://www.hermify.io/en/blog/cheap-vps-for-ai-agent), [ToolHalla / OpenClaw post](https://toolhalla.ai/blog/openclaw-ollama-production-config-2026)
- Recommendation: buy CPU and RAM first, then NVMe. For this workload, GPU is optional unless you self-host inference. If you want a simple rule, use `32 GB` as the floor for a single busy operator and `64 GB+` once you want 10+ concurrent agents with long-running sandboxes and logs.

## B. Process supervision

- Recommended pattern: `systemd` on the host, `rootless Docker` or `Docker Compose` for the agent stack, and one container or unprivileged user per agent sandbox.
- `systemd` is the right outer supervisor because it is built for boot-time service management, dependency ordering, restart policy, cgroups, and credentials handling. Its own docs recommend `Restart=on-failure` for long-running services, and the credentials docs show a native secret-passing mechanism that fits headless daemons well. [systemd overview](https://systemd.io/), [systemd.service](https://www.freedesktop.org/software/systemd/man/249/systemd.service.html), [systemd credentials](https://systemd.io/CREDENTIALS/)
- Docker Compose is the best single-host multi-container abstraction here. Docker’s docs describe Compose as the tool for defining and running multi-container applications, with service lifecycle, logs, networks, and volumes in one file. OpenHands documents Docker deployment heavily, including `docker-compose.yml`, hardened Docker settings, and Kubernetes for enterprise. [Docker Compose](https://docs.docker.com/compose/), [OpenHands Docker runtime](https://docs.all-hands.dev/openhands/usage/runtimes/docker), [OpenHands README](https://github.com/OpenHands/OpenHands)
- `k3s` only becomes the right answer when you need multi-node scheduling, rolling upgrades across boxes, or a genuine cluster control plane. K3s markets itself as a lightweight Kubernetes distribution and explicitly documents installation as a systemd/openrc service. OpenHands Enterprise also points to Kubernetes for self-hosting in a VPC, which matches the “more than one host” use case. [K3s](https://docs.k3s.io/), [K3s installation](https://docs.k3s.io/installation), [OpenHands README](https://github.com/OpenHands/OpenHands)
- `PM2` and `supervisord` are process keepalive tools, not agent runtimes. PM2 can generate startup scripts and restart Node processes; supervisord manages UNIX processes and expects foreground programs. That is useful if your stack is a single Node daemon, but it does not solve sandboxing, secrets, or network isolation. [PM2 startup](https://pm2.keymetrics.io/docs/usage/startup/), [PM2 process management](https://pm2.keymetrics.io/docs/usage/process-management/), [Supervisor](https://supervisord.org/index.html)
- What the major frameworks document today is telling: OpenHands documents Docker and Kubernetes; Continue documents a CLI with headless mode and API-key auth; Aider documents local git repos and automatic commits. None of those docs position PM2 or supervisord as the primary runtime layer. [Continue CLI](https://docs.continue.dev/cli), [Continue headless mode](https://docs.continue.dev/cli/headless-mode), [Aider README](https://github.com/Aider-AI/aider), [Aider git integration](https://aider.chat/docs/git.html)

## C. Network exposure

- Best default for a single-user remote agent host: private overlay networking with no public inbound ports. Tailscale is the cleanest option if you control the client devices; it uses WireGuard, gives you ACLs, Tailscale SSH, and avoids open firewall ports when set up correctly. [Tailscale what is](https://tailscale.com/docs/concepts/what-is-tailscale), [Tailscale WireGuard](https://tailscale.com/docs/concepts/wireguard), [Tailscale secure the network](https://tailscale.com/docs/secure-networks)
- If you want browser access without exposing the host directly, Cloudflare Tunnel is a strong fit. Its docs emphasize outbound-only operation, no public IPs, and no open inbound ports; Cloudflare Access then lets you enforce identity- and device-aware policies on top. [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/), [Cloudflare Tunnel permissions](https://developers.cloudflare.com/tunnel/advanced/local-management/tunnel-permissions/), [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- For CLIs and agents, Cloudflare now supports managed OAuth for non-browser clients, which makes it more attractive than a raw reverse proxy if you need login flows for tools. [Cloudflare managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- If you already want a reverse proxy, add an auth proxy rather than exposing the agent UI directly. `oauth2-proxy` supports GitHub and other providers, and Traefik documents mTLS client-auth if you want certificate-based access instead of browser SSO. [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/), [Traefik mTLS](https://doc.traefik.io/traefik/v2.7/https/tls/)
- Port forwarding is the worst option for a long-lived agent farm. It is fine for a quick demo, but it gives you the least control over identity, audit, and revocation.

## D. Auth model

- For a personal farm, the simplest model is a single-user API key plus a private network boundary. Continue explicitly supports `CONTINUE_API_KEY` for headless use, Aider takes provider API keys on the command line, and OpenHands stores secrets as runtime env vars. [Continue quickstart](https://docs.continue.dev/cli/quickstart), [Aider README](https://github.com/Aider-AI/aider), [OpenHands secrets](https://docs.openhands.dev/openhands/usage/settings/secrets-settings)
- If you want stronger device-level control, use mTLS in front of the UI and keep the agent host private. Traefik’s `RequireAndVerifyClientCert` mode is the clearest current example of this pattern in mainstream docs. [Traefik mTLS](https://doc.traefik.io/traefik/v2.7/https/tls/)
- If you want a team-friendly model, use OAuth against your own identity provider. Cloudflare Access can front the app with policy rules, and `oauth2-proxy` can front the app with GitHub or other OAuth providers. That gives you per-user login, revocation, and audit without giving every person the host shell. [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/), [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/)
- The hosted agent products in this space mostly follow the same pattern. OpenHands Cloud uses GitHub/GitLab sign-in plus RBAC and multi-user support; Composio leans on managed auth and user-scoped sessions; Devin exposes web, Slack, and API entrypoints; CodeAnt and Sweep both anchor their workflows in SCM or account sign-in. [OpenHands README](https://github.com/OpenHands/OpenHands), [Composio sessions](https://docs.composio.dev/docs/sessions-vs-direct-execution), [Devin enterprise deploy](https://docs.devin.ai/enterprise/deploy), [CodeAnt setup](https://docs.codeant.ai/cli/setup), [Sweep docs](https://docs.sweep.dev/)

## E. Secrets / credentials

- Best default on a remote host: store secrets on the host as root-owned files or systemd credentials, and inject them only at runtime into the specific service or container that needs them.
- `systemd` credentials are a good fit for headless services because the manager can pass encrypted credentials to the service without relying on a desktop keyring. Docker Compose also has first-class secrets support, with secrets sourced from files or environment values. [systemd credentials](https://systemd.io/CREDENTIALS/), [Docker Compose secrets](https://docs.docker.com/reference/compose-file/secrets/)
- If you want encrypted-at-rest config in git, use `sops` with `age`. If you want centralized rotation and policy, use Vault KV. Both are materially better than plain env files once you have more than a toy setup. [SOPS docs](https://getsops.io/docs/), [Vault KV](https://developer.hashicorp.com/vault/docs/secrets/kv), [Vault static secrets](https://developer.hashicorp.com/vault/docs/about-vault/why-use-vault/static-secrets)
- At the application layer, OpenHands now ships a secrets manager/registry that exports secrets as env vars at runtime and masks them in output. Continue has user and org secrets. Composio manages OAuth and API-key injection server-side so the agent never handles raw tokens. [OpenHands secrets](https://docs.openhands.dev/openhands/usage/settings/secrets-settings), [OpenHands Secret Registry](https://docs.openhands.dev/sdk/guides/secrets), [Continue secrets](https://docs.continue.dev/hub/secrets/secret-types), [Composio proxy execute](https://docs.composio.dev/docs/proxy-execute)
- Keep provider credentials separate. Anthropic/OpenAI should be provider-scoped secrets; GitHub should preferably be a fine-grained PAT or GitHub App token; Telegram bot tokens and similar webhook secrets should never be exported into images or checked into repos. Cursor-related credentials, if you need them at all, should stay host-only and never enter the sandbox.

## F. Storage / git topology

- Clone repositories locally and give each agent a linked worktree, not a remote checkout. Git worktrees share refs and object storage, but each worktree has its own `HEAD` and administrative metadata, which is exactly what you want for parallel agent runs. [git worktree](https://git-scm.com/docs/git-worktree.html)
- This is the same topology Aider and OpenHands gravitate toward: local git repo, edits committed as part of the workflow, and a strong preference for undoable git history over opaque temp files. [Aider git integration](https://aider.chat/docs/git.html), [OpenHands README](https://github.com/OpenHands/OpenHands)
- Disk growth rule of thumb: shared clone plus one working tree per active agent plus build artifacts and logs. The shared `.git` object store is deduplicated, but the checkout itself, `node_modules`, build outputs, browser profiles, and test fixtures are not. For 5-20 concurrent agents, plan for hundreds of GB of NVMe if the repos are non-trivial.
- Cleanup strategy: `git worktree prune`, `git gc`, age out abandoned sandboxes, keep caches outside the repo, and kill orphaned browser/test artifacts on a timer. Git’s own docs say `git gc` will call `git worktree prune` on stale entries. [git gc](https://git-scm.com/docs/git-gc/2.43.0), [git worktree prune](https://git-scm.com/docs/git-worktree.html)

## G. Observability

- Recommended stack: structured JSON logs per agent, OpenTelemetry traces for tool calls and lifecycle events, Prometheus for host/process metrics, and Loki/Grafana for log exploration.
- OpenHands already documents both OpenTelemetry tracing and metrics tracking for token usage, cost, and latency. That makes it a strong reference point for the kind of telemetry a coding-agent host should expose. [OpenHands observability](https://docs.openhands.dev/sdk/guides/observability), [OpenHands metrics](https://docs.openhands.dev/sdk/guides/metrics)
- The best “hooks” pattern I found is the disler multi-agent observability repo: Claude Code hooks emit events to a Bun server, which stores them in SQLite and streams them to a Vue UI. It tracks multiple concurrent agents, session IDs, and lifecycle events, which maps almost directly to codex-peers. [disler observability repo](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- For codex-peers, emit at least: `agent_id`, `session_id`, `repo`, `branch`, `model`, `turn`, `tool_name`, `exit_status`, `approval_state`, `git_commit`, `sandbox_id`, and `cost`. That lets you answer the questions that matter in production: what ran, how long it took, what it changed, and why it failed.
- Grafana Loki is a good log backend because it is built for label-indexed logs and integrates naturally with Grafana dashboards; Prometheus is the right metric store because it is the standard pull-based time-series system. [Loki overview](https://grafana.com/docs/loki/latest/get-started/overview/), [Prometheus docs](https://next.prometheus.io/)

## H. Cost

- The infra-only cost of a small agent host is surprisingly modest compared to model spend. Recent 2026 posts put “agent-host” VPS setups in the `$20-70/month` band, with a cheap dedicated box often being the better value once concurrency climbs. [HostedClaws comparison](https://www.hostedclaws.com/blog/ai-agent-hosting-comparison-2026), [Hermify cheap VPS post](https://www.hermify.io/en/blog/cheap-vps-for-ai-agent)
- Current Hetzner cloud pricing after the April 2026 adjustment is roughly `CPX11 €4.49/mo`, `CPX21 €7.99/mo`, `CPX41 €31.49/mo`, and `CPX51 €59.99/mo` in Germany/Finland. That is good for small control-plane or dev hosts, but not ideal for 5-20 busy agents unless you heavily constrain concurrency. [Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- Current Hetzner dedicated AX pricing shows `AX42` around `€46-52/mo` and `AX52` around `€59-66/mo`, with the AX52 page calling out two 1 TB Gen4 NVMe SSDs. That is the sweet spot I would target for a dedicated agent farm host that needs real parallelism but still wants sane monthly cost. [Hetzner AX servers](https://www.hetzner.com/dedicated-rootserver/matrix-ax/?country=en), [Hetzner AX52](https://www.hetzner.com/dedicated-rootserver/ax52/?country=us)
- Bare metal or colo can get cheaper per core at higher scale, but only if you are willing to own patching, failures, remote power, and spares. For a single operator, cheap dedicated is usually the better tradeoff than true colo.

## I. Comparable hosted agent products

- **Devin** exposes a full workspace with shell, browser, and code editor; session progress views; web/Slack/API entrypoints; hooks; and enterprise deployment into a customer VPC via Kubernetes. A self-hoster should copy the workspace visibility and the “where is my agent?” progress UI first. [Devin computer use](https://docs.devin.ai/work-with-devin/computer-use), [Devin session tools](https://docs.devin.ai/product-guides/interactive-browser), [Devin hooks](https://cli.devin.ai/docs/extensibility/hooks/overview), [Devin enterprise deploy](https://docs.devin.ai/enterprise/deploy)
- **CodeAnt** exposes automatic PR reviews, line-level feedback, severity labels, GitHub/GitLab/Bitbucket/Azure DevOps integration, headless CLI review, and PR chat. A self-hoster should match the PR review surface, structured severity, and cross-SCM compatibility. [CodeAnt review](https://docs.codeant.ai/cli/review), [CodeAnt SCM integration](https://docs.codeant.ai/cli/scm-integration), [CodeAnt PR chat](https://docs.codeant.ai/pull_request/features/chat)
- **Sweep** exposes an IDE agent, inline editing, autocomplete, AI code review, web search/fetch tools, and remote MCP servers. The thing to copy is the tight loop between IDE, code review, and tool access rather than just the chat UI. [Sweep docs](https://docs.sweep.dev/), [Sweep about](https://sweep.dev/about-us)
- **Composio Cloud** exposes managed OAuth, triggers, context-aware sessions, session-scoped auth, and BYOC messaging. A self-hoster should treat those as product requirements, not embellishments: users need persistent identities, durable sessions, and event-driven tools. [Composio home](https://composio.dev/), [Composio sessions](https://docs.composio.dev/tool-router/users-and-sessions), [Composio triggers](https://docs.composio.dev/docs/triggers), [Composio connect](https://docs.composio.dev/docs/composio-connect)
- The common denominator across all four is that the agent platform is not just “a CLI that runs a prompt.” It is workspace state, auth, logs, branch tracking, review surfaces, and a stable lifecycle API.

## J. Security model

- Minimum bar for a publicly reachable `--yolo` agent host: one sandbox per agent, no root in the sandbox, no Docker socket mounted into agent containers, explicit read-write mounts only for the intended worktree, outbound network restrictions, and an auth layer in front of every UI/API.
- OpenHands documents Docker sandboxing as the secure runtime, warns that the local runtime has no sandbox isolation, and provides hardened Docker guidance for public-network use. It also documents a rootless Apptainer sandbox for shared/HPC-style environments. [OpenHands Docker runtime](https://docs.all-hands.dev/openhands/usage/runtimes/docker), [OpenHands runtime architecture](https://docs.all-hands.dev/usage/architecture/runtime), [OpenHands local runtime](https://docs.all-hands.dev/modules/usage/runtimes/local), [OpenHands docs index](https://docs.openhands.dev/llms.txt)
- Docker rootless mode is the baseline I would want on a public host if I were forced to use containers. Docker’s docs are explicit that rootless runs both daemon and containers without root privileges. [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- If you need stronger isolation than rootless Docker, move to per-agent VMs or microVMs. If you cannot do that, keep the host private behind Tailscale or Cloudflare Access and do not expose the agent port directly.

## Synthesized stack recommendation for codex-peers

- Host: `Hetzner AX52` or equivalent cheap dedicated server.
- OS: `Ubuntu 24.04 LTS`.
- Supervision: `systemd` service that owns a `rootless Docker Compose` stack.
- Network: `Tailscale` for private access; `Cloudflare Tunnel + Access` if browser-based remote use is required.
- Auth: start with a single-user API key model; add `mTLS` if you have a small trusted device set, or `oauth2-proxy` if you need team login.
- Secrets: `systemd credentials` for host-level injection, plus `SOPS/age` or `Vault` for source-controlled or centralized secrets.
- Git: local clone plus `git worktree` per agent, with scheduled `git worktree prune` and `git gc`.
- Observability: JSON logs, OpenTelemetry traces, Loki, Prometheus, Grafana.
- Sandbox: rootless Docker container per agent as the minimum; upgrade to VM-per-agent if the host becomes publicly reachable or the workload becomes high-risk.

## Bootstrap checklist

1. Install Ubuntu Server on the host, patch it, create a non-root operator account, and set up SSH keys.
2. Install and configure `systemd`, `rootless Docker`, `docker compose`, `git`, `Tailscale`, and your firewall rules.
3. Create the host directories for worktrees, logs, cache, and secrets.
4. Configure the private access layer first: Tailscale or Cloudflare Tunnel + Access.
5. Add auth in front of any web UI before exposing anything beyond localhost.
6. Create one root-owned secret store for provider keys, then wire them into the service with `systemd` credentials or Compose secrets.
7. Clone one test repo locally and validate the `git worktree` lifecycle, cleanup jobs, and branch push path.
8. Turn on JSON logging, OTEL tracing, and a basic host metrics stack before you add more agents.
9. Run a single dry agent, then 2-3 parallel agents, then your target concurrency, watching CPU, RAM, open files, disk, and network.
10. Only after that should you let `--yolo` runs onto the host.

## Estimated monthly cost

| Layer | Typical monthly cost | Notes |
| --- | ---: | --- |
| Tiny VPS | `€5-30` | Enough for a gateway, not enough for serious 5-20-agent concurrency. |
| Cheap dedicated | `€60-120` | Best value for this use case; AX52-class hardware lands here. |
| Extras | `€10-40` | Backup storage, tunnel/auth service, and observability overhead. |
| Model/API spend | separate | Usually dominates infra cost once agents are active. |

For a reasonable codex-peers host, I would budget roughly `€80-160/month` for the server plus basic ops, before model/API spend.

## Sources

- [OpenHands README](https://github.com/OpenHands/OpenHands)
- [OpenHands local setup](https://docs.all-hands.dev/openhands/usage/local-setup)
- [OpenHands Docker runtime](https://docs.all-hands.dev/openhands/usage/runtimes/docker)
- [OpenHands runtime architecture](https://docs.all-hands.dev/usage/architecture/runtime)
- [OpenHands secrets](https://docs.openhands.dev/openhands/usage/settings/secrets-settings)
- [OpenHands observability](https://docs.openhands.dev/sdk/guides/observability)
- [OpenHands metrics](https://docs.openhands.dev/sdk/guides/metrics)
- [OpenHands docs index](https://docs.openhands.dev/llms.txt)
- [Continue CLI](https://docs.continue.dev/cli)
- [Continue headless mode](https://docs.continue.dev/cli/headless-mode)
- [Continue secrets](https://docs.continue.dev/hub/secrets/secret-types)
- [Continue telemetry](https://docs.continue.dev/telemetry)
- [Aider README](https://github.com/Aider-AI/aider)
- [Aider git integration](https://aider.chat/docs/git.html)
- [Docker Compose](https://docs.docker.com/compose/)
- [Docker Compose secrets](https://docs.docker.com/reference/compose-file/secrets/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [systemd overview](https://systemd.io/)
- [systemd.service](https://www.freedesktop.org/software/systemd/man/249/systemd.service.html)
- [systemd credentials](https://systemd.io/CREDENTIALS/)
- [K3s](https://docs.k3s.io/)
- [K3s installation](https://docs.k3s.io/installation)
- [git worktree](https://git-scm.com/docs/git-worktree.html)
- [git gc](https://git-scm.com/docs/git-gc/2.43.0)
- [Tailscale what is](https://tailscale.com/docs/concepts/what-is-tailscale)
- [Tailscale WireGuard](https://tailscale.com/docs/concepts/wireguard)
- [Tailscale secure the network](https://tailscale.com/docs/secure-networks)
- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [Cloudflare managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/)
- [Traefik mTLS](https://doc.traefik.io/traefik/v2.7/https/tls/)
- [SOPS docs](https://getsops.io/docs/)
- [Vault KV](https://developer.hashicorp.com/vault/docs/secrets/kv)
- [Vault static secrets](https://developer.hashicorp.com/vault/docs/about-vault/why-use-vault/static-secrets)
- [Grafana Loki overview](https://grafana.com/docs/loki/latest/get-started/overview/)
- [Prometheus docs](https://next.prometheus.io/)
- [disler multi-agent observability repo](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- [Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Hetzner AX servers](https://www.hetzner.com/dedicated-rootserver/matrix-ax/?country=en)
- [Hetzner AX52](https://www.hetzner.com/dedicated-rootserver/ax52/?country=us)
- [HostedClaws comparison](https://www.hostedclaws.com/blog/ai-agent-hosting-comparison-2026)
- [Hermify cheap VPS post](https://www.hermify.io/en/blog/cheap-vps-for-ai-agent)
- [Devin computer use](https://docs.devin.ai/work-with-devin/computer-use)
- [Devin session tools](https://docs.devin.ai/product-guides/interactive-browser)
- [Devin hooks](https://cli.devin.ai/docs/extensibility/hooks/overview)
- [Devin enterprise deploy](https://docs.devin.ai/enterprise/deploy)
- [CodeAnt review](https://docs.codeant.ai/cli/review)
- [CodeAnt SCM integration](https://docs.codeant.ai/cli/scm-integration)
- [CodeAnt PR chat](https://docs.codeant.ai/pull_request/features/chat)
- [Sweep docs](https://docs.sweep.dev/)
- [Sweep about](https://sweep.dev/about-us)
- [Composio home](https://composio.dev/)
- [Composio sessions](https://docs.composio.dev/tool-router/users-and-sessions)
- [Composio triggers](https://docs.composio.dev/docs/triggers)
- [Composio connect](https://docs.composio.dev/docs/composio-connect)
