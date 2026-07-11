#Requires -Version 7.4
<#
.SYNOPSIS
    Run PSScriptAnalyzer over PowerShell files with fail-closed error handling.

.DESCRIPTION
    Lints .ps1/.psm1 files exactly once against a
    PSScriptAnalyzerSettings.psd1 ruleset. Findings and analyzer/engine errors
    are separate failure classes; neither is retried or suppressed.

    With no -Path, discovery is git-tracked: only *.ps1/*.psm1 files tracked by
    git are analyzed, so ignored or generated scripts in a dirty tree are never
    gated. When -Path is given, each directory is walked with Get-ChildItem
    -Force (a raw filesystem walk that does not consult .gitignore) so
    dot-prefixed directories (for example .github) are not silently skipped by
    Linux pwsh.

.PARAMETER Path
    Files and/or directories to analyze. Directories are searched recursively.
    Empty (the default) runs git-tracked discovery over the whole repo; pass
    explicit paths to opt into a raw filesystem walk of exactly those paths.

.PARAMETER Settings
    Path to the caller's PSScriptAnalyzerSettings.psd1 ruleset. Callers pass
    -Settings explicitly. The fallback default only resolves if a ruleset sits
    next to this script.

.PARAMETER AnalyzerVersion
    Required exact PSScriptAnalyzer version. Default 1.25.0, which resolves an
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
    Exit 2: configuration or analyzer/engine failure.

.NOTES
    Upstream issue #1708 makes PSUseCorrectCasing intermittently crash the
    analyzer. Policy owners should leave that rule disabled until an official
    release fixes it. This runner treats every rule/engine error as a failed
    analysis instead of maintaining a second retry implementation.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string[]]$Path = @(),
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
    Where-Object { $_.Version -eq [version]$AnalyzerVersion } |
    Select-Object -First 1
if (-not $module) {
    Write-Warning "PSScriptAnalyzer $AnalyzerVersion not installed — skipping (CI is the authoritative gate)."
    exit 0
}

if (-not (Test-Path -LiteralPath $Settings)) {
    # Non-terminating so the exit-2 contract holds under $ErrorActionPreference='Stop'.
    Write-Error "Settings file not found: $Settings" -ErrorAction Continue
    exit 2
}

$files = [System.Collections.Generic.List[string]]::new()
if ($Path.Count -eq 0) {
    # Git-tracked discovery (default): only tracked *.ps1/*.psm1, so ignored or
    # generated scripts in a dirty tree are never gated. Filter to on-disk files
    # so a sparse checkout (skip-worktree entries absent) is handled cleanly.
    # NUL-delimited with quoting disabled so paths with non-ASCII/special bytes
    # (which git C-quotes by default) and embedded newlines survive — mirrors the
    # check-exec-bit.sh discovery idiom. PowerShell may split native stdout on
    # newline, so reassemble and split on the NUL separator.
    $raw = & git -c core.quotePath=false ls-files -z -- '*.ps1' '*.psm1'
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'git ls-files failed — not a git checkout?' -ErrorAction Continue
        exit 2
    }
    $tracked = ($raw -join "`n") -split "`0" | Where-Object { $_ }
    foreach ($rel in $tracked) {
        if (-not (Test-Path -LiteralPath $rel -PathType Leaf)) { continue }
        $resolved = (Resolve-Path -LiteralPath $rel).Path
        if (-not (Test-PathExcluded -FullPath $resolved -Patterns $ExcludePath)) {
            $files.Add($resolved)
        }
    }
} else {
    # -Force so dot-prefixed directories (.github, etc.) are descended on Linux pwsh.
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
try {
    Import-Module PSScriptAnalyzer -RequiredVersion $AnalyzerVersion -ErrorAction Stop
} catch {
    Write-Error "Import-Module failed: $($_.Exception.Message)" -ErrorAction Continue
    exit 2
}

foreach ($file in $files) {
    $analysisErrors = @()
    $params = @{
        Path          = $file
        Settings      = $Settings
        ErrorVariable = 'analysisErrors'
        ErrorAction   = 'SilentlyContinue'
    }
    try {
        $findings = @(Invoke-ScriptAnalyzer @params)
    } catch {
        Write-Error "PSScriptAnalyzer failed for ${file}: $($_.Exception.Message)" -ErrorAction Continue
        exit 2
    }
    if ($analysisErrors) {
        $analysisErrors | ForEach-Object {
            Write-Output "PSScriptAnalyzer error for ${file}: $($_.Exception.Message)"
        }
        exit 2
    }
    $findings | ForEach-Object {
        Write-Output ('{0}:{1}:{2} {3} [{4}]' -f $_.ScriptName, $_.Line, $_.Column, $_.Message, $_.RuleName)
    }
    $findingCount += $findings.Count
}

if ($findingCount -gt 0) {
    Write-Output ''
    Write-Output "PSScriptAnalyzer: $findingCount finding(s) across $($files.Count) file(s)."
    exit 1
}

Write-Output "PSScriptAnalyzer: clean across $($files.Count) file(s)."
exit 0
