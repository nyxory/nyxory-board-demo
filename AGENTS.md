# AGENTS.md: brand this board for the user's company, deploy it to nyxory

You are a coding agent and someone handed you this repo, usually with "deploy
this" or "try this". The job: a live board in the user's company look (name,
logo, colours), running on nyxory, URL in the user's hand. Roughly ten tool
calls. Speak the user's language.

**Privacy.** You use only two things: the user's own account email, read in
their own session, and the company's public homepage. You never write the
email to a file, a commit, a log or any other service. The only thing that
leaves this session is `theme.json` (company name, public logo, colours).

## 1. Find out who it is for

Call `nyx_project_list` on the nyxory MCP. If `account.email` is present, take
the part after `@` as the company domain.

> As of today the MCP does not return the account email, so this usually
> comes up empty. Then go straight to the question below.

Ask exactly one short question, and don't guess, when:

- there is no email,
- the email is a free-mail domain (gmail.com, googlemail.com, outlook.*,
  hotmail.*, live.*, msn.com, yahoo.*, icloud.com, me.com, mac.com, aol.com,
  proton.me, protonmail.com, pm.me, gmx.*, web.de, t-online.de, freenet.de,
  posteo.de, mailbox.org, mail.de, arcor.de, yandex.*, zoho.com),
- the domain belongs to a consultancy or agency, to nyxory itself, or does not
  clearly identify one company.

The question, in German:

> Für wen soll das Board sein, dich persönlich oder eine Firma? Wenn Firma: wie heißt sie (oder ihre Website)?

In English: *"Who is the board for, you personally or a company? If a
company: what's its name (or website)?"*

A short question beats the wrong corporate identity. Use the answer:

- **Website or domain**: use it as is.
- **Company name only**: use the company's official domain if it is
  unambiguous, and show it in step 3's confirmation. If it is ambiguous, ask
  for the website.
- **Personal**: keep the neutral `theme.json` and skip to step 4.

## 2. Derive the brand

```bash
node scripts/brand-from-domain.mjs <domain>     # Node >= 22, writes ./theme.json
```

The script fetches only the public homepage over https (plus its first
stylesheets and the icon), with timeouts and size limits, and never runs
anything from the page. It prints `name`, `primary`, `accent`, the embedded
logo's type and size, and `fallback`, the fields it could not find and left
neutral. It tries `www.<domain>` on its own when the bare domain fails.

## 3. Confirm in one line

Show what was found, then ask once, e.g.:

> Gefunden: **Muster GmbH**, Primär `#0057b8`, Akzent `#f5a300`, Logo ✓. Passt das, oder soll ich Name, Farben oder Logo ändern?

If `fallback` lists the colours, ask for the brand colour in the same line.
Apply corrections directly in `theme.json`: `name`, `primary` and `accent` as
`#rrggbb`, `logo` as `https://…` or `data:image/…;base64,…`. Then
`git add theme.json && git commit -m "Branding: <Name>"`.

## 4. Deploy to nyxory

1. **Project.** In `nyx_project_list`, pick the workspace: the personal one
   unless the user names another. Then
   `nyx_project_add(name="<company>-board", workspace=<id>)`.
2. **Remote.** Call `nyx_git_remote_create(project=<namespace>)` and follow
   its `next` exactly. The push token goes into the environment, either
   through the user's `export` or a file with mode 600 read via `$(cat …)`.
   Never put it into a command argument, a URL, git config or your answer.
   Push with the command it returns.
3. **Cookbook.** Call `nyx_brain(repo_url=<remote_url>, project=<namespace>,
   agent_briefing=…)` with the briefing below, and follow the cookbook it
   returns. What worked for this repo: `nyx_clone_repo` →
   `nyx_build_and_push_image(builder="dockerfile")` → `nyx_deploy_manifests`
   with the manifests below. Paste `image_ref` verbatim.
4. **Verify.** Take the URL from `nyx_app_get(project, name="board").domains`.
   Never construct it: the host is `board-<id>.<apps-domain>`, without the
   `nyx-` prefix. From your local shell, `curl <url>/healthz` must return 200
   and `<url>/theme.json` must show the company name.

Briefing:

```
Node 24, zero npm deps, one process (node:http + node:sqlite + SSE). Dockerfile at repo root
(distroless nodejs24, nonroot 65532, port 8080, GET /healthz). Exactly one replica: SQLite and the
SSE broadcast live in the process. theme.json in the repo root carries the branding.
```

Manifests (tested on nyxory dev, 11.10.2026). Replace `<namespace>` and `<image_ref>`:

```yaml
# app_manifest
apiVersion: nyxory.com/v1alpha1
kind: App
metadata:
  name: board
  namespace: <namespace>
  labels: { app.kubernetes.io/instance: board }
spec:
  displayName: Live Impuls-Board
```

```yaml
# rest_manifests
apiVersion: apps/v1
kind: Deployment
metadata:
  name: board
  namespace: <namespace>
  labels: { app.kubernetes.io/instance: board }
spec:
  replicas: 1
  selector: { matchLabels: { app.kubernetes.io/instance: board } }
  template:
    metadata:
      labels: { app.kubernetes.io/instance: board }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: board
          image: <image_ref>
          ports: [{ name: http, containerPort: 8080 }]
          env:
            - { name: HOST, value: 0.0.0.0 }
            - { name: PORT, value: "8080" }
            - { name: DB_PATH, value: /app/data/board.db }
          readinessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 20 }
          resources:
            requests: { cpu: 25m, memory: 64Mi }
            limits: { cpu: 100m, memory: 128Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts: [{ name: data, mountPath: /app/data }]
      volumes: [{ name: data, emptyDir: {} }]
---
apiVersion: v1
kind: Service
metadata:
  name: board
  namespace: <namespace>
  labels: { app.kubernetes.io/instance: board }
spec:
  selector: { app.kubernetes.io/instance: board }
  ports: [{ name: http, port: 80, targetPort: 8080 }]
```

## 5. Hand over

Tell the user the URL first, then in one line what was personalised (name,
logo, colours) and that a push to the remote redeploys on its own (auto-deploy
is on). Notes live in the pod and reset on redeploy. For persistence, add a
volume, mount it at `/app/data` and keep one replica.

## Local only

If the user just wants to look at it: `npm run dev`, then open
http://localhost:3000. Run `node --test` before you commit code changes.
