import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import 'placeholder_screen.dart';

/// Step 4 replaces this with the series hero and its episode list.
class SeriesDetailScreen extends StatelessWidget {
  const SeriesDetailScreen({super.key, required this.seriesId});

  final String seriesId;

  @override
  Widget build(BuildContext context) => PlaceholderScreen(
    title: context.strings.seriesKicker,
    arrivesIn: '${context.placeholderNote} — step 4 · id $seriesId',
  );
}
