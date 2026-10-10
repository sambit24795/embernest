# Embernest installer for Windows (PowerShell 5.1 or newer).
#   irm https://raw.githubusercontent.com/sambit24795/embernest/main/install/install.ps1 | iex
#
# Environment (all optional):
#   EMBERNEST_HOME               data folder (default: %LOCALAPPDATA%\Embernest)
#   EMBERNEST_VERSION            npm version or tag of the embernest package to install (default: latest)
#   EMBERNEST_SOURCE             install from this instead of the npm registry: a local .tgz
#                                path, or a tarball URL such as
#                                https://codeload.github.com/sambit24795/embernest/tar.gz/main
#   EMBERNEST_BIN_DIR            where embernest.cmd goes (default: <home>\bin)
#   EMBERNEST_NO_SETUP=1         do not run `embernest setup` at the end
#   EMBERNEST_FORCE_NODE_DOWNLOAD=1  ignore any Node on PATH (used for testing)
# The old PIXELKILN_* names are still accepted. An existing PixelKiln data folder is reused.
#
# Everything is inside a function so `| iex` can fail with `throw` without closing the window.

$Repo = 'sambit24795/embernest'

# Settings are read as EMBERNEST_*; the old PIXELKILN_* names still work.
function Get-EnvOrLegacy([string]$suffix) {
    $v = [Environment]::GetEnvironmentVariable("EMBERNEST_$suffix")
    if ($v) { return $v }
    return [Environment]::GetEnvironmentVariable("PIXELKILN_$suffix")
}

function Install-Embernest {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on 5.1
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # Node LTS ("Krypton" 24.x) from https://nodejs.org/dist/index.json; any Node >= 22 works.
    $NodeVersion = '24.21.0'
    $NodeMinMajor = 22

    # --- 1. Architecture ---------------------------------------------------
    $rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($rawArch) {
        'AMD64' { $arch = 'x64' }
        'ARM64' { $arch = 'arm64' }
        default { throw "Unsupported CPU architecture '$rawArch'." }
    }

    # --- 2. Data folder ----------------------------------------------------
    # Order: EMBERNEST_HOME, PIXELKILN_HOME, the new default if it exists, an existing
    # PixelKiln folder (kept in place, never moved), else the new default.
    $homeDir = Get-EnvOrLegacy 'HOME'
    if (-not $homeDir) {
        $newHome = Join-Path $env:LOCALAPPDATA 'Embernest'
        $oldHome = Join-Path $env:LOCALAPPDATA 'PixelKiln'
        if (Test-Path $newHome) { $homeDir = $newHome }
        elseif (Test-Path $oldHome) { $homeDir = $oldHome }
        else { $homeDir = $newHome }
    }
    $binDir = Get-EnvOrLegacy 'BIN_DIR'
    if (-not $binDir) { $binDir = Join-Path $homeDir 'bin' }
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null

    # --- 3. Node -----------------------------------------------------------
    $node = $null
    $npm = $null
    if ((Get-EnvOrLegacy 'FORCE_NODE_DOWNLOAD') -ne '1') {
        $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
        $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($nodeCmd -and $npmCmd) {
            $major = 0
            try { $major = [int](& $nodeCmd.Source -p 'process.versions.node.split(".")[0]') } catch { $major = 0 }
            if ($major -ge $NodeMinMajor) {
                $node = $nodeCmd.Source
                $npm = $npmCmd.Source
                Write-Host "Using Node at $node"
            }
        }
    }
    if (-not $node) {
        $name = "node-v$NodeVersion-win-$arch"
        $base = "https://nodejs.org/dist/v$NodeVersion"
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("embernest-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        try {
            Write-Host "Downloading Node.js v$NodeVersion (win-$arch)..."
            $zip = Join-Path $tmp "$name.zip"
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.zip" -OutFile $zip
            $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
            $want = $null
            foreach ($line in ($sums -split "`n")) {
                if ($line.Trim() -match '^([0-9a-fA-F]{64})\s+(\S+)$' -and $Matches[2] -eq "$name.zip") { $want = $Matches[1].ToLower() }
            }
            if (-not $want) { throw "No checksum for $name.zip in SHASUMS256.txt." }
            $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
            if ($got -ne $want) { throw "Checksum mismatch for $name.zip (expected $want, got $got)." }
            Write-Host 'Checksum OK.'

            $nodeDir = Join-Path $homeDir 'node'
            if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
            Expand-Archive -Path $zip -DestinationPath $tmp -Force
            Move-Item -Path (Join-Path $tmp $name) -Destination $nodeDir
        }
        finally {
            Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        }
        $node = Join-Path $homeDir 'node\node.exe'
        $npm = Join-Path $homeDir 'node\npm.cmd'
        $env:Path = (Join-Path $homeDir 'node') + ';' + $env:Path
    }

    # --- 4. Embernest ------------------------------------------------------
    $spec = Get-EnvOrLegacy 'SOURCE'
    if (-not $spec) {
        # From the npm registry unless EMBERNEST_SOURCE points at a tarball (local or URL).
        $ref = Get-EnvOrLegacy 'VERSION'
        if (-not $ref) { $ref = 'latest' }
        $spec = "embernest@$ref"
    }
    $appDir = Join-Path $homeDir 'app'
    Write-Host "Installing $spec into $appDir ..."
    # npm prints notices on stderr, which Windows PowerShell 5.1 would turn into errors.
    $ErrorActionPreference = 'Continue'
    & $npm install -g --prefix $appDir --no-fund --no-audit $spec
    $npmExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($npmExit -ne 0) { throw "npm install failed (exit code $npmExit)." }

    # On Windows, global packages go to <prefix>\node_modules (no lib\ folder).
    # https://docs.npmjs.com/cli/configuring-npm/folders
    $entry = Join-Path $appDir 'node_modules\embernest\bin\embernest.js'
    if (-not (Test-Path $entry)) { throw "Install finished but $entry is missing." }

    # --- 5. Shim and PATH --------------------------------------------------
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $shim = Join-Path $binDir 'embernest.cmd'
    $shimText = "@echo off`r`n`"$node`" `"$entry`" %*`r`n"
    Set-Content -Path $shim -Value $shimText -Encoding Default -NoNewline
    # Keep the old command name working too.
    Copy-Item -Force -Path $shim -Destination (Join-Path $binDir 'pixelkiln.cmd')
    Write-Host "Installed $shim (and pixelkiln.cmd as an alias)"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $parts = $userPath -split ';' | Where-Object { $_ }
    if ($parts -notcontains $binDir) {
        $newPath = (@($parts) + $binDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Added $binDir to your user PATH. Open a new terminal to use 'embernest'."
    }
    if (($env:Path -split ';') -notcontains $binDir) { $env:Path = $binDir + ';' + $env:Path }

    # --- 6. Setup ----------------------------------------------------------
    if ((Get-EnvOrLegacy 'NO_SETUP') -eq '1') {
        Write-Host "Skipping setup. Run 'embernest setup' when you are ready."
        return
    }
    & $shim setup
}

Install-Embernest
