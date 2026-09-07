[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $projectRoot 'assets\branding\ElpisDAW.png'
$iconPath = Join-Path $projectRoot 'assets\branding\ElpisDAW.ico'
$webIconPath = Join-Path $projectRoot 'public\elpisdaw-icon.png'
$iconSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
# Favor the planet and keyboard at small Windows icon sizes while preserving the source artwork.
$iconFocusRatio = 0.79

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "The ElpisDAW brand source was not found at $sourcePath"
}

Add-Type -AssemblyName System.Drawing

function Get-VisibleBounds {
  param([System.Drawing.Bitmap]$Bitmap)

  $left = $Bitmap.Width
  $top = $Bitmap.Height
  $right = -1
  $bottom = -1

  for ($y = 0; $y -lt $Bitmap.Height; $y += 1) {
    for ($x = 0; $x -lt $Bitmap.Width; $x += 1) {
      if ($Bitmap.GetPixel($x, $y).A -eq 0) {
        continue
      }

      if ($x -lt $left) { $left = $x }
      if ($x -gt $right) { $right = $x }
      if ($y -lt $top) { $top = $y }
      if ($y -gt $bottom) { $bottom = $y }
    }
  }

  if ($right -lt $left -or $bottom -lt $top) {
    throw 'The ElpisDAW brand source has no visible pixels.'
  }

  return [System.Drawing.Rectangle]::FromLTRB($left, $top, $right + 1, $bottom + 1)
}

function Get-IconFocusBounds {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [double]$FocusRatio
  )

  $shorterSide = [Math]::Min($Bitmap.Width, $Bitmap.Height)
  $side = [int][Math]::Round($shorterSide * $FocusRatio)
  $left = [int][Math]::Round(($Bitmap.Width - $side) / 2.0)
  $top = [int][Math]::Round(($Bitmap.Height - $side) / 2.0)

  return New-Object System.Drawing.Rectangle($left, $top, $side, $side)
}

function New-SquareIconBitmap {
  param(
    [System.Drawing.Bitmap]$Source,
    [System.Drawing.Rectangle]$SourceBounds,
    [int]$Size
  )

  $bitmap = New-Object System.Drawing.Bitmap(
    $Size,
    $Size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $attributes = New-Object System.Drawing.Imaging.ImageAttributes

  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)

    $available = $Size
    $scale = [Math]::Min(
      $available / $SourceBounds.Width,
      $available / $SourceBounds.Height
    )
    $width = $SourceBounds.Width * $scale
    $height = $SourceBounds.Height * $scale
    $destination = New-Object System.Drawing.Rectangle(
      [int][Math]::Round(($Size - $width) / 2.0),
      [int][Math]::Round(($Size - $height) / 2.0),
      [int][Math]::Round($width),
      [int][Math]::Round($height)
    )

    $graphics.DrawImage(
      $Source,
      $destination,
      $SourceBounds.X,
      $SourceBounds.Y,
      $SourceBounds.Width,
      $SourceBounds.Height,
      [System.Drawing.GraphicsUnit]::Pixel,
      $attributes
    )
  }
  finally {
    $attributes.Dispose()
    $graphics.Dispose()
  }

  return $bitmap
}

function Convert-BitmapToPngBytes {
  param([System.Drawing.Bitmap]$Bitmap)

  $stream = New-Object System.IO.MemoryStream
  try {
    $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return $stream.ToArray()
  }
  finally {
    $stream.Dispose()
  }
}

function Write-MultiResolutionIcon {
  param(
    [System.Collections.IList]$Frames,
    [int[]]$Sizes,
    [string]$OutputPath
  )

  $temporaryPath = "$OutputPath.tmp"
  $stream = New-Object System.IO.FileStream(
    $temporaryPath,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  $writer = New-Object System.IO.BinaryWriter($stream)

  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$Frames.Count)
    $offset = 6 + (16 * $Frames.Count)

    for ($index = 0; $index -lt $Frames.Count; $index += 1) {
      $size = $Sizes[$index]
      $frame = [byte[]]$Frames[$index]
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$frame.Length)
      $writer.Write([UInt32]$offset)
      $offset += $frame.Length
    }

    foreach ($frame in $Frames) {
      $writer.Write([byte[]]$frame)
    }
  }
  finally {
    $writer.Dispose()
    $stream.Dispose()
  }

  Move-Item -LiteralPath $temporaryPath -Destination $OutputPath -Force
}

New-Item -ItemType Directory -Path (Split-Path $iconPath), (Split-Path $webIconPath) -Force |
  Out-Null

$source = [System.Drawing.Bitmap]::FromFile($sourcePath)
try {
  $visibleBounds = Get-VisibleBounds -Bitmap $source
  $focusBounds = Get-IconFocusBounds -Bitmap $source -FocusRatio $iconFocusRatio
  # Edge owns the taskbar window, so its web icon keeps the complete orbit at full width.
  $webBitmap = New-SquareIconBitmap -Source $source -SourceBounds $visibleBounds -Size 512
  try {
    $temporaryWebIconPath = "$webIconPath.tmp"
    $webBitmap.Save($temporaryWebIconPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Move-Item -LiteralPath $temporaryWebIconPath -Destination $webIconPath -Force
  }
  finally {
    $webBitmap.Dispose()
  }

  $frames = New-Object System.Collections.ArrayList
  foreach ($size in $iconSizes) {
    $frameBitmap = New-SquareIconBitmap `
      -Source $source `
      -SourceBounds $focusBounds `
      -Size $size
    try {
      [void]$frames.Add((Convert-BitmapToPngBytes -Bitmap $frameBitmap))
    }
    finally {
      $frameBitmap.Dispose()
    }
  }

  Write-MultiResolutionIcon -Frames $frames -Sizes $iconSizes -OutputPath $iconPath
}
finally {
  $source.Dispose()
}

$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()
$iconHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $iconPath).Hash.ToLowerInvariant()
$webIconHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $webIconPath).Hash.ToLowerInvariant()

Write-Output "ElpisDAW brand source SHA-256: $sourceHash"
Write-Output "ElpisDAW Windows icon SHA-256: $iconHash"
Write-Output "ElpisDAW web icon SHA-256: $webIconHash"
Write-Output "Visible bounds: $($visibleBounds.X),$($visibleBounds.Y) $($visibleBounds.Width)x$($visibleBounds.Height)"
Write-Output "Icon focus bounds: $($focusBounds.X),$($focusBounds.Y) $($focusBounds.Width)x$($focusBounds.Height)"
