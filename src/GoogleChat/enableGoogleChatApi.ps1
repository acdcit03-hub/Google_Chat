$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CloudChatApiClick {
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

function Click-ScreenPoint([int]$x, [int]$y) {
  [CloudChatApiClick]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [CloudChatApiClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [CloudChatApiClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Click-Element($window, $element) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) {
    return $false
  }

  $hwnd = New-Object IntPtr ($window.Current.NativeWindowHandle)
  [CloudChatApiClick]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 200
  $x = [int]($rect.X + ($rect.Width / 2))
  $y = [int]($rect.Y + ($rect.Height / 2))
  Click-ScreenPoint $x $y
  return $true
}

function Get-ClickableControls($window) {
  $types = @(
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::Hyperlink,
    [System.Windows.Automation.ControlType]::Text
  )
  $controls = New-Object System.Collections.ArrayList

  foreach ($controlType in $types) {
    foreach ($control in (Find-Controls $window $controlType)) {
      [void]$controls.Add($control)
    }
  }

  return $controls
}

function Find-TryThisApi($controls) {
  foreach ($control in $controls) {
    $name = ([string]$control.Current.Name).Trim()
    if ($name -notlike "Try this API*") {
      continue
    }

    $rect = $control.Current.BoundingRectangle
    if ($rect.Width -gt 40 -and $rect.Height -gt 12) {
      return $control
    }
  }

  return $null
}

function Find-EnableButton($window, $controls, $tryButton) {
  $tryRect = $null
  if ($tryButton) {
    $tryRect = $tryButton.Current.BoundingRectangle
  }

  $best = $null
  $bestDistance = [double]::MaxValue

  foreach ($control in $controls) {
    $name = ([string]$control.Current.Name).Trim()
    if ($name -notmatch '^(?i)Enable$') {
      continue
    }

    $rect = $control.Current.BoundingRectangle
    if ($rect.Width -lt 36 -or $rect.Height -lt 16 -or $rect.Width -gt 220) {
      continue
    }

    if ($tryRect -and $tryRect.Width -gt 0) {
      $sameRow = [Math]::Abs(($rect.Y + ($rect.Height / 2)) - ($tryRect.Y + ($tryRect.Height / 2))) -le 24
      $isLeft = ($rect.X + $rect.Width) -le ($tryRect.X + 8)
      if (-not $sameRow -or -not $isLeft) {
        continue
      }
    } else {
      $windowRect = $window.Current.BoundingRectangle
      if (($rect.Y - $windowRect.Y) -lt 80) {
        continue
      }
    }

    $distance = 0
    if ($tryRect -and $tryRect.Width -gt 0) {
      $distance = $tryRect.X - ($rect.X + $rect.Width)
    }

    if ($distance -lt $bestDistance) {
      $best = $control
      $bestDistance = $distance
    }
  }

  return $best
}

function Find-AlreadyEnabled($controls, $tryButton) {
  $tryRect = $null
  if ($tryButton) {
    $tryRect = $tryButton.Current.BoundingRectangle
  }

  foreach ($control in $controls) {
    $name = ([string]$control.Current.Name).Trim()
    $rect = $control.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) {
      continue
    }

    if ($name -match '(?i)API Enabled') {
      return $true
    }

    if ($name -notmatch '^(?i)Manage$') {
      continue
    }

    if (-not $tryRect -or $tryRect.Width -le 0) {
      return $true
    }

    $sameRow = [Math]::Abs(($rect.Y + ($rect.Height / 2)) - ($tryRect.Y + ($tryRect.Height / 2))) -le 24
    $isLeft = ($rect.X + $rect.Width) -le ($tryRect.X + 8)
    if ($sameRow -and $isLeft) {
      return $true
    }
  }

  return $false
}

$deadline = (Get-Date).AddSeconds(35)
$clickCount = 0

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
    if ($title -notmatch "Google Cloud|console\.cloud\.google\.com|Chat API|APIs") {
      continue
    }

    $controls = Get-ClickableControls $win
    $tryButton = Find-TryThisApi $controls

    if (Find-AlreadyEnabled $controls $tryButton) {
      Write-Output "CHAT_API_ALREADY_ENABLED=1"
      exit 0
    }

    $enableButton = Find-EnableButton $win $controls $tryButton

    if ($enableButton -and (Click-Element $win $enableButton)) {
      $clickCount++
      Start-Sleep -Milliseconds 1200
    }
  }

  Start-Sleep -Milliseconds 700
}

if ($clickCount -gt 0) {
  Write-Output "CHAT_API_ENABLED=1"
  exit 0
}

[Console]::Error.WriteLine("Google Chat API Enable button was not clicked.")
exit 1
