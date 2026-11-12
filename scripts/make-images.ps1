# Quantopus Exporter: gera os ícones (16/48/128 px) e a imagem promocional da loja (440x280).
# Logo: balão de conversa verde-azulado com seta de download, tentáculos de polvo e selo de ✓✓,
# em 3D (placa com espessura, esfera com luz, sombras suaves e brilho).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\make-images.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $root 'icons'
$storeDir = Join-Path $root 'store'
New-Item -ItemType Directory -Force $iconsDir, $storeDir | Out-Null

function C([int]$a, [int]$r, [int]$g, [int]$b) { [System.Drawing.Color]::FromArgb($a, $r, $g, $b) }
function P([float]$x, [float]$y) { [System.Drawing.PointF]::new($x, $y) }

# Paleta
$navyTop   = C 255 30 41 59     # #1E293B
$navy      = C 255 11 17 32     # #0B1120
$slabNavy  = C 255 2 6 23       # #020617
$tealLight = C 255 94 234 212   # #5EEAD4
$teal      = C 255 20 184 166   # #14B8A6
$tealMid   = C 255 13 148 136   # #0D9488
$tealDeep  = C 255 15 118 110   # #0F766E
$tealDark  = C 255 17 94 89     # #115E59
$tealSlab  = C 255 19 78 74     # #134E4A
$tickBlue  = C 255 56 189 248   # #38BDF8

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# Sombra suave: contornos cada vez mais finos e translúcidos sobre o caminho deslocado.
function Draw-SoftShadow($g, $path, [float]$dx, [float]$dy, [int]$blur, [int]$alpha, $rgb = @(0, 0, 0)) {
    $p = $path.Clone()
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Translate($dx, $dy)
    $p.Transform($m)
    $blur = [Math]::Max(1, $blur)
    $step = [Math]::Max(1, [int]($alpha / $blur))
    for ($i = $blur; $i -ge 1; $i--) {
        $pen = New-Object System.Drawing.Pen((C $step $rgb[0] $rgb[1] $rgb[2]), ($i * 2))
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawPath($pen, $p)
        $pen.Dispose()
    }
    $g.FillPath((New-Object System.Drawing.SolidBrush((C $alpha $rgb[0] $rgb[1] $rgb[2]))), $p)
}

# Desenha o logo. Coordenadas internas numa placa de 104 unidades.
# $fancy = espessura, sombras, ventosas e selo ✓✓ (48/128 px e promo). No 16 px fica só o essencial.
function Draw-Logo($g, [float]$ox, [float]$oy, [float]$size, [bool]$fancy) {
    if ($fancy) {
        $s = $size / 128.0
        $tx = $ox + 12 * $s; $ty = $oy + 8 * $s; $tw = 104 * $s
    } else {
        $tx = $ox; $ty = $oy; $tw = $size
    }
    $u = $tw / 104.0
    function Q([float]$x, [float]$y) { P ($tx + $x * $u) ($ty + $y * $u) }

    # --- Placa ---
    $radius = 24 * $u
    $tile = New-RoundedRect $tx $ty $tw $tw $radius
    if ($fancy) {
        $slab = New-RoundedRect $tx ($ty + 6 * $u) $tw $tw $radius
        Draw-SoftShadow $g $slab 0 (4 * $u) ([int](7 * $u)) 80 @(0, 0, 0)
        $g.FillPath((New-Object System.Drawing.SolidBrush($slabNavy)), $slab)
    }
    $face = New-Object System.Drawing.Drawing2D.LinearGradientBrush((P $tx $ty), (P $tx ($ty + $tw)), $navyTop, $navy)
    $g.FillPath($face, $tile)

    # Brilho ambiente verde-azulado atrás do balão
    $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glowPath.AddEllipse(($tx + 4 * $u), ($ty - 6 * $u), (96 * $u), (90 * $u))
    $glow = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
    $glow.CenterColor = C 70 20 184 166
    $glow.SurroundColors = [System.Drawing.Color[]]@((C 0 20 184 166))
    $state = $g.Save(); $g.SetClip($tile)
    $g.FillPath($glow, $glowPath)
    $g.Restore($state)

    # Em 16 px os tentáculos viram ruído: mostra só o balão maior com a seta.
    $tiny = $size -lt 32
    if ($tiny) { $bcx = 52; $bcy = 46; $br = 36 } else { $bcx = 52; $bcy = 36; $br = 26 }
    $k = $br / 26.0
    function B([float]$dx, [float]$dy) { Q ($bcx + $dx * $k) ($bcy + $dy * $k) }

    # --- Tentáculos (atrás do balão) ---
    if (-not $tiny) {
    $tentacles = @(
        @((Q 34 57), (Q 28.6 71), (Q 39 78), (Q 32.5 89)),
        @((Q 46.8 61), (Q 44.2 78), (Q 52 83), (Q 46.8 93)),
        @((Q 59.8 61), (Q 62.4 78), (Q 54.6 83), (Q 59.8 93)),
        @((Q 72.8 57), (Q 78 71), (Q 67.6 78), (Q 74.1 89))
    )
    $tBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush((Q 0 50), (Q 0 104), $teal, $tealDark)
    $tBrush.WrapMode = [System.Drawing.Drawing2D.WrapMode]::TileFlipXY
    $tPen = New-Object System.Drawing.Pen($tBrush, ([Math]::Max(1.6, 8 * $u)))
    $tPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $tPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    foreach ($t in $tentacles) {
        $tp = New-Object System.Drawing.Drawing2D.GraphicsPath
        $tp.AddBezier($t[0], $t[1], $t[2], $t[3])
        if ($fancy) {
            $shadowPen = New-Object System.Drawing.Pen((C 90 0 0 0), (9 * $u))
            $shadowPen.StartCap = 'Round'; $shadowPen.EndCap = 'Round'
            $m = New-Object System.Drawing.Drawing2D.Matrix; $m.Translate(0, (2 * $u))
            $sp = $tp.Clone(); $sp.Transform($m)
            $g.DrawPath($shadowPen, $sp)
        }
        $g.DrawPath($tPen, $tp)
    }
    if ($fancy) {
        # Ventosas
        $sucker = New-Object System.Drawing.SolidBrush((C 200 94 234 212))
        foreach ($pt in @(@(31.5, 74), @(33.5, 83), @(47.5, 78), @(58.5, 78), @(75, 74), @(73.5, 83))) {
            $r = 1.6 * $u
            $g.FillEllipse($sucker, ($tx + $pt[0] * $u - $r), ($ty + $pt[1] * $u - $r), (2 * $r), (2 * $r))
        }
    }
    }

    # --- Balão (esfera) ---
    $circle = New-Object System.Drawing.Drawing2D.GraphicsPath
    $circle.AddEllipse(($tx + ($bcx - $br) * $u), ($ty + ($bcy - $br) * $u), (2 * $br * $u), (2 * $br * $u))
    $tailPts = [System.Drawing.PointF[]]@((B -7.8 22), (B -28.6 32.5), (B -19.5 13))
    $tail = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tail.AddPolygon($tailPts)
    if ($fancy) {
        $bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
        $bubble.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding
        $bubble.AddPath($circle, $false)
        $bubble.AddPolygon([System.Drawing.PointF[]]@($tailPts[2], $tailPts[1], $tailPts[0]))
        Draw-SoftShadow $g $bubble 0 (4 * $u) ([int][Math]::Max(1, 5 * $u)) 110 @(0, 0, 0)
    }
    $tailBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush((B 0 10), (B -28 34), $teal, $tealDeep)
    $g.FillPath($tailBrush, $tail)
    $sphere = New-Object System.Drawing.Drawing2D.PathGradientBrush($circle)
    $sphere.CenterPoint = B -9 -11
    $sphere.CenterColor = $tealLight
    $sphere.SurroundColors = [System.Drawing.Color[]]@($tealDeep)
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $blend.Colors = @($tealDeep, $teal, $tealLight)
    $blend.Positions = @(0.0, 0.55, 1.0)
    $sphere.InterpolationColors = $blend
    $g.FillPath($sphere, $circle)

    # Brilho especular no topo do balão
    $gTop = B -19 -23
    $glossRect = New-Object System.Drawing.RectangleF($gTop.X, $gTop.Y, (24 * $k * $u), (12 * $k * $u))
    $gloss = New-Object System.Drawing.Drawing2D.LinearGradientBrush($glossRect, (C 150 255 255 255), (C 0 255 255 255), 90.0)
    $g.FillEllipse($gloss, $glossRect)

    # --- Seta de download ---
    $arrow = New-Object System.Drawing.Drawing2D.GraphicsPath
    $arrow.AddPolygon([System.Drawing.PointF[]]@(
        (B -4 -14), (B 4 -14), (B 4 1), (B 11 1), (B 0 13), (B -11 1), (B -4 1)
    ))
    if ($fancy) { Draw-SoftShadow $g $arrow 0 (2 * $u) ([int][Math]::Max(1, 2 * $u)) 90 @(4, 47, 46) }
    $aBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush((B 0 -14), (B 0 13), (C 255 255 255 255), (C 255 204 251 241))
    $g.FillPath($aBrush, $arrow)

    # --- Selo ✓✓ ---
    if ($fancy) {
        $bx = 80; $by = 17; $bR = 11
        $badge = New-Object System.Drawing.Drawing2D.GraphicsPath
        $badge.AddEllipse(($tx + ($bx - $bR) * $u), ($ty + ($by - $bR) * $u), (2 * $bR * $u), (2 * $bR * $u))
        Draw-SoftShadow $g $badge 0 (2 * $u) ([int][Math]::Max(1, 3 * $u)) 110 @(0, 0, 0)
        $bb = New-Object System.Drawing.Drawing2D.LinearGradientBrush((Q 0 6), (Q 0 28), $navyTop, $navy)
        $g.FillPath($bb, $badge)
        $g.DrawPath((New-Object System.Drawing.Pen($teal, (1.8 * $u))), $badge)
        $tick = New-Object System.Drawing.Pen($tickBlue, (2.4 * $u))
        $tick.StartCap = 'Round'; $tick.EndCap = 'Round'; $tick.LineJoin = 'Round'
        $g.DrawLines($tick, [System.Drawing.PointF[]]@((Q 72.5 17.5), (Q 75.3 20.3), (Q 80.3 13.8)))
        $g.DrawLines($tick, [System.Drawing.PointF[]]@((Q 78.4 19.6), (Q 79.1 20.3), (Q 84.6 13.8)))
    }

    # Borda de luz sutil na placa
    if ($fancy) { $g.DrawPath((New-Object System.Drawing.Pen((C 45 255 255 255), (1.0 * $u))), $tile) }
}

function New-Canvas([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    return @($bmp, $g)
}

foreach ($size in 16, 48, 128) {
    $bmp, $g = New-Canvas $size $size
    Draw-Logo $g 0 0 $size ($size -ge 48)
    $out = Join-Path $iconsDir "$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "ícone: $out"
}

# Logo grande (512 px) para README, redes sociais etc.
$bmp, $g = New-Canvas 512 512
Draw-Logo $g 0 0 512 $true
$out = Join-Path $storeDir 'logo-512.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "logo: $out"

# ---------- Imagem promocional pequena da Chrome Web Store: 440x280 ----------
$W = 440; $H = 280
$bmp, $g = New-Canvas $W $H
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush((P 0 0), (P $W $H), (C 255 2 6 23), (C 255 19 78 74))
$g.FillRectangle($bg, 0, 0, $W, $H)

# Grade sutil de "dados" ao fundo
$gridPen = New-Object System.Drawing.Pen((C 18 94 234 212), 1)
for ($x = 0; $x -le $W; $x += 22) { $g.DrawLine($gridPen, $x, 0, $x, $H) }
for ($y = 0; $y -le $H; $y += 22) { $g.DrawLine($gridPen, 0, $y, $W, $y) }

$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(-40, 0, 300, 280)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glow.CenterColor = C 130 20 184 166
$glow.SurroundColors = [System.Drawing.Color[]]@((C 0 20 184 166))
$g.FillPath($glow, $glowPath)

$floor = New-Object System.Drawing.Drawing2D.GraphicsPath
$floor.AddEllipse(38, 226, 144, 22)
$floorBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($floor)
$floorBrush.CenterColor = C 150 0 0 0
$floorBrush.SurroundColors = [System.Drawing.Color[]]@((C 0 0 0 0))
$g.FillPath($floorBrush, $floor)

Draw-Logo $g 26 64 168 $true

function Draw-Text($g, $text, $font, $brush, [float]$x, [float]$y) {
    $g.DrawString($text, $font, (New-Object System.Drawing.SolidBrush((C 120 0 0 0))), ($x + 1), ($y + 2))
    $g.DrawString($text, $font, $brush, $x, $y)
}

$white = [System.Drawing.Brushes]::White
$tealText = New-Object System.Drawing.SolidBrush($tealLight)
$muted = New-Object System.Drawing.SolidBrush((C 255 204 251 241))
$fTitle = New-Object System.Drawing.Font('Segoe UI Semibold', 32, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fSub   = New-Object System.Drawing.Font('Segoe UI', 12.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fChip  = New-Object System.Drawing.Font('Segoe UI Semibold', 12, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fTag   = New-Object System.Drawing.Font('Segoe UI', 12.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

Draw-Text $g 'Quantopus' $fTitle $white 204 52
Draw-Text $g 'Exporter' $fTitle $tealText 204 88
Draw-Text $g 'Exporte conversas do WhatsApp Web' $fSub $muted 206 132

$chips = @(@('TXT', 206), @('HTML', 254), @('CSV', 312), @('JSON', 360))
$angle = -4
foreach ($c in $chips) {
    $label = $c[0]; $x = [float]$c[1]; $y = 164
    $w = $g.MeasureString($label, $fChip).Width + 14
    $state = $g.Save()
    $g.TranslateTransform(($x + $w / 2), ($y + 12))
    $g.RotateTransform($angle)
    $chip = New-RoundedRect (-$w / 2) -12 $w 24 7
    $chipSlab = New-RoundedRect (-$w / 2) -9 $w 24 7
    Draw-SoftShadow $g $chipSlab 0 2 4 80 @(0, 0, 0)
    $g.FillPath((New-Object System.Drawing.SolidBrush($tealSlab)), $chipSlab)
    $cb = New-Object System.Drawing.Drawing2D.LinearGradientBrush((P 0 -12), (P 0 12), (C 255 45 212 191), $tealMid)
    $g.FillPath($cb, $chip)
    $g.DrawPath((New-Object System.Drawing.Pen((C 90 255 255 255), 1)), $chip)
    $sz = $g.MeasureString($label, $fChip)
    $g.DrawString($label, $fChip, $white, (-$sz.Width / 2), (-$sz.Height / 2))
    $g.Restore($state)
    $angle = -$angle
}

Draw-Text $g '100% local · nada sai do seu PC' $fTag $muted 206 208

$out = Join-Path $storeDir 'promo-440x280.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "promo: $out"
