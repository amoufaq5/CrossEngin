/// Geometry from the handoff: radii, the spacing scale, and hit targets.
///
/// The design uses gaps between siblings, never margins — layouts should reach
/// for `Column(spacing:)` / `Row(spacing:)` / `Wrap(spacing:)` with these
/// values rather than wrapping children in `Padding`.
abstract final class AppRadii {
  /// Screen-level cards.
  static const double card = 22;

  /// The resume card's inner surface, inside its 1px gold ring.
  static const double cardInner = 21;

  /// Series rows.
  static const double row = 19;

  /// Mini-player.
  static const double mini = 19;

  /// Library and settings rows.
  static const double rowTight = 16;

  /// Thumbnails and small covers.
  static const double thumb = 16;

  /// Latest-lesson row covers (44x44).
  static const double thumbSmall = 13;

  /// Header icon buttons (34x34).
  static const double iconButton = 11;

  /// The brand mark's tile in the home header (34x34).
  static const double brandTile = 10;

  /// Search field.
  static const double field = 14;

  /// Sheet rows.
  static const double sheetRow = 14;

  /// The resume card's play button and the primary series action.
  static const double action = 15;

  /// Series rail cover art (132x132).
  static const double cover = 18;

  /// Player cover art.
  static const double coverLarge = 24;

  /// Bottom sheets, top corners only.
  static const double sheet = 26;

  /// Chips and pills.
  static const double pill = 20;
}

/// The 4–26 spacing scale. Nothing outside this set should appear in a layout.
abstract final class AppSpace {
  static const double x4 = 4;
  static const double x5 = 5;
  static const double x8 = 8;
  static const double x10 = 10;
  static const double x12 = 12;
  static const double x14 = 14;
  static const double x16 = 16;
  static const double x18 = 18;
  static const double x20 = 20;
  static const double x22 = 22;
  static const double x26 = 26;

  /// Screen horizontal padding.
  static const double screenX = x20;

  /// Inset of a row's content inside its list container.
  static const double rowInset = x8;

  /// Bottom padding on scrollable content, so the mini-player and tab bar
  /// never cover the last row.
  static const double contentBottom = 176;
}

/// Minimum touch sizes. Nothing tappable may be smaller than [minTarget].
abstract final class AppTargets {
  /// The handoff sets a 44x44 floor — iOS's minimum. Material's floor is 48,
  /// and 48 satisfies both, so tap areas are sized to 48 while painted
  /// geometry stays at the design's own sizes. Enlarging a touch target is
  /// never a visual change.
  static const double minTarget = 48;

  /// The design's stated floor, kept for the places that reason about the
  /// painted box rather than the touch area.
  static const double designMinTarget = 44;

  /// The player's primary play/pause button.
  static const double playerPlay = 66;

  /// The resume card's play button.
  static const double resumePlay = 46;

  /// The mini-player's play button.
  static const double miniPlay = 34;

  /// Header icon buttons. Below [minTarget] visually — they must be given a
  /// 44x44 tap area around the 34x34 painted box.
  static const double headerButton = 34;
}

/// Durations the handoff names explicitly.
abstract final class AppMotion {
  /// Sheet slide-up and scrim fade.
  static const Duration sheet = Duration(milliseconds: 200);

  /// Full-player push.
  static const Duration player = Duration(milliseconds: 250);

  /// Toast dwell before auto-dismiss.
  static const Duration toast = Duration(milliseconds: 2600);

  /// Theme changes are instant — no cross-fade.
  static const Duration theme = Duration.zero;
}

/// Blur radius behind the tab bar and mini-player.
const double kChromeBlur = 18;
