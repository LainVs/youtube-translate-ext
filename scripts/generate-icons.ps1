Add-Type -AssemblyName System.Drawing

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "src\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($s in @(16, 48, 128)) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $bgPath = New-RoundedPath 0 0 $s $s ($s * 0.22)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 66, 133, 244),
    [System.Drawing.Color]::FromArgb(255, 155, 89, 255),
    45)
  $g.FillPath($bgBrush, $bgPath)

  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 0, 0, 0))

  # screen frame
  $mx = $s * 0.20
  $my = $s * 0.24
  $frameW = $s - $mx * 2
  $frameH = $s * 0.52
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [Math]::Max(1.2, $s * 0.045))
  $frame = New-RoundedPath $mx $my $frameW $frameH ($s * 0.08)
  $g.DrawPath($pen, $frame)

  # two subtitle bars
  $barH = [Math]::Max(1.6, $s * 0.075)
  $barR = $barH / 2
  $b1w = $frameW * 0.62
  $b2w = $frameW * 0.44
  $b1x = $mx + ($frameW - $b1w) / 2
  $b2x = $mx + ($frameW - $b2w) / 2
  $b1y = $my + $frameH * 0.46
  $b2y = $b1y + $barH * 1.7
  $g.FillPath($white, (New-RoundedPath $b1x $b1y $b1w $barH $barR))
  $g.FillPath($white, (New-RoundedPath $b2x $b2y $b2w $barH $barR))

  $out = Join-Path $outDir "icon$s.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

  $g.Dispose(); $bmp.Dispose()
  Write-Host "created $out"
}
