#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: $0 LFS_FIXTURE LFS_SHA256 DOTNET_VERSION NODE_VERSION PYTHON_VERSION OUTPUT" >&2
}

if (($# != 6)); then
  usage
  exit 64
fi

lfs_fixture=$1
lfs_sha256=$2
dotnet_version=$3
node_version=$4
python_version=$5
output=$6

for command in clang dotnet git node pwsh python sha256sum sudo; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is unavailable: $command" >&2
    exit 1
  fi
done

if [[ ! -f $lfs_fixture ]]; then
  echo "Git LFS fixture is missing: $lfs_fixture" >&2
  exit 1
fi
if ! git lfs ls-files --name-only | grep -Fqx -- "$lfs_fixture"; then
  echo "fixture is not tracked by Git LFS: $lfs_fixture" >&2
  exit 1
fi

actual_lfs_sha256=$(sha256sum -- "$lfs_fixture" | cut -d ' ' -f 1)
if [[ $actual_lfs_sha256 != "$lfs_sha256" ]]; then
  echo "Git LFS fixture digest mismatch" >&2
  exit 1
fi

actual_dotnet_version=$(dotnet --version)
actual_node_version=$(node --version)
actual_python_version=$(python --version)
if [[ $actual_dotnet_version != "$dotnet_version" ]]; then
  echo "unexpected .NET SDK: $actual_dotnet_version" >&2
  exit 1
fi
if [[ $actual_node_version != "v$node_version" ]]; then
  echo "unexpected Node.js runtime: $actual_node_version" >&2
  exit 1
fi
if [[ $actual_python_version != "Python $python_version" ]]; then
  echo "unexpected Python runtime: $actual_python_version" >&2
  exit 1
fi

pwsh_result=$(pwsh -NoLogo -NoProfile -NonInteractive -Command '"pwsh-" + "ok"')
if [[ $pwsh_result != "pwsh-ok" ]]; then
  echo "PowerShell compatibility probe failed" >&2
  exit 1
fi

sudo -n true
if [[ ! -f /usr/include/zlib.h ]]; then
  echo "zlib development headers are unavailable" >&2
  exit 1
fi

work_dir=$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/ci-runner-parity.XXXXXX")
certificate_name="ci-runner-canary-${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}-${GITHUB_JOB:?GITHUB_JOB is required}.crt"
certificate_path="$work_dir/$certificate_name"
installed_certificate="/usr/local/share/ca-certificates/$certificate_name"

cleanup() {
  rm -rf -- "$work_dir"
  if sudo test -e "$installed_certificate"; then
    sudo rm -f -- "$installed_certificate"
    sudo update-ca-certificates >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cat >"$work_dir/create-certificate.ps1" <<'POWERSHELL'
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=ci-runner-canary',
        $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
            $true, $false, 0, $true))
    $keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
    $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
            $keyUsage, $true))
    $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new(
            $request.PublicKey, $false))
    $certificate = $request.CreateSelfSigned(
        [DateTimeOffset]::UtcNow.AddMinutes(-1),
        [DateTimeOffset]::UtcNow.AddMinutes(30))
    try {
        [IO.File]::WriteAllText(
            $env:CERTIFICATE_PATH,
            $certificate.ExportCertificatePem(),
            [Text.UTF8Encoding]::new($false))
    }
    finally {
        $certificate.Dispose()
    }
}
finally {
    $rsa.Dispose()
}
POWERSHELL

CERTIFICATE_PATH=$certificate_path pwsh \
  -NoLogo \
  -NoProfile \
  -NonInteractive \
  -File "$work_dir/create-certificate.ps1"
sudo install -m 0644 -- "$certificate_path" "$installed_certificate"
sudo update-ca-certificates
if [[ ! -e "/etc/ssl/certs/${certificate_name%.crt}.pem" ]]; then
  echo "custom certificate was not added to the system trust store" >&2
  exit 1
fi
CERTIFICATE_PATH=$certificate_path python - <<'PYTHON'
import os
import ssl

with open(os.environ["CERTIFICATE_PATH"], encoding="ascii") as certificate_file:
    expected = ssl.PEM_cert_to_DER_cert(certificate_file.read())

if expected not in ssl.create_default_context().get_ca_certs(binary_form=True):
    raise SystemExit("custom certificate is absent from the default trust context")
PYTHON

dotnet_major=${dotnet_version%%.*}
framework="net${dotnet_major}.0"
native_aot_dir="$work_dir/native-aot"
dotnet new console \
  --name NativeAotCanary \
  --output "$native_aot_dir" \
  --framework "$framework" \
  --no-restore
sed -i '/<PropertyGroup>/a\    <PublishAot>true</PublishAot>' \
  "$native_aot_dir/NativeAotCanary.csproj"
dotnet publish "$native_aot_dir/NativeAotCanary.csproj" \
  --configuration Release \
  --runtime linux-x64
native_aot_result=$(
  "$native_aot_dir/bin/Release/$framework/linux-x64/publish/NativeAotCanary"
)
if [[ $native_aot_result != "Hello, World!" ]]; then
  echo "Native AOT executable returned unexpected output" >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$output")"
{
  printf 'checkout=%s\n' "$(git rev-parse HEAD)"
  printf 'dotnet=%s\n' "$actual_dotnet_version"
  printf 'lfs-sha256=%s\n' "$actual_lfs_sha256"
  printf 'native-aot=%s\n' "$native_aot_result"
  printf 'node=%s\n' "$actual_node_version"
  printf 'powershell=%s\n' "$pwsh_result"
  printf 'python=%s\n' "$actual_python_version"
  printf 'sudo-certificate-trust=ok\n'
} >"$output"
