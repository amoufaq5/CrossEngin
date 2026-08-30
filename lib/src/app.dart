import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'l10n/app_localizations.dart';
import 'router/app_router.dart';
import 'settings/settings_controller.dart';
import 'theme/app_colors.dart';
import 'theme/app_metrics.dart';
import 'theme/app_theme.dart';

/// The router is built once and kept for the app's life; rebuilding it on a
/// settings change would drop the navigation stack on every theme toggle.
final Provider<GoRouter> routerProvider = Provider<GoRouter>(
  (Ref ref) => buildRouter(),
);

class AmgadSamirApp extends ConsumerWidget {
  const AmgadSamirApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final Brightness brightness = ref.watch(brightnessProvider);
    final Locale locale = ref.watch(localeProvider);

    // The theme toggle switches the OS status-bar style along with the tokens.
    SystemChrome.setSystemUIOverlayStyle(
      AppTheme.systemOverlayStyle(brightness),
    );

    return MaterialApp.router(
      title: 'Amgad Samir',
      debugShowCheckedModeBanner: false,
      routerConfig: ref.watch(routerProvider),
      locale: locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localeResolutionCallback: (Locale? device, Iterable<Locale> supported) =>
          AppLocalizations.resolve(device, supported),
      localizationsDelegates: const <LocalizationsDelegate<Object>>[
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      // One theme, chosen by the app rather than by the OS: the design's
      // appearance row is an explicit choice, not a system follow.
      theme: AppTheme.of(brightness),
      // Instant, per the handoff — no cross-fade between themes.
      themeAnimationDuration: AppMotion.theme,
      builder: (BuildContext context, Widget? child) {
        // Text is sized for the design's small scale; letting the system
        // scale run unbounded breaks 44px rows, so it is clamped rather than
        // ignored.
        final MediaQueryData mq = MediaQuery.of(context);
        return MediaQuery(
          data: mq.copyWith(
            textScaler: mq.textScaler.clamp(
              minScaleFactor: 1.0,
              maxScaleFactor: 1.3,
            ),
          ),
          child: ColoredBox(
            color: (brightness == Brightness.dark
                    ? AppColors.dark
                    : AppColors.light)
                .bg,
            child: child ?? const SizedBox.shrink(),
          ),
        );
      },
    );
  }
}
