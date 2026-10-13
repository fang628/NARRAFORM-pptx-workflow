param([Parameter(Mandatory=$true)][string]$DeckPath,[Parameter(Mandatory=$true)][string]$OutputDir)
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
function Invoke-OfficeCall([scriptblock]$Operation) {
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        try { return (& $Operation) } catch {
            if ($attempt -ge 5) { throw }
            Start-Sleep -Milliseconds 400
        }
    }
}
try {
    $app = New-Object -ComObject PowerPoint.Application
    $deck = Invoke-OfficeCall { $app.Presentations.Open($deckFile, -1, 0, 0) }
    if ([Math]::Abs($deck.PageSetup.SlideWidth / $deck.PageSetup.SlideHeight - 16.0 / 9.0) -gt 0.00001) { throw 'PPTX must be 16:9' }
    $pages = @()
    for ($index = 1; $index -le $deck.Slides.Count; $index++) {
        $file = 'S{0:D2}.png' -f $index
        $image = Join-Path $renderDir $file
        Invoke-OfficeCall { $deck.Slides.Item($index).Export($image, 'PNG', 1920, 1080) }
        $pages += @{index=$index-1;file=$file;sha256=(File-SHA256 $image)}
    }
    Invoke-OfficeCall { $deck.SaveAs((Join-Path $renderDir 'deck.pdf'),32) }
    $manifest = @{renderer='Microsoft PowerPoint';version=$app.Version;pages=$pages;at=[DateTime]::UtcNow.ToString('o');pptx_sha256=(File-SHA256 $deckFile)}
    $json = $manifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $renderDir 'render-manifest.json'),$json,[Text.UTF8Encoding]::new($false))
    Write-Output $json
} finally {
    if ($null -ne $deck) { $deck.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck) }
    if ($null -ne $app) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
