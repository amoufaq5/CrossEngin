import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/app.dart';
import 'src/settings/app_settings.dart';
import 'src/settings/settings_controller.dart';
import 'src/settings/settings_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Settings are read before the first frame so the app opens in the theme and
  // language the user last chose, with no flash of the defaults.
  final SettingsStore store = SharedPreferencesSettingsStore(
    SharedPreferencesAsync(),
  );
  final AppSettings settings = await store.read();

  runApp(
    ProviderScope(
      // `Override` is not exported from the riverpod barrel, so the list
      // type is inferred rather than written out.
      overrides: [
        settingsStoreProvider.overrideWithValue(store),
        initialSettingsProvider.overrideWithValue(settings),
      ],
      child: const AmgadSamirApp(),
    ),
  );
}
