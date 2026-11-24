param(
  [string]$ProjectName = "",
  [string]$ProjectId = "",
  [switch]$SendCtrlO,
  [switch]$ChipOnly
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CloudProjectSelectClick {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

function Find-Controls($window, $controlType) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    $controlType
  )

  return $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )
}

function Find-ByName($window, [string]$name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $name
  )

  return $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )
}

function Send-CtrlO($window) {
  $hwnd = New-Object IntPtr ($window.Current.NativeWindowHandle)
  [CloudProjectSelectClick]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait("^o")
}

function Click-ScreenPoint([int]$x, [int]$y) {
  [CloudProjectSelectClick]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [CloudProjectSelectClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [CloudProjectSelectClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Click-Element($window, $element) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) {
    return $false
  }

  $hwnd = New-Object IntPtr ($window.Current.NativeWindowHandle)
  [CloudProjectSelectClick]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 200
  $x = [int]($rect.X + ($rect.Width / 2))
  $y = [int]($rect.Y + ($rect.Height / 2))
  Click-ScreenPoint $x $y
  return $true
}

function Test-NameEquals([string]$name, [string]$expected) {
  return $name.Trim().ToLower() -eq $expected.Trim().ToLower()
}

function Get-HeaderNodes($window) {
  $windowRect = $window.Current.BoundingRectangle
  $minY = $windowRect.Y + 20
  $maxY = $windowRect.Y + 260
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $queue = New-Object System.Collections.Queue
  $nodes = New-Object System.Collections.ArrayList
  $queue.Enqueue($window)
  $seen = 0

  while ($queue.Count -gt 0 -and $seen -lt 4000) {
    $node = $queue.Dequeue()
    $seen++
    $rect = $null
    try {
      $rect = $node.Current.BoundingRectangle
    } catch {
      continue
    }

    $belowHeader = $rect.Width -gt 0 -and $rect.Y -gt $maxY -and $rect.Height -lt 80
    if (-not $belowHeader) {
      $child = $null
      try { $child = $walker.GetFirstChild($node) } catch { $child = $null }
      while ($child) {
        $queue.Enqueue($child)
        try { $child = $walker.GetNextSibling($child) } catch { break }
      }
    }

    if ($rect.Width -ge 16 -and $rect.Height -ge 12 -and $rect.Height -le 80 -and $rect.Y -ge $minY -and $rect.Y -le $maxY) {
      [void]$nodes.Add($node)
    }
  }

  return $nodes
}

function Find-HeaderSearch($window, $nodes) {
  $windowRect = $window.Current.BoundingRectangle
  $named = $null
  $namedWidth = 0
  $wide = $null
  $wideWidth = 0

  foreach ($control in $nodes) {
    $name = [string]$control.Current.Name
    $rect = $control.Current.BoundingRectangle
    if ($rect.Height -lt 20 -or $rect.Height -gt 70 -or $rect.Width -lt 80) {
      continue
    }

    $relY = $rect.Y - $windowRect.Y
    if ($relY -lt 40 -or $relY -gt 240) {
      continue
    }

    if ($name -like "*Search*" -and $rect.Width -gt $namedWidth) {
      $named = $control
      $namedWidth = $rect.Width
    }

    $center = $rect.X + ($rect.Width / 2)
    $windowCenter = $windowRect.X + ($windowRect.Width / 2)
    if ($rect.Width -gt 220 -and [Math]::Abs($center - $windowCenter) -lt ($windowRect.Width * 0.28) -and $rect.Width -gt $wideWidth) {
      $wide = $control
      $wideWidth = $rect.Width
    }
  }

  if ($named) {
    return $named
  }

  return $wide
}

function Find-ProjectChip($search, $nodes) {
  $searchRect = $search.Current.BoundingRectangle
  $searchMidY = $searchRect.Y + ($searchRect.Height / 2)
  $best = $null
  $bestScore = [double]::MinValue

  foreach ($control in $nodes) {
    $name = ([string]$control.Current.Name).Trim()
    if ($name -like "*Search*" -or $name -like "Google Cloud*") {
      continue
    }

    if ($name -match "menu|navigation|Dismiss|Notifications|Help|Start free") {
      continue
    }

    $rect = $control.Current.BoundingRectangle
    if ($rect.Width -lt 36 -or $rect.Width -gt 280 -or $rect.Height -lt 16 -or $rect.Height -gt 64) {
      continue
    }

    $midY = $rect.Y + ($rect.Height / 2)
    if ([Math]::Abs($midY - $searchMidY) -gt 22) {
      continue
    }

    if (($rect.X + $rect.Width) -ge ($searchRect.X - 4)) {
      continue
    }

    if (($searchRect.X - ($rect.X + $rect.Width)) -gt 220) {
      continue
    }

    $score = $rect.X + $rect.Width
    if ($name) {
      $score += 1000
    }

    if ($score -gt $bestScore) {
      $best = $control
      $bestScore = $score
    }
  }

  return $best
}

function Click-ProjectChip($window, $search, $nodes, [int]$offset, [bool]$forceOffset) {
  if (-not $forceOffset) {
    $chip = Find-ProjectChip $search $nodes
    if ($chip) {
      return Click-Element $window $chip
    }
  }

  $searchRect = $search.Current.BoundingRectangle
  if ($searchRect.Width -le 0 -or $searchRect.Height -le 0) {
    return $false
  }

  $hwnd = New-Object IntPtr ($window.Current.NativeWindowHandle)
  [CloudProjectSelectClick]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 200
  $x = [int]($searchRect.X - $offset)
  $y = [int]($searchRect.Y + ($searchRect.Height / 2))
  Click-ScreenPoint $x $y
  return $true
}

function Test-PickerOpen($window) {
  $patternId = [System.Windows.Automation.TextPattern]::Pattern
  foreach ($document in (Find-Controls $window ([System.Windows.Automation.ControlType]::Document))) {
    $patternObject = $null
    try {
      if (-not $document.TryGetCurrentPattern($patternId, [ref]$patternObject)) {
        continue
      }

      $text = $patternObject.DocumentRange.GetText(8000)
      if ($text -match "Search projects and folders" -or $text -match "Select a project") {
        return $true
      }
    } catch {
    }
  }

  foreach ($label in @("Select a project", "Search projects and folders")) {
    foreach ($control in (Find-ByName $window $label)) {
      $rect = $control.Current.BoundingRectangle
      if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
        return $true
      }
    }
  }

  return $false
}

function Find-ProjectRow($window, $search) {
  $searchBottom = $search.Current.BoundingRectangle.Y + $search.Current.BoundingRectangle.Height
  $best = $null
  $bestScore = -1
  $types = @(
    [System.Windows.Automation.ControlType]::DataItem,
    [System.Windows.Automation.ControlType]::ListItem,
    [System.Windows.Automation.ControlType]::TreeItem,
    [System.Windows.Automation.ControlType]::Hyperlink,
    [System.Windows.Automation.ControlType]::Text,
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::Custom
  )

  foreach ($controlType in $types) {
    foreach ($control in (Find-Controls $window $controlType)) {
      $name = ([string]$control.Current.Name).Trim()
      if (-not $name -or $name -like "*Search*" -or $name -eq "New project" -or $name -eq "Select a project") {
        continue
      }

      $rect = $control.Current.BoundingRectangle
      if ($rect.Width -le 0 -or $rect.Height -le 0 -or $rect.Y -lt ($searchBottom + 20)) {
        continue
      }

      if ($rect.Width -gt 900 -or $rect.Height -gt 80) {
        continue
      }

      $score = -1
      $parentName = ""
      try {
        $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($control)
        if ($parent) {
          $parentName = [string]$parent.Current.Name
        }
      } catch {
        $parentName = ""
      }

      $blob = "$name $parentName"
      if ($blob -like "*$ProjectId*") {
        $score = 30
      } elseif (Test-NameEquals $name $ProjectName) {
        $score = 20
      } elseif ($name.ToLower().StartsWith($ProjectName.Trim().ToLower())) {
        $score = 10
      }

      if ($score -gt $bestScore) {
        $best = $control
        $bestScore = $score
      }
    }
  }

  return $best
}

$deadline = (Get-Date).AddSeconds(35)
$chipClicked = $false
$ctrlSent = $false
$rowClicked = $false
$chipTries = 0
$chipOffsets = @(64, 96, 128, 48)

while ((Get-Date) -lt $deadline) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $chromeCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    "Chrome_WidgetWin_1"
  )
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $chromeCond
  )

  foreach ($win in $windows) {
    $title = [string]$win.Current.Name
    if ($title -notmatch "Welcome|Google Cloud|console\.cloud\.google\.com") {
      continue
    }

    if ($ChipOnly -and $chipClicked -and (Test-PickerOpen $win)) {
      Write-Output "CHIP_OPENED=1"
      exit 0
    }

    if ($rowClicked) {
      Write-Output "PROJECT_SELECTED=1"
      exit 0
    }

    $nodes = Get-HeaderNodes $win
    $search = Find-HeaderSearch $win $nodes
    if (-not $search) {
      continue
    }

    if (-not $chipClicked -or ($ChipOnly -and $chipTries -lt $chipOffsets.Count -and -not (Test-PickerOpen $win))) {
      $offset = $chipOffsets[[Math]::Min($chipTries, $chipOffsets.Count - 1)]
      if (Click-ProjectChip $win $search $nodes $offset ($chipTries -gt 0)) {
        $chipClicked = $true
        $chipTries++
        Start-Sleep -Milliseconds 800
      }
      continue
    }

    if ($ChipOnly) {
      continue
    }

    if ($SendCtrlO -and -not $ctrlSent) {
      Send-CtrlO $win
      $ctrlSent = $true
      Start-Sleep -Milliseconds 900
      continue
    }

    if (Test-PickerOpen $win) {
      $row = Find-ProjectRow $win $search
      if ($row -and (Click-Element $win $row)) {
        $rowClicked = $true
        Start-Sleep -Milliseconds 800
      }
    }
  }

  Start-Sleep -Milliseconds 700
}

if ($ChipOnly) {
  [Console]::Error.WriteLine("The project picker in the header was not opened.")
} else {
  [Console]::Error.WriteLine("Google chat was not selected from the project list.")
}
exit 1
