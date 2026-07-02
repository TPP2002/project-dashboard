# make-icon.ps1 —— 生成「项目管理看板」品牌图标 icon.ico（多尺寸，System.Drawing 绘制）
# 图形：圆角渐变底（靛蓝→蓝）+ 三条白色泳道 + 每道若干卡片（带状态色左条），一眼是「看板」。
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([int]$x,[int]$y,[int]$w,[int]$h,[int]$r){
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r*2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x+$w-$d, $y, $d, $d, 270, 90)
  $p.AddArc($x+$w-$d, $y+$h-$d, $d, $d, 0, 90)
  $p.AddArc($x, $y+$h-$d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Master([int]$S){
  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $f = $S / 256.0

  # 底：圆角渐变方块
  $m = [int](12*$f)
  $bg = New-RoundedPath $m $m ($S-2*$m) ($S-2*$m) ([int](52*$f))
  $rect = New-Object System.Drawing.Rectangle($m,$m,($S-2*$m),($S-2*$m))
  $c1 = [System.Drawing.Color]::FromArgb(255, 99, 91, 255)   # 靛蓝 #635BFF
  $c2 = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)   # 蓝 #2563EB
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)
  $g.FillPath($grad, $bg)

  # 三条泳道
  $laneW = [int](54*$f)
  $laneTop = [int](74*$f)
  $laneBot = [int](200*$f)
  $laneH = $laneBot - $laneTop
  $gap = [int](18*$f)
  $totalW = 3*$laneW + 2*$gap
  $startX = [int](($S - $totalW)/2)
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(240,255,255,255))
  # 状态色：灰/琥珀/绿（呼应看板状态色）
  $statusCols = @(
    [System.Drawing.Color]::FromArgb(255,148,163,184),  # 灰
    [System.Drawing.Color]::FromArgb(255,245,158,11),   # 琥珀
    [System.Drawing.Color]::FromArgb(255,34,197,94)     # 绿
  )
  $cardsPerLane = @(3,2,2)
  for($i=0;$i -lt 3;$i++){
    $lx = $startX + $i*($laneW+$gap)
    $lane = New-RoundedPath $lx $laneTop $laneW $laneH ([int](12*$f))
    $g.FillPath($white, $lane)
    # 卡片
    $cardH = [int](26*$f)
    $cardGap = [int](12*$f)
    $pad = [int](8*$f)
    for($k=0;$k -lt $cardsPerLane[$i];$k++){
      $cy = $laneTop + $pad + $k*($cardH+$cardGap)
      $cx = $lx + $pad
      $cw = $laneW - 2*$pad
      $card = New-RoundedPath $cx $cy $cw $cardH ([int](5*$f))
      $cardBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,226,232,240)) # 浅灰蓝
      $g.FillPath($cardBrush, $card)
      # 左侧状态色条
      $bar = New-RoundedPath $cx $cy ([int](6*$f)) $cardH ([int](3*$f))
      $barBrush = New-Object System.Drawing.SolidBrush($statusCols[$i])
      $g.FillPath($barBrush, $bar)
      $cardBrush.Dispose(); $barBrush.Dispose()
    }
  }
  $g.Dispose()
  return $bmp
}

# 主图 256，其余尺寸高质量缩放
$master = Draw-Master 256
$sizes = @(256,128,64,48,32,16)
$pngs = @()
foreach($s in $sizes){
  $bm = New-Object System.Drawing.Bitmap($s,$s,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = [System.Drawing.Graphics]::FromImage($bm)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gg.DrawImage($master, 0, 0, $s, $s)
  $gg.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bm.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += ,($ms.ToArray())
  $bm.Dispose(); $ms.Dispose()
}
$master.Dispose()

# 组装 ICO 容器
$outDir = Join-Path $PSScriptRoot "assets"
if(-not (Test-Path $outDir)){ New-Item -ItemType Directory -Path $outDir | Out-Null }
$out = Join-Path $outDir "icon.ico"
$fs = New-Object System.IO.FileStream($out,[System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)      # reserved
$bw.Write([UInt16]1)      # type=icon
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16*$sizes.Count
for($i=0;$i -lt $sizes.Count;$i++){
  $s = $sizes[$i]; $len = $pngs[$i].Length
  $dim = if($s -ge 256){0}else{$s}
  $bw.Write([Byte]$dim)   # width (0=256)
  $bw.Write([Byte]$dim)   # height
  $bw.Write([Byte]0)      # colors
  $bw.Write([Byte]0)      # reserved
  $bw.Write([UInt16]1)    # planes
  $bw.Write([UInt16]32)   # bpp
  $bw.Write([UInt32]$len) # bytes
  $bw.Write([UInt32]$offset)
  $offset += $len
}
foreach($p in $pngs){ $bw.Write($p) }
$bw.Flush(); $bw.Close(); $fs.Close()
Write-Output ("icon.ico 已生成: {0} ({1} 字节, {2} 尺寸)" -f $out, (Get-Item $out).Length, $sizes.Count)
