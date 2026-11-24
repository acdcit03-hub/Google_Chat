param(
  [Parameter(Mandatory = $true)][string]$Scopes,
  [Parameter(Mandatory = $true)][string]$Email
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OAuthPlaygroundClick {
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

function Get-ElementValue($element) {
  $patternObject = $null
  $valuePattern = [System.Windows.Automation.ValuePattern]::Pattern
  if ($element.TryGetCurrentPattern($valuePattern, [ref]$patternObject)) {
    return [string]$patternObject.Current.Value
  }

  return ""
}

function Escape-SendKeys([string]$text) {
  return [regex]::Replace($text, '([+^%~(){}\[\]])', '{$1}')
}

function Click-Element($window, $element) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) {
    return $false
  }

  $hwnd = New-Object IntPtr ($window.Current.NativeWindowHandle)
  [OAuthPlaygroundClick]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 200
  $x = [int]($rect.X + ($rect.Width / 2))
  $y = [int]($rect.Y + ($rect.Height / 2))
  [OAuthPlaygroundClick]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [OAuthPlaygroundClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [OAuthPlaygroundClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}

function Find-AuthorizeButton($window) {
  foreach ($control in (Find-Controls $window ([System.Windows.Automation.ControlType]::Button))) {
    $name = ([string]$control.Current.Name).Trim()
    if ($name -ne "Authorize APIs") {
      continue
    }

    $rect = $control.Current.BoundingRectangle
    if ($rect.Width -gt 40 -and $rect.Height -gt 12) {
      return $control
    }
  }

  return $null
}

function Find-ScopeInput($window, $authorizeButton) {
  $authorizeRect = $authorizeButton.Current.BoundingRectangle
  $best = $null
  $bestRight = [double]::MinValue
  $types = @(
    [System.Windows.Automation.ControlType]::Edit,
    [System.Windows.Automation.ControlType]::ComboBox,
    [System.Windows.Automation.ControlType]::Document
  )

  foreach ($controlType in $types) {
    foreach ($control in (Find-Controls $window $controlType)) {
      $name = ([string]$control.Current.Name).Trim()
      if ($name -like "*Search*") {
        continue
      }

      $rect = $control.Current.BoundingRectangle
      if ($rect.Width -lt 80 -or $rect.Height -lt 14 -or $rect.Height -gt 80) {
        continue
      }

      $sameRow = [Math]::Abs(($rect.Y + ($rect.Height / 2)) - ($authorizeRect.Y + ($authorizeRect.Height / 2))) -le 28
      $isLeft = ($rect.X + $rect.Width) -le ($authorizeRect.X + 12)
      $namedScope = $name -like "*scope*"
      if (-not $namedScope -and (-not $sameRow -or -not $isLeft)) {
        continue
      }

      $right = $rect.X + $rect.Width
      if ($namedScope -or $right -gt $bestRight) {
        $best = $control
        $bestRight = $right
      }
    }
  }

  return $best
}

function Set-ScopeValue($window, $element, [string]$text) {
  $current = (Get-ElementValue $element).Trim()
  if ($current -eq $text) {
    return $true
  }

  $patternObject = $null
  $valuePattern = [System.Windows.Automation.ValuePattern]::Pattern
  if ($element.TryGetCurrentPattern($valuePattern, [ref]$patternObject)) {
    $patternObject.SetValue($text)
    Start-Sleep -Milliseconds 200
    if ((Get-ElementValue $element).Trim() -eq $text) {
      return $true
    }
  }

  $hwnd = New-Object IntPtr ($window.Current.NativeWindowHandle)
  [OAuthPlaygroundClick]::SetForegroundWindow($hwnd) | Out-Null
  try {
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
  Start-Sleep -Milliseconds 300
  return (Get-ElementValue $element).Trim() -eq $text
}

function Find-PayloadAccount($window, [string]$email) {
  $windowRect = $window.Current.BoundingRectangle
  $needle = $email.Trim().ToLower()
  $types = @(
    [System.Windows.Automation.ControlType]::ListItem,
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::Hyperlink,
    [System.Windows.Automation.ControlType]::DataItem,
    [System.Windows.Automation.ControlType]::Text
  )
  $best = $null
  $bestScore = -1

  foreach ($controlType in $types) {
    foreach ($control in (Find-Controls $window $controlType)) {
      $name = ([string]$control.Current.Name).Trim()
      if (-not $name -or $name -like "*Use another account*") {
        continue
      }

      if ($name.ToLower() -notlike "*$needle*") {
        continue
      }

      $rect = $control.Current.BoundingRectangle
      if ($rect.Width -lt 80 -or $rect.Height -lt 16 -or $rect.Height -gt 140) {
        continue
      }

      if (($rect.Y - $windowRect.Y) -lt 80) {
        continue
      }

      $score = 10
      if ($control.Current.ControlType.ProgrammaticName -match "ListItem|Button|Hyperlink|DataItem") {
        $score = 30
      }

      if ($score -gt $bestScore) {
        $best = $control
        $bestScore = $score
      }
    }
  }

  return $best
}

function Find-ByExactName($window, $controlTypes, [string]$expected) {
  foreach ($controlType in $controlTypes) {
    foreach ($control in (Find-Controls $window $controlType)) {
      $name = ([string]$control.Current.Name).Trim()
      if ($name -ne $expected) {
        continue
      }

      $rect = $control.Current.BoundingRectangle
      if ($rect.Width -gt 8 -and $rect.Height -gt 8) {
        return $control
      }
    }
  }

  return $null
}

function Test-IsChecked($element) {
  $patternObject = $null
  $togglePattern = [System.Windows.Automation.TogglePattern]::Pattern
  if ($element.TryGetCurrentPattern($togglePattern, [ref]$patternObject)) {
    return $patternObject.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
  }

  return $false
}

function Find-SelectAll($window) {
  $checkbox = Find-ByExactName $window @(
    [System.Windows.Automation.ControlType]::CheckBox
  ) "Select all"
  if ($checkbox) {
    return $checkbox
  }

  return Find-ByExactName $window @(
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::Text,
    [System.Windows.Automation.ControlType]::Hyperlink
  ) "Select all"
}

function Find-LearnWhy($window) {
  $types = @(
    [System.Windows.Automation.ControlType]::Text,
    [System.Windows.Automation.ControlType]::Hyperlink,
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::Group
  )

  foreach ($controlType in $types) {
    foreach ($control in (Find-Controls $window $controlType)) {
      $name = ([string]$control.Current.Name).Trim()
      if ($name -notlike "Learn why you're not seeing links*") {
        continue
      }

      $rect = $control.Current.BoundingRectangle
      if ($rect.Width -gt 40 -and $rect.Height -gt 8) {
        return $control
      }
    }
  }

  return $null
}

function Find-ScrollArrow($window, $learnWhy) {
  $learnRect = $null
  if ($learnWhy) {
    $learnRect = $learnWhy.Current.BoundingRectangle
  }

  $types = @(
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::Image,
    [System.Windows.Automation.ControlType]::Custom
  )
  $best = $null
  $bestScore = [double]::MinValue

  foreach ($controlType in $types) {
    foreach ($control in (Find-Controls $window $controlType)) {
      $name = ([string]$control.Current.Name).Trim()
      if ($name -match '(?i)cancel|continue|select all|see access details|help|privacy|terms') {
        continue
      }

      $rect = $control.Current.BoundingRectangle
      if ($rect.Width -lt 20 -or $rect.Width -gt 72 -or $rect.Height -lt 20 -or $rect.Height -gt 72) {
        continue
      }

      $namedArrow = $name -match '(?i)scroll|down arrow|show more'
      $belowLearn = $false
      if ($learnRect -and $learnRect.Width -gt 0) {
        $belowLearn = $rect.Y -gt ($learnRect.Y + $learnRect.Height - 8) -and $rect.Y -lt ($learnRect.Y + $learnRect.Height + 90)
        $centerX = $rect.X + ($rect.Width / 2)
        $within = $centerX -gt ($learnRect.X - 40) -and $centerX -lt ($learnRect.X + $learnRect.Width + 40)
        $belowLearn = $belowLearn -and $within
      }

      if (-not $namedArrow -and -not $belowLearn) {
        continue
      }

      $score = $rect.Y
      if ($namedArrow) {
        $score += 5000
      }
      if ($score -gt $bestScore) {
        $best = $control
        $bestScore = $score
      }
    }
  }

  return $best
}

function Click-BelowElement($window, $element, [int]$gap) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) {
    return $false
  }

  $hwnd = New-Object IntPtr ($window.Current.NativeWindowHandle)
  [OAuthPlaygroundClick]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 200
  $x = [int]($rect.X + ($rect.Width / 2))
  $y = [int]($rect.Y + $rect.Height + $gap)
  [OAuthPlaygroundClick]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [OAuthPlaygroundClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [OAuthPlaygroundClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}

function Find-ContinueButton($window) {
  $cancel = Find-ByExactName $window @(
    [System.Windows.Automation.ControlType]::Button
  ) "Cancel"
  $best = $null
  $bestScore = [double]::MinValue

  foreach ($control in (Find-Controls $window ([System.Windows.Automation.ControlType]::Button))) {
    $name = ([string]$control.Current.Name).Trim()
    if ($name -ne "Continue") {
      continue
    }

    $rect = $control.Current.BoundingRectangle
    if ($rect.Width -lt 40 -or $rect.Height -lt 16) {
      continue
    }

    $score = $rect.Y
    if ($cancel) {
      $cancelRect = $cancel.Current.BoundingRectangle
      $sameRow = [Math]::Abs(($rect.Y + ($rect.Height / 2)) - ($cancelRect.Y + ($cancelRect.Height / 2))) -le 24
      $isRight = $rect.X -gt $cancelRect.X
      if (-not $sameRow -or -not $isRight) {
        continue
      }
      $score += 10000
    }

    if ($score -gt $bestScore) {
      $best = $control
      $bestScore = $score
    }
  }

  return $best
}

function Find-ExchangeButton($window) {
  return Find-ByExactName $window @(
    [System.Windows.Automation.ControlType]::Button
  ) "Exchange authorization code for tokens"
}

function Test-ExchangePage($window) {
  return [bool](Find-ExchangeButton $window)
}

function Read-PlaygroundRefresh($window) {
  $fieldToken = $null
  $jsonToken = $null
  $expiresIn = $null

  foreach ($control in (Find-Controls $window ([System.Windows.Automation.ControlType]::Edit))) {
    $name = ([string]$control.Current.Name).Trim()
    $value = (Get-ElementValue $control).Trim()
    if ($value -notmatch '^1//') {
      continue
    }
    if ($name -like "*Access token*") {
      continue
    }
    if ($name -like "*Refresh token*" -or -not $fieldToken -or $value.Length -gt $fieldToken.Length) {
      $fieldToken = $value
    }
  }

  $patternId = [System.Windows.Automation.TextPattern]::Pattern
  foreach ($document in (Find-Controls $window ([System.Windows.Automation.ControlType]::Document))) {
    $patternObject = $null
    try {
      if (-not $document.TryGetCurrentPattern($patternId, [ref]$patternObject)) {
        continue
      }
      $text = $patternObject.DocumentRange.GetText(30000)
      if ($text -match '"refresh_token"\s*:\s*"(1//[^"]+)"') {
        $jsonToken = $Matches[1]
      }
      if ($text -match '"refresh_token_expires_in"\s*:\s*(\d+)') {
        $expiresIn = $Matches[1]
      }
    } catch {
    }
  }

  $token = $jsonToken
  if ($fieldToken -and ((-not $jsonToken) -or ($fieldToken.Length -ge $jsonToken.Length))) {
    $token = $fieldToken
  }

  if (-not $token -or -not $expiresIn) {
    return $null
  }

  return @{
    token = $token
    expiresIn = $expiresIn
  }
}

$deadline = (Get-Date).AddSeconds(90)
$phase = "playground"
$selectAllDone = $false
$arrowClicked = $false
$exchangeClicked = $false

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

    if ($phase -eq "consent") {
      if ($title -notmatch "Sign in|Account|Google Accounts|permission|OAuth|Playground|Google Developers") {
        continue
      }

      if (Test-ExchangePage $win) {
        Write-Output "CONSENT_CONTINUED=1"
        $phase = "exchange"
        Start-Sleep -Milliseconds 800
        continue
      }

      $selectAll = Find-SelectAll $win
      $continueButton = Find-ContinueButton $win
      if (-not $selectAll -and $continueButton -and (Click-Element $win $continueButton)) {
        $phase = "done"
        Start-Sleep -Milliseconds 1500
        continue
      }

      if (-not $selectAllDone) {
        $selectAll = Find-SelectAll $win
        if ($selectAll) {
          if (-not (Test-IsChecked $selectAll)) {
            Click-Element $win $selectAll | Out-Null
          }
          $selectAllDone = $true
          Start-Sleep -Milliseconds 600
        }
        continue
      }

      if (-not $arrowClicked) {
        $learnWhy = Find-LearnWhy $win
        $arrow = Find-ScrollArrow $win $learnWhy
        if ($arrow -and (Click-Element $win $arrow)) {
          $arrowClicked = $true
          Start-Sleep -Milliseconds 700
          continue
        }

        if ($learnWhy -and (Click-BelowElement $win $learnWhy 36)) {
          $arrowClicked = $true
          Start-Sleep -Milliseconds 700
        }
        continue
      }

      $continueButton = Find-ContinueButton $win
      if ($continueButton -and (Click-Element $win $continueButton)) {
        $phase = "done"
        Start-Sleep -Milliseconds 1500
      }
      continue
    }

    if ($phase -eq "done") {
      if (Test-ExchangePage $win) {
        Write-Output "CONSENT_CONTINUED=1"
        $phase = "exchange"
        Start-Sleep -Milliseconds 800
      }
      continue
    }

    if ($phase -eq "exchange") {
      if ($title -notmatch "OAuth|Playground|Google Developers") {
        continue
      }

      if (-not $exchangeClicked) {
        $exchangeButton = Find-ExchangeButton $win
        if ($exchangeButton -and (Click-Element $win $exchangeButton)) {
          $exchangeClicked = $true
          Start-Sleep -Milliseconds 2500
        }
        continue
      }

      $refresh = Read-PlaygroundRefresh $win
      if ($refresh) {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($refresh.token))
        Write-Output "REFRESH_TOKEN_B64=$encoded"
        Write-Output "REFRESH_EXPIRES_IN=$($refresh.expiresIn)"
        exit 0
      }
      continue
    }

    if ($phase -eq "account") {
      if ($title -notmatch "Sign in|Account|Google Accounts|OAuth|Playground|Google Developers") {
        continue
      }

      $account = Find-PayloadAccount $win $Email
      if ($account -and (Click-Element $win $account)) {
        Write-Output "ACCOUNT_SELECTED=1"
        $phase = "consent"
        Start-Sleep -Milliseconds 1500
      }
      continue
    }

    if ($title -notmatch "OAuth|Playground|Google Developers") {
      continue
    }

    $authorizeButton = Find-AuthorizeButton $win
    if (-not $authorizeButton) {
      continue
    }

    $scopeInput = Find-ScopeInput $win $authorizeButton
    if (-not ($scopeInput -and (Set-ScopeValue $win $scopeInput $Scopes))) {
      continue
    }

    Write-Output "SCOPES_TYPED=1"
    $authorizeButton = Find-AuthorizeButton $win
    if ($authorizeButton -and (Click-Element $win $authorizeButton)) {
      Write-Output "AUTHORIZE_CLICKED=1"
      $phase = "account"
      Start-Sleep -Milliseconds 1500
    }
  }

  Start-Sleep -Milliseconds 700
}

if ($phase -eq "exchange") {
  [Console]::Error.WriteLine("The refresh token was not stored.")
} elseif ($phase -eq "done" -or $phase -eq "consent") {
  [Console]::Error.WriteLine("Select all or Continue was not completed.")
} elseif ($phase -eq "account") {
  [Console]::Error.WriteLine("The payload email was not selected on the Google account page.")
} else {
  [Console]::Error.WriteLine("Authorize APIs was not clicked.")
}
exit 1
