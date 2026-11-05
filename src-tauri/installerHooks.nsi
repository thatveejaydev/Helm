!macro customInstall
  DetailPrint "Installing Helm Bridge to Adobe Premiere Pro via UPIA..."
  ${If} ${FileExists} "$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    nsExec::Exec '"$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "$INSTDIR\premiere-plugin\helm-bridge.ccx"'
  ${ElseIf} ${FileExists} "$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    nsExec::Exec '"$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "$INSTDIR\premiere-plugin\helm-bridge.ccx"'
  ${EndIf}
!macroend

!macro customUninstall
  DetailPrint "Removing Helm Bridge from Adobe Premiere Pro..."
  ${If} ${FileExists} "$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    nsExec::Exec '"$COMMONFILES64\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /remove "is.helm.palette.bridge"'
  ${ElseIf} ${FileExists} "$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    nsExec::Exec '"$COMMONFILES\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /remove "is.helm.palette.bridge"'
  ${EndIf}
!macroend
