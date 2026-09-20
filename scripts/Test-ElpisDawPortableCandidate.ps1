[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,

  [Parameter(Mandatory = $true)]
  [string]$ChecksumPath,

  [Parameter(Mandatory = $true)]
  [string]$EvidenceDirectory,

  [ValidateSet('normal', 'spaces', 'non-ascii')]
  [string]$PathScenario = 'normal',

  [string]$ExpectedNodeVersion = 'v24.20.0',

  [switch]$AllowUnsignedNativeBinaries,

  [ValidatePattern('^[0-9A-Fa-f]{40}$')]
  [string]$ExpectedSelfSignedPreviewThumbprint,

  [switch]$RequireToolFreeHost,

  [switch]$OccupyDefaultPort,

  [switch]$SkipEngineSmoke,

  [switch]$KeepExtracted
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not ('ElpisDaw.WinTrustVerifier' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ElpisDaw
{
    public static class WinTrustVerifier
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustFileInfo
        {
            public uint cbStruct;
            [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustData
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = false, CharSet = CharSet.Unicode)]
        private static extern int WinVerifyTrust(
            IntPtr hwnd,
            [MarshalAs(UnmanagedType.LPStruct)] Guid actionId,
            ref WinTrustData data);

        public static string VerifyEmbeddedSignature(string filePath)
        {
            var fileInfo = new WinTrustFileInfo
            {
                cbStruct = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo)),
                pcwszFilePath = filePath,
                hFile = IntPtr.Zero,
                pgKnownSubject = IntPtr.Zero
            };
            IntPtr fileInfoPointer = Marshal.AllocHGlobal(
                Marshal.SizeOf(typeof(WinTrustFileInfo)));

            try
            {
                Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);
                var data = new WinTrustData
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WinTrustData)),
                    pPolicyCallbackData = IntPtr.Zero,
                    pSIPClientData = IntPtr.Zero,
                    dwUIChoice = 2,
                    fdwRevocationChecks = 0,
                    dwUnionChoice = 1,
                    pFile = fileInfoPointer,
                    dwStateAction = 0,
                    hWVTStateData = IntPtr.Zero,
                    pwszURLReference = IntPtr.Zero,
                    dwProvFlags = 0x00001000,
                    dwUIContext = 0
                };
                Guid actionId = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
                int status = WinVerifyTrust(new IntPtr(-1), actionId, ref data);
                return "0x" + unchecked((uint)status).ToString("X8");
            }
            finally
            {
                Marshal.DestroyStructure(fileInfoPointer, typeof(WinTrustFileInfo));
                Marshal.FreeHGlobal(fileInfoPointer);
            }
        }
    }
}
'@
}

function Assert-Condition {
  param(
    [bool]$Condition,
    [string]$Code,
    [string]$Message
  )

  if (-not $Condition) {
    throw [System.InvalidOperationException]::new("$Code`: $Message")
  }
}

function Resolve-AbsolutePath {
  param(
    [string]$Path,
    [string]$Label
  )

  Assert-Condition ([System.IO.Path]::IsPathRooted($Path)) 'RELATIVE_PATH_REJECTED' "$Label must be absolute."
  return [System.IO.Path]::GetFullPath($Path)
}

function Remove-OwnedDirectory {
  param(
    [string]$Path,
    [string]$ExpectedParent,
    [string]$ExpectedLeaf
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    return
  }

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullParent = [System.IO.Path]::GetFullPath($ExpectedParent).TrimEnd('\')
  $actualParent = [System.IO.Path]::GetDirectoryName($fullPath).TrimEnd('\')
  $actualLeaf = [System.IO.Path]::GetFileName($fullPath)

  Assert-Condition (
    [string]::Equals($actualParent, $fullParent, [System.StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals($actualLeaf, $ExpectedLeaf, [System.StringComparison]::Ordinal)
  ) 'UNSAFE_CLEANUP_TARGET' 'Refusing to remove a directory outside the runner-owned boundary.'

  Remove-Item -LiteralPath $fullPath -Recurse -Force
}

function Read-ExpectedArchiveHash {
  param(
    [string]$Path,
    [string]$ArchiveFileName
  )

  $matchingHashes = @()

  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^([0-9A-Fa-f]{64})[ \t]+\*?([^\\/\r\n]+)$') {
      if ([string]::Equals($Matches[2], $ArchiveFileName, [System.StringComparison]::Ordinal)) {
        $matchingHashes += $Matches[1].ToLowerInvariant()
      }
    }
  }

  Assert-Condition ($matchingHashes.Count -eq 1) 'CHECKSUM_ENTRY_INVALID' 'SHA256SUMS.txt must contain exactly one exact archive entry.'
  return $matchingHashes[0]
}

function Test-ArchiveTopology {
  param([string]$Path)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)

  try {
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    [long]$totalLength = 0

    Assert-Condition ($archive.Entries.Count -gt 0) 'EMPTY_ARCHIVE' 'The portable ZIP must contain files.'

    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName
      $segments = $name.Split('/')
      $isUnsafe = (
        [string]::IsNullOrWhiteSpace($name) -or
        $name.Contains('\') -or
        $name.StartsWith('/') -or
        $name.EndsWith('/') -or
        $name.Contains(':') -or
        $segments -contains '' -or
        $segments -contains '.' -or
        $segments -contains '..' -or
        -not $name.StartsWith('ElpisDAW-Core/', [System.StringComparison]::Ordinal)
      )

      Assert-Condition (-not $isUnsafe) 'UNSAFE_ARCHIVE_ENTRY' 'The portable ZIP contains an unsafe or unexpected entry path.'
      Assert-Condition ($seen.Add($name)) 'DUPLICATE_ARCHIVE_ENTRY' 'The portable ZIP contains a duplicate case-insensitive entry path.'
      Assert-Condition ($entry.Length -le 536870912) 'ARCHIVE_ENTRY_TOO_LARGE' 'A portable ZIP entry exceeds the 512 MiB preflight boundary.'
      $totalLength += $entry.Length
      Assert-Condition ($totalLength -le 1073741824) 'ARCHIVE_TOO_LARGE' 'The portable ZIP exceeds the 1 GiB extracted-size preflight boundary.'
    }

    return [ordered]@{
      entryCount = $archive.Entries.Count
      extractedBytes = $totalLength
    }
  }
  finally {
    $archive.Dispose()
  }
}

function Resolve-EdgePath {
  $candidates = @()

  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
  }

  if ($env:ProgramFiles) {
    $candidates += Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'
  }

  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'
  }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }

  throw [System.InvalidOperationException]::new('EDGE_NOT_FOUND: Microsoft Edge is required for portable acceptance.')
}

function Get-SignatureReport {
  param([string]$Path)

  $signature = Get-AuthenticodeSignature -FilePath $Path
  $subject = $null
  $issuer = $null
  $thumbprint = $null
  $codeSigningEku = $false

  if ($signature.SignerCertificate) {
    $subject = $signature.SignerCertificate.Subject
    $issuer = $signature.SignerCertificate.Issuer
    $thumbprint = $signature.SignerCertificate.Thumbprint
    $eku = $signature.SignerCertificate.Extensions |
      Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
      Select-Object -First 1
    if ($eku) {
      $codeSigningEku = [bool]($eku.EnhancedKeyUsages |
        Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })
    }
  }

  return [ordered]@{
    status = $signature.Status.ToString()
    codeSigningEku = $codeSigningEku
    signerIssuer = $issuer
    signerSubject = $subject
    signerThumbprint = $thumbprint
    winTrustStatus = [ElpisDaw.WinTrustVerifier]::VerifyEmbeddedSignature($Path)
  }
}

function Assert-AcceptedSignature {
  param(
    [System.Collections.IDictionary]$Report,
    [string]$Label,
    [bool]$AllowUnsigned,
    [string]$ExpectedSelfSignedThumbprint
  )

  if ($Report.status -eq 'Valid' -and $Report.winTrustStatus -ceq '0x00000000') {
    return
  }

  if ($AllowUnsigned -and $Report.status -eq 'NotSigned') {
    return
  }

  if (-not [string]::IsNullOrWhiteSpace($ExpectedSelfSignedThumbprint)) {
    $normalizedExpectedThumbprint = $ExpectedSelfSignedThumbprint.ToUpperInvariant()
    $selfSignedStatus = $Report.status -in @('NotTrusted', 'UnknownError')
    $selfSignedIdentity = (
      $Report.winTrustStatus -ceq '0x800B0109' -and
      $Report.codeSigningEku -eq $true -and
      -not [string]::IsNullOrWhiteSpace([string]$Report.signerSubject) -and
      [string]::Equals(
        [string]$Report.signerSubject,
        [string]$Report.signerIssuer,
        [System.StringComparison]::Ordinal
      ) -and
      [string]::Equals(
        [string]$Report.signerThumbprint,
        $normalizedExpectedThumbprint,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    )
    if ($selfSignedStatus -and $selfSignedIdentity) {
      return
    }
  }

  throw [System.InvalidOperationException]::new(
    "BINARY_SIGNATURE_REJECTED: $Label Authenticode status is $($Report.status); WinVerifyTrust status is $($Report.winTrustStatus)."
  )
}

function Invoke-LauncherCheck {
  param(
    [string]$LauncherPath,
    [string]$Mode,
    [string]$ResultPath
  )

  $process = Start-Process `
    -FilePath $LauncherPath `
    -ArgumentList @($Mode, '--result-file', $ResultPath) `
    -WindowStyle Hidden `
    -Wait `
    -PassThru

  Assert-Condition ($process.ExitCode -eq 0) 'LAUNCHER_CHECK_FAILED' "The native launcher failed $Mode."
  Assert-Condition (Test-Path -LiteralPath $ResultPath -PathType Leaf) 'LAUNCHER_RESULT_MISSING' "The native launcher did not write the $Mode result."
  return (Get-Content -LiteralPath $ResultPath -Raw).Trim()
}

function Get-ToolInventory {
  $tools = @()

  foreach ($name in @('node.exe', 'pnpm.cmd', 'git.exe', 'python.exe', 'dotnet.exe', 'csc.exe')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    $availableOnPath = [bool]$command
    $isAppExecutionAlias = $false

    if ($availableOnPath -and $command.Source) {
      $isAppExecutionAlias = $command.Source -match '[\\/]WindowsApps[\\/]'
    }

    $tools += [ordered]@{
      name = $name
      availableOnPath = $availableOnPath
      appExecutionAlias = $isAppExecutionAlias
      installed = $availableOnPath -and -not $isAppExecutionAlias
    }
  }

  return $tools
}

$archiveFullPath = Resolve-AbsolutePath $ArchivePath 'ArchivePath'
$checksumFullPath = Resolve-AbsolutePath $ChecksumPath 'ChecksumPath'
$evidenceFullPath = Resolve-AbsolutePath $EvidenceDirectory 'EvidenceDirectory'
Assert-Condition (
  -not ($AllowUnsignedNativeBinaries -and -not [string]::IsNullOrWhiteSpace($ExpectedSelfSignedPreviewThumbprint))
) 'SIGNATURE_POLICY_CONFLICT' 'Unsigned and self-signed preview exceptions cannot be enabled together.'

Assert-Condition (Test-Path -LiteralPath $archiveFullPath -PathType Leaf) 'ARCHIVE_NOT_FOUND' 'The portable ZIP was not found.'
Assert-Condition (Test-Path -LiteralPath $checksumFullPath -PathType Leaf) 'CHECKSUM_NOT_FOUND' 'SHA256SUMS.txt was not found.'
Assert-Condition (-not (Test-Path -LiteralPath $evidenceFullPath)) 'EVIDENCE_ALREADY_EXISTS' 'The evidence directory must not already exist.'

$archiveFileName = [System.IO.Path]::GetFileName($archiveFullPath)
$expectedArchiveHash = Read-ExpectedArchiveHash $checksumFullPath $archiveFileName
$archiveItem = Get-Item -LiteralPath $archiveFullPath
$actualArchiveHash = (Get-FileHash -LiteralPath $archiveFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-Condition ($actualArchiveHash -eq $expectedArchiveHash) 'ARCHIVE_HASH_MISMATCH' 'The portable ZIP SHA-256 does not match SHA256SUMS.txt.'

$archiveTopology = Test-ArchiveTopology $archiveFullPath
$windowsVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$windowsBuild = [int]$windowsVersion.CurrentBuildNumber
Assert-Condition ([System.Environment]::Is64BitOperatingSystem) 'UNSUPPORTED_ARCHITECTURE' 'Portable acceptance requires Windows x64.'
Assert-Condition ($windowsBuild -ge 22000) 'UNSUPPORTED_WINDOWS_VERSION' 'Portable acceptance requires Windows 11.'

$edgePath = Resolve-EdgePath
$edgeVersion = (Get-Item -LiteralPath $edgePath).VersionInfo.ProductVersion
$toolInventory = Get-ToolInventory

if ($RequireToolFreeHost) {
  $unexpectedTools = @($toolInventory | Where-Object { $_.installed })
  Assert-Condition ($unexpectedTools.Count -eq 0) 'HOST_TOOLING_PRESENT' 'A clean-machine run must not expose Node.js, pnpm, Git, Python, dotnet, or csc on PATH.'
}

$runId = [Guid]::NewGuid().ToString('N')
$temporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')

switch ($PathScenario) {
  'normal' { $extractionLeaf = "ElpisDawPortableAcceptance_$runId" }
  'spaces' { $extractionLeaf = "ElpisDAW Portable Acceptance $runId" }
  'non-ascii' {
    $nonAsciiToken = "{0}{1}" -f [char]0x691c, [char]0x8a3c
    $extractionLeaf = "ElpisDAW_${nonAsciiToken}_$runId"
  }
}

$extractionRoot = Join-Path $temporaryParent $extractionLeaf
$stateLeaf = "ElpisDawPortableState_$runId"
$stateRoot = Join-Path $temporaryParent $stateLeaf
$evidenceParent = [System.IO.Path]::GetDirectoryName($evidenceFullPath)
$evidenceStagingLeaf = ".elpisdaw-acceptance-staging-$runId"
$evidenceStaging = Join-Path $evidenceParent $evidenceStagingLeaf
$listener = $null
$oldLocalAppData = $env:LOCALAPPDATA
$oldAppData = $env:APPDATA
$published = $false

Assert-Condition (-not (Test-Path -LiteralPath $extractionRoot)) 'EXTRACTION_ALREADY_EXISTS' 'The generated extraction directory already exists.'
Assert-Condition (-not (Test-Path -LiteralPath $stateRoot)) 'STATE_ALREADY_EXISTS' 'The generated state directory already exists.'
Assert-Condition (-not (Test-Path -LiteralPath $evidenceStaging)) 'EVIDENCE_STAGING_ALREADY_EXISTS' 'The generated evidence staging directory already exists.'

try {
  New-Item -ItemType Directory -Path $extractionRoot | Out-Null
  New-Item -ItemType Directory -Path $stateRoot | Out-Null
  New-Item -ItemType Directory -Path $evidenceParent -Force | Out-Null
  New-Item -ItemType Directory -Path $evidenceStaging | Out-Null

  Expand-Archive -LiteralPath $archiveFullPath -DestinationPath $extractionRoot
  $topLevelEntries = @(Get-ChildItem -LiteralPath $extractionRoot -Force)
  Assert-Condition (
    $topLevelEntries.Count -eq 1 -and
    $topLevelEntries[0].PSIsContainer -and
    $topLevelEntries[0].Name -ceq 'ElpisDAW-Core'
  ) 'EXTRACTED_ROOT_INVALID' 'The portable ZIP must extract to one exact ElpisDAW-Core directory.'

  $packageRoot = $topLevelEntries[0].FullName
  $portableDataRoot = Join-Path $extractionRoot 'ElpisDAW-Data'
  $launcherPath = Join-Path $packageRoot 'ElpisDAW.exe'
  $directoryPickerPath = Join-Path $packageRoot 'native\HumStudio.DirectoryPicker.exe'
  $nodePath = Join-Path $packageRoot 'runtime\node.exe'
  $manifestPath = Join-Path $packageRoot 'release-manifest.json'
  $selfSignedPreviewNoticePath = Join-Path $packageRoot 'SELF_SIGNED_PREVIEW.txt'

  foreach ($requiredPath in @($launcherPath, $directoryPickerPath, $nodePath, $manifestPath)) {
    Assert-Condition (Test-Path -LiteralPath $requiredPath -PathType Leaf) 'REQUIRED_PACKAGE_FILE_MISSING' 'The extracted package is missing a required file.'
  }

  $selfSignedPreviewMode = -not [string]::IsNullOrWhiteSpace($ExpectedSelfSignedPreviewThumbprint)
  if ($selfSignedPreviewMode) {
    Assert-Condition (
      Test-Path -LiteralPath $selfSignedPreviewNoticePath -PathType Leaf
    ) 'SELF_SIGNED_PREVIEW_NOTICE_MISSING' 'A self-signed preview must include SELF_SIGNED_PREVIEW.txt.'
    $selfSignedPreviewNotice = Get-Content -LiteralPath $selfSignedPreviewNoticePath -Raw
    Assert-Condition (
      $selfSignedPreviewNotice.Contains($ExpectedSelfSignedPreviewThumbprint.ToUpperInvariant()) -and
      $selfSignedPreviewNotice.Contains(
        'Do not install this certificate into Trusted Root Certification Authorities or Trusted Publishers.'
      )
    ) 'SELF_SIGNED_PREVIEW_NOTICE_INVALID' 'The self-signed preview notice does not match the expected certificate policy.'
  }
  else {
    Assert-Condition (
      -not (Test-Path -LiteralPath $selfSignedPreviewNoticePath)
    ) 'UNEXPECTED_SELF_SIGNED_PREVIEW_NOTICE' 'A trusted or unsigned candidate must not contain a self-signed preview notice.'
  }

  $forbiddenFiles = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -Force -File | Where-Object {
    $relativePath = $_.FullName.Substring($packageRoot.Length).TrimStart('\').Replace('\', '/')
    $relativePath -match '(^|/)(node_modules|\.git|__pycache__)(/|$)' -or
    $relativePath -match '\.(test|fixture)\.' -or
    $relativePath -match '\.(map|pyc|pyo)$'
  })
  Assert-Condition ($forbiddenFiles.Count -eq 0) 'FORBIDDEN_PACKAGE_FILE' 'The extracted package contains a development or cache artifact.'

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $launcherSignature = Get-SignatureReport $launcherPath
  $directoryPickerSignature = Get-SignatureReport $directoryPickerPath
  $nodeSignature = Get-SignatureReport $nodePath
  Assert-AcceptedSignature $launcherSignature 'ElpisDAW.exe' $AllowUnsignedNativeBinaries.IsPresent $ExpectedSelfSignedPreviewThumbprint
  Assert-AcceptedSignature $directoryPickerSignature 'HumStudio.DirectoryPicker.exe' $AllowUnsignedNativeBinaries.IsPresent $ExpectedSelfSignedPreviewThumbprint
  Assert-AcceptedSignature $nodeSignature 'runtime/node.exe' $false $null

  $nodeVersion = (& $nodePath --version 2>&1 | Out-String).Trim()
  Assert-Condition ($LASTEXITCODE -eq 0) 'NODE_VERSION_FAILED' 'The packaged Node.js runtime did not report its version.'
  Assert-Condition ($nodeVersion -ceq $ExpectedNodeVersion) 'NODE_VERSION_MISMATCH' 'The packaged Node.js version does not match the expected release runtime.'

  $env:LOCALAPPDATA = $stateRoot
  $env:APPDATA = Join-Path $stateRoot 'Roaming'
  New-Item -ItemType Directory -Path $env:APPDATA | Out-Null

  $validationResultPath = Join-Path $evidenceStaging 'launcher-validation.txt'
  $validationResult = Invoke-LauncherCheck $launcherPath '--validate-only' $validationResultPath
  $expectedValidationResult = "READY`n$($manifest.version)"
  Assert-Condition (($validationResult -replace "`r`n", "`n") -ceq $expectedValidationResult) 'LAUNCHER_VALIDATION_INVALID' 'The native launcher returned an unexpected validation result.'

  $smokeResult = $null
  $engineOrigin = $null
  $engineReachableAfterSmoke = $null
  $portableDataRootCreated = $null
  $localAppDataUntouched = $null

  if (-not $SkipEngineSmoke) {
    if ($OccupyDefaultPort) {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 43120)
      $listener.Server.ExclusiveAddressUse = $true
      $listener.Start()
    }

    $smokeResultPath = Join-Path $evidenceStaging 'launcher-smoke.txt'
    $smokeResult = Invoke-LauncherCheck $launcherPath '--smoke-test' $smokeResultPath
    $normalizedSmokeResult = $smokeResult -replace "`r`n", "`n"
    $versionPattern = [Regex]::Escape([string]$manifest.version)
    $smokeMatch = [Regex]::Match(
      $normalizedSmokeResult,
      "^READY`n$versionPattern`nENGINE_ORIGIN=(http://127\.0\.0\.1:([0-9]+))$"
    )
    Assert-Condition ($smokeMatch.Success) 'LAUNCHER_SMOKE_INVALID' 'The native launcher returned an unexpected smoke result.'
    $engineOrigin = $smokeMatch.Groups[1].Value
    $enginePort = [int]$smokeMatch.Groups[2].Value

    if ($OccupyDefaultPort) {
      Assert-Condition ($enginePort -ne 43120) 'ALTERNATE_PORT_NOT_SELECTED' 'The launcher did not move away from the occupied preferred port.'
    }

    $engineReachableAfterSmoke = $false

    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri "$engineOrigin/api/v1/health" -TimeoutSec 2
      $engineReachableAfterSmoke = $true
    }
    catch {
      $engineReachableAfterSmoke = $false
    }

    Assert-Condition (-not $engineReachableAfterSmoke) 'ENGINE_PROCESS_SURVIVED' 'The Local Engine remained reachable after launcher smoke shutdown.'

    foreach ($portableResourcePath in @(
      (Join-Path $portableDataRoot 'Runtimes\BasicPitch'),
      (Join-Path $portableDataRoot 'Runtimes\FluidSynth'),
      (Join-Path $portableDataRoot 'Resources\SoundFonts')
    )) {
      Assert-Condition (
        Test-Path -LiteralPath $portableResourcePath -PathType Container
      ) 'PORTABLE_DATA_ROOT_INVALID' 'The launcher did not create the expected portable resource directories.'
    }

    $portableDataRootCreated = $true
    $localAppDataUntouched = -not (Test-Path -LiteralPath (Join-Path $stateRoot 'ElpisDAW'))
    Assert-Condition $localAppDataUntouched 'LOCAL_APP_DATA_WRITTEN' 'The portable launcher wrote ElpisDAW data under LocalAppData.'
  }

  $report = [ordered]@{
    schemaVersion = 1
    status = if (
      $SkipEngineSmoke -or
      -not [string]::IsNullOrWhiteSpace($ExpectedSelfSignedPreviewThumbprint)
    ) { 'PASS_WITH_GAPS' } else { 'PASS' }
    observedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    runner = [ordered]@{
      fileName = [System.IO.Path]::GetFileName($PSCommandPath)
      sha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    artifact = [ordered]@{
      fileName = $archiveFileName
      sha256 = $actualArchiveHash
      bytes = $archiveItem.Length
      zipEntryCount = $archiveTopology.entryCount
      extractedBytes = $archiveTopology.extractedBytes
    }
    package = [ordered]@{
      product = [string]$manifest.product
      version = [string]$manifest.version
      platform = [string]$manifest.platform
      manifestSha256 = $manifestHash
      manifestFileCount = @($manifest.files).Count
      nodeVersion = $nodeVersion
    }
    host = [ordered]@{
      windowsFamily = 'Windows 11'
      registryProductName = [string]$windowsVersion.ProductName
      editionId = [string]$windowsVersion.EditionID
      displayVersion = [string]$windowsVersion.DisplayVersion
      buildNumber = $windowsBuild
      osArchitecture = 'x64'
      edgeVersion = $edgeVersion
      toolInventory = $toolInventory
    }
    policy = [ordered]@{
      pathScenario = $PathScenario
      allowUnsignedNativeBinaries = $AllowUnsignedNativeBinaries.IsPresent
      expectedSelfSignedPreviewThumbprint = if (
        [string]::IsNullOrWhiteSpace($ExpectedSelfSignedPreviewThumbprint)
      ) { $null } else { $ExpectedSelfSignedPreviewThumbprint.ToUpperInvariant() }
      requireToolFreeHost = $RequireToolFreeHost.IsPresent
      occupyDefaultPort = $OccupyDefaultPort.IsPresent
      engineSmokeSkipped = $SkipEngineSmoke.IsPresent
      extractionRetained = $KeepExtracted.IsPresent
    }
    signatures = [ordered]@{
      launcher = $launcherSignature
      directoryPicker = $directoryPickerSignature
      node = $nodeSignature
    }
    checks = [ordered]@{
      checksumMatched = $true
      archiveTopologyAccepted = $true
      exactPackageRootAccepted = $true
      forbiddenDevelopmentArtifactsAbsent = $true
      selfSignedPreviewNoticeAccepted = if ($selfSignedPreviewMode) { $true } else { $null }
      launcherValidation = $validationResult -replace "`r`n", "`n"
      launcherSmoke = if ($smokeResult) { $smokeResult -replace "`r`n", "`n" } else { $null }
      engineOrigin = $engineOrigin
      engineReachableAfterSmoke = $engineReachableAfterSmoke
      portableDataRootCreated = $portableDataRootCreated
      localAppDataUntouched = $localAppDataUntouched
    }
    remainingManualAcceptance = @(
      'Launch with external networking disabled and retain the network-state evidence.',
      'Exercise the Windows notification-area Open ElpisDAW and Exit ElpisDAW actions.',
      'Exercise Directory Picker, portable/external model storage, Project save/restart/reopen, Provider fallback, keyboard access, display scaling, upgrade, rollback, and uninstall cases.',
      'Retain screenshots, logs, and the final clean-machine aggregate.'
    )
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $reportPath = Join-Path $evidenceStaging 'portable-preflight-report.json'
  [System.IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 10) + "`n"), $utf8)

  Move-Item -LiteralPath $evidenceStaging -Destination $evidenceFullPath
  $published = $true
  Write-Output "ElpisDAW portable preflight: $($report.status)"
  Write-Output "Evidence: $evidenceFullPath"
}
finally {
  if ($listener) {
    $listener.Stop()
  }

  $env:LOCALAPPDATA = $oldLocalAppData
  $env:APPDATA = $oldAppData

  if (-not $published) {
    Remove-OwnedDirectory $evidenceStaging $evidenceParent $evidenceStagingLeaf
  }

  if (-not $KeepExtracted) {
    Remove-OwnedDirectory $extractionRoot $temporaryParent $extractionLeaf
    Remove-OwnedDirectory $stateRoot $temporaryParent $stateLeaf
  }
}
