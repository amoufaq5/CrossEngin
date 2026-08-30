import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../screens/home_screen.dart';
import '../screens/library_screen.dart';
import '../screens/series_detail_screen.dart';
import '../screens/series_screen.dart';
import '../screens/settings_screen.dart';
import '../shell/app_shell.dart';

abstract final class AppRoutes {
  static const String home = '/';
  static const String search = '/search';
  static const String series = '/series';
  static const String library = '/library';
  static const String settings = '/settings';
  static const String player = '/player';

  static String seriesDetail(String id) => '/series/$id';
}

final GlobalKey<NavigatorState> _rootNavigatorKey =
    GlobalKey<NavigatorState>(debugLabel: 'root');

/// Four tab branches under one shell.
///
/// Series detail is a route *inside* the series branch rather than a top-level
/// push, which is what keeps the Series tab lit while a detail screen is open,
/// as the design requires. The full player and the search screen are pushed on
/// the root navigator instead, because both cover the tab bar entirely.
GoRouter buildRouter() {
  return GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: AppRoutes.home,
    routes: <RouteBase>[
      StatefulShellRoute.indexedStack(
        builder:
            (
              BuildContext context,
              GoRouterState state,
              StatefulNavigationShell shell,
            ) => AppShell(shell: shell),
        branches: <StatefulShellBranch>[
          StatefulShellBranch(
            routes: <RouteBase>[
              GoRoute(
                path: AppRoutes.home,
                builder: (BuildContext c, GoRouterState s) =>
                    const HomeScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: <RouteBase>[
              GoRoute(
                path: AppRoutes.series,
                builder: (BuildContext c, GoRouterState s) =>
                    const SeriesScreen(),
                routes: <RouteBase>[
                  GoRoute(
                    path: ':seriesId',
                    builder: (BuildContext c, GoRouterState s) =>
                        SeriesDetailScreen(
                          seriesId: s.pathParameters['seriesId']!,
                        ),
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: <RouteBase>[
              GoRoute(
                path: AppRoutes.library,
                builder: (BuildContext c, GoRouterState s) =>
                    const LibraryScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: <RouteBase>[
              GoRoute(
                path: AppRoutes.settings,
                builder: (BuildContext c, GoRouterState s) =>
                    const SettingsScreen(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
}
