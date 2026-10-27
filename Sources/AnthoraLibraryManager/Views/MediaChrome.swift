import LibraryCore
import Observation
import SwiftUI

/// Quiet, neutral placeholder behind loading thumbnails. Deliberately calm —
/// no gradients, no color — so the media itself is the only color on screen.
struct MediaPlaceholder: View {
    let mediaType: MediaType

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.quaternary.opacity(0.5))
            Image(systemName: mediaType == .video ? "film" : "photo")
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(.quaternary)
        }
    }
}

/// Small duration/"video" chip on grid cells.
struct VideoBadge: View {
    let durationSeconds: Double?

    var body: some View {
        Group {
            if let durationSeconds, durationSeconds > 0 {
                Text(Duration.seconds(durationSeconds), format: .time(pattern: .minuteSecond))
                    .font(.caption2.weight(.medium))
                    .monospacedDigit()
            } else {
                Image(systemName: "play.fill")
                    .font(.caption2)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(6)
    }
}

/// Auto-hides viewer chrome after a short idle period, Pixea/QuickTime-style:
/// any pointer movement brings it back, and it never hides while the pointer
/// is resting on the chrome itself.
@MainActor
@Observable
final class ChromeAutoHider {
    private(set) var visible = true
    var pinned = false {
        didSet { if pinned { show() } }
    }

    private var hideTask: Task<Void, Never>?

    /// Nonisolated so it can serve as a `@State` default value regardless of
    /// the enclosing initializer's isolation.
    nonisolated init() {}

    /// Call on any pointer/keyboard activity.
    func poke() {
        show()
        scheduleHide()
    }

    func show() {
        hideTask?.cancel()
        visible = true
    }

    private func scheduleHide() {
        hideTask?.cancel()
        guard !pinned else { return }
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.2))
            guard !Task.isCancelled else { return }
            if let self, !self.pinned {
                self.visible = false
            }
        }
    }

    func cancel() {
        hideTask?.cancel()
    }
}
