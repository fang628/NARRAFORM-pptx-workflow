param([Parameter(Mandatory=$true)][string]$DeckPath,[Parameter(Mandatory=$true)][string]$OutputPath,[Parameter(Mandatory=$true)][int]$PageNumber,[Parameter(Mandatory=$true)][string]$ObjectId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'office_lock.ps1')
function Find-SourceShape($Shapes, [string]$Id) {
    foreach ($shape in $Shapes) {
        if ([string]$shape.Id -eq $Id) { return $shape }
        if ($shape.Type -eq 6) {
            $child = Find-SourceShape $shape.GroupItems $Id
            if ($null -ne $child) { return $child }
        }
    }
    return $null
}
$officeLock = $null
$app = $null
$deck = $null
try {
    $source = (Resolve-Path -LiteralPath $DeckPath).Path
    $target = [IO.Path]::GetFullPath($OutputPath)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    $officeLock = Enter-NarraformOfficeRender
    $app = New-Object -ComObject PowerPoint.Application
    # Read-only source: export the actual object, never crop a slide screenshot.
    $deck = $app.Presentations.Open($source, -1, 0, 0)
    if ($PageNumber -lt 1 -or $PageNumber -gt $deck.Slides.Count) { throw 'Source slide does not exist' }
    $shape = Find-SourceShape $deck.Slides.Item($PageNumber).Shapes $ObjectId
    if ($null -eq $shape) { throw 'Source object does not exist' }
    # ppShapeFormatPNG=2; ppScaleXY=4 exports only the selected source object.
    $scale = [Math]::Min(4.0, 4096.0 / [Math]::Max(1.0, [Math]::Max($shape.Width, $shape.Height)))
    $shape.Export($target, 2, [int][Math]::Max(1, $shape.Width*$scale), [int][Math]::Max(1, $shape.Height*$scale), 4)
    Add-Type -AssemblyName System.Drawing
    $image = [Drawing.Image]::FromFile($target)
    try { @{width=$image.Width;height=$image.Height;file=[IO.Path]::GetFileName($target)} | ConvertTo-Json -Compress }
    finally { $image.Dispose() }
} finally {
    try {
        if ($null -ne $deck) { $deck.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck) }
    } finally {
        try { if ($null -ne $app) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } }
        finally { Exit-NarraformOfficeRender $officeLock }
    }
}
