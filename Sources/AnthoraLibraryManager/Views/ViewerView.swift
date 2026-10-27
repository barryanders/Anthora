import AVKit
import LibraryCore
import SwiftUI
import ThumbnailEngine

/// Immersive full-window viewer.
///
/// Keys: ← → (and ↑ ↓) navigate · Space play/pause video, closes an image
/// (like Quick Look) · F favorite · I toggle info · ⌘↩ reveal in Finder ·
/// Esc close (resets zoom first if zoomed).
///
/// Chrome auto-hides after a moment of stillness and returns on any pointer
/// or key activity. Images support pinch/double-click zoom with drag to pan.
struct ViewerView: View {
    @Environment(AppModel.self) private var model
    @State private var fullImage: ThumbnailImage?
    @State private var player: AVPlayer?
    @State private var showInfo = true
    @State private var chrome = ChromeAutoHider()
    @FocusState private var focused: Bool

    // Zoom & pan (images only).
    @State private var zoomScale: CGFloat = 1
    @State private var gestureBaseScale: CGFloat?
    @State private var panOffset: CGSize = .zero
    @State private var gestureBasePan: CGSize?

    private var isZoomed: Bool { zoomScale > 1.001 }

    var body: some View {
        if let item = model.viewerItem {
            ZStack {
                Color.black.ignoresSafeArea()

                content(for: item)

                VStack {
                    topBar(for: item)
                    Spacer()
                    if showInfo {
                        infoBar(for: item)
                    }
                }
                .padding(16)
                .opacity(chrome.visible ? 1 : 0)
                .animation(.easeOut(duration: 0.2), value: chrome.visible)
            }
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .onAppear {
                focused = true
                chrome.poke()
            }
            .onContinuousHover { phase in
                if case .active = phase {
                    chrome.poke()
                }
            }
            .onKeyPress(phases: .down) { press in
                chrome.poke()
                return handleKey(press, item: item)
            }
            .task(id: item.id) {
                await load(item)
            }
            .onDisappear {
                player?.pause()
                player = nil
                chrome.cancel()
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(for item: MediaItemRecord) -> some View {
        if item.missing {
            ContentUnavailableView(
                "File is missing",
                systemImage: "exclamationmark.triangle",
                description: Text("The original file can't be found. It may be on a disconnected drive.\n\(item.path)")
            )
            .foregroundStyle(.white)
        } else {
            switch item.mediaType {
            case .image:
                if let fullImage {
                    imageContent(fullImage)
                } else {
                    ProgressView()
                        .controlSize(.large)
                        .tint(.white)
                }
            case .video:
                if let player {
                    VideoPlayer(player: player)
                        .padding(24)
                } else {
                    ProgressView()
                        .controlSize(.large)
                        .tint(.white)
                }
            }
        }
    }

    private func imageContent(_ image: ThumbnailImage) -> some View {
        Image(decorative: image.cgImage, scale: 1)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .padding(isZoomed ? 0 : 24)
            .scaleEffect(zoomScale)
            .offset(panOffset)
            .contentShape(Rectangle())
            .gesture(magnification)
            .simultaneousGesture(pan)
            .onTapGesture(count: 2) {
                withAnimation(.easeOut(duration: 0.2)) {
                    if isZoomed {
                        resetZoom()
                    } else {
                        zoomScale = 2.5
                    }
                }
            }
            .animation(.easeOut(duration: 0.15), value: isZoomed)
    }

    private var magnification: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let base = gestureBaseScale ?? zoomScale
                gestureBaseScale = base
                zoomScale = min(6, max(1, base * value.magnification))
                if zoomScale <= 1.001 {
                    panOffset = .zero
                }
            }
            .onEnded { _ in
                gestureBaseScale = nil
                if zoomScale <= 1.05 {
                    withAnimation(.easeOut(duration: 0.15)) {
                        resetZoom()
                    }
                }
            }
    }

    private var pan: some Gesture {
        DragGesture()
            .onChanged { value in
                guard isZoomed else { return }
                let base = gestureBasePan ?? panOffset
                gestureBasePan = base
                panOffset = CGSize(
                    width: base.width + value.translation.width,
                    height: base.height + value.translation.height
                )
            }
            .onEnded { _ in
                gestureBasePan = nil
            }
    }

    private func resetZoom() {
        zoomScale = 1
        panOffset = .zero
        gestureBaseScale = nil
        gestureBasePan = nil
    }

    private func load(_ item: MediaItemRecord) async {
        player?.pause()
        player = nil
        fullImage = nil
        resetZoom()
        guard !item.missing else { return }
        switch item.mediaType {
        case .image:
            // Show the cached thumbnail instantly, then swap in the full decode.
            if let quick = await model.thumbnails?.thumbnail(for: item), fullImage == nil {
                fullImage = quick
            }
            if let full = await model.thumbnails?.fullImage(for: item) {
                fullImage = full
            }
            prefetchNeighbors()
        case .video:
            let newPlayer = AVPlayer(url: item.fileURL)
            player = newPlayer
            newPlayer.play()
        }
    }

    /// Warms the full-image cache for the neighboring items so ←/→ is instant.
    private func prefetchNeighbors() {
        guard let index = model.viewerIndex, let thumbnails = model.thumbnails else { return }
        let neighbors = [index + 1, index - 1].filter { model.items.indices.contains($0) }
        for neighborIndex in neighbors {
            let neighbor = model.items[neighborIndex]
            guard neighbor.mediaType == .image, !neighbor.missing else { continue }
            Task {
                _ = await thumbnails.fullImage(for: neighbor)
            }
        }
    }

    // MARK: - Chrome

    private func topBar(for item: MediaItemRecord) -> some View {
        HStack(spacing: 12) {
            Button {
                model.closeViewer()
            } label: {
                Image(systemName: "xmark")
            }
            .help("Close (Esc)")

            Spacer()

            Text(item.filename)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer()

            Button {
                model.toggleFavorite(item)
            } label: {
                Image(systemName: item.favorite ? "heart.fill" : "heart")
                    .foregroundStyle(item.favorite ? .pink : .primary)
            }
            .help("Favorite (F)")

            Button {
                model.revealInFinder(item)
            } label: {
                Image(systemName: "folder")
            }
            .help("Reveal in Finder (⌘↩)")

            Button {
                showInfo.toggle()
            } label: {
                Image(systemName: "info.circle")
            }
            .help("Toggle info (I)")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .onHover { hovering in
            chrome.pinned = hovering
        }
    }

    private func infoBar(for item: MediaItemRecord) -> some View {
        HStack(spacing: 14) {
            ForEach(infoParts(for: item), id: \.self) { part in
                Text(part)
            }
            Spacer()
            if let index = model.viewerIndex {
                Text("\((index + 1).formatted()) of \(model.totalCount.formatted())")
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .onHover { hovering in
            chrome.pinned = hovering
        }
    }

    private func infoParts(for item: MediaItemRecord) -> [String] {
        var parts: [String] = []
        if let width = item.width, let height = item.height {
            parts.append("\(width)×\(height)")
        }
        parts.append(item.sizeBytes.formatted(.byteCount(style: .file)))
        if let date = item.createdAt ?? item.modifiedAt {
            parts.append(date.formatted(date: .abbreviated, time: .shortened))
        }
        parts.append(item.fileURL.deletingLastPathComponent().lastPathComponent)
        return parts
    }

    // MARK: - Keyboard

    private func handleKey(_ press: KeyPress, item: MediaItemRecord) -> KeyPress.Result {
        switch press.key {
        case .escape:
            if isZoomed {
                withAnimation(.easeOut(duration: 0.15)) {
                    resetZoom()
                }
            } else {
                model.closeViewer()
            }
            return .handled
        case .leftArrow, .upArrow:
            model.viewerStep(-1)
            return .handled
        case .rightArrow, .downArrow:
            model.viewerStep(1)
            return .handled
        case .space:
            if item.mediaType == .video, let player {
                player.timeControlStatus == .playing ? player.pause() : player.play()
            } else {
                model.closeViewer()
            }
            return .handled
        case .return where press.modifiers.contains(.command):
            model.revealInFinder(item)
            return .handled
        default:
            break
        }
        switch press.characters {
        case "f":
            model.toggleFavorite(item)
            return .handled
        case "i":
            showInfo.toggle()
            return .handled
        default:
            return .ignored
        }
    }
}
