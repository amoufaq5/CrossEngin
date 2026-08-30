import 'package:amgad_samir_app/src/app.dart';
import 'package:amgad_samir_app/src/l10n/app_localizations.dart';
import 'package:amgad_samir_app/src/settings/app_settings.dart';
import 'package:amgad_samir_app/src/settings/settings_controller.dart';
import 'package:amgad_samir_app/src/settings/settings_store.dart';
import 'package:amgad_samir_app/src/theme/app_colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _app(InMemorySettingsStore store) => ProviderScope(
  overrides: [
    settingsStoreProvider.overrideWithValue(store),
    initialSettingsProvider.overrideWithValue(store.value),
  ],
  child: const AmgadSamirApp(),
);

/// A phone-sized surface, so layout matches what the design targets rather
/// than the 800x600 test default.
Future<void> _pumpPhone(WidgetTester tester, InMemorySettingsStore store) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_app(store));
}

/// The direction the app's own content is laid out in, read below
/// [MaterialApp] so it reflects the resolved locale rather than the test host.
TextDirection _contentDirection(WidgetTester tester) =>
    Directionality.of(tester.element(find.byType(Scaffold).first));

AppColors _activeColors(WidgetTester tester) =>
    Theme.of(
      tester.element(find.byType(Scaffold).first),
    ).extension<AppColors>()!;

void main() {
  testWidgets('opens in Arabic, right-to-left, in the dark theme', (
    WidgetTester tester,
  ) async {
    await _pumpPhone(tester, InMemorySettingsStore());
    await tester.pumpAndSettle();

    expect(_contentDirection(tester), TextDirection.rtl);
    expect(_activeColors(tester), AppColors.dark);
    expect(find.text('أمجد سمير'), findsOneWidget);
  });

  testWidgets('a saved English + light preference paints the first frame', (
    WidgetTester tester,
  ) async {
    await _pumpPhone(
      tester,
      InMemorySettingsStore(
        const AppSettings(languageCode: 'en', themeMode: Brightness.light),
      ),
    );
    // Deliberately not settled first: the very first frame must already be
    // English and light, with no flash of the Arabic dark defaults.
    await tester.pump();

    expect(_contentDirection(tester), TextDirection.ltr);
    expect(_activeColors(tester), AppColors.light);
    expect(find.text('Amgad Samir'), findsOneWidget);
  });

  testWidgets('the theme toggle swaps every token and persists', (
    WidgetTester tester,
  ) async {
    final InMemorySettingsStore store = InMemorySettingsStore();
    await _pumpPhone(tester, store);
    await tester.pumpAndSettle();
    expect(_activeColors(tester), AppColors.dark);

    await tester.tap(find.byIcon(Icons.dark_mode_outlined));
    await tester.pumpAndSettle();

    expect(_activeColors(tester), AppColors.light);
    expect(store.value.themeMode, Brightness.light);
    // And back, so the toggle is symmetric.
    await tester.tap(find.byIcon(Icons.light_mode_outlined));
    await tester.pumpAndSettle();
    expect(_activeColors(tester), AppColors.dark);
  });

  testWidgets('the language toggle switches direction, strings and persists', (
    WidgetTester tester,
  ) async {
    final InMemorySettingsStore store = InMemorySettingsStore();
    await _pumpPhone(tester, store);
    await tester.pumpAndSettle();

    expect(_contentDirection(tester), TextDirection.rtl);
    expect(find.text('الرئيسية'), findsWidgets);

    await tester.tap(find.text('EN'));
    await tester.pumpAndSettle();

    expect(_contentDirection(tester), TextDirection.ltr);
    expect(find.text('Home'), findsWidgets);
    expect(find.text('الرئيسية'), findsNothing);
    expect(store.value.languageCode, 'en');
    // The toggle now offers the way back.
    expect(find.text('ع'), findsOneWidget);
  });

  testWidgets('the tab bar leaves the content behind it tappable', (
    WidgetTester tester,
  ) async {
    // Regression: `bottomNavigationBar` is handed loose constraints, so an
    // unbounded tab bar grows to fill the screen and eats every tap meant for
    // the content behind it.
    await _pumpPhone(tester, InMemorySettingsStore());
    await tester.pumpAndSettle();

    final Size screen = tester.view.physicalSize / tester.view.devicePixelRatio;
    final Rect bar = tester.getRect(find.byType(BackdropFilter));
    expect(bar.height, lessThan(screen.height / 4));
    expect(bar.bottom, screen.height);
  });

  testWidgets('every tab is reachable', (WidgetTester tester) async {
    await _pumpPhone(tester, InMemorySettingsStore());
    await tester.pumpAndSettle();

    for (final String tab in <String>['السلاسل', 'مكتبتي', 'الإعدادات']) {
      await tester.tap(find.text(tab).last);
      await tester.pumpAndSettle();
      expect(find.text(tab), findsWidgets);
    }
  });

  testWidgets('the settings screen persists appearance and language', (
    WidgetTester tester,
  ) async {
    final InMemorySettingsStore store = InMemorySettingsStore();
    await _pumpPhone(tester, store);
    await tester.pumpAndSettle();

    await tester.tap(find.text('الإعدادات').last);
    await tester.pumpAndSettle();

    await tester.tap(find.text('المظهر'));
    await tester.pumpAndSettle();
    expect(store.value.themeMode, Brightness.light);
    expect(find.text('فاتح'), findsOneWidget);

    await tester.tap(find.text('اللغة'));
    await tester.pumpAndSettle();
    expect(store.value.languageCode, 'en');
    expect(find.text('English'), findsOneWidget);
  });

  testWidgets('every tap target on the home screen is at least 44x44', (
    WidgetTester tester,
  ) async {
    await _pumpPhone(tester, InMemorySettingsStore());
    await tester.pumpAndSettle();

    final SemanticsHandle handle = tester.ensureSemantics();
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
    handle.dispose();
  });

  test('an unsupported system locale falls back to Arabic', () {
    expect(
      AppLocalizations.resolve(
        const Locale('fr'),
        AppLocalizations.supportedLocales,
      ),
      const Locale('ar'),
    );
    expect(
      AppLocalizations.resolve(
        const Locale('en', 'GB'),
        AppLocalizations.supportedLocales,
      ),
      const Locale('en'),
    );
    expect(
      AppLocalizations.resolve(null, AppLocalizations.supportedLocales),
      const Locale('ar'),
    );
  });
}
