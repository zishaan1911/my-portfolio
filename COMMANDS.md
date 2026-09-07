# PowerShell command reference

Everything below is PowerShell (Windows). Run as your normal user; nothing here
needs an administrator prompt except the optional tool installs.

---

## 1. Install prerequisites

```powershell
winget install --id Git.Git         -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
winget install --id GitHub.cli      -e --source winget   # optional, for secrets
```

Close and reopen the terminal so PATH updates, then confirm:

```powershell
git --version
node --version      # must be 20 or newer
gh --version        # optional
```

---

## 2. Fork and clone

Fork `Richard-Apps/richardapps-web` on GitHub first (button, top right), then:

```powershell
$dev = "$HOME\dev"
New-Item -ItemType Directory -Path $dev -Force | Out-Null
Set-Location $dev

git clone https://github.com/zishaan1911/my-portfolio.git
Set-Location .\my-portfolio
```

Point the fork back at upstream so you can pull design fixes later:

```powershell
git remote add upstream https://github.com/Richard-Apps/richardapps-web.git
git remote -v
```

---

## 3. Extract the payload

Unzip **next to** the repo, not inside it:

```powershell
Expand-Archive -Path "$HOME\Downloads\zishaan-terminal-site.zip" `
               -DestinationPath "$dev\payload" -Force

Get-ChildItem "$dev\payload" | Select-Object Name
```

---

## 4. Apply the commits

Dry run first — this changes nothing:

```powershell
Set-Location "$dev\my-portfolio"
& "$dev\payload\setup.ps1" -RepoPath "$dev\my-portfolio" -PayloadPath "$dev\payload" -DryRun
```

If the plan looks right, apply it:

```powershell
& "$dev\payload\setup.ps1" -RepoPath "$dev\my-portfolio" -PayloadPath "$dev\payload"
```

If PowerShell blocks the script:

```powershell
Unblock-File "$dev\payload\setup.ps1"
# or, for this session only:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Review before pushing:

```powershell
git log --oneline
git log -p          # q to quit
git show HEAD~2     # inspect any single commit
```

---

## 5. Test

```powershell
npm test            # guard tests + mocked end-to-end sync
npm run test:guard  # just the content guard
```

---

## 6. Run locally

The site uses ES modules, so it **must** be served over HTTP. Opening
`index.html` by double-clicking gives you a page with no themes, no tabs and no
effects, because the browser blocks modules on `file://`.

```powershell
python -m http.server 8000
# then browse to http://localhost:8000
```

No Python? Use Node:

```powershell
npx --yes http-server -p 8000 -c-1
```

Stop the server with `Ctrl+C`.

---

## 7. Push

```powershell
git push origin HEAD
```

Then enable Pages: **Settings → Pages → Source: Deploy from a branch → main / (root)**.

---

## 8. Set up the live sync

Add the Groq key as a repository secret:

```powershell
gh auth login
gh secret set GROQ_API_KEY --body "gsk_your_key_here"
gh secret list
```

Without `gh`, add it at **Settings → Secrets and variables → Actions → New repository secret**.

**Enable Actions.** Scheduled workflows are disabled by default in forked
repositories — without this the cron never fires:

```powershell
gh workflow enable "Sync live data"
gh workflow list
```

Run it now rather than waiting for the schedule:

```powershell
gh workflow run "Sync live data"
Start-Sleep -Seconds 20
gh run list --workflow "Sync live data" --limit 3
gh run watch
```

Force every description to regenerate, ignoring the README cache:

```powershell
gh workflow run "Sync live data" -f force=true
```

---

## 9. Run the sync locally

```powershell
$env:GITHUB_TOKEN = (gh auth token)
$env:GROQ_API_KEY = "gsk_your_key_here"
node scripts/sync.mjs

git diff --stat src/data
```

Clear the variables when finished:

```powershell
Remove-Item Env:\GROQ_API_KEY, Env:\GITHUB_TOKEN
```

---

## 10. Pull upstream design fixes later

```powershell
git fetch upstream
git merge upstream/main
```

Conflicts will be in `index.html` and `style.css` — the two files with the most
local changes. Everything else should merge cleanly.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No themes, tabs don't switch | Opened via `file://`. Serve over HTTP (step 6). |
| Themes missing on the Projects tab | The picker only exists on Home. |
| "Themes" shows as a heading only | Mobile width collapses `<details>`. Tap it. |
| Repo list stuck on "Loading…" | `src/data/repos.json` missing. Run `node scripts/sync.mjs`. |
| Workflow never runs | Actions not enabled on the fork (step 8). |
| Groq returns 400 | Dead model ID. `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` were decommissioned on 2026-08-16. |
| Guard rejects everything | Working as intended if the README has no facts to summarise. Check the run log. |
