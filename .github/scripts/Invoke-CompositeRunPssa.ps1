#Requires -Version 7.4
<#
.SYNOPSIS
    Run PSScriptAnalyzer over the PowerShell embedded in composite action `run:` blocks.

.DESCRIPTION
    No existing lane sees that PowerShell. actionlint reads workflows only, the
    `powershell` lane discovers *.ps1/*.psm1, and composite-run-shellcheck.sh —
    this check's bash/sh sibling — announces every pwsh block as skipped rather
    than analyzing it.

    This extracts each pwsh/powershell `run:` block and hands it to the repo's
    single PSScriptAnalyzer runner under the same contract that sibling applies
    to bash/sh: expression substitution, line-number mapping, and guards that
    stop a selector matching nothing from passing as a clean scan.

    Analysis itself is delegated to .github/actions/powershell/Invoke-Pssa.ps1
    so the repo keeps one analyzer invocation and one pinned version, read here
    from the `powershell` action's own `analyzer-version` default.

.PARAMETER Path
    Composite action metadata files to check, each a repo-relative path. Empty
    (the default) checks every tracked .github/actions/*/action.yml.

.PARAMETER AnalyzerVersion
    Required exact PSScriptAnalyzer version. Defaults to the `powershell`
    action's `analyzer-version` input default, so the pin has one home.

.OUTPUTS
    Exit 0: every extracted block is clean.
    Exit 1: findings present, or a guard proved the scan was not what it claimed.
    Exit 2: configuration, extraction, or analyzer/engine failure.

.NOTES
    Run from the repository root. Requires yq (mikefarah, preinstalled on
    ubuntu-24.04) — the same exception composite-run-shellcheck.sh takes — and
    PSScriptAnalyzer on the module path, which the `powershell` action installs
    for the CI lane this runs in.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments)]
    [string[]]$Path = @(),

    [string]$AnalyzerVersion
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$actionMetadata = '.github/actions/powershell/action.yml'
$runner = '.github/actions/powershell/Invoke-Pssa.ps1'
$settings = 'PSScriptAnalyzerSettings.psd1'

function Write-Annotation {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string]$Message,

        [string]$File
    )

    $scope = if ($File) { "error file=$File" } else { 'error' }
    Write-Output "::${scope}::Invoke-CompositeRunPssa: $Message"
}

function Invoke-Yq {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [string]$Expression,

        [Parameter(Mandatory)]
        [string]$File
    )

    $output = [string[]]@(& yq -r $Expression $File)
    if ($LASTEXITCODE -ne 0) {
        Write-Annotation -File $File -Message "yq could not read $File."
        exit 2
    }
    # PowerShell unwraps a one-element array on return, so callers that index a
    # result re-wrap it with @().
    return $output
}

function ConvertTo-SanitizedScript {
    <#
        GitHub expands `${{ }}` before the runner writes the step script, so a
        raw block is not valid PowerShell on its own — `${` opens a braced
        variable name, and the unbalanced braces are a parse error that would
        mask every real finding behind it. Each expression becomes an
        equal-width run of underscores, mirroring actionlint's
        sanitizeExpressionsInScript: same width keeps reported columns aligned,
        and underscores (rather than blanks) keep the token whole where the
        expression stands in for a value. Newlines inside an expression are
        preserved rather than filled, so an expression spanning lines does not
        shift the line numbers of everything after it. An unterminated `${{` is
        left intact to be reported rather than silently mangled.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Script
    )

    $builder = [System.Text.StringBuilder]::new()
    $cursor = 0
    while ($true) {
        $start = $Script.IndexOf('${{', $cursor, [StringComparison]::Ordinal)
        if ($start -lt 0) {
            break
        }
        $close = $Script.IndexOf('}}', $start, [StringComparison]::Ordinal)
        if ($close -lt 0) {
            break
        }
        $expression = $Script.Substring($start, $close + 2 - $start)
        [void]$builder.Append($Script.Substring($cursor, $start - $cursor))
        [void]$builder.Append([regex]::Replace($expression, '[^\r\n]', '_'))
        $cursor = $close + 2
    }
    [void]$builder.Append($Script.Substring($cursor))
    return $builder.ToString()
}

if (-not $AnalyzerVersion) {
    if (-not (Test-Path -LiteralPath $actionMetadata -PathType Leaf)) {
        Write-Annotation -Message "$actionMetadata not found — run from the repository root."
        exit 2
    }
    $AnalyzerVersion = @(Invoke-Yq -Expression '.inputs."analyzer-version".default' -File $actionMetadata)[0]
    if (-not $AnalyzerVersion -or $AnalyzerVersion -eq 'null') {
        Write-Annotation -File $actionMetadata -Message 'analyzer-version has no default to pin against.'
        exit 2
    }
}

# Invoke-Pssa.ps1 self-skips with exit 0 when the pinned analyzer is absent, so
# a contributor box without it still gets working hooks. Delegating to that
# under CI would turn a missing module into a green gate that analyzed nothing,
# so this check requires what it self-skips on.
$module = Get-Module -ListAvailable -Name PSScriptAnalyzer |
    Where-Object { $_.Version -eq [version]$AnalyzerVersion } |
    Select-Object -First 1
if (-not $module) {
    Write-Annotation -Message ("PSScriptAnalyzer $AnalyzerVersion is not installed; " +
        "$runner would self-skip and pass this check on zero analysis.")
    exit 2
}

$files = @($Path)
if ($files.Count -eq 0) {
    # NUL-delimited with quoting disabled so paths with non-ASCII bytes or
    # embedded newlines survive — the discovery idiom Invoke-Pssa.ps1 uses.
    $raw = & git -c core.quotePath=false ls-files -z -- '.github/actions/*/action.yml'
    if ($LASTEXITCODE -ne 0) {
        Write-Annotation -Message 'git ls-files failed — not a git checkout?'
        exit 2
    }
    $files = @(($raw -join "`n") -split "`0" | Where-Object { $_ })
}
if ($files.Count -eq 0) {
    Write-Annotation -Message 'no composite action metadata files to check.'
    exit 1
}

# Each path is reused verbatim as the extracted script's location under the temp
# workdir, so a rooted path escapes to the real filesystem root and a `..` one
# resolves outside the workdir entirely, past the cleanup below. A leading `-`
# would reach yq as a flag rather than a file. git ls-files only ever yields the
# safe form; this guards the documented explicit-argument form.
foreach ($file in $files) {
    $reason = if (-not $file) {
        'empty'
    } elseif ([System.IO.Path]::IsPathRooted($file)) {
        'an absolute path'
    } elseif (($file -split '[\\/]') -contains '..') {
        'a path with a ".." component'
    } elseif ($file.StartsWith('-')) {
        'a path starting with "-"'
    } elseif (-not (Split-Path -Path $file -Parent)) {
        # The extracted script is named after the action's own directory, which
        # a bare filename does not have.
        'not inside an action directory'
    } else {
        $null
    }
    if ($reason) {
        Write-Annotation -Message ("'$file' is $reason; each argument must be a repo-relative path" +
            ' — run from the repository root.')
        exit 1
    }
}

$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$workdir = Join-Path $temp "composite-run-pssa-$([guid]::NewGuid())"
$null = New-Item -ItemType Directory -Path $workdir -Force

try {
    # Keyed by the leaf PSScriptAnalyzer will report, so it doubles as the
    # collision guard below and the count of what was extracted.
    $leaves = @{}

    foreach ($file in $files) {
        # Announced for every file discovery reaches, before any shape check can
        # skip it, so the coverage floor can tell "discovery missed this action"
        # from "this action has no PowerShell to check". A composite whose steps
        # are all `uses:` is legitimate and emits no step line of its own.
        Write-Output "visit $file"

        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            Write-Annotation -Message "$file does not exist."
            exit 2
        }

        $using = @(Invoke-Yq -Expression '.runs.using // ""' -File $file)[0]
        if ($using -ne 'composite') {
            $shown = if ($using) { $using } else { '<unset>' }
            Write-Output "skip ${file}: runs.using is $shown, not composite"
            continue
        }

        # Counted with an expression independent of the extraction query below,
        # so a selector that silently matches nothing is caught rather than
        # passing as a zero-block success — the false green this check exists to
        # prevent.
        $expectedQuery = '[.runs.steps[] | select(has("run"))' +
        ' | select((.shell // "") | test("^(pwsh|powershell)( |$)"))] | length'
        $expected = [int]@(Invoke-Yq -Expression $expectedQuery -File $file)[0]
        $produced = 0

        # `line` and `style` together locate the block body in the source: a
        # literal or folded scalar starts on the line after its `run:` key, a
        # plain or quoted one starts on the key's own line.
        $entryQuery = '.runs.steps | to_entries[] | select(.value | has("run"))' +
        ' | (.key | tostring) + "\t" + (.value.shell // "") + "\t"' +
        ' + (.value.run | line | tostring) + "\t" + (.value.run | style)'
        foreach ($entry in (Invoke-Yq -Expression $entryQuery -File $file)) {
            if (-not $entry) {
                continue
            }
            $index, $shell, $keyLine, $style = $entry -split "`t", 4

            # `.key` is a sequence index only while `runs.steps` is a sequence.
            # A mapping makes it an arbitrary author-supplied string, and this
            # runs against pull-request content, so reject the shape at the
            # boundary rather than escaping it at each use: the key reaches both
            # a write path and an interpolated yq expression below.
            if ($index -notmatch '^\d+$') {
                Write-Annotation -File $file -Message "runs.steps is not a sequence (key '$index')."
                exit 1
            }

            # GitHub's custom-shell form is `command [...options] {0}`, and the
            # dialect is the leading command word. Matching only the bare names
            # would leave a block GitHub runs with pwsh unanalyzed while the job
            # stayed green — the coverage hole this check exists to close.
            # `powershell` is Windows PowerShell 5.1; it is analyzed under the
            # same 7.4-targeted ruleset because an unanalyzed block is the worse
            # outcome, and this repo has none.
            if (-not $shell) {
                Write-Annotation -File $file -Message ("runs.steps[$index] has a run: block with no shell:;" +
                    ' refusing to guess the dialect.')
                exit 1
            }
            if ($shell -cnotmatch '^(pwsh|powershell)( |$)') {
                Write-Output "skip $file runs.steps[${index}]: shell is $shell, not pwsh/powershell"
                continue
            }
            $dialect = ($shell -split ' ', 2)[0]

            $body = (Invoke-Yq -Expression ".runs.steps[$index].run" -File $file) -join "`n"

            # Pad to the block's own offset so a reported line number is the
            # line in the source metadata, not an offset into an extract. The
            # body is dedented by the YAML parse, so columns are shifted left by
            # the block's indentation; lines are exact.
            $bodyLine = if ($style -in 'literal', 'folded') { [int]$keyLine + 1 } else { [int]$keyLine }
            $content = ("`n" * ($bodyLine - 1)) + (ConvertTo-SanitizedScript -Script $body)

            # PSScriptAnalyzer reports the file's leaf name only, so a leaf that
            # repeats would make a finding ambiguous about which action it came
            # from. The action's own directory name is what distinguishes them.
            $leaf = '{0}.step-{1}.ps1' -f (Split-Path -Path (Split-Path -Path $file -Parent) -Leaf), $index
            if ($leaves.ContainsKey($leaf)) {
                Write-Annotation -File $file -Message ("runs.steps[$index] and $($leaves[$leaf]) both report" +
                    " as '$leaf'; findings would be ambiguous.")
                exit 2
            }
            $leaves[$leaf] = "$file runs.steps[$index]"

            $destination = Join-Path $workdir (Join-Path (Split-Path -Path $file -Parent) $leaf)
            $null = New-Item -ItemType Directory -Path (Split-Path -Path $destination -Parent) -Force
            Set-Content -LiteralPath $destination -Value $content -NoNewline

            $produced++
            Write-Output "check $file runs.steps[$index] (shell: $dialect) as $leaf"
        }

        if ($produced -ne $expected) {
            Write-Annotation -File $file -Message "extracted $produced of $expected pwsh/powershell run: block(s)."
            exit 1
        }
    }

    if ($leaves.Count -eq 0) {
        Write-Annotation -Message ('no pwsh/powershell run: block was extracted;' +
            ' the file set or the extraction is wrong.')
        exit 1
    }

    Write-Output ''
    Write-Output ("Analyzing $($leaves.Count) embedded run: block(s); a reported line is the line" +
        ' in the action.yml it was extracted from.')

    # -FailOnNoFiles turns a workdir the runner cannot see into a failure rather
    # than the clean-on-zero-files pass it defaults to.
    & $runner -Path $workdir -Settings $settings -FailOnNoFiles -AnalyzerVersion $AnalyzerVersion
    exit $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $workdir -Recurse -Force -ErrorAction SilentlyContinue
}
