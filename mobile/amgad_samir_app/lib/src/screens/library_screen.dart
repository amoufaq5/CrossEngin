import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import 'placeholder_screen.dart';

/// Step 6 replaces this with the downloads library.
class LibraryScreen extends StatelessWidget {
  const LibraryScreen({super.key});

  @override
  Widget build(BuildContext context) => PlaceholderScreen(
    title: context.strings.libraryTitle,
    arrivesIn: '${context.placeholderNote} — step 6',
  );
}
