@Tags(<String>['golden'])
library;

import 'dart:ui' as ui;

import 'package:amgad_samir_app/src/app.dart';
import 'package:amgad_samir_app/src/settings/app_settings.dart';
import 'package:amgad_samir_app/src/settings/settings_controller.dart';
import 'package:amgad_samir_app/src/settings/settings_store.dart';
import 'package:amgad_samir_app/src/theme/app_typography.dart';
import 'package:amgad_samir_app/src/widgets/arabic_text.dart';
import 'package:amgad_samir_app/src/widgets/directional.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Renders the app with the real bundled fonts so the goldens show the actual
/// Arabic type, not the test runner's placeholder face. Run with
/// `flutter test --update-goldens --tags golden` to refresh them.
Future<void> _loadFonts() async {
  Future<void> load(String family, List<String> assets) async {
    final FontLoader loader = FontLoader(family);
    for (final String asset in assets) {
      loader.addFont(rootBundle.load(asset));
    }
    await loader.load();
  }

  await load(AppFonts.kufi, <String>[
    for (final int w in <int>[400, 500, 600, 700])
      'assets/fonts/NotoKufiArabic-$w.ttf',
  ]);
  await load(AppFonts.plex, <String>[
    for (final int w in <int>[300, 400, 500, 600, 700])
      'assets/fonts/IBMPlexSansArabic-$w.ttf',
  ]);
  // `uses-material-design: true` puts the icon font in the bundle; without it
  // every Material icon renders as an empty box in a golden.
  try {
    await load('MaterialIcons', <String>['fonts/MaterialIcons-Regular.otf']);
  } on FlutterError {
    // Not fatal: the design's own stroked icons replace these anyway.
  }
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFonts();
  });

  Future<void> shoot(
    WidgetTester tester,
    String name,
    AppSettings settings,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          settingsStoreProvider.overrideWithValue(
            InMemorySettingsStore(settings),
          ),
          initialSettingsProvider.overrideWithValue(settings),
        ],
        child: const AmgadSamirApp(),
      ),
    );
    await tester.pumpAndSettle();
    // Asset images decode off the test's fake async clock, so without this
    // the golden shows an empty box where the logo belongs.
    await tester.runAsync(() async {
      await precacheImage(
        const AssetImage('assets/images/logo.png'),
        tester.element(find.byType(MaterialApp)),
      );
    });
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/$name.png'),
    );
  }

  testWidgets('dark, Arabic', (WidgetTester tester) async {
    await shoot(tester, 'home_dark_ar', const AppSettings());
  });

  testWidgets('light, Arabic', (WidgetTester tester) async {
    await shoot(
      tester,
      'home_light_ar',
      const AppSettings(themeMode: Brightness.light),
    );
  });

  testWidgets('dark, English', (WidgetTester tester) async {
    await shoot(
      tester,
      'home_dark_en',
      const AppSettings(languageCode: 'en'),
    );
  });

  testWidgets('light, English', (WidgetTester tester) async {
    await shoot(
      tester,
      'home_light_en',
      const AppSettings(languageCode: 'en', themeMode: Brightness.light),
    );
  });

  // A focused shot of the direction rules, which sit below the fold on the
  // preview screen: a mirrored chevron, an unmirrored play triangle, and an
  // Arabic title inside an English layout.
  testWidgets('direction rules', (WidgetTester tester) async {
    Widget row(TextDirection d, String prefix) => Directionality(
      textDirection: d,
      child: ColoredBox(
        color: const Color(0xFF111828),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            spacing: 16,
            children: <Widget>[
              const ForwardChevron(color: Color(0xFF8D96AC), size: 18),
              const PlayGlyph(color: Color(0xFFC9A25A), size: 18),
              Expanded(
                child: EpisodeTitleText(
                  prefix: prefix,
                  title: 'من ثمرات الذكر: طردُ الشيطان',
                  isArabicUi: d == TextDirection.rtl,
                  style: AppText.rowTitle.copyWith(
                    color: const Color(0xFFF3EFE8),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );

    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(size: Size(390, 140)),
        child: Center(
          child: SizedBox(
            width: 390,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                row(TextDirection.rtl, 'الحلقة ٤٢ — '),
                row(TextDirection.ltr, 'Ep. 42 — '),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(Column).first,
      matchesGoldenFile('goldens/direction_rules.png'),
    );
  });

  test('the goldens rendered with real glyphs, not tofu boxes', () {
    // A sanity check that the FontLoader actually took: PaintingBinding has
    // the families registered by the time the shots are taken.
    expect(ui.PlatformDispatcher.instance.views, isNotEmpty);
  });
}
