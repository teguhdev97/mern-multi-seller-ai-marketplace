$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $repo 'backend'
$envFile = Join-Path $backend '.env'
$container = 'marketplace-mysql-local'
$volume = 'marketplace-mysql-local-data'
$port = 3308

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program failed (exit $LASTEXITCODE)."
    }
}

function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    } finally {
        $rng.Dispose()
    }
}

Get-Command bun, node, podman | Out-Null
Invoke-Checked 'podman' @('info', '--format', '{{.Host.OS}}')

foreach ($name in @('DB_CONNECTION', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'DB_TLS_CA_FILE')) {
    if (Test-Path "Env:$name") {
        throw "Remove the inherited $name setting from this PowerShell session before running the local setup."
    }
}

# Guard the local setup from existing environment files for other databases.
if (Test-Path $envFile) {
    $settings = @{}
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^([A-Z_]+)=(.*)$') {
            if ($settings.ContainsKey($Matches[1])) {
                throw "Duplicate setting $($Matches[1]) in backend/.env."
            }
            $settings[$Matches[1]] = $Matches[2]
        }
    }
    if ($settings['DB_CONNECTION'] -ne 'mysql' -or $settings['DB_HOST'] -ne '127.0.0.1' -or $settings['DB_PORT'] -ne "$port" -or
        $settings['DB_DATABASE'] -ne 'marketplace' -or $settings['DB_USERNAME'] -ne 'marketplace_app' -or
        $settings['DB_PASSWORD'] -notmatch '^[a-f0-9]{64}$') {
        throw 'Move backend/.env to a backup path before running the local setup. This script expects its own local MySQL settings.'
    }
    $password = $settings['DB_PASSWORD']
} else {
    $password = New-Secret
    $secret = New-Secret
    $lines = Get-Content (Join-Path $backend '.env.example')
    $lines -replace '^DB_PORT=.*$', "DB_PORT=$port" `
           -replace '^DB_PASSWORD=.*$', "DB_PASSWORD=$password" `
           -replace '^BETTER_AUTH_SECRET=.*$', "BETTER_AUTH_SECRET=$secret" |
        Set-Content -Encoding ASCII $envFile
}

& podman container exists $container
switch ($LASTEXITCODE) {
    0 { Invoke-Checked 'podman' @('start', $container) }
    1 {
        $mysqlEnv = [IO.Path]::GetTempFileName()
        try {
            @(
                "MYSQL_ROOT_PASSWORD=$(New-Secret)"
                'MYSQL_DATABASE=marketplace'
                'MYSQL_USER=marketplace_app'
                "MYSQL_PASSWORD=$password"
            ) | Set-Content -Encoding ASCII $mysqlEnv

            Invoke-Checked 'podman' @(
                'run', '--detach', '--name', $container,
                '--publish', "127.0.0.1:${port}:3306",
                '--volume', "${volume}:/var/lib/mysql",
                '--env-file', $mysqlEnv,
                'docker.io/library/mysql:8.4'
            )
        } finally {
            Remove-Item $mysqlEnv
        }
    }
    default { throw 'Could not inspect the local MySQL container.' }
}

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & podman exec $container sh -c 'MYSQL_PWD=$MYSQL_PASSWORD mysql --protocol=TCP -h 127.0.0.1 -u "$MYSQL_USER" "$MYSQL_DATABASE" -e "SELECT 1" >/dev/null 2>&1'
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    throw "Local MySQL did not become ready. Run: podman logs $container"
}

Push-Location $backend
try {
    Invoke-Checked 'bun' @('install', '--frozen-lockfile')
    Invoke-Checked 'bun' @('run', 'db:migrate')
} finally {
    Pop-Location
}

Push-Location (Join-Path $repo 'frontend')
try {
    Invoke-Checked 'bun' @('install', '--frozen-lockfile')
} finally {
    Pop-Location
}

Write-Host 'Local MySQL and the app dependencies are ready.'
Write-Host 'From the repo root, start the API with: cd backend; bun run dev'
Write-Host 'In another terminal, start the web app with: cd frontend; bun run dev'
Write-Host 'Open http://localhost:5173'
