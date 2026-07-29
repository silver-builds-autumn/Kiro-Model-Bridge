$credentialPatterns = @(
  [regex]'\bsk-[A-Za-z0-9_-]{32,}\b',
  [regex]'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
  [regex]'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{36,})\b',
  [regex]'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
  [regex]'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b',
  [regex]'(?i)\bBearer\s+[A-Za-z0-9._~-]{20,}\b',
  [regex]'(?i)"(?:api[_-]?key|access[_-]?token|secret|authorization)"\s*:\s*"[^"\r\n]{16,}"',
  [regex]'^\s*(?:API_KEY|ACCESS_TOKEN|SECRET)\s*=\s*[^\s#]{16,}'
)
$findings = @()

function Test-CredentialPattern([string]$line) {
  foreach ($pattern in $credentialPatterns) {
    if ($pattern.IsMatch($line)) { return $true }
  }
  return $false
}

$package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$expectedVsix = "$($package.name)-$($package.version).vsix"
if (-not (Test-Path -LiteralPath $expectedVsix -PathType Leaf)) {
  Write-Error "expected VSIX not found: $expectedVsix"
  exit 1
}

$trackedFiles = git ls-files
if ($LASTEXITCODE -ne 0) {
  Write-Error 'git ls-files failed'
  exit 1
}
foreach ($relativePath in $trackedFiles) {
  if (-not (Test-Path -LiteralPath $relativePath -PathType Leaf)) { continue }
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $relativePath -ErrorAction SilentlyContinue) {
    $lineNumber++
    if (Test-CredentialPattern $line) { $findings += "${relativePath}:${lineNumber}" }
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$textEntryPattern = '\.(?:cfg|conf|css|env|html|ini|js|json|key|md|pem|ps1|toml|ts|txt|xml|ya?ml)$'
$vsixFile = Get-Item -LiteralPath $expectedVsix
$archive = [System.IO.Compression.ZipFile]::OpenRead($vsixFile.FullName)
try {
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName -notmatch $textEntryPattern) { continue }
    $reader = [System.IO.StreamReader]::new($entry.Open())
    try {
      $lineNumber = 0
      while (($line = $reader.ReadLine()) -ne $null) {
        $lineNumber++
        if (Test-CredentialPattern $line) {
          $findings += "$($entry.FullName):${lineNumber}"
        }
      }
    } finally {
      $reader.Dispose()
    }
  }
} finally {
  $archive.Dispose()
}

if ($findings.Count -gt 0) {
  $findings | ForEach-Object { Write-Error "potential credential at $_" }
  exit 1
}
Write-Output 'secret scan: 0 high-entropy API keys found'
Write-Output 'secret scan: 0 broader credential-pattern hits'
