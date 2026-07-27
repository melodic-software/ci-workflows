#Requires -Version 7.4
<#
.SYNOPSIS
    Pin the properties a green Invoke-CompositeRunPssa run cannot prove on its own.

.DESCRIPTION
    Proves that a broken `run:` block fails the check, that a reported line is
    the line in the source metadata, that the expression substitution actually
    runs, that a step PSScriptAnalyzer cannot read is announced, that every
    shell shape GitHub runs with PowerShell is analyzed rather than skipped,
    that every tracked composite is reached — including one carrying no shell at
    all — that a malformed `runs.steps` shape is refused rather than extracted
    from, that a file set yielding no block fails rather than passing empty, and
    that a missing analyzer fails instead of self-skipping to green. Without
    these, a selector matching nothing — or nearly nothing — is
    indistinguishable from a clean scan.

.NOTES
    Run from the repository root. Exits 1 on the first failed assertion.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$check = '.github/scripts/Invoke-CompositeRunPssa.ps1'
$badFixture = 'fixtures/composite-action/pwsh-bad/action.yml'
$customFixture = 'fixtures/composite-action/pwsh-custom-shell/action.yml'
$usesOnlyFixture = 'fixtures/composite-action/uses-only/action.yml'
$mappingFixture = 'fixtures/composite-action/mapping-steps/action.yml'
$noShellFixture = 'fixtures/composite-action/no-shell/action.yml'
$coveredAction = '.github/actions/powershell/action.yml'

function Assert-Condition {
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,

        [Parameter(Mandatory)]
        [string]$Message,

        [string]$Context
    )

    if (-not $Condition) {
        if ($Context) {
            Write-Output $Context
        }
        Write-Output "FAIL: $Message"
        exit 1
    }
}

function Invoke-Check {
    <#
        The check exits rather than returning, so it runs as a child process:
        dot-sourcing it would end this test at the first guard it trips.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [string[]]$Argument = @()
    )

    # Most cases here expect the child to exit non-zero, which is the assertion
    # rather than a fault. Pinned because the default has moved across pwsh
    # releases, and under $ErrorActionPreference = 'Stop' the other setting turns
    # an expected exit code into a terminating error before it can be read.
    $PSNativeCommandUseErrorActionPreference = $false

    $captured = & pwsh -NoProfile -File $check @Argument 2>&1
    $code = $LASTEXITCODE
    $text = (@($captured) | ForEach-Object { $_.ToString() }) -join "`n"
    return @{ Output = $text; ExitCode = $code }
}

function Get-FixtureLine {
    <#
        Reads the expected line out of the fixture instead of hard-coding it, so
        the assertion proves the reported line is that statement's own line
        rather than a constant that happens to agree.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$Pattern
    )

    $lines = @(Get-Content -LiteralPath $Path)
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match $Pattern) {
            return $index + 1
        }
    }
    Write-Output "FAIL: no line in $Path matches $Pattern."
    exit 1
}

$broken = Invoke-Check -Argument @($badFixture, $usesOnlyFixture)
Assert-Condition -Condition ($broken.ExitCode -eq 1) `
    -Message 'The intentionally broken composite pwsh run: block unexpectedly passed.' `
    -Context $broken.Output

# The finding must land on the fixture's own line, not on an offset into the
# extracted script — the whole point of padding the extract to the block offset.
$unusedLine = Get-FixtureLine -Path $badFixture -Pattern '^\s*\$neverRead ='
Assert-Condition -Condition ($broken.Output -match "pwsh-bad\.step-0\.ps1:${unusedLine}:") `
    -Message "The unused-variable finding was not reported at $badFixture line $unusedLine." `
    -Context $broken.Output
Assert-Condition -Condition ($broken.Output.Contains('[PSUseDeclaredVarsMoreThanAssignments]')) `
    -Message 'The planted PSScriptAnalyzer violation was not reported.' `
    -Context $broken.Output

# Substituted, the inline expression collapses to underscores and leaves a
# constant string; left raw it is a variable reference and the constant-string
# rule stays silent. The finding's PRESENCE is therefore what proves the
# substitution ran — an absent parse error would not, since PowerShell parses
# `${{ ... }}` inside a double-quoted string as a braced variable name.
$expressionLine = Get-FixtureLine -Path $badFixture -Pattern '^\s*Write-Output "\$\{\{'
Assert-Condition -Condition ($broken.Output -match "pwsh-bad\.step-0\.ps1:${expressionLine}:.*\[PSAvoid") `
    -Message 'An inline GitHub expression reached PSScriptAnalyzer unsubstituted.' `
    -Context $broken.Output

# A step PSScriptAnalyzer cannot analyse is announced, never silently dropped.
Assert-Condition -Condition ($broken.Output.Contains('shell is bash, not pwsh/powershell')) `
    -Message 'A non-PowerShell step was dropped instead of being announced.' `
    -Context $broken.Output

# A composite whose steps are all `uses:` emits no step line at all, so only the
# visit line keeps it out of the coverage floor's false-negative bucket below.
Assert-Condition -Condition ($broken.Output.Contains("visit $usesOnlyFixture")) `
    -Message "Discovery never announced $usesOnlyFixture." `
    -Context $broken.Output

# `runs.steps` as a mapping makes the step key an author-supplied string that
# would otherwise reach a write path and an interpolated yq expression. The
# shape is refused, not extracted from.
$mapping = Invoke-Check -Argument @($mappingFixture)
Assert-Condition -Condition ($mapping.ExitCode -ne 0) `
    -Message 'A mapping-shaped runs.steps was unexpectedly accepted.' `
    -Context $mapping.Output
Assert-Condition -Condition ($mapping.Output.Contains('runs.steps is not a sequence')) `
    -Message 'The malformed runs.steps shape was not reported.' `
    -Context $mapping.Output

# GitHub's custom-shell form (`command [...options] {0}`) is run with the
# leading command word, so the dialect resolves by prefix; `powershell` is a
# separate keyword GitHub also runs PowerShell with. Matching only `pwsh` would
# leave either unanalyzed while the job stayed green. Asserted as `check` lines,
# not merely as an exit code: the count guard only compares two selectors, so it
# agrees when both are wrong.
$custom = Invoke-Check -Argument @($customFixture)
Assert-Condition -Condition ($custom.ExitCode -eq 0) `
    -Message 'The clean custom-shell fixture unexpectedly failed.' `
    -Context $custom.Output
Assert-Condition -Condition ($custom.Output.Contains('runs.steps[1] (shell: pwsh)')) `
    -Message "GitHub's custom-shell form was not resolved to pwsh." `
    -Context $custom.Output
Assert-Condition -Condition ($custom.Output.Contains('runs.steps[2] (shell: powershell)')) `
    -Message 'The powershell shell keyword was not analyzed.' `
    -Context $custom.Output
$customChecks = @($custom.Output -split "`n" | Where-Object { $_ -like "check $customFixture*" })
Assert-Condition -Condition ($customChecks.Count -eq 3) `
    -Message "Expected exactly three checked blocks in the custom-shell fixture, got $($customChecks.Count)." `
    -Context $custom.Output

# A path is reused verbatim as the extracted script's location under the temp
# workdir, so only a repo-relative one stays inside it: an absolute path writes
# from the filesystem root and a `..` one resolves past the cleanup entirely. A
# leading `-` would reach yq as a flag rather than a file. Purely syntactic, so
# the paths below need not exist.
foreach ($bad in @((Join-Path $PWD $badFixture), '../action.yml', '-action.yml')) {
    $outside = Invoke-Check -Argument @($bad)
    Assert-Condition -Condition ($outside.ExitCode -ne 0) `
        -Message "A path that is not repo-relative was unexpectedly accepted: $bad" `
        -Context $custom.Output
    Assert-Condition -Condition ($outside.Output.Contains('must be a repo-relative path')) `
        -Message "The non-repo-relative path was not reported: $bad" `
        -Context $custom.Output
}

# Coverage floor. The check announces every file discovery reaches, so every
# tracked composite must appear by name: discovery that quietly reaches one
# action instead of all of them is otherwise a clean green. Keyed on the visit
# line rather than a check line so an action carrying no PowerShell still counts
# as reached.
$covered = Invoke-Check
Assert-Condition -Condition ($covered.ExitCode -eq 0) `
    -Message 'The default run over the tracked composites failed.' `
    -Context $covered.Output
# Mirrors the check's own discovery, quoting included, so a path holding a
# non-ASCII byte cannot make this floor disagree with what was actually visited.
$raw = & git -c core.quotePath=false ls-files -z -- '.github/actions/*/action.yml'
foreach ($action in @(($raw -join "`n") -split "`0" | Where-Object { $_ })) {
    Assert-Condition -Condition ($covered.Output.Contains("visit $action")) `
        -Message "Discovery never reached $action." `
        -Context $covered.Output
}

# The issue's first acceptance criterion is about the real action, not the
# fixtures: a visit line fires before any shape check, so on its own it would
# still pass if that action's blocks stopped being extracted. Counted against an
# independent selector so the assertion does not encode a step ordering, and so
# it keeps its power once a second action grows a PowerShell block.
$query = '[.runs.steps[] | select(has("run"))' +
' | select((.shell // "") | test("^(pwsh|powershell)( |$)"))] | length'
$expectedBlocks = [int]@(& yq -r $query $coveredAction)[0]
Assert-Condition -Condition ($expectedBlocks -gt 0) `
    -Message "$coveredAction no longer has a PowerShell run: block for this check to cover."
$coveredChecks = @($covered.Output -split "`n" | Where-Object { $_ -like "check $coveredAction*" })
Assert-Condition -Condition ($coveredChecks.Count -eq $expectedBlocks) `
    -Message "Expected $expectedBlocks analyzed block(s) in $coveredAction, got $($coveredChecks.Count)." `
    -Context $covered.Output

# A run: step with no shell: leaves the dialect unknowable, and GitHub rejects
# the shape outright. Refused rather than guessed at.
$noShell = Invoke-Check -Argument @($noShellFixture)
Assert-Condition -Condition ($noShell.ExitCode -eq 1) `
    -Message 'A run: block with no shell: was unexpectedly accepted.' `
    -Context $noShell.Output
Assert-Condition -Condition ($noShell.Output.Contains('refusing to guess the dialect')) `
    -Message 'The missing shell: was not reported.' `
    -Context $noShell.Output

$empty = Invoke-Check -Argument @('.github/workflows/ci.yml')
Assert-Condition -Condition ($empty.ExitCode -ne 0) `
    -Message 'A file set containing no composite pwsh run: block unexpectedly passed.' `
    -Context $empty.Output
Assert-Condition -Condition ($empty.Output.Contains('no pwsh/powershell run: block was extracted')) `
    -Message 'The empty extraction was not reported.' `
    -Context $empty.Output

# Invoke-Pssa.ps1 self-skips to exit 0 when the pinned analyzer is missing, so
# without this guard an absent module would pass the gate on zero analysis.
$missing = Invoke-Check -Argument @('-AnalyzerVersion', '0.0.1')
Assert-Condition -Condition ($missing.ExitCode -eq 2) `
    -Message 'A missing analyzer did not fail the check.' `
    -Context $missing.Output
Assert-Condition -Condition ($missing.Output.Contains('would self-skip and pass this check on zero analysis')) `
    -Message 'The missing analyzer was not reported as a false-green risk.' `
    -Context $missing.Output

Write-Output 'Invoke-CompositeRunPssa: all assertions passed.'
