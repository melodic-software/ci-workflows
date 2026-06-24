#Requires -Version 7.4
<#
.SYNOPSIS
    Run PSScriptAnalyzer over PowerShell files with per-file subprocess isolation.

.DESCRIPTION
    Lints .ps1/.psm1 files against a PSScriptAnalyzerSettings.psd1 ruleset. Each
    file is analyzed in a fresh pwsh subprocess to sidestep an intermittent
    NullReferenceException in PSScriptAnalyzer's CommandInfoCache that surfaces
    when many files are analyzed in one process (PSScriptAnalyzer issue #1708).

    File discovery uses Get-ChildItem -Force so dot-prefixed directories (for
    example .github) are not silently skipped by Linux pwsh.

.PARAMETER Path
    Files and/or directories to analyze. Directories are searched recursively.
    Defaults to the current directory.

.PARAMETER Settings
    Path to the PSScriptAnalyzerSettings.psd1 ruleset. The consumer supplies its
    own copied ruleset; callers pass -Settings explicitly. The fallback default
    only resolves if a ruleset sits next to this script.

.PARAMETER AnalyzerVersion
    Required minimum PSScriptAnalyzer version. Default 1.25.0, which resolves an
    Import-Module assembly-version mismatch on newer pwsh 7.4.x
    (PSScriptAnalyzer issue #2106 / PR #2107).

.PARAMETER ExcludePath
    Path substrings to skip (matched against forward-slash-normalized full
    paths). The .git directory is always skipped.

.PARAMETER FailOnNoFiles
    When set, exit 1 if no .ps1/.psm1 files are found, instead of exit 0. A
    tripwire for sparse-checkout/path mistakes that would otherwise pass the
    gate on zero files. Only takes effect when the analyzer is installed.

.OUTPUTS
    Exit 0: no findings (or PSScriptAnalyzer not installed — see note below),
            or no files to analyze when -FailOnNoFiles is not set.
    Exit 1: findings present (printed to the host), or no files found when
            -FailOnNoFiles is set.
    Exit 2: configuration error, a non-transient analysis failure, or the
            transient PSScriptAnalyzer #1708 race that reproduced on every retry.

.NOTES
    PSScriptAnalyzer #1708: the UseCorrectCasing rule reads CommandInfo.Parameters
    off the pipeline thread, hitting an intermittent PowerShell runspace-affinity
    crash (NullReferenceException / InvalidOperationException). It is unfixed
    upstream through 1.25.0 and is intra-rule, so per-file subprocess isolation
    cannot fully clear it. Each per-file child classifies that exact transient
    signature (an ErrorRecord with FullyQualifiedErrorId 'RULE_ERROR*' carrying
    one of those exception types) as exit 3 and the parent retries it on a fresh
    subprocess up to a bounded count, then hard-fails — never masking it. Findings
    (success stream) and crashes (error stream) are disjoint, so the retry can
    never reclassify or drop a real finding.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string[]]$Path = @('.'),
    [string]$Settings = (Join-Path $PSScriptRoot 'PSScriptAnalyzerSettings.psd1'),
    [string]$AnalyzerVersion = '1.25.0',
    [string[]]$ExcludePath = @(),
    [switch]$FailOnNoFiles
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Test-PathExcluded {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string]$FullPath,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$Patterns
    )

    $normalized = $FullPath -replace '\\', '/'
    if ($normalized -match '/\.git/') {
        return $true
    }
    foreach ($pattern in $Patterns) {
        $needle = ($pattern -replace '\\', '/').Trim('/')
        if ($needle -and $normalized -like "*$needle*") {
            return $true
        }
    }
    return $false
}

# Self-skip when the analyzer is unavailable (a contributor box without it).
# CI is the authoritative gate; a missing analyzer must not hard-fail local hooks.
$module = Get-Module -ListAvailable -Name PSScriptAnalyzer |
    Where-Object { $_.Version -ge [version]$AnalyzerVersion } |
    Select-Object -First 1
if (-not $module) {
    Write-Warning "PSScriptAnalyzer >= $AnalyzerVersion not installed — skipping (CI is the authoritative gate)."
    exit 0
}

if (-not (Test-Path -LiteralPath $Settings)) {
    # Non-terminating so the exit-2 contract holds under $ErrorActionPreference='Stop'.
    Write-Error "Settings file not found: $Settings" -ErrorAction Continue
    exit 2
}

# -Force so dot-prefixed directories (.github, etc.) are descended on Linux pwsh.
$files = [System.Collections.Generic.List[string]]::new()
foreach ($entry in $Path) {
    if (Test-Path -LiteralPath $entry -PathType Leaf) {
        $resolved = (Resolve-Path -LiteralPath $entry).Path
        $ext = [System.IO.Path]::GetExtension($resolved)
        # Filter leaf inputs by extension too — a hook may pass a mixed file list.
        if (($ext -in '.ps1', '.psm1') -and -not (Test-PathExcluded -FullPath $resolved -Patterns $ExcludePath)) {
            $files.Add($resolved)
        }
    } elseif (Test-Path -LiteralPath $entry -PathType Container) {
        Get-ChildItem -LiteralPath $entry -Recurse -Force -File |
            Where-Object { $_.Extension -in '.ps1', '.psm1' } |
            ForEach-Object {
                if (-not (Test-PathExcluded -FullPath $_.FullName -Patterns $ExcludePath)) {
                    $files.Add($_.FullName)
                }
            }
    } else {
        Write-Error "Path not found: $entry" -ErrorAction Continue
        exit 2
    }
}

if ($files.Count -eq 0) {
    if ($FailOnNoFiles) {
        # Non-terminating so the exit-1 contract holds under $ErrorActionPreference='Stop'.
        Write-Error 'No .ps1/.psm1 files matched, but -FailOnNoFiles is set.' -ErrorAction Continue
        exit 1
    }
    Write-Output 'No .ps1/.psm1 files to analyze.'
    exit 0
}

$findingCount = 0
# Bounded retry for the transient #1708 race (see .NOTES). The race is
# intermittent and intra-rule; a fresh subprocess almost always clears it. Only
# the exact transient signature (child exit 3) is retried — real failures fail
# fast, and exhausting the budget hard-fails so a persistent crash is exposed.
# Retries cost nothing unless a crash actually occurs. The measured per-attempt
# rate on a cmdlet-heavy file is ~12%, so 8 attempts leave a < 1-in-a-million
# residual even at a pessimistic CI rate, while a deterministic crash still fails.
$maxAttempts = 8
# If a runner enables the PSNativeCommandUseErrorActionPreference experimental
# feature, a non-zero child exit would throw under ErrorActionPreference=Stop
# before $LASTEXITCODE is read. Opt out so the exit code is always captured.
$PSNativeCommandUseErrorActionPreference = $false
foreach ($file in $files) {
    $env:PSSA_FILE = $file
    $env:PSSA_SETTINGS = $Settings
    $env:PSSA_VERSION = $AnalyzerVersion
    $output = $null
    $childExit = -1
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        # Single-quoted here-string: variables expand in the child from its
        # inherited environment, not here. The child classifies its own outcome
        # off the error stream: 0 clean, 1 findings, 2 real error, 3 transient.
        $output = pwsh -NoProfile -NonInteractive -Command @'
try {
    Import-Module PSScriptAnalyzer -MinimumVersion $env:PSSA_VERSION -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine("Import-Module failed: $($_.Exception.Message)")
    exit 2
}
$errs = $null
$params = @{
    Path          = $env:PSSA_FILE
    Settings      = $env:PSSA_SETTINGS
    ErrorVariable = 'errs'
    ErrorAction   = 'SilentlyContinue'
}
try {
    $findings = Invoke-ScriptAnalyzer @params
} catch [System.NullReferenceException] {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 3
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 2
}
# A rule that throws surfaces as a non-terminating ErrorRecord with
# FullyQualifiedErrorId 'RULE_ERROR'. The #1708 affinity family throws
# NullReference/InvalidOperation there; treat only that exact pairing as
# transient. Any other error record is a real failure (parse error, bad
# settings, ...). Findings are on a separate stream and are never inspected here.
$transient = @($errs | Where-Object {
        $_.FullyQualifiedErrorId -like 'RULE_ERROR*' -and
        ($_.Exception -is [System.NullReferenceException] -or $_.Exception -is [System.InvalidOperationException])
    })
$real = @($errs | Where-Object { $transient -notcontains $_ })
if ($real.Count -gt 0) {
    $real | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }
    exit 2
}
# A transient crash means the analysis was incomplete (the crashed rule did not
# run), so discard any partial findings and signal a retry rather than trust them.
if ($transient.Count -gt 0) {
    [Console]::Error.WriteLine($transient[0].Exception.ToString())
    exit 3
}
$findings | ForEach-Object { '{0}:{1}:{2} {3} [{4}]' -f $_.ScriptName, $_.Line, $_.Column, $_.Message, $_.RuleName }
if (@($findings).Count -gt 0) { exit 1 } else { exit 0 }
'@
        $childExit = $LASTEXITCODE
        if ($childExit -ne 3) { break }
        Write-Warning "PSSA #1708 transient race on ${file} (attempt $attempt/$maxAttempts); retrying."
    }
    if ($childExit -eq 3) {
        $msg = 'PSScriptAnalyzer: the transient #1708 race reproduced on all ' +
        "$maxAttempts attempts for ${file} (stack above); failing rather than masking it."
        Write-Error $msg -ErrorAction Continue
        exit 2
    }
    if ($childExit -ne 0 -and $childExit -ne 1) {
        Write-Error "PSSA subprocess failed for ${file} (exit $childExit; see stack above)." -ErrorAction Continue
        exit 2
    }
    if ($output) {
        $output | ForEach-Object { Write-Output $_ }
        $findingCount += @($output).Count
    }
}

if ($findingCount -gt 0) {
    Write-Output ''
    Write-Output "PSScriptAnalyzer: $findingCount finding(s) across $($files.Count) file(s)."
    exit 1
}

Write-Output "PSScriptAnalyzer: clean across $($files.Count) file(s)."
exit 0
