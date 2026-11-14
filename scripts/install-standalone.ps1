#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-purge-nolimit standalone installer for DeepSeek Harness desktop.

.DESCRIPTION
    DSH desktop cannot install plugins through `dsh plugin add` because it tries to
    resolve the private @deepseek-ai/* packages from the public npm registry, which
    does not carry them. This script performs the manual route instead:

      1. stop the host
      2. back everything up
      3. extract the tarball into node_modules/dsh-purge
      4. patch profile package.json (dependency + bundles)
      5. rewrite all three lockfiles, recomputing the tarball integrity
      6. restart the host
      7. verify /dsh-purge/status

    Nothing outside the target profile is touched. Every change is preceded by a
    backup under %USERPROFILE%\dsh-purge-install-backup-<timestamp>.

.PARAMETER Tarball
    Path to dsh-purge-nolimit-<version>.tar.gz. Required.

.PARAMETER Profile
    Profile name. Default: desktop.

.PARAMETER DshHome
    DSH home directory. Default: %USERPROFILE%\.dsh

.PARAMETER NoRestart
    Do not restart the host at the end.

.PARAMETER DryRun
    Report what would happen, change nothing.

.EXAMPLE
    .\install-standalone.ps1 -Tarball .\dsh-purge-nolimit-2.3.32-dsh022.tar.gz

.EXAMPLE
    .\install-standalone.ps1 -Tarball D:\dl\pkg.tar.gz -Profile web -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Tarball,

    [string]$Profile = 'desktop',

    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),

    [switch]$NoRestart,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- helpers

$script:Step = 0
function Step($msg) {
    $script:Step++
    Write-Host ''
    Write-Host ('[' + $script:Step + '] ' + $msg) -ForegroundColor Cyan
}
function Ok($msg)   { Write-Host ('    ok   ' + $msg) -ForegroundColor Green }
function Info($msg) { Write-Host ('         ' + $msg) -ForegroundColor DarkGray }
function Warn($msg) { Write-Host ('    warn ' + $msg) -ForegroundColor Yellow }
function Die($msg)  { Write-Host ('    fail ' + $msg) -ForegroundColor Red; throw $msg }

function Read-Text([string]$p) {
    return [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($p))
}
function Write-Text([string]$p, [string]$t) {
    $dir = Split-Path $p -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
}

# SHA512 of the tarball, as sha512-<base64> - what pnpm records as `integrity`.
function Get-TarballIntegrity([string]$path) {
    $sha = [System.Security.Cryptography.SHA512]::Create()
    try {
        $fs = [System.IO.File]::OpenRead($path)
        try { $hash = $sha.ComputeHash($fs) } finally { $fs.Dispose() }
    } finally { $sha.Dispose() }
    return 'sha512-' + [Convert]::ToBase64String($hash)
}

function Get-HostProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------- banner

Write-Host ''
Write-Host '  dsh-purge-nolimit  standalone installer' -ForegroundColor White
Write-Host '  ---------------------------------------' -ForegroundColor DarkGray
if ($DryRun) { Write-Host '  DRY RUN - nothing will be changed' -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. validate

Step 'Validating inputs'

if (-not (Test-Path $Tarball)) { Die "tarball not found: $Tarball" }
$Tarball = (Resolve-Path $Tarball).Path
$tgz = Get-Item $Tarball
if ($tgz.Extension -ne '.gz') { Warn ('expected a .tar.gz, got ' + $tgz.Name) }
Ok ('tarball  ' + $tgz.Name + '  ' + $tgz.Length + ' B')

if (-not (Test-Path $DshHome)) { Die "DSH home not found: $DshHome" }
$profileDir = Join-Path $DshHome ('profiles\' + $Profile)
if (-not (Test-Path $profileDir)) { Die "profile not found: $profileDir" }
Ok ('profile  ' + $profileDir)

$profilePkg = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profilePkg)) { Die 'profile package.json missing' }
$pkg = Read-Text $profilePkg | ConvertFrom-Json
Ok ('host     ' + $pkg.name)

# ---------------------------------------------------------------- 2. backup

Step 'Backing up the current state'

$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakDir = Join-Path $env:USERPROFILE ('dsh-purge-install-backup-' + $stamp)

if ($DryRun) {
    Info ('would create ' + $bakDir)
} else {
    New-Item -ItemType Directory -Path $bakDir -Force | Out-Null
    $toBackup = @(
        'package.json',
        'pnpm-lock.yaml',
        'node_modules\.pnpm\lock.yaml',
        'node_modules\.modules.yaml',
        'cordis.patch.yml',
        'cordis.yml'
    )
    foreach ($rel in $toBackup) {
        $src = Join-Path $profileDir $rel
        if (Test-Path $src) {
            $dst = Join-Path $bakDir ($rel -replace '\\', '__')
            Copy-Item $src $dst -Force
        }
    }
    $existingPlugin = Join-Path $profileDir 'node_modules\dsh-purge'
    if (Test-Path $existingPlugin) {
        Copy-Item $existingPlugin (Join-Path $bakDir 'dsh-purge.old') -Recurse -Force
        Ok 'backed up existing plugin directory'
    }
    Ok ('backup   ' + $bakDir)
}

# ---------------------------------------------------------------- 3. stop host

Step 'Stopping the host'

$procs = Get-HostProcesses
Info ('running processes: ' + $procs.Count)
if ($procs.Count -gt 0) {
    if ($DryRun) {
        Info 'would stop the host'
    } else {
        $procs | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            if ((Get-HostProcesses).Count -eq 0) { break }
        }
        $left = (Get-HostProcesses).Count
        if ($left -gt 0) { Warn ('still running: ' + $left + ' - continuing anyway') } else { Ok 'host stopped' }
    }
} else {
    Ok 'host was not running'
}

# ---------------------------------------------------------------- 4. integrity

Step 'Computing tarball integrity'

$integrity = Get-TarballIntegrity $Tarball
Ok $integrity

# The lockfile stores the tarball location. Absolute forward-slash path is what
# pnpm itself writes on Windows.
$tarballPath = ($Tarball -replace '\\', '/')
$spec = 'file:' + $tarballPath

# ---------------------------------------------------------------- 5. extract

Step 'Extracting into node_modules/dsh-purge'

$pluginDir = Join-Path $profileDir 'node_modules\dsh-purge'
$verInTarball = ''

if ($DryRun) {
    Info ('would extract into ' + $pluginDir)
} else {
    $stage = Join-Path $env:TEMP ('dsh-purge-stage-' + $stamp)
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null

    & tar -xzf $Tarball -C $stage
    if ($LASTEXITCODE -ne 0) { Die ('tar failed with exit ' + $LASTEXITCODE) }

    # npm-style tarballs wrap everything in `package/`; our own tarballs are flat.
    $root = $stage
    $inner = Join-Path $stage 'package'
    if (Test-Path $inner) { $root = $inner }
    else {
        $dirs = @(Get-ChildItem $stage -Directory)
        $files = @(Get-ChildItem $stage -File)
        if ($dirs.Count -eq 1 -and $files.Count -eq 0) { $root = $dirs[0].FullName }
    }

    $pkgJson = Join-Path $root 'package.json'
    if (-not (Test-Path $pkgJson)) { Die 'package.json not found inside the tarball' }
    $innerPkg = Read-Text $pkgJson | ConvertFrom-Json
    if ($innerPkg.name -ne 'dsh-purge') {
        Die ("tarball package.json has name '" + $innerPkg.name + "', expected 'dsh-purge'")
    }
    $verInTarball = $innerPkg.version
    Ok ('tarball contains ' + $innerPkg.name + ' ' + $verInTarball)

    if (Test-Path $pluginDir) { Remove-Item $pluginDir -Recurse -Force }
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
    Copy-Item (Join-Path $root '*') $pluginDir -Recurse -Force
    # dotfiles are not matched by '*'
    Get-ChildItem $root -Force | Where-Object { $_.Name -like '.*' } | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $pluginDir $_.Name) -Recurse -Force
    }
    Ok ('extracted ' + (Get-ChildItem $pluginDir -Recurse -File).Count + ' files')

    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 6. package.json

Step 'Patching the profile package.json'

if ($DryRun) {
    Info ('would set dependencies.dsh-purge = ' + $spec)
    Info 'would add dsh-purge to dsh.profile.bundles'
} else {
    $raw = Read-Text $profilePkg
    $wasDryRun = $DryRun
    $DryRun = $false

    if (-not $pkg.PSObject.Properties['dependencies']) {
        $pkg | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
    }
    $pkg.dependencies | Add-Member -MemberType NoteProperty -Name 'dsh-purge' -Value $spec -Force

    if (-not $pkg.PSObject.Properties['dsh']) {
        $pkg | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{})
    }
    if (-not $pkg.dsh.PSObject.Properties['profile']) {
        $pkg.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{})
    }
    $bundles = @()
    if ($pkg.dsh.profile.PSObject.Properties['bundles']) { $bundles = @($pkg.dsh.profile.bundles) }
    if ($bundles -notcontains 'dsh-purge') { $bundles += 'dsh-purge' }
    $pkg.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $bundles -Force

    Write-Text $profilePkg ($pkg | ConvertTo-Json -Depth 20)
    Ok ('dependency = ' + $spec)
    Ok ('bundles    = ' + ($bundles -join ', '))
}

# ---------------------------------------------------------------- 7. lockfiles

Step 'Rewriting the three lockfiles'

$depKey = 'dsh-purge'
$pkgId  = 'dsh-purge@' + $spec

function Update-LockYaml([string]$text, [string]$spec, [string]$integrity, [string]$tarballForResolution, [string]$version) {
    $nl = "`n"
    $lines = $text -split "`n"

    # ---- Phase A: drop every line belonging to a `dsh-purge@...` block ----
    $kept = New-Object System.Collections.Generic.List[string]
    $i = 0
    while ($i -lt $lines.Count) {
        $ln = $lines[$i]
        if ($ln -match '^(\s*)dsh-purge@') {
            $baseIndent = $matches[1].Length
            $i++
            while ($i -lt $lines.Count) {
                $nxt = $lines[$i]
                if ($nxt.Trim() -eq '') { $i++; continue }
                $ind = $nxt.Length - $nxt.TrimStart().Length
                if ($ind -le $baseIndent) { break }
                $i++
            }
            continue
        }
        $kept.Add($ln)
        $i++
    }

    # ---- Phase B: drop bare `dsh-purge:` under importers, then insert ours ----
    $out = New-Object System.Collections.Generic.List[string]
    $i = 0
    $sawDep = $false
    while ($i -lt $kept.Count) {
        $ln = $kept[$i]
        if ($ln -match '^\s{6}dsh-purge:\s*$') {
            $i++
            while ($i -lt $kept.Count -and $kept[$i] -match '^\s{8}') { $i++ }
            continue
        }
        $out.Add($ln)
        if (-not $sawDep -and $ln -match '^\s{4}dependencies:\s*$') {
            $out.Add('      dsh-purge:')
            $out.Add('        specifier: ' + $spec)
            $out.Add('        version: ' + $spec)
            $sawDep = $true
        }
        $i++
    }
    if (-not $sawDep) {
        $out2 = New-Object System.Collections.Generic.List[string]
        $done = $false
        foreach ($ln in $out) {
            $out2.Add($ln)
            if (-not $done -and $ln -match '^\s{2}\.:\s*$') {
                $out2.Add('    dependencies:')
                $out2.Add('      dsh-purge:')
                $out2.Add('        specifier: ' + $spec)
                $out2.Add('        version: ' + $spec)
                $done = $true
            }
        }
        $out = $out2
    }

    # ---- Phase C: remove any existing `packages:` / `snapshots:` header and its
    #      (already empty, since phase A stripped dsh-purge blocks) body, then
    #      append both sections fresh at the end of the document. --------------
    $body = New-Object System.Collections.Generic.List[string]
    $i = 0
    while ($i -lt $out.Count) {
        $ln = $out[$i]
        if ($ln -match '^(packages|snapshots):\s*$') {
            $i++
            # skip blank lines and any remaining indented body lines
            while ($i -lt $out.Count) {
                $nxt = $out[$i]
                if ($nxt.Trim() -eq '') { $i++; continue }
                if ($nxt -match '^\s') { $i++; continue }
                break
            }
            continue
        }
        $body.Add($ln)
        $i++
    }

    # trim trailing blanks from the body
    while ($body.Count -gt 0 -and $body[$body.Count - 1].Trim() -eq '') {
        $body.RemoveAt($body.Count - 1)
    }

    $body.Add('')
    $body.Add('packages:')
    $body.Add('')
    $body.Add('    dsh-purge@' + $spec + ':')
    $body.Add('      resolution: {integrity: ' + $integrity + ', tarball: ' + $tarballForResolution + '}')
    $body.Add('      version: ' + $version)
    $body.Add('')
    $body.Add('snapshots:')
    $body.Add('')
    $body.Add('    dsh-purge@' + $spec + ': {}')
    $final = ($body -join $nl)
    $final = [regex]::Replace($final, '\n{3,}', ($nl + $nl))
    return $final.TrimEnd() + $nl
}

$lockFiles = @(
    @{ rel = 'pnpm-lock.yaml';                  kind = 'yaml';   tarballAbs = $true  },
    @{ rel = 'node_modules\.pnpm\lock.yaml';    kind = 'yaml';   tarballAbs = $false },
    @{ rel = 'node_modules\.modules.yaml';      kind = 'modules'; tarballAbs = $true }
)

foreach ($lf in $lockFiles) {
    $p = Join-Path $profileDir $lf.rel
    $tarballForResolution = $(if ($lf.tarballAbs) { $tarballPath } else { $spec })

    if ($DryRun) {
        Info ('would rewrite ' + $lf.rel)
        continue
    }
    if (-not (Test-Path $p)) {
        Warn ($lf.rel + ' missing - creating a minimal one')
    }

    if ($lf.kind -eq 'yaml') {
        $cur = if (Test-Path $p) { Read-Text $p } else { "lockfileVersion: '9.0'`n`nimporters:`n`n  .:`n`np`n" }
        $new = Update-LockYaml $cur $spec $integrity $tarballForResolution $verInTarball
        Write-Text $p $new
        Ok $lf.rel
    }
    else {
        # .modules.yaml is actually JSON in pnpm 9
        $obj = $null
        if (Test-Path $p) {
            try { $obj = Read-Text $p | ConvertFrom-Json } catch { $obj = $null }
        }
        if ($null -eq $obj) { $obj = [pscustomobject]@{} }

        foreach ($name in @('hoistedDependencies', 'injectedDeps', 'skipped', 'included')) {
            if (-not $obj.PSObject.Properties[$name]) {
                $obj | Add-Member -MemberType NoteProperty -Name $name -Value ([pscustomobject]@{})
            }
        }
        $obj | Add-Member -MemberType NoteProperty -Name 'pendingBuilds' -Value @() -Force
        foreach ($name in @('prunedAt', 'publicHoistPattern', 'registries')) {
            if (-not $obj.PSObject.Properties[$name]) {
                $obj | Add-Member -MemberType NoteProperty -Name $name -Value $null
            }
        }
        Write-Text $p ($obj | ConvertTo-Json -Depth 20)
        Ok $lf.rel
    }
}

# ---------------------------------------------------------------- 8. cordis

Step 'Checking cordis.patch.yml'

$cpPath = Join-Path $profileDir 'cordis.patch.yml'
$hasInsert = $false
if (Test-Path $cpPath) {
    $cp = Read-Text $cpPath
    if ($cp -match '(?m)^\s*-\s*id:\s*dsh-purge\s*$') { $hasInsert = $true }
}
if ($hasInsert) {
    Ok 'dsh-purge insert already present'
} else {
    if ($DryRun) {
        Info 'would append an `id: dsh-purge` insert entry'
    } else {
        $entry = "`n- id: dsh-purge`n  config:`n    enabled: true`n"
        $cur = if (Test-Path $cpPath) { Read-Text $cpPath } else { "[]`n" }
        if ($cur.Trim() -eq '[]') {
            Write-Text $cpPath ($entry.TrimStart() + "`n")
        } else {
            Write-Text $cpPath ($cur.TrimEnd() + $entry)
        }
        Ok 'appended the insert entry'
    }
}

# ---------------------------------------------------------------- 9. verify files

Step 'Verifying the installed files'

if ($DryRun) {
    Info 'would verify package.json / lib/core.js / lib/index.js / client.js / cordis.patch.yml'
    Info 'would warn if lib/default-prompt-inject*.md ended up in the package'
} else {
    $mustExist = @(
        'package.json',
        'lib\core.js',
        'lib\index.js',
        'client.js',
        'cordis.patch.yml'
    )
    $missing = @()
    foreach ($m in $mustExist) {
        if (-not (Test-Path (Join-Path $pluginDir $m))) { $missing += $m }
    }
    if ($missing.Count -gt 0) {
        Die ('installed plugin is incomplete, missing: ' + ($missing -join ', '))
    }
    Ok ('dsh-purge ' + $verInTarball + ' in place')

    $leak = @()
    foreach ($pf in @('lib\default-prompt-inject.md','lib\default-prompt-inject.zh.md','lib\default-prompt-inject.en.md')) {
        if (Test-Path (Join-Path $pluginDir $pf)) { $leak += $pf }
    }
    if ($leak.Count -gt 0) { Warn ('prompt plaintext present in the package: ' + ($leak -join ', ')) }
}

# ---------------------------------------------------------------- 10. restart

Step 'Starting the host'

if ($NoRestart) {
    Info 'skipped (-NoRestart)'
} elseif ($DryRun) {
    Info 'would start DeepSeek Harness'
} else {
    $exeCandidates = @(
        'F:\DeepSeek Harness\DeepSeek Harness.exe',
        'D:\DeepSeek Harness\DeepSeek Harness.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
        (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')
    )
    $exe = $exeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) {
        Warn 'host executable not found - start DeepSeek Harness manually'
    } else {
        $taskName = 'dsh-purge-install-start'
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        $action    = New-ScheduledTaskAction -Execute $exe
        $principal = New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
        Start-Sleep -Seconds 2
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 10
        Ok ('host started: ' + $exe)
    }
}

# ---------------------------------------------------------------- 11. status

Step 'Reading the plugin status'

if ($DryRun -or $NoRestart) {
    Info 'skipped'
} else {
    $port = $null
    for ($i = 0; $i -lt 20; $i++) {
        $h = Get-HostProcesses | Where-Object { $_.CommandLine -like '*desktop-host*' } | Select-Object -First 1
        if ($h) {
            & netstat -ano 2>$null | Select-String 'LISTENING' | ForEach-Object {
                $parts = ($_ -replace '\s+', ' ').Trim() -split ' '
                if ($parts[-1] -eq [string]$h.ProcessId) { $port = ($parts[1] -split ':')[-1] }
            }
        }
        if ($port) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $port) {
        Warn 'host is not listening yet - check the panel manually'
    } else {
        try {
            $status = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/dsh-purge/status') -UseBasicParsing -TimeoutSec 30
            $s = $status.Content | ConvertFrom-Json
            Ok ('plugin ' + $s.plugin_version + '   patches ' + $s.patches_applied + '/' + $s.patches_total)
            Info 'open the panel and press Apply to write the host patches'
        } catch {
            Warn ('status API not ready: ' + $_.Exception.Message)
        }
    }
}

# ---------------------------------------------------------------- done

Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
if (-not $DryRun) {
    Write-Host ('  Backup: ' + $bakDir) -ForegroundColor DarkGray
    Write-Host '  Next:   open DeepSeek Harness, click dsh-purge, then Apply.' -ForegroundColor DarkGray
}
Write-Host ''
