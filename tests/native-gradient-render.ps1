param([Parameter(Mandatory=$true)][string]$DeckPath,[Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$file=(Resolve-Path -LiteralPath $DeckPath).Path
$folder=[IO.Path]::GetFullPath($OutputDir)
[IO.Directory]::CreateDirectory($folder) | Out-Null
$app=$null;$deck=$null
$officeLock=$null
. (Join-Path $PSScriptRoot '../tools/office_lock.ps1')
try {
    $officeLock=Enter-NarraformOfficeRender
    $app=New-Object -ComObject PowerPoint.Application
    $deck=$app.Presentations.Open($file,-1,0,0)
    $slide=$deck.Slides.Item(1)
    $objects=@()
    foreach($shape in $slide.Shapes){
        $text='';$fill=$shape.Fill
        if($shape.HasTextFrame -ne 0 -and $shape.TextFrame2.HasText -ne 0){$text=[string]$shape.TextFrame2.TextRange.Text;$fill=$shape.TextFrame2.TextRange.Font.Fill}
        $stops=@()
        if($fill.Type -eq 3){foreach($stop in $fill.GradientStops){$stops+=@{position=[double]$stop.Position;transparency=[double]$stop.Transparency;rgb=[int]$stop.Color.RGB}}}
        $objects+=@{name=[string]$shape.Name;text=$text;fillType=[int]$fill.Type;stops=$stops}
    }
    $slide.Export((Join-Path $folder 'S01.png'),'PNG',1920,1080)
    # Both operations edit native color stops, without replacing any object.
    $slide.Shapes.Item('linear-block').Fill.GradientStops.Item(1).Color.RGB=65280
    $slide.Shapes.Item('title').TextFrame2.TextRange.Font.Fill.GradientStops.Item(1).Color.RGB=65280
    $deck.SaveAs((Join-Path $folder 'roundtrip.pptx'),24)
    $slide.Export((Join-Path $folder 'S01-edited.png'),'PNG',1920,1080)
    $result=@{renderer='Microsoft PowerPoint';objects=$objects;roundtrip='roundtrip.pptx'} | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $folder 'gradient-manifest.json'),$result,[Text.UTF8Encoding]::new($false))
    Write-Output $result
} finally {
    try {
        if($null -ne $deck){$deck.Close();[void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck)}
    } finally {
        try { if($null -ne $app){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)} }
        finally { Exit-NarraformOfficeRender $officeLock }
    }
}
