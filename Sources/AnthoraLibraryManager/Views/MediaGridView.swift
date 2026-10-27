import LibraryCore
import SwiftUI
import ThumbnailEngine

struct MediaGridView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var gridFocused: Bool
    @State private var estimatedColumns = 4

    private static let spacing: CGFloat = 12

    var body: some View {
        let zoom = model.gridZoom
        let columns = [GridItem(.adaptive(minimum: zoom.cellMin, maximum: zoom.cellMax), spacing: Self.spacing)]

        ScrollViewReader { proxy in
            ScrollView {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(model.items) { item in
                        MediaCardView(item: item)
                            .id(item.id)
                            .onAppear {
                                model.loadMoreIfNeeded(after: item)
                            }
                    }
                }
                .padding(16)
                .background {
                    GeometryReader { geometry in
                        Color.clear.onChange(of: geometry.size.width, initial: true) { _, width in
                            estimatedColumns = max(1, Int((width + Self.spacing) / (zoom.cellMin + Self.spacing)))
                        }
                    }
                }
            }
            .focusable()
            .focusEffectDisabled()
            .focused($gridFocused)
            .onAppear { gridFocused = true }
            .onKeyPress(phases: .down) { press in
                handleKey(press)
            }
            .onChange(of: model.selectedItemID) { _, id in
                if let id {
                    proxy.scrollTo(id, anchor: .center)
                }
            }
        }
    }

    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        switch press.key {
        case .leftArrow:
            model.moveSelection(by: -1)
            return .handled
        case .rightArrow:
            model.moveSelection(by: 1)
            return .handled
        case .upArrow:
            model.moveSelection(by: -estimatedColumns)
            return .handled
        case .downArrow:
            model.moveSelection(by: estimatedColumns)
            return .handled
        case .home:
            if let first = model.items.first {
                model.selectedItemID = first.id
            }
            return .handled
        case .end:
            if let last = model.items.last {
                model.selectedItemID = last.id
            }
            return .handled
        case .space, .return:
            model.openViewerForSelection()
            return .handled
        case .escape where model.selectedItemID != nil:
            model.selectedItemID = nil
            return .handled
        default:
            break
        }
        if press.characters == "f" {
            model.toggleFavoriteForFocus()
            return .handled
        }
        return .ignored
    }
}

struct MediaCardView: View {
    @Environment(AppModel.self) private var model
    let item: MediaItemRecord

    private var isSelected: Bool { model.selectedItemID == item.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ThumbnailView(item: item)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(
                            isSelected ? Color.accentColor : Color.primary.opacity(0.06),
                            lineWidth: isSelected ? 2.5 : 1
                        )
                }

            Text(item.filename)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .contentShape(Rectangle())
        .gesture(
            TapGesture(count: 2).onEnded {
                model.openViewer(item)
            }
        )
        .simultaneousGesture(
            TapGesture().onEnded {
                model.selectedItemID = item.id
            }
        )
        .contextMenu {
            Button(item.favorite ? "Remove from Favorites" : "Add to Favorites") {
                model.toggleFavorite(item)
            }
            Menu("Add to Album") {
                ForEach(model.collections) { collection in
                    Button(collection.name) {
                        model.add(item, toCollection: collection.id)
                    }
                }
                if !model.collections.isEmpty {
                    Divider()
                }
                Button("New Album…") {
                    model.promptNewCollection(adding: item)
                }
            }
            if case .collection = model.selection {
                Button("Remove from Album") {
                    model.removeFromCurrentCollection(item)
                }
            }
            if case .folder = model.selection {
                Button("Use as Folder Cover") {
                    model.useAsCurrentFolderCover(item)
                }
            }
            Divider()
            Button("Reveal in Finder") {
                model.revealInFinder(item)
            }
        }
        .help(detailLine)
    }

    private var detailLine: String {
        var parts: [String] = [item.path]
        if let width = item.width, let height = item.height {
            parts.append("\(width)×\(height)")
        }
        parts.append(item.sizeBytes.formatted(.byteCount(style: .file)))
        return parts.joined(separator: " · ")
    }
}

/// Async-loading thumbnail on a quiet neutral placeholder, with a soft
/// fade-in. `.task(id:)` cancels loads for cells that scroll away before
/// their turn.
struct ThumbnailView: View {
    @Environment(AppModel.self) private var model
    let item: MediaItemRecord
    @State private var thumbnail: ThumbnailImage?

    var body: some View {
        ZStack {
            if let thumbnail {
                Image(decorative: thumbnail.cgImage, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .transition(.opacity)
            } else {
                MediaPlaceholder(mediaType: item.mediaType)
            }
        }
        .animation(.easeOut(duration: 0.18), value: thumbnail != nil)
        .overlay(alignment: .bottomTrailing) {
            if item.mediaType == .video {
                VideoBadge(durationSeconds: item.durationSeconds)
            }
        }
        .overlay(alignment: .topTrailing) {
            if item.favorite {
                Image(systemName: "heart.fill")
                    .font(.caption)
                    .foregroundStyle(.pink)
                    .shadow(radius: 2)
                    .padding(6)
            }
        }
        .overlay(alignment: .bottomLeading) {
            if item.missing {
                Label("Missing", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.thinMaterial, in: Capsule())
                    .padding(6)
            }
        }
        .task(id: item.id) {
            guard !item.missing else { return }
            thumbnail = await model.thumbnails?.thumbnail(for: item)
        }
    }
}
