param([Parameter(Mandatory=$true)][string]$DeckPath,[Parameter(Mandatory=$true)][string]$OutputDir,[string]$MotionSpec='')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function File-SHA256([string]$FilePath) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($FilePath)))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
}
$deckFile = (Resolve-Path -LiteralPath $DeckPath).Path
$renderDir = [IO.Path]::GetFullPath($OutputDir)
[IO.Directory]::CreateDirectory($renderDir) | Out-Null
$app = $null
$deck = $null
$officeLock = $null
. (Join-Path $PSScriptRoot 'office_lock.ps1')
function Invoke-OfficeCall([scriptblock]$Operation) {
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        try { return (& $Operation) } catch {
            if ($attempt -ge 5) { throw }
            Start-Sleep -Milliseconds 400
        }
    }
}
try {
    $officeLock = Enter-NarraformOfficeRender
    $app = Invoke-OfficeCall { New-Object -ComObject PowerPoint.Application }
    $readOnly = -1
    if ($MotionSpec) { $readOnly = 0 }
    $deck = Invoke-OfficeCall { $app.Presentations.Open($deckFile, $readOnly, 0, 0) }
    . (Join-Path $PSScriptRoot 'slide_motion.ps1')
    if ($MotionSpec) {
        $motion = Get-Content -LiteralPath $MotionSpec -Raw -Encoding UTF8 | ConvertFrom-Json
        $motionReport = Set-NarraformMotion $deck $motion
        $deck.Save()
        [IO.File]::WriteAllText((Join-Path $renderDir 'animation-manifest.json'), ($motionReport | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    }
    if ([Math]::Abs($deck.PageSetup.SlideWidth / $deck.PageSetup.SlideHeight - 16.0 / 9.0) -gt 0.00001) { throw 'PPTX must be 16:9' }
    $pages = @()
    for ($index = 1; $index -le $deck.Slides.Count; $index++) {
        $slide = $deck.Slides.Item($index)
        $scale = 1600.0 / $deck.PageSetup.SlideWidth
        $texts = @()
        $measurementErrors = @()
        foreach ($shape in $slide.Shapes) {
            try {
                if ($shape.HasTextFrame -ne 0 -and $shape.TextFrame2.HasText -ne 0) {
                    $range = $shape.TextFrame2.TextRange
                    $texts += @{
                        key = Get-NarraformShapeKey $shape
                        x = [double]$shape.Left * $scale
                        y = [double]$shape.Top * $scale
                        w = [double]$shape.Width * $scale
                        h = [double]$shape.Height * $scale
                        boundWidth = [double]$range.BoundWidth * $scale
                        boundHeight = [double]$range.BoundHeight * $scale
                        fontSize = [double]$range.Font.Size / 0.6
                    }
                }
            } catch {
                $measurementErrors += @{key=[string]$shape.Name;error=$_.Exception.Message}
            }
        }
        $file = 'S{0:D2}.png' -f $index
        $image = Join-Path $renderDir $file
        Invoke-OfficeCall { $deck.Slides.Item($index).Export($image, 'PNG', 1920, 1080) }
        $pages += @{index=$index-1;file=$file;sha256=(File-SHA256 $image);texts=$texts;measurementErrors=$measurementErrors}
    }
    Invoke-OfficeCall { $deck.SaveAs((Join-Path $renderDir 'deck.pdf'),32) }
    $manifest = @{renderer='Microsoft PowerPoint';version=$app.Version;pages=$pages;at=[DateTime]::UtcNow.ToString('o');pptx_sha256=(File-SHA256 $deckFile)}
    $json = $manifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $renderDir 'render-manifest.json'),$json,[Text.UTF8Encoding]::new($false))
    Write-Output $json
} finally {
    try {
        if ($null -ne $deck) { $deck.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck) }
    } finally {
        try { if ($null -ne $app) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } }
        finally { Exit-NarraformOfficeRender $officeLock }
    }
}
