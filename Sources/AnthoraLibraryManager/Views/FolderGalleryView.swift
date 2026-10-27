import AppKit
import LibraryCore
import SwiftUI

struct FolderGalleryView: View {
    @Environment(AppModel.self) private var model

    private let columns = [
        GridItem(.adaptive(minimum: 150, maximum: 210), spacing: 24),
    ]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 28) {
                ForEach(model.visualFolders) { visualFolder in
                    FolderCircleCard(visualFolder: visualFolder)
                }
            }
            .padding(24)
        }
    }
}

private struct FolderCircleCard: View {
    @Environment(AppModel.self) private var model
    let visualFolder: VisualFolder

    var body: some View {
        Button {
            model.openFolder(visualFolder.folder)
        } label: {
            VStack(spacing: 11) {
                Group {
                    if let cover = visualFolder.cover {
                        ThumbnailView(item: cover)
                    } else {
                        ZStack {
                            Circle().fill(.quaternary)
                            Image(systemName: "folder.fill")
                                .font(.system(size: 38, weight: .light))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .clipShape(Circle())
                .overlay {
                    Circle().strokeBorder(.primary.opacity(0.08), lineWidth: 1)
                }
                .shadow(color: .black.opacity(0.08), radius: 9, y: 4)

                Text(visualFolder.folder.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text("\(visualFolder.itemCount.formatted()) items")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Choose Cover Automatically") {
                model.useAutomaticCover(for: visualFolder.folder)
            }
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([
                    URL(fileURLWithPath: visualFolder.folder.path, isDirectory: true),
                ])
            }
        }
        .help(visualFolder.folder.path)
    }
}
