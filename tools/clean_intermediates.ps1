param([switch]$PreviewOnly)
$ErrorActionPreference = 'Stop'

# This tool cleans known development/test output only. Never follow reparse
# points (including Windows junctions), and never enter project data or exports.
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$cleanupRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'work'))
$rootPrefix = $cleanupRoot.TrimEnd('\') + '\'
$files = New-Object 'System.Collections.Generic.List[object]'
$directories = New-Object 'System.Collections.Generic.List[string]'
$skippedLinks = New-Object 'System.Collections.Generic.List[string]'

function Assert-SafePath([string]$FilePath) {
    $absolute = [IO.Path]::GetFullPath($FilePath)
    if ($absolute -ne $cleanupRoot -and -not $absolute.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the cleanup directory: $absolute"
    }
    for ($parent = $absolute; $parent; $parent = Split-Path -Parent $parent) {
        $item = Get-Item -LiteralPath $parent -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked path is protected: $parent" }
        if ($parent -eq $projectRoot) { return }
    }
    throw 'Unable to verify the project root.'
}

function Find-TestOutput([string]$FilePath) {
    $item = Get-Item -LiteralPath $FilePath -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $skippedLinks.Add($item.FullName)
        return
    }
    # Scanning only descends through directories checked above. Full ancestor
    # checks run again on the complete plan before any deletion.
    if (-not $item.FullName.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Scan target is outside the work directory.'
    }
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { Find-TestOutput $child.FullName }
        # Child directories precede their parents, so empty directories can be
        # removed without recursive deletion after the file plan is processed.
        $directories.Add($item.FullName)
    } else {
        $files.Add([pscustomobject]@{Path=$item.FullName; Bytes=$item.Length; Ticks=$item.LastWriteTimeUtc.Ticks})
    }
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'server.mjs')) -or
        -not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json'))) { throw 'This is not a NARRAFORM project directory.' }
    if (-not (Test-Path -LiteralPath $cleanupRoot)) { Write-Host 'No work directory. Nothing to clean.'; exit 0 }
    Assert-SafePath $cleanupRoot

    $prefixes = @(
        'actual-rebuild-check','adaptive-progress','ai-image-edit','analysis-fallback','artifact-storage',
        'artistic-text','artistic-matte-replay','automatic-mode','content-recovery','current-calligraphy',
        'cutout-fallback','design-editing','directional-elements','frame-repair','frame-restoration',
        'frontend-resources','frontend-modules',
        'image-task-queue','missing-theme-candidates','native-effects','native-font-instance','native-gradient',
        'native-motion','open-fonts','outline-edit-test','page-design-retry','page-reuse','placeholder-fallback',
        'placeholder-geometry','progress-align','progress-reference','progress-regeneration','rebuild-partial',
        'rebuild-reuse','rebuild-tool-partial','rebuild-permissive','reuse','scoped-rebuild',
        'source-evidence-api','svg-actual-repro','svg-filter-replay','svg-pattern','title-rule-compat',
        'table-content','table-extract','table-http','text-spacing','theme-assets','theme-confirmation',
        'theme-photo','title-fonts','transparent-retry','visual-analysis','visual-treatment'
    )
    $fixturePattern = '^(?:' + (($prefixes | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')-(?:[a-zA-Z0-9_]{6,12}|[0-9]{13}|[0-9]+-[0-9]{13})$'
    $debugPattern = '^(?:expanded-cutout-(?:check|composite|report)|footer-(?:overflow-fixed|scroll-check)|reference-cutout-check)\.(?:png|json)$|^before-content-restore-[0-9]{8}-[0-9]{6}\.json$'
    foreach ($entry in @(Get-ChildItem -LiteralPath $cleanupRoot -Force)) {
        if (($entry.PSIsContainer -and $entry.Name -match $fixturePattern) -or
            (-not $entry.PSIsContainer -and $entry.Name -match $debugPattern)) { Find-TestOutput $entry.FullName }
    }
    $totalBytes = 0L
    foreach ($file in $files) { $totalBytes += $file.Bytes }
    Write-Host ''
    Write-Host 'NARRAFORM - intermediate file cleanup'
    Write-Host "Scope: $cleanupRoot"
    Write-Host ('Files: {0}; size: {1:N2} MiB; skipped links: {2}' -f $files.Count, ($totalBytes/1MB), $skippedLinks.Count)
    Write-Host 'Includes: known test output, cutout/debug images and temporary recovery snapshots.'
    Write-Host 'Kept: data, exports, materials, undo history, fonts, dependencies and source code.'
    Write-Host 'Kept: current-rebuild-scenes, progress demos and material preparation notes.'
    Write-Host 'Kept: service logs. Links are skipped; their targets are never scanned or deleted.'
    if ($PreviewOnly) { Write-Host 'Preview only. No files deleted.'; exit 0 }
    if ($files.Count -eq 0) { Write-Host 'Nothing to clean.'; exit 0 }
    if ((Read-Host 'Type DELETE to remove these test/debug files; Enter cancels') -cne 'DELETE') {
        Write-Host 'Cancelled. No files deleted.'
        exit 0
    }

    # Stop if a test suite could still be writing into work/. No service is killed.
    $runningTests = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -match '(?:^|\s)--test(?:\s|=|$)|tests[\\/].*\.test\.mjs'
    })
    if ($runningTests.Count) { throw 'A Node test suite is running. Stop it and rerun this script.' }

    # Validate the complete plan again before removing anything. Refuse changed
    # files and new links instead of deleting a different file after confirmation.
    foreach ($file in $files) {
        Assert-SafePath $file.Path
        $item = Get-Item -LiteralPath $file.Path -Force
        if ($item.PSIsContainer -or $item.Length -ne $file.Bytes -or $item.LastWriteTimeUtc.Ticks -ne $file.Ticks) {
            throw 'Files changed after scanning. Rerun this script.'
        }
    }
    $deletedFiles = 0
    $deletedBytes = 0L
    try {
        foreach ($file in $files) {
            Assert-SafePath $file.Path
            Remove-Item -LiteralPath $file.Path -Force
            $deletedFiles++
            $deletedBytes += $file.Bytes
        }
        foreach ($directory in $directories) {
            Assert-SafePath $directory
            if (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) { [IO.Directory]::Delete($directory, $false) }
        }
    } finally {
        Write-Host ('Deleted: {0} files; freed: {1:N2} MiB.' -f $deletedFiles, ($deletedBytes/1MB))
    }
    Write-Host 'Cleanup complete. No application data was changed.'
} catch {
    Write-Host ('Cleanup stopped: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
