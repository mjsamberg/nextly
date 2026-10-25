; Installer for the native Windows app (Inno Setup 6). CI builds it from the
; self-contained publish folder; see the windows-native job in
; .github/workflows/build.yml. Installs for the current user only (no admin
; rights needed) as "Nextly Native", so it sits beside the Tauri "Nextly"
; until that one is retired (docs/parity.md).
;
;   iscc /DAppVersion=2026.10.24.3 /DPublishDir=..\publish\x64 Nextly.iss

#ifndef AppVersion
  #define AppVersion "0.0.0.0"
#endif
#ifndef PublishDir
  #define PublishDir "..\publish\x64"
#endif

[Setup]
AppId={{6B0E8B2A-3C61-4D4E-9F1C-2A7B5D3E8C41}
AppName=Nextly Native
AppVersion={#AppVersion}
AppVerName=Nextly Native {#AppVersion}
AppPublisher=Mark Samberg
AppPublisherURL=https://github.com/mjsamberg/nextly
DefaultDirName={localappdata}\Programs\Nextly Native
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputDir=..\installer-out
OutputBaseFilename=Nextly-Native-{#AppVersion}-x64-setup
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\Nextly.App\Assets\nextly.ico
UninstallDisplayIcon={app}\Nextly.exe
UninstallDisplayName=Nextly Native
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Close a running copy so its files can be replaced.
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{userprograms}\Nextly Native"; Filename: "{app}\Nextly.exe"; AppUserModelID: "com.mjsamberg.nextly.native"

[Run]
Filename: "{app}\Nextly.exe"; Description: "Open Nextly Native"; Flags: nowait postinstall skipifsilent

[Code]
// Uninstalling removes this app's own nextly:// link registration (Links.cs
// marks it with an NextlyNative value), so links go back to whatever handled
// them before. Tasks and settings in %LOCALAPPDATA%\Nextly are kept.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Mark: String;
begin
  if CurUninstallStep = usPostUninstall then
    if RegQueryStringValue(HKCU, 'Software\Classes\nextly', 'NextlyNative', Mark) then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\nextly');
end;
