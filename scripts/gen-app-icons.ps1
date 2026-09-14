# Generates TOTP app icons programmatically via GDI+ (System.Drawing).
#
# Design: blue (#4A90D9) rounded square base, white ring with a gap at the
# 12 o'clock position (countdown metaphor), white sans-serif "T" centered.
#
# Outputs:
#   apps/extension/public/icon.png               128px (WXT source for manifest icons)
#   apps/desktop/src-tauri/icons/16x16.png
#   apps/desktop/src-tauri/icons/32x32.png
#   apps/desktop/src-tauri/icons/48x48.png
#   apps/desktop/src-tauri/icons/128x128.png
#   apps/desktop/src-tauri/icons/128x128@2x.png  256px
#   apps/desktop/src-tauri/icons/icon.ico        multi-size (16/32/48/256, PNG-in-ICO)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $PSScriptRoot
$blue = [System.Drawing.Color]::FromArgb(255, 0x4A, 0x90, 0xD9)

function New-RoundedSquarePath([float]$size, [float]$radius) {
  $d = 2 * $radius
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($size - $d, 0, $d, $d, 270, 90)
  $p.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $p.AddArc(0, $size - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  # 1. rounded square base
  $radius = [Math]::Max(2.0, $size * 0.22)
  $path = New-RoundedSquarePath $size $radius
  $brush = New-Object System.Drawing.SolidBrush($blue)
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()

  # 2. ring with a gap at 12 o'clock (GDI+ angles: 0 = +x axis, clockwise; -90 = 12 o'clock)
  $ringWidth = if ($size -le 20) { [Math]::Max(1.8, $size * 0.10) } else { [Math]::Max(1.6, $size * 0.085) }
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]$ringWidth)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $m = $size * 0.17
  $rect = New-Object System.Drawing.RectangleF($m, $m, ($size - 2 * $m), ($size - 2 * $m))
  $gapDeg = 46
  $g.DrawArc($pen, $rect, (-90 + $gapDeg / 2), (360 - $gapDeg))
  $pen.Dispose()

  # 3. centered "T"
  if ($size -ge 48) {
    $font = New-Object System.Drawing.Font('Segoe UI', (0.46 * $size), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $tBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $fullRect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString('T', $font, $tBrush, $fullRect, $sf)
    $tBrush.Dispose()
    $sf.Dispose()
    $font.Dispose()
  }
  else {
    # geometric "T" strokes for small sizes (legible at 16/32px);
    # <=20px uses thicker strokes and a slightly smaller T to avoid touching the ring
    $small = $size -le 20
    $tPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]$(if ($small) { 1.8 } else { [Math]::Max(1.5, $size * 0.085) }))
    $tPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $tPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $half = if ($small) { 0.15 * $size } else { 0.17 * $size }
    $cx = 0.5 * $size
    $topY = if ($small) { 0.37 * $size } else { 0.345 * $size }
    $botY = if ($small) { 0.63 * $size } else { 0.665 * $size }
    $g.DrawLine($tPen, ($cx - $half), $topY, ($cx + $half), $topY)
    $g.DrawLine($tPen, $cx, $topY, $cx, $botY)
    $tPen.Dispose()
  }

  $g.Dispose()
  return $bmp
}

function Write-Ico([string]$outPath, [object[]]$entries) {
  # entries: objects with .size (int) and .bytes (PNG data). PNG-in-ICO is
  # supported by Windows Vista+ and by the Rust `ico` crate used by Tauri.
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint16]0)                      # reserved
  $bw.Write([uint16]1)                      # type: icon
  $bw.Write([uint16]$entries.Count)         # image count
  $offset = [uint32](6 + 16 * $entries.Count)
  foreach ($e in $entries) {
    $dim = if ($e.size -ge 256) { [byte]0 } else { [byte]$e.size }
    $bw.Write($dim)                         # width (0 = 256)
    $bw.Write($dim)                         # height (0 = 256)
    $bw.Write([byte]0)                      # color count
    $bw.Write([byte]0)                      # reserved
    $bw.Write([uint16]1)                    # color planes
    $bw.Write([uint16]32)                   # bits per pixel
    $bw.Write([uint32]$e.bytes.Length)      # data size
    $bw.Write([uint32]$offset)              # data offset
    $offset += $e.bytes.Length
  }
  foreach ($e in $entries) { $bw.Write($e.bytes) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($outPath, $ms.ToArray())
  $bw.Dispose()
}

$pngSizes = 16, 32, 48, 128, 256
$names = @{ 16 = '16x16.png'; 32 = '32x32.png'; 48 = '48x48.png'; 128 = '128x128.png'; 256 = '128x128@2x.png' }
$desktopIcons = Join-Path $Root 'apps/desktop/src-tauri/icons'
$extPublic = Join-Path $Root 'apps/extension/public'
New-Item -ItemType Directory -Force -Path $extPublic | Out-Null

$bytes = @{}
foreach ($s in $pngSizes) {
  $bmp = New-IconBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes[$s] = $ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()
  [System.IO.File]::WriteAllBytes((Join-Path $desktopIcons $names[$s]), $bytes[$s])
}

# extension: single 128px source icon + per-size icons for manifest.icons
[System.IO.File]::WriteAllBytes((Join-Path $extPublic 'icon.png'), $bytes[128])
$extIconDir = Join-Path $extPublic 'icon'
New-Item -ItemType Directory -Force -Path $extIconDir | Out-Null
foreach ($s in 16, 32, 48, 128) {
  [System.IO.File]::WriteAllBytes((Join-Path $extIconDir "$s.png"), $bytes[$s])
}

# desktop: multi-size true ICO (16/32/48/256)
$icoEntries = @(16, 32, 48, 256 | ForEach-Object {
  [pscustomobject]@{ size = $_; bytes = $bytes[$_] }
})
Write-Ico (Join-Path $desktopIcons 'icon.ico') $icoEntries

Write-Host ('PNG written: ' + (($pngSizes | ForEach-Object { "$($_)px=$($bytes[$_].Length)B" }) -join ', '))
Write-Host ('icon.ico written: ' + (Get-Item (Join-Path $desktopIcons 'icon.ico')).Length + 'B')
Write-Host ('extension icon.png written: ' + $bytes[128].Length + 'B')
Write-Host 'Done.'
