[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $TargetPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedLfsSha256 = '962AB05586B24DBC1C300C70385EAD92D59393900FB9240F6D4D5CC949EC1CB2'
$ExpectedPointer = @(
    'version https://git-lfs.github.com/spec/v1'
    'oid sha256:962ab05586b24dbc1c300c70385ead92d59393900fb9240f6d4d5cc949ec1cb2'
    'size 24'
) -join "`n"
$ExpectedRemotePattern = '(?:github\.com[/:])melodic-software/ci-runner-canary(?:\.git)?$'
$SeedFiles = @(
    '.gitattributes'
    '.github/dependabot.yml'
    '.github/workflows/local-runner-canary.yml'
    'bootstrap.ps1'
    'fixtures/cache/canary.lock'
    'fixtures/lfs/canary.txt'
    'README.md'
)

function Invoke-GitCommand {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [string] $WorkingDirectory,

        [Parameter(Mandatory)]
        [string[]] $ArgumentList,

        [switch] $PassThru
    )

    $output = [string[]] @(& git -C $WorkingDirectory @ArgumentList 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "git $($ArgumentList -join ' ') failed: $($output -join [Environment]::NewLine)"
    }

    if ($PassThru) {
        return $output
    }

    foreach ($line in $output) {
        Write-Verbose $line
    }
}

$target = Get-Item -LiteralPath $TargetPath -ErrorAction Stop
if (-not $target.PSIsContainer -or -not (Test-Path -LiteralPath (Join-Path $target.FullName '.git'))) {
    throw 'TargetPath must be the root of a Git checkout.'
}

$remote = (Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList @(
        'remote', 'get-url', 'origin'
    ) -PassThru) -join ''
if ($remote -notmatch $ExpectedRemotePattern) {
    throw "Target origin is not melodic-software/ci-runner-canary: $remote"
}

$branch = (Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList @(
        'branch', '--show-current'
    ) -PassThru) -join ''
if ($branch -ne 'main') {
    throw "Target checkout must be on main, not '$branch'."
}

$status = (Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList @(
        'status', '--porcelain=v1'
    ) -PassThru) -join ''
if ($status.Length -ne 0) {
    throw 'Target checkout must be clean before seeding.'
}

$sourceFixture = Join-Path $PSScriptRoot 'fixtures/lfs/canary.txt'
$sourceDigest = (Get-FileHash -LiteralPath $sourceFixture -Algorithm SHA256).Hash
if ($sourceDigest -ne $ExpectedLfsSha256) {
    throw 'The source LFS fixture is absent or not materialized to the reviewed content.'
}

foreach ($relativePath in $SeedFiles) {
    $source = Join-Path $PSScriptRoot $relativePath
    $destination = Join-Path $target.FullName $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    $null = New-Item -ItemType Directory -Path $destinationDirectory -Force
    if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) {
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList @('lfs', 'install', '--local')
Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList (@('add', '--') + $SeedFiles)

$lfsFiles = @(Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList @(
        'lfs', 'ls-files', '--name-only'
    ) -PassThru)
if ($lfsFiles.Count -ne 1 -or $lfsFiles[0] -ne 'fixtures/lfs/canary.txt') {
    throw "Unexpected Git LFS index: $($lfsFiles -join ', ')"
}

$pointer = (Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList @(
        'show', ':fixtures/lfs/canary.txt'
    ) -PassThru) -join "`n"
if ($pointer.Trim() -ne $ExpectedPointer) {
    throw 'The staged Git LFS pointer does not match the reviewed object.'
}

Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList @('diff', '--cached', '--check')
Invoke-GitCommand -WorkingDirectory $target.FullName -ArgumentList @('status', '--short')
$completionMessage = 'Seed staged successfully. Review the diff; this script did not commit or push.'
Write-Information $completionMessage -InformationAction Continue
