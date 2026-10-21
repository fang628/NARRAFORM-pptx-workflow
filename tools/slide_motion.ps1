# Native slide transitions only. No delayed page animation and no macros.
function Get-NarraformShapeKey($Shape) {
    $stored = [string]$Shape.Tags.Item('NARRAFORM_KEY')
    if ($stored) { return $stored }
    $name = [string]$Shape.Name
    if ($name.StartsWith('!!nf-page-')) { return ($name -replace '^!!nf-page-\d+--', '') }
    if ($name.StartsWith('!!nf-progress-')) { return $name.Substring(2) }
    if ($name.StartsWith('!!nf-footer-')) { return $name.Substring(2) }
    return $name
}
function Set-NarraformMotion($Deck, $Plan) {
    $report = @()
    foreach ($page in $Plan.pages) {
        $slide = $Deck.Slides.Item([int]$page.index + 1)
        $sequence = $slide.TimeLine.MainSequence
        for ($i = $sequence.Count; $i -ge 1; $i--) {
            $key = Get-NarraformShapeKey $sequence.Item($i).Shape
            if ($key.StartsWith('nf-progress-') -or $key.StartsWith('nf-footer-')) { $sequence.Item($i).Delete() }
        }
        foreach ($shape in $slide.Shapes) {
            $key = Get-NarraformShapeKey $shape
            $shape.Tags.Add('NARRAFORM_KEY', $key)
            if ($Plan.settings.enabled) {
                # Match native main titles and navigation across slides.
                # Artistic/calligraphy image titles remain ordinary pictures.
                if ($key.StartsWith('nf-progress-') -or $key.StartsWith('nf-footer-')) { $shape.Name = '!!' + $key }
                elseif ($page.title -and $key -eq [string]$page.title.key -and [string]$page.title.kind -eq 'text') { $shape.Name = '!!nf-title-text' }
                else { $shape.Name = '!!nf-page-' + [string]$page.index + '--' + $key }
            } else { $shape.Name = $key }
        }
        $kind = 'none'
        $duration = [double]$page.duration
        if ($page.transition) { $kind = [string]$page.transition.type; $duration = [double]$page.transition.duration }
        elseif ($page.fade) { $kind = 'fade' }
        $slide.SlideShowTransition.EntryEffect = 0
        $slide.SlideShowTransition.AdvanceOnClick = -1
        $slide.SlideShowTransition.AdvanceOnTime = 0
        if ($kind -eq 'morph') {
            $slide.SlideShowTransition.EntryEffect = 3954 # ppEffectMorphByObject
            $slide.SlideShowTransition.Duration = [single]$duration
        } elseif ($kind -eq 'fade') {
            $slide.SlideShowTransition.EntryEffect = 3849 # ppEffectFadeSmoothly
            $slide.SlideShowTransition.Duration = [single]$duration
        }
        $labelCount = 0
        if ($page.labelChanges) { $labelCount = @($page.labelChanges).Count }
        $report += @{index=[int]$page.index;fade=($kind -eq 'fade');transition=$kind;duration=$duration;startDelay=0;progressEffects=0;progressMorph=($kind -eq 'morph' -and $null -ne $page.progress);titleMorph=($kind -eq 'morph' -and $page.titleMorph);title=$page.title;labelMorphCount=$labelCount;progress=$page.progress}
    }
    return @{version=3;renderer='Microsoft PowerPoint';pages=$report}
}
