import 'package:flutter/foundation.dart';

/// The rendition ladder the app offers, from audio-only up to 1080p.
///
/// This is fixed vocabulary rather than model data — every screen that talks
/// about quality (the playback sheet, the download sheets, the settings row,
/// the library badge) draws from this one ladder. Step 2's `Rendition` model
/// keys off it.
enum Quality {
  /// Audio only. The lightest option, and the one that keeps playing while
  /// the screen is locked.
  mp3(key: 'mp3', megabytesPerMinute: 0.72, isAudioOnly: true),
  p144(key: '144', megabytesPerMinute: 1.1),
  p360(key: '360', megabytesPerMinute: 2.8),
  p480(key: '480', megabytesPerMinute: 4.4),
  p720(key: '720', megabytesPerMinute: 7.2),
  p1080(key: '1080', megabytesPerMinute: 14.5);

  const Quality({
    required this.key,
    required this.megabytesPerMinute,
    this.isAudioOnly = false,
  });

  /// Stable identifier — persisted in preferences and in the downloads index,
  /// and expected to match the API's `rendition.quality`.
  final String key;

  /// Placeholder sizing rate. The handoff is explicit that production must
  /// use `rendition.bytes` from the API; this only exists so the download
  /// sheet can show an honest-looking size before that API is live.
  final double megabytesPerMinute;

  final bool isAudioOnly;

  bool get isVideo => !isAudioOnly;

  /// Estimated download size for a lesson of [duration], in megabytes.
  ///
  /// Deliberately unused once real `bytes` arrive from the API — see
  /// `Rendition.bytes` in step 2.
  double estimatedMegabytes(Duration duration) =>
      duration.inSeconds / 60 * megabytesPerMinute;

  static Quality? fromKey(String? key) {
    for (final Quality q in Quality.values) {
      if (q.key == key) return q;
    }
    return null;
  }

  /// The playback-quality sheet offers one extra row above the ladder:
  /// "auto (network)". It is a selection, not a rendition, so it is modelled
  /// as the absence of a fixed [Quality] rather than as a ladder member.
  static const String autoKey = 'auto';
}

/// A playback-quality choice: either a pinned [Quality] or "auto".
@immutable
class QualitySelection {
  const QualitySelection.auto() : quality = null;

  const QualitySelection.pinned(Quality this.quality);

  final Quality? quality;

  bool get isAuto => quality == null;

  String get key => quality?.key ?? Quality.autoKey;

  static QualitySelection fromKey(String? key) {
    final Quality? q = Quality.fromKey(key);
    return q == null ? const QualitySelection.auto() : QualitySelection.pinned(q);
  }

  @override
  bool operator ==(Object other) =>
      other is QualitySelection && other.quality == quality;

  @override
  int get hashCode => quality.hashCode;
}
