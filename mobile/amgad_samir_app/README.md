# تطبيق أمجد سمير — Flutter app

An Arabic-first, audio-first app for the lectures published on
[amgadsamir.com](https://www.amgadsamir.com/): background playback that
survives a locked screen, offline downloads from MP3 up to 1080p, and an
English UI toggle that never touches the Arabic content.

Built to the `design_handoff_amgad_samir_app` bundle. The handoff's
`AmgadSamirApp-preview.html` is the visual source of truth; the `.dc.html`
boards are references, not code to port.

## Running it

```bash
flutter pub get
flutter run                 # iOS simulator or Android emulator
flutter analyze             # must be clean
flutter test                # the suite
flutter test --tags golden --run-skipped                  # render checks
flutter test --tags golden --run-skipped --update-goldens # refresh them
```

Built against **Flutter 3.47.2 / Dart 3.13.2**.

## Where things are

```
lib/
  main.dart                     reads settings off disk, then runApp
  src/
    app.dart                    MaterialApp.router, theme + locale wiring
    core/quality.dart           the MP3→1080p rendition ladder
    theme/
      app_colors.dart           both token tables, as a ThemeExtension
      app_metrics.dart          radii, the 4–26 spacing scale, hit targets
      app_typography.dart       the type scale, colourless
      app_theme.dart            ThemeData + system overlay style
      series_palette.dart       the six cover gradients
    l10n/
      numerals.dart             Arabic-Indic ⇄ Latin digits, durations, speed
      app_strings.dart          the string interface
      strings_ar.dart           Arabic
      strings_en.dart           English
      app_localizations.dart    the delegate; `context.strings`
    settings/                   persisted preferences (Riverpod + prefs)
    widgets/
      arabic_text.dart          RTL islands for Arabic content
      directional.dart          mirroring rules, chevron, play, pause
    router/app_router.dart      four tab branches under one shell
    shell/app_shell.dart        tab bar
    screens/                    placeholders until their step
assets/
  fonts/                        Noto Kufi Arabic + IBM Plex Sans Arabic (OFL)
  images/logo.png               the client's mark
```

## Conventions

- **Tokens, never literals.** Colours come from `context.colors`, sizes from
  `AppRadii` / `AppSpace` / `AppTargets`, type from `AppText`. A raw hex or a
  magic number in a screen is a bug.
- **Gaps, not margins.** The design specifies gaps between siblings; use
  `Column(spacing:)` / `Row(spacing:)` rather than wrapping children in
  `Padding`.
- **Content is not a string.** Lesson and series titles never enter
  `AppStrings`. They are Arabic in both languages and are rendered with
  `ArabicText` / `EpisodeTitleText`, which open their own RTL island.
- **Adding a string means adding it twice.** `AppStrings` is an abstract class,
  so a string missing from either language fails to compile.

## Dependency plan

The full stack the handoff calls for was resolved against this SDK before any
of it was declared, so no step will hit a version wall:

| Package | Resolves to | Wired in |
|---|---|---|
| `flutter_riverpod` | 3.4.2 | step 1 |
| `go_router` | 17.5.0 | step 1 |
| `shared_preferences` | 2.5.5 | step 1 |
| `just_audio` | 0.10.6 | step 5 |
| `audio_service` | 0.18.19 | step 5 |
| `rxdart` | 0.28.0 | step 5 |
| `dio` | 5.11.0 | step 6 |
| `sqflite` | 2.4.3 | step 6 |
| `path_provider` | 2.1.6 | step 6 |
| `connectivity_plus` | 7.3.1 | step 6 |
| `url_launcher` | 6.3.2 | step 7 |

Only the step-1 three are declared today. A native plugin declared early
merges its permissions into the Android manifest and its pod into the iOS
build before the step that justifies them, which is exactly what the store
review checklist warns against.

## Build order

1. **Scaffold, tokens, fonts, localisation, RTL** — done.
2. Models, repository interface, mock repository.
3. Home.
4. Series list and series detail.
5. Player, mini-player, `audio_service`, lock-screen integration.
6. Downloads, quality sheets, Library.
7. Search, Settings, sheets, toasts.
8. Platform config, icons, splash, release builds.

## Fonts

Bundled, never fetched at runtime. Static instances per weight rather than the
variable sources, so `FontWeight` maps to exactly the weight the design asks
for. Licences and provenance in `assets/fonts/ATTRIBUTION.md`.
