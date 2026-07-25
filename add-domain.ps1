param (
    [Parameter(Mandatory=$true, HelpMessage="Domain to add on the VPS (e.g. mybrand-review.com)")]
    [string]$Domain,
    [switch]$DryRun
)

# Adds a new site on the VPS by running `./add-site.sh <domain>` over SSH — the
# same manual step you'd otherwise SSH in to do by hand. Uses the same server +
# key-based SSH as deploy.ps1. It ONLY runs add-site; deploy content afterwards
# with deploy.ps1.

# --- Server config (same VPS as deploy.ps1) ---
$VPS_IP   = "45.32.122.181"
$VPS_USER = "root"

# --- Validate the domain ---
# The value is passed into a REMOTE shell command, so restrict it to a strict
# domain whitelist (a-z 0-9 . -). That guarantees no shell metacharacter
# (space ; & | $ backtick ' ") can smuggle an extra command onto the server.
$Domain = $Domain.Trim().ToLower()
$domainPattern = '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'
if ($Domain -notmatch $domainPattern) {
    Write-Host "Error: '$Domain' is not a valid domain. Example: mybrand-review.com" -ForegroundColor Red
    exit 1
}

Write-Host "========================================" -ForegroundColor Magenta
Write-Host "ADD SITE ON VPS: $Domain" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Magenta

$remote = "./add-site.sh $Domain"
Write-Host "`n-> ssh ${VPS_USER}@${VPS_IP} `"$remote`"" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "`n[DryRun] Not executing. The command above is what would run." -ForegroundColor DarkYellow
    exit 0
}

ssh "${VPS_USER}@${VPS_IP}" $remote

if ($LASTEXITCODE -ne 0) {
    Write-Host "`nError: add-site failed (exit $LASTEXITCODE). Check SSH access / the domain." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "`nDONE. '$Domain' added on the server." -ForegroundColor Green
Write-Host "Next: deploy content with  .\deploy.ps1 -Domain $Domain" -ForegroundColor DarkCyan
