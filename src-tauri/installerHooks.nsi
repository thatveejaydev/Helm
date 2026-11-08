!macroundef MUI_PAGE_FINISH
!macro MUI_PAGE_FINISH
  !insertmacro MUI_UNSET MUI_FINISHPAGE_RUN
  !insertmacro MUI_UNSET MUI_FINISHPAGE_RUN_TEXT
  !insertmacro MUI_UNSET MUI_FINISHPAGE_RUN_PARAMETERS
  !insertmacro MUI_UNSET MUI_FINISHPAGE_RUN_NOTCHECKED
  !insertmacro MUI_UNSET MUI_FINISHPAGE_RUN_FUNCTION
  !insertmacro MUI_UNSET MUI_FINISHPAGE_SHOWREADME
  !insertmacro MUI_UNSET MUI_FINISHPAGE_SHOWREADME_TEXT
  !insertmacro MUI_UNSET MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !insertmacro MUI_UNSET MUI_FINISHPAGE_SHOWREADME_FUNCTION
  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_PAGEDECLARATION_FINISH
!macroend

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM helm.exe'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing Helm Bridge to Adobe Premiere Pro via UPIA..."
  ${If} ${FileExists} "$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    nsExec::Exec '"$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /remove "Helm Bridge"'
    nsExec::Exec '"$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "$INSTDIR\premiere-plugin\helm-bridge.ccx"'
  ${ElseIf} ${FileExists} "$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    nsExec::Exec '"$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /remove "Helm Bridge"'
    nsExec::Exec '"$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "$INSTDIR\premiere-plugin\helm-bridge.ccx"'
  ${EndIf}
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Helm" '"$INSTDIR\helm.exe" --watch-premiere'
  WriteRegStr HKCU "Software\Classes\helm" "" "URL:Helm Protocol"
  WriteRegStr HKCU "Software\Classes\helm" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\helm\shell\open\command" "" '"$INSTDIR\helm.exe" --autostart "%1"'
  Exec '"$INSTDIR\helm.exe" --watch-premiere'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM helm.exe'
  DetailPrint "Removing Helm Bridge from Adobe Premiere Pro..."
  ${If} ${FileExists} "$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    nsExec::Exec '"$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /remove "Helm Bridge"'
  ${ElseIf} ${FileExists} "$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    nsExec::Exec '"$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /remove "Helm Bridge"'
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Helm"
  DeleteRegKey HKCU "Software\Classes\helm"
!macroend
