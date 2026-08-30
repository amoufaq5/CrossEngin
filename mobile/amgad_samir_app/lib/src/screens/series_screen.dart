import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import 'placeholder_screen.dart';

/// Step 4 replaces this with the series index.
class SeriesScreen extends StatelessWidget {
  const SeriesScreen({super.key});

  @override
  Widget build(BuildContext context) => PlaceholderScreen(
    title: context.strings.seriesTitle,
    arrivesIn: '${context.placeholderNote} — step 4',
  );
}
