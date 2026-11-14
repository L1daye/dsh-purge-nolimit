# check-runtime.ps1
#
# 报告 DSH 宿主自带的 Node / pnpm 位置与版本，以及 PATH 可见性。
#
# dsh-purge 的安装脚本是"直接复制文件"，不依赖包管理器；
# 但如果你想走 `dsh plugin add` 受管路线，或者跑自定义脚本，
# 就需要知道宿主 runtime 在哪。
#
# 用法：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File check-runtime.ps1
#   pwsh ... -InstallRoot "D:\DeepSeek Harness"

param(
    [string]$InstallRoot = ""
)

$ErrorActionPreference = 'Continue'

function Say($m) { Write-Output $m }
function Ok($m) { Write-Output ('  [OK]   ' + $m) }
function Warn($m) { Write-Output ('  [WARN] ' + $m) }
function Info($m) { Write-Output ('         ' + $m) }

Say '=== DSH Runtime 自检 ==='
Say ''

# ── 1. 定位安装根目录 ──
if (-not $InstallRoot) {
    $cands = @(
        'D:\DeepSeek Harness',
        'F:\DeepSeek Harness',
        'C:\Program Files\DeepSeek Harness',
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek-Harness')
    )
    foreach ($c in $cands) {
        if (Test-Path (Join-Path $c 'DeepSeek Harness.exe')) { $InstallRoot = $c; break }
    }
}
if (-not $InstallRoot -or -not (Test-Path $InstallRoot)) {
    Warn '找不到 DSH 安装目录，请用 -InstallRoot 指定'
    exit 1
}
Say ('安装目录 : ' + $InstallRoot)

$rt = Join-Path $InstallRoot 'resources\runtime\primary-runtime'
Say ('运行时目录: ' + $rt)
Say ''

# ── 2. 宿主自带的 node ──
Say '=== Node ==='
$nodeCands = @(
    (Join-Path $rt 'dependencies\node\bin\node.exe'),
    (Join-Path $rt 'node.exe'),
    (Join-Path $InstallRoot 'resources\runtime\node.exe')
)
$nodePath = $null
foreach ($c in $nodeCands) {
    if (Test-Path $c) { $nodePath = $c; break }
}
if ($nodePath) {
    $v = (& $nodePath --version 2>&1) -join ' '
    Ok ('宿主自带: ' + $v.Trim() + '  ' + $nodePath)
    $major = 0
    if ($v -match 'v(\d+)\.') { $major = [int]$matches[1] }
    if ($major -ge 22) { Ok ('主版本 ' + $major + ' >= 22，满足 DSH 要求') }
    else { Warn ('主版本 ' + $major + ' < 22，可能不满足 DSH 要求') }
} else {
    Warn '宿主目录里没找到 node.exe'
    Info ('查过: ' + ($nodeCands -join ', '))
}

$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode) {
    $pv = (& $pathNode.Source --version 2>&1) -join ' '
    Ok ('PATH 里的 node: ' + $pv.Trim() + '  ' + $pathNode.Source)
} else {
    Info 'PATH 里没有 node（走宿主自带即可）'
}

Say ''

# ── 3. 宿主自带的 pnpm ──
Say '=== pnpm ==='
$pnpmCands = @(
    (Join-Path $rt 'dependencies\pnpm\bin\pnpm.mjs'),
    (Join-Path $rt 'dependencies\pnpm\pnpm.cjs')
)
$pnpmPath = $null
foreach ($c in $pnpmCands) {
    if (Test-Path $c) { $pnpmPath = $c; break }
}
if ($pnpmPath -and $nodePath) {
    Ok ('宿主自带: ' + $pnpmPath)
    try {
        $out = (& $nodePath $pnpmPath --version 2>&1) -join ' '
        Ok ('版本: ' + $out.Trim())
    } catch {
        Warn ('跑不起来: ' + $_.Exception.Message)
    }
} elseif ($pnpmPath) {
    Ok ('存在但缺 node 无法验证: ' + $pnpmPath)
} else {
    Warn '宿主目录里没找到 pnpm'
    Info ('查过: ' + ($pnpmCands -join ', '))
}

$pathPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pathPnpm) {
    Ok ('PATH 里的 pnpm: ' + $pathPnpm.Source)
} else {
    Info 'PATH 里没有 pnpm（走宿主自带即可）'
}

Say ''

# ── 4. 直接用宿主 node+pnpm 的等价命令 ──
Say '=== 想走 dsh plugin 受管路线时用这个 ==='
if ($nodePath -and $pnpmPath) {
    Say ''
    Say ('  $node = "' + $nodePath + '"')
    Say ('  $pnpm = "' + $pnpmPath + '"')
    Say '  Set-Location "$env:USERPROFILE\.dsh\profiles\desktop"'
    Say '  & $node $pnpm add "file:<包路径>"'
    Say '  & $node $pnpm approve-builds --all'
} else {
    Warn 'node 或 pnpm 缺失，无法给出命令'
}

Say ''
Say '=== 完成 ==='
Say ''
Say '注：dsh-purge 的 install-optional-plugins.ps1 和 install-redteam-tools.ps1'
Say '    都是直接复制文件，不经过包管理器，所以上面的缺失不影响它们。'
