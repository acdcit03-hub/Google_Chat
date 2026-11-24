param(
  [Parameter(Mandatory = $true)][string]$ProjectName,
  [Parameter(Mandatory = $true)][string]$ProjectId
)

$ErrorActionPreference = "Stop"
$script:pageProjectId = $null

function Publish-PageProjectId([string]$name) {
  if ($script:pageProjectId) {
    return
  }

  if ($name -match 'Project ID:\s*([a-z][a-z0-9-]{4,28}[a-z0-9])') {
    $script:pageProjectId = $Matches[1]
  }
}

function Read-VisibleProjectId($window) {
  if ($script:pageProjectId) {
    return
  }

  $patternId = [System.Windows.Automation.TextPattern]::Pattern
  foreach ($document in (Find-Controls $window ([System.Windows.Automation.ControlType]::Document))) {
    $patternObject = $null
    try {
      if (-not $document.TryGetCurrentPattern($patternId, [ref]$patternObject)) {
        continue
      }

      Publish-PageProjectId $patternObject.DocumentRange.GetText(12000)
      if ($script:pageProjectId) {
        return
      }

      $found = $patternObject.DocumentRange.FindText("Project ID:", $false, $true)
      if ($found) {
        $line = $found.Clone()
        $line.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Line)
        Publish-PageProjectId $line.GetText(300)
      }
    } catch {
    }

    if ($script:pageProjectId) {
      return
    }
  }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CloudProjectFormClick {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern uint GetDpiForWindow(IntPtr hWnd);
}
"@

function Escape-SendKeys([string]$text) {
  return [regex]::Replace($text, '([+^%~(){}\[\]])', '{$1}')
}

function Test-IsSearch($element) {
  $name = [string]$element.Current.Name
  return $name -like "*Search*"
}

function Get-ElementValue($element) {
  $patternObject = $null
  $valuePattern = [System.Windows.Automation.ValuePattern]::Pattern
  if ($element.TryGetCurrentPattern($valuePattern, [ref]$patternObject)) {
    return [string]$patternObject.Current.Value
  }

  return ""
}

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

function Test-IsEditLink($element) {
  if (Test-IsSearch $element) {
    return $false
  }

  $name = ([string]$element.Current.Name).Trim()
  if ($name -eq "Edit") {
    return $true
  }

  if ($name -like "*cannot be changed later*") {
    return $true
  }

  return $name -match '(^|[^A-Za-z])Edit$'
}

function Test-IsInTopBar($window, $element) {
  $windowRect = $window.Current.BoundingRectangle
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) {
    return $false
  }

  return ($rect.Y - $windowRect.Y) -lt 160
}

function Test-IsProjectIdField($window, $element) {
  if (Test-IsSearch $element) {
    return $false
  }

  $name = ([string]$element.Current.Name).Trim()
  if ($name -like "*Project name*") {
    return $false
  }

  if ($name -like "*Project ID*") {
    return $true
  }

  if (Test-IsInTopBar $window $element) {
    return $false
  }

  $value = Get-ElementValue $element
  return $value -match '^[a-z][a-z0-9]+(?:-[a-z0-9]+)+$'
}

function Find-First($window, $controlTypes, [scriptblock]$test) {
  foreach ($controlType in $controlTypes) {
    $found = Find-Controls $window $controlType
    foreach ($control in $found) {
      if (& $test $control) {
        return $control
      }
    }
  }

  return $null
}

function Click-ScreenPoint([int]$x, [int]$y) {
  [CloudProjectFormClick]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [CloudProjectFormClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [CloudProjectFormClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Measure-TextWidth([string]$text, [double]$scale) {
  Add-Type -AssemblyName System.Drawing
  $font = New-Object System.Drawing.Font("Segoe UI", 12)
  $bitmap = New-Object System.Drawing.Bitmap(1, 1)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $width = $graphics.MeasureString($text, $font).Width * $scale
  $graphics.Dispose()
  $bitmap.Dispose()
  $font.Dispose()
  return $width
}

function Find-ProjectIdLineNode($start) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $origin = $start
  for ($level = 0; $level -lt 8; $level++) {
    $parent = $walker.GetParent($origin)
    if (-not $parent) { break }
    $origin = $parent
  }

  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($origin)
  $seen = 0
  while ($queue.Count -gt 0 -and $seen -lt 3000) {
    $node = $queue.Dequeue()
    $seen++
    $name = ""
    try { $name = [string]$node.Current.Name } catch { $name = "" }
    Publish-PageProjectId $name
    if ($name -like "*Project ID:*changed later*") {
      return $node
    }
    if ($name.Trim() -eq "Edit") {
      $editRect = $node.Current.BoundingRectangle
      if ($editRect.Width -gt 0 -and $editRect.Width -lt 120) {
        return $node
      }
    }

    $child = $walker.GetFirstChild($node)
    while ($child) {
      $queue.Enqueue($child)
      $child = $walker.GetNextSibling($child)
    }
  }

  return $null
}

function Click-EditWordOnLine($nameEdit, $hwnd) {
  $nameRect = $nameEdit.Current.BoundingRectangle
  $dpi = [CloudProjectFormClick]::GetDpiForWindow($hwnd)
  $scale = 1.0
  if ($dpi -gt 0) { $scale = $dpi / 96.0 }

  $node = Find-ProjectIdLineNode $nameEdit
  if ($node) {
    $text = ([string]$node.Current.Name).Trim()
    $rect = $node.Current.BoundingRectangle
    if ($text -eq "Edit" -and $rect.Width -gt 0 -and $rect.Width -lt (80 * $scale)) {
      Click-ScreenPoint ([int]($rect.X + ($rect.Width / 2))) ([int]($rect.Y + ($rect.Height / 2)))
      return $true
    }

    if ($text -like "*changed later*" -and $rect.Width -gt 0) {
      $prefix = $text
      if ($text -match '^(.*changed later\.)\s*') {
        $prefix = $Matches[1] + " "
      }
      $prefixWidth = Measure-TextWidth $prefix $scale
      $editWidth = Measure-TextWidth "Edit" $scale
      $x = [int]($rect.X + $prefixWidth + ($editWidth / 2))
      if ($x -gt ($rect.X + $rect.Width - 4)) {
        $x = [int]($rect.X + $rect.Width - ($editWidth / 2))
      }
      $y = [int]($rect.Y + ($rect.Height / 2))
      Click-ScreenPoint $x $y
      return $true
    }
  }

  return $false
}

function Click-MarkedEdit($window, $nameEdit) {
  $patternId = [System.Windows.Automation.TextPattern]::Pattern
  $documentType = [System.Windows.Automation.ControlType]::Document
  foreach ($document in (Find-Controls $window $documentType)) {
    $patternObject = $null
    if (-not $document.TryGetCurrentPattern($patternId, [ref]$patternObject)) {
      continue
    }

    $match = $patternObject.DocumentRange.FindText("later. Edit", $false, $true)
    if (-not $match) {
      continue
    }

    $rects = @($match.GetBoundingRectangles())
    if ($rects.Count -lt 4) {
      continue
    }

    $last = $rects.Count - 4
    $x = [int]($rects[$last] + $rects[$last + 2] - 14)
    $y = [int]($rects[$last + 1] + ($rects[$last + 3] / 2))
    if ($nameEdit) {
      try {
        $nameRect = $nameEdit.Current.BoundingRectangle
        if ($y -lt ($nameRect.Y + $nameRect.Height - 8)) {
          continue
        }
      } catch {
      }
    }

    Click-ScreenPoint $x $y
    return $true
  }

  return $false
}

function Open-Element($element) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
    $name = ([string]$element.Current.Name).Trim()
    $x = [int]($rect.X + ($rect.Width / 2))
    $y = [int]($rect.Y + ($rect.Height / 2))
    if ($name -like "*cannot be changed later*") {
      Add-Type -AssemblyName System.Drawing
      $font = New-Object System.Drawing.Font("Segoe UI", 13)
      $bitmap = New-Object System.Drawing.Bitmap(1, 1)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $prefix = $name
      if ($name -match '^(.*changed later\.)\s*') {
        $prefix = $Matches[1] + " "
      }
      $prefixWidth = $graphics.MeasureString($prefix, $font).Width
      $editWidth = $graphics.MeasureString("Edit", $font).Width
      $x = [int]($rect.X + $prefixWidth + ($editWidth / 2))
      $graphics.Dispose()
      $bitmap.Dispose()
      $font.Dispose()
    }
    Click-ScreenPoint $x $y
    return
  }

  $patternObject = $null
  $invokePattern = [System.Windows.Automation.InvokePattern]::Pattern
  if ($element.TryGetCurrentPattern($invokePattern, [ref]$patternObject)) {
    $patternObject.Invoke()
    return
  }

  throw "Project ID Edit link could not be clicked."
}

function Set-EditValue($element, [string]$text) {
  try {
    if ((Get-ElementValue $element) -eq $text) {
      return $true
    }

    $element.SetFocus()
  } catch {
    return $false
  }

  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait("{DEL}")
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $text))
  Start-Sleep -Milliseconds 250

  try {
    return (Get-ElementValue $element) -eq $text
  } catch {
    return $false
  }
}

function Test-IsBelowNameField($nameEdit, $element) {
  try {
    $nameRect = $nameEdit.Current.BoundingRectangle
    $rect = $element.Current.BoundingRectangle
  } catch {
    return $false
  }

  if ($rect.Width -le 0 -or $rect.Height -le 0) {
    return $false
  }

  return $rect.Y -ge ($nameRect.Y + $nameRect.Height - 8)
}

function Find-EditNear($start) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $origin = $start
  for ($level = 0; $level -lt 8; $level++) {
    $parent = $walker.GetParent($origin)
    if (-not $parent) {
      break
    }
    $origin = $parent
  }

  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($origin)
  $seen = 0
  while ($queue.Count -gt 0 -and $seen -lt 2500) {
    $node = $queue.Dequeue()
    $seen++
    $name = ""
    try {
      $name = ([string]$node.Current.Name).Trim()
    } catch {
      $name = ""
    }

    if ($name -eq "Edit") {
      return $node
    }

    $child = $walker.GetFirstChild($node)
    while ($child) {
      $queue.Enqueue($child)
      $child = $walker.GetNextSibling($child)
    }
  }

  return $null
}

$classProp = [System.Windows.Automation.AutomationElement]::ClassNameProperty
$linkTypes = @(
  [System.Windows.Automation.ControlType]::Hyperlink,
  [System.Windows.Automation.ControlType]::Button,
  [System.Windows.Automation.ControlType]::Text,
  [System.Windows.Automation.ControlType]::Custom
)
$deadline = (Get-Date).AddSeconds(40)
$clickAttempt = 0
$nameFilled = $false

while ((Get-Date) -lt $deadline) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $chromeCond = New-Object System.Windows.Automation.PropertyCondition(
    $classProp,
    "Chrome_WidgetWin_1"
  )
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $chromeCond
  )

  $projectWindow = $null
  foreach ($win in $windows) {
    $title = [string]$win.Current.Name
    if ($title -match "New Project") {
      $projectWindow = $win
      break
    }

    if (-not $projectWindow -and $title -match "Google Cloud|console\.cloud\.google\.com") {
      $projectWindow = $win
    }
  }

  if ($projectWindow) {
    $hwnd = New-Object IntPtr ($projectWindow.Current.NativeWindowHandle)
    [CloudProjectFormClick]::SetForegroundWindow($hwnd) | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")

    if (-not $nameFilled) {
      $nameEdit = Find-First $projectWindow @(
        [System.Windows.Automation.ControlType]::Edit
      ) { param($control) ([string]$control.Current.Name) -like "*Project name*" }
      if ($nameEdit) {
        Set-EditValue $nameEdit $ProjectName | Out-Null
        $nameFilled = $true
      }
    }

    if (-not $script:pageProjectId) {
      Read-VisibleProjectId $projectWindow
    }

    if ($script:pageProjectId -and $clickAttempt -eq 0) {
      $createButton = Find-First $projectWindow @(
        [System.Windows.Automation.ControlType]::Button,
        [System.Windows.Automation.ControlType]::Hyperlink,
        [System.Windows.Automation.ControlType]::SplitButton
      ) {
        param($control)
        ([string]$control.Current.Name).Trim() -eq "Create"
      }

      if ($createButton) {
        $clickAttempt = 1
        Open-Element $createButton
        Write-Output "PAGE_PROJECT_ID=$($script:pageProjectId)"
        Write-Output "PROJECT_CREATED=1"
        exit 0
      }
    }
  }

  Start-Sleep -Milliseconds 800
}

[Console]::Error.WriteLine("Create was not clicked, so the project ID was not stored.")
exit 1
